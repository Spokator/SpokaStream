// Les accès au panneau : chacun son identifiant, son mot de passe et son rôle, utilisables depuis n'importe quel navigateur.
// Un mot de passe n'est jamais stocké, seulement son empreinte scrypt. Le code à 6 chiffres suit la RFC 6238, comme toutes les applis d'authentification.
import { createHash, createHmac, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

const SCRYPT = { N: 2 ** 15, r: 8, p: 1, maxmem: 128 * 1024 * 1024 };
const KEY_BYTES = 32;
const MIN_PASSWORD = 12;
const MAX_PASSWORD = 256;
const INVITE_MS = 24 * 3600_000;
const TOTP_STEP_S = 30;
const TOTP_DRIFT = 1;
const RECOVERY_CODES = 8;
const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export type AdminRole = "owner" | "admin" | "moderator";

/** Plus le rang est haut, plus le rôle peut faire de choses. Le serveur décide avec ça, jamais l'interface. */
export const ROLE_RANK: Record<AdminRole, number> = { moderator: 1, admin: 2, owner: 3 };

interface AdminUser {
  id: string;
  username: string;
  role: AdminRole;
  salt: string;
  hash: string;
  createdAt: number;
  changedAt: number;
  lastLogin: number;
  disabled?: boolean;
  /** Le compte de l'application qui a ce rôle, pour le raccourci depuis les paramètres. */
  appAccount?: string;
  totp?: { secret: string; lastCounter: number };
  /** Empreintes des codes de secours : chacun ne sert qu'une fois. */
  recovery: string[];
}

interface Invite {
  id: string;
  hash: string;
  expires: number;
  role: AdminRole;
  /** Remplit l'identifiant, ou vise un accès existant pour lui redonner un mot de passe. */
  username: string;
  userId: string | null;
  appAccount: string | null;
}

interface AuthFile {
  users: AdminUser[];
  invites: Invite[];
}

export interface AdminUserView {
  id: string;
  username: string;
  role: AdminRole;
  disabled: boolean;
  appAccount: string | null;
  createdAt: number;
  changedAt: number;
  lastLogin: number;
  totp: boolean;
  recoveryLeft: number;
}

export type LoginResult = "ok" | "code" | "bad";

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

const derive = (password: string, salt: string) =>
  new Promise<Buffer>((resolve, reject) => scrypt(password.normalize("NFKC"), Buffer.from(salt, "hex"), KEY_BYTES, SCRYPT, (e, key) => (e ? reject(e) : resolve(key))));

function base32Encode(bytes: Buffer) {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
    value &= (1 << bits) - 1;
  }
  return bits ? out + BASE32[(value << (5 - bits)) & 31] : out;
}

function base32Decode(text: string) {
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of text) {
    value = (value << 5) | BASE32.indexOf(char);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
    value &= (1 << bits) - 1;
  }
  return Buffer.from(out);
}

export function totpCode(secret: string, counter: number) {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac("sha1", base32Decode(secret)).update(message).digest();
  const offset = digest[19]! & 15;
  return String((digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, "0");
}

const view = (user: AdminUser): AdminUserView => ({
  id: user.id,
  username: user.username,
  role: user.role,
  disabled: !!user.disabled,
  appAccount: user.appAccount ?? null,
  createdAt: user.createdAt,
  changedAt: user.changedAt,
  lastLogin: user.lastLogin,
  totp: !!user.totp,
  recoveryLeft: user.recovery.length,
});

export class AdminAuth {
  private readonly file?: string;
  private memory: AuthFile = { users: [], invites: [] };
  /** Une empreinte factice : un identifiant inconnu coûte le même temps qu'un mauvais mot de passe. */
  private readonly decoy = randomBytes(16).toString("hex");
  private readonly pendingSecrets = new Map<string, string>();

  constructor(file?: string) {
    this.file = file;
    if (file) mkdirSync(path.dirname(file), { recursive: true });
  }

  /** Relu à chaque fois : la commande de secours écrit ce fichier pendant que le serveur tourne. */
  private read(): AuthFile {
    if (!this.file) return this.memory;
    try {
      return JSON.parse(readFileSync(this.file, "utf8")) as AuthFile;
    } catch {
      return { users: [], invites: [] };
    }
  }

  private write(data: AuthFile) {
    this.memory = data;
    if (!this.file) return;
    const temporary = `${this.file}.tmp`;
    writeFileSync(temporary, JSON.stringify(data), { mode: 0o600 });
    renameSync(temporary, this.file);
  }

  get state() {
    return { configured: this.read().users.length > 0 };
  }

  list() {
    return this.read().users.map(view);
  }

  invites(now = Date.now()) {
    return this.read()
      .invites.filter(invite => invite.expires > now)
      .map(({ id, expires, role, username, userId }) => ({ id, expires, role, username, reset: !!userId }));
  }

  user(id: string) {
    const user = this.read().users.find(u => u.id === id);
    return user && !user.disabled ? view(user) : null;
  }

  byAppAccount(accountId: string) {
    const user = this.read().users.find(u => u.appAccount === accountId && !u.disabled);
    return user ? view(user) : null;
  }

  /** Rend un code à usage unique, valable 24 heures : pour créer un accès, ou redonner un mot de passe à un accès existant. */
  invite(options: { role: AdminRole; username?: string; userId?: string; appAccount?: string }, now = Date.now()) {
    const code = randomBytes(24).toString("base64url");
    const data = this.read();
    // Un nouveau lien pour le même accès annule le précédent.
    const invites = data.invites.filter(i => i.expires > now && !(options.userId && i.userId === options.userId));
    invites.push({ id: randomBytes(6).toString("hex"), hash: sha256(code), expires: now + INVITE_MS, role: options.role, username: options.username ?? "", userId: options.userId ?? null, appAccount: options.appAccount ?? null });
    this.write({ ...data, invites });
    return code;
  }

  /** La porte de secours depuis le serveur : l'accès du propriétaire s'il existe, sinon le premier. */
  ownerInvite(appAccount?: string, now = Date.now()) {
    const owner = this.read().users.find(u => u.role === "owner");
    return owner ? this.invite({ role: "owner", username: owner.username, userId: owner.id }, now) : this.invite({ role: "owner", appAccount }, now);
  }

  cancelInvite(id: string) {
    const data = this.read();
    this.write({ ...data, invites: data.invites.filter(i => i.id !== id) });
  }

  inviteInfo(code: unknown, now = Date.now()) {
    if (typeof code !== "string") return null;
    const invite = this.read().invites.find(i => i.hash === sha256(code) && i.expires > now);
    return invite ? { username: invite.username, role: invite.role, reset: !!invite.userId } : null;
  }

  static passwordProblem(password: unknown) {
    if (typeof password !== "string" || password.length < MIN_PASSWORD) return `Choisis au moins ${MIN_PASSWORD} caractères.`;
    return password.length > MAX_PASSWORD ? "Ce mot de passe est trop long." : null;
  }

  /** Repartir d'un lien retire aussi le code à 6 chiffres : c'est précisément ce qu'on a pu perdre. */
  async completeInvite(code: unknown, username: unknown, password: unknown, now = Date.now()): Promise<{ problem: string | null; user: AdminUserView | null }> {
    const fail = (problem: string) => ({ problem, user: null });
    const data = this.read();
    const invite = typeof code === "string" ? data.invites.find(i => i.hash === sha256(code) && i.expires > now) : undefined;
    if (!invite) return fail("Ce lien n'est plus valable.");
    const name = invite.userId ? invite.username : typeof username === "string" ? username.trim() : "";
    if (name.length < 3 || name.length > 64) return fail("Choisis un identifiant d'au moins 3 caractères.");
    if (!invite.userId && data.users.some(u => u.username.toLowerCase() === name.toLowerCase())) return fail("Cet identifiant est déjà pris.");
    const problem = AdminAuth.passwordProblem(password);
    if (problem) return fail(problem);
    const salt = randomBytes(16).toString("hex");
    const hash = (await derive(password as string, salt)).toString("hex");
    const invites = data.invites.filter(i => i !== invite);
    const existing = invite.userId ? data.users.find(u => u.id === invite.userId) : undefined;
    if (invite.userId && !existing) return fail("Cet accès n'existe plus.");
    const user: AdminUser = existing ?? { id: randomBytes(9).toString("hex"), username: name, role: invite.role, salt, hash, createdAt: now, changedAt: now, lastLogin: 0, recovery: [], ...(invite.appAccount ? { appAccount: invite.appAccount } : {}) };
    if (existing) {
      Object.assign(existing, { salt, hash, changedAt: now, recovery: [] });
      delete existing.totp;
      delete existing.disabled;
    }
    this.write({ users: existing ? data.users : [...data.users, user], invites });
    return { problem: null, user: view(user) };
  }

  private async passwordMatches(user: AdminUser | undefined, password: unknown) {
    const given = typeof password === "string" ? password.slice(0, MAX_PASSWORD) : "";
    const key = await derive(given, user?.salt ?? this.decoy);
    return !!user && timingSafeEqual(key, Buffer.from(user.hash, "hex"));
  }

  private checkSecondFactor(data: AuthFile, user: AdminUser, code: string, now: number) {
    const clean = code.replace(/\s/g, "");
    const totp = user.totp!;
    const counter = Math.floor(now / 1000 / TOTP_STEP_S);
    for (let drift = -TOTP_DRIFT; drift <= TOTP_DRIFT; drift++) {
      const candidate = counter + drift;
      // Un code déjà utilisé ne ressert pas, même dans ses 30 secondes.
      if (candidate > totp.lastCounter && timingSafeEqual(Buffer.from(totpCode(totp.secret, candidate)), Buffer.from(clean.padEnd(6, " ").slice(0, 6)))) {
        totp.lastCounter = candidate;
        return true;
      }
    }
    const index = user.recovery.indexOf(sha256(clean.toUpperCase()));
    if (index < 0) return false;
    user.recovery.splice(index, 1);
    return true;
  }

  async login(username: unknown, password: unknown, code: unknown, now = Date.now()): Promise<{ result: LoginResult; user: AdminUserView | null }> {
    const data = this.read();
    const name = typeof username === "string" ? username.trim().toLowerCase() : "";
    const user = data.users.find(u => u.username.toLowerCase() === name);
    const matches = await this.passwordMatches(user, password);
    if (!matches || !user || user.disabled) return { result: "bad", user: null };
    if (user.totp) {
      if (typeof code !== "string" || !code.trim()) return { result: "code", user: null };
      if (!this.checkSecondFactor(data, user, code, now)) return { result: "bad", user: null };
    }
    user.lastLogin = now;
    this.write(data);
    return { result: "ok", user: view(user) };
  }

  async changePassword(userId: string, current: unknown, next: unknown) {
    const data = this.read();
    const user = data.users.find(u => u.id === userId);
    if (!(await this.passwordMatches(user, current))) return "Le mot de passe actuel est faux.";
    const problem = AdminAuth.passwordProblem(next);
    if (problem) return problem;
    const salt = randomBytes(16).toString("hex");
    Object.assign(user!, { salt, hash: (await derive(next as string, salt)).toString("hex"), changedAt: Date.now() });
    this.write(data);
    return null;
  }

  startTotp(userId: string) {
    const secret = base32Encode(randomBytes(20));
    this.pendingSecrets.set(userId, secret);
    const label = encodeURIComponent(`SpokaStream:${this.read().users.find(u => u.id === userId)?.username ?? "admin"}`);
    return { secret, uri: `otpauth://totp/${label}?secret=${secret}&issuer=SpokaStream&algorithm=SHA1&digits=6&period=${TOTP_STEP_S}` };
  }

  /** Le code n'est activé qu'une fois prouvé qu'il marche : sinon on s'enfermerait dehors. Rend les codes de secours, montrés une seule fois. */
  confirmTotp(userId: string, code: unknown, now = Date.now()) {
    const data = this.read();
    const user = data.users.find(u => u.id === userId);
    const secret = this.pendingSecrets.get(userId);
    if (!user || !secret || typeof code !== "string") return null;
    const counter = Math.floor(now / 1000 / TOTP_STEP_S);
    if (![-TOTP_DRIFT, 0, TOTP_DRIFT].some(drift => totpCode(secret, counter + drift) === code.trim())) return null;
    const recovery = Array.from({ length: RECOVERY_CODES }, () => randomBytes(5).toString("hex").toUpperCase());
    user.totp = { secret, lastCounter: counter };
    user.recovery = recovery.map(sha256);
    this.pendingSecrets.delete(userId);
    this.write(data);
    return recovery;
  }

  async disableTotp(userId: string, password: unknown) {
    const data = this.read();
    const user = data.users.find(u => u.id === userId);
    if (!(await this.passwordMatches(user, password))) return false;
    delete user!.totp;
    user!.recovery = [];
    this.write(data);
    return true;
  }

  /** Il reste toujours un propriétaire actif : sinon plus personne ne pourrait gérer les accès. */
  private lastOwner(data: AuthFile, user: AdminUser) {
    return user.role === "owner" && data.users.filter(u => u.role === "owner" && !u.disabled).length <= 1;
  }

  private change(id: string, apply: (data: AuthFile, user: AdminUser) => string | null) {
    const data = this.read();
    const user = data.users.find(u => u.id === id);
    if (!user) return "Cet accès n'existe plus.";
    const problem = apply(data, user);
    if (!problem) this.write(data);
    return problem;
  }

  setRole(id: string, role: AdminRole) {
    return this.change(id, (data, user) => {
      if (role !== "owner" && this.lastOwner(data, user)) return "Il faut garder au moins un propriétaire.";
      user.role = role;
      return null;
    });
  }

  setDisabled(id: string, disabled: boolean) {
    return this.change(id, (data, user) => {
      if (disabled && this.lastOwner(data, user)) return "Il faut garder au moins un propriétaire.";
      if (disabled) user.disabled = true;
      else delete user.disabled;
      return null;
    });
  }

  linkApp(id: string, appAccount: string) {
    return this.change(id, (_data, user) => {
      if (appAccount) user.appAccount = appAccount;
      else delete user.appAccount;
      return null;
    });
  }

  remove(id: string) {
    return this.change(id, (data, user) => {
      if (this.lastOwner(data, user)) return "Il faut garder au moins un propriétaire.";
      data.users = data.users.filter(u => u !== user);
      return null;
    });
  }
}
