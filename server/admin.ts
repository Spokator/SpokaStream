// Le panneau d'administration : ce que le serveur sait, et ce qu'on peut y faire, sans ouvrir une session SSH.
// On y entre avec un identifiant et un mot de passe, depuis n'importe quel navigateur. L'application ajoute un raccourci : un billet à usage unique.
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { statfsSync } from "node:fs";
import type http from "node:http";
import os from "node:os";
import tls from "node:tls";
import { AdminAuth, ROLE_RANK } from "./adminAuth.ts";
import type { AdminRole } from "./adminAuth.ts";
import type { Hub } from "./hub.ts";
import type { PushService } from "./push.ts";
import type { Store } from "./store.ts";
import { ADMIN_HTML, ADMIN_JS, APP_VERSION } from "./viewer.gen.ts";

const SESSION_MS = 12 * 3600_000;
const TICKET_MS = 60_000;
const SAMPLE_MS = 60_000;
const HISTORY_POINTS = 1440;
const SERVICE_CACHE_MS = 30_000;
const RELEASE_CACHE_MS = 10 * 60_000;
const CERT_CACHE_MS = 3600_000;
/** Après 5 échecs depuis une même adresse, plus aucun essai pendant 15 minutes : deviner un mot de passe devient sans espoir. */
const LOGIN_FAILURES = 5;
const LOGIN_WINDOW_MS = 15 * 60_000;
const BODY_BYTES = 8192;
const COOKIE = "spoka_admin";
const CSP = ["default-src 'none'", "script-src 'self'", "style-src 'unsafe-inline'", "img-src 'self' data:", "connect-src 'self'", "base-uri 'none'", "form-action 'none'", "frame-ancestors 'none'"].join("; ");

interface Session {
  /** null : ouverte depuis l'application par un compte de ADMIN_ACCOUNTS, sans accès du panneau. */
  userId: string | null;
  role: AdminRole;
  name: string;
  expires: number;
}

/** Le rang minimum de chaque action. C'est ici que les rôles existent : l'interface ne fait que masquer ce qui serait refusé. */
const ACTION_RANK: Record<string, number> = {
  stopStream: ROLE_RANK.moderator,
  kick: ROLE_RANK.moderator,
  lockRoom: ROLE_RANK.moderator,
  deleteReport: ROLE_RANK.moderator,
  ban: ROLE_RANK.moderator,
  message: ROLE_RANK.moderator,
  disconnect: ROLE_RANK.moderator,
  renameUser: ROLE_RANK.moderator,
  clearAvatar: ROLE_RANK.moderator,
  deleteRoom: ROLE_RANK.admin,
  renameRoom: ROLE_RANK.admin,
  transferRoom: ROLE_RANK.admin,
  clearBans: ROLE_RANK.admin,
  deleteUser: ROLE_RANK.admin,
  detachDevice: ROLE_RANK.admin,
  announce: ROLE_RANK.admin,
  maintenance: ROLE_RANK.admin,
  restart: ROLE_RANK.owner,
};

const isRole = (value: unknown): value is AdminRole => value === "owner" || value === "admin" || value === "moderator";

interface Sample {
  at: number;
  connections: number;
  streams: number;
  memoryMb: number;
}

export interface AdminOptions {
  hub: Hub;
  store: Store;
  push?: PushService;
  /** Dossier des données : c'est son disque qu'on surveille. */
  dataDir?: string;
  repository?: string;
  /** Sous systemd, quitter revient à redémarrer. Ailleurs, le bouton n'a pas de sens. */
  canRestart?: boolean;
  auth?: AdminAuth;
}

const json = (res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...headers });
  res.end(JSON.stringify(body));
};

function readBody(req: http.IncomingMessage) {
  return new Promise<Record<string, unknown>>((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > BODY_BYTES) {
        reject(new Error("trop long"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString() || "{}") as unknown;
        resolve(parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {});
      } catch {
        reject(new Error("illisible"));
      }
    });
    req.on("error", reject);
  });
}

const isActive = (service: string) =>
  new Promise<string>(resolve => {
    execFile("systemctl", ["is-active", service], { timeout: 3000 }, (_error, stdout) => resolve(stdout.trim() || "inconnu"));
  });

export class AdminPanel {
  private readonly options: AdminOptions;
  private readonly sessions = new Map<string, Session>();
  private readonly tickets = new Map<string, { accountId: string; expires: number }>();
  private readonly failures = new Map<string, { count: number; since: number }>();
  readonly auth: AdminAuth;
  private readonly history: Sample[] = [];
  private readonly sampler: NodeJS.Timeout;
  private services: { at: number; value: Record<string, string> } = { at: 0, value: {} };
  private release: { at: number; value: { tag: string; publishedAt: string; downloads: number } | null } = { at: 0, value: null };
  private certificate: { at: number; expires: string | null } = { at: 0, expires: null };

  constructor(options: AdminOptions) {
    this.options = options;
    this.auth = options.auth ?? new AdminAuth();
    options.hub.linkedAdmin = accountId => !!this.auth.byAppAccount(accountId);
    options.hub.onTicket = accountId => {
      const ticket = randomBytes(24).toString("base64url");
      this.tickets.set(ticket, { accountId, expires: Date.now() + TICKET_MS });
      return ticket;
    };
    this.sample();
    this.sampler = setInterval(() => this.sample(), SAMPLE_MS);
    this.sampler.unref();
  }

  close() {
    clearInterval(this.sampler);
  }

  private current(): Sample {
    const { connections, streams } = this.options.hub.stats;
    return { at: Date.now(), connections, streams, memoryMb: Math.round(process.memoryUsage().rss / 1_048_576) };
  }

  private sample() {
    this.history.push(this.current());
    if (this.history.length > HISTORY_POINTS) this.history.shift();
  }

  private session(req: http.IncomingMessage) {
    const id = String(req.headers.cookie ?? "").match(new RegExp(`(?:^|; )${COOKIE}=([\\w-]+)`))?.[1];
    const session = id ? this.sessions.get(id) : undefined;
    if (!id || !session) return null;
    if (session.expires < Date.now()) {
      this.sessions.delete(id);
      return null;
    }
    if (!session.userId) return { id, ...session };
    // Le rôle se relit à chaque requête : retirer un droit agit tout de suite, pas à la prochaine connexion.
    const user = this.auth.user(session.userId);
    if (!user) {
      this.sessions.delete(id);
      return null;
    }
    return { id, ...session, role: user.role, name: user.username };
  }

  private locked(ip: string) {
    const entry = this.failures.get(ip);
    if (!entry) return false;
    if (Date.now() - entry.since > LOGIN_WINDOW_MS) {
      this.failures.delete(ip);
      return false;
    }
    return entry.count >= LOGIN_FAILURES;
  }

  private failed(ip: string) {
    const entry = this.failures.get(ip);
    if (entry) entry.count++;
    else this.failures.set(ip, { count: 1, since: Date.now() });
    this.options.hub.log("warning", "admin", "Connexion refusée au panneau");
  }

  private open(req: http.IncomingMessage, res: http.ServerResponse, ip: string, who: Omit<Session, "expires">, how: string) {
    this.failures.delete(ip);
    const id = randomBytes(32).toString("base64url");
    this.sessions.set(id, { ...who, expires: Date.now() + SESSION_MS });
    this.options.hub.log("info", "admin", `${who.name} se connecte au panneau (${how})`);
    const secure = req.headers["x-forwarded-proto"] === "https" ? "; Secure" : "";
    json(res, 200, { ok: true }, { "set-cookie": `${COOKIE}=${id}; HttpOnly; SameSite=Strict; Path=/admin; Max-Age=${SESSION_MS / 1000}${secure}` });
  }

  private async login(req: http.IncomingMessage, res: http.ServerResponse, ip: string) {
    if (this.locked(ip)) return json(res, 429, { error: "Trop d'essais. Réessaie dans 15 minutes." });
    const body = await readBody(req).catch(() => ({}) as Record<string, unknown>);
    if (typeof body.ticket === "string") {
      const ticket = this.tickets.get(body.ticket);
      this.tickets.delete(body.ticket);
      if (ticket && ticket.expires > Date.now() && this.options.hub.isAdminAccount(ticket.accountId)) {
        const user = this.auth.byAppAccount(ticket.accountId);
        return this.open(req, res, ip, user ? { userId: user.id, role: user.role, name: user.username } : { userId: null, role: "owner", name: "Application" }, "application");
      }
      this.failed(ip);
      return json(res, 403, { error: "Ce lien n'est plus valable." });
    }
    const { result, user } = await this.auth.login(body.username, body.password, body.code);
    if (result === "ok" && user) return this.open(req, res, ip, { userId: user.id, role: user.role, name: user.username }, "mot de passe");
    if (result === "code") return json(res, 401, { needCode: true });
    this.failed(ip);
    json(res, 403, { error: "Identifiant, mot de passe ou code incorrect." });
  }

  private async setup(req: http.IncomingMessage, res: http.ServerResponse, ip: string) {
    if (this.locked(ip)) return json(res, 429, { error: "Trop d'essais. Réessaie dans 15 minutes." });
    const body = await readBody(req).catch(() => ({}) as Record<string, unknown>);
    const { problem, user } = await this.auth.completeInvite(body.code, body.username, body.password);
    if (!problem && user) {
      // Un mot de passe reposé coupe toutes les sessions de cet accès.
      for (const [id, session] of this.sessions) if (session.userId === user.id) this.sessions.delete(id);
      return this.open(req, res, ip, { userId: user.id, role: user.role, name: user.username }, "lien d'accès");
    }
    if (problem === "Ce lien n'est plus valable.") this.failed(ip);
    json(res, 400, { error: problem });
  }

  private async security(req: http.IncomingMessage, res: http.ServerResponse, name: string, session: Session & { id: string }) {
    const { auth } = this;
    const { hub } = this.options;
    const userId = session.userId;
    if (!userId) return json(res, 400, { error: "Connecte-toi avec ton identifiant pour changer ça." });
    const body = await readBody(req).catch(() => ({}) as Record<string, unknown>);
    if (name === "password") {
      const problem = await auth.changePassword(userId, body.current, body.next);
      if (problem) return json(res, 400, { error: problem });
      // Un mot de passe qui change coupe les autres sessions de cet accès : c'est souvent pour ça qu'on le change.
      for (const [id, other] of this.sessions) if (id !== session.id && other.userId === userId) this.sessions.delete(id);
      hub.log("warning", "admin", `${session.name} change son mot de passe`);
      return json(res, 200, { ok: true });
    }
    if (name === "totp/start") return json(res, 200, auth.startTotp(userId));
    if (name === "totp/confirm") {
      const recovery = auth.confirmTotp(userId, body.code);
      if (!recovery) return json(res, 400, { error: "Ce code ne correspond pas. Vérifie l'heure du téléphone." });
      hub.log("warning", "admin", `${session.name} active le code à 6 chiffres`);
      return json(res, 200, { recovery });
    }
    if (name === "totp/disable") {
      if (!(await auth.disableTotp(userId, body.password))) return json(res, 400, { error: "Le mot de passe est faux." });
      hub.log("warning", "admin", `${session.name} désactive le code à 6 chiffres`);
      return json(res, 200, { ok: true });
    }
    if (name === "sessions/revoke") {
      for (const [id, other] of this.sessions) if (id !== session.id && other.userId === userId) this.sessions.delete(id);
      return json(res, 200, { ok: true });
    }
    json(res, 404, { error: "Inconnu." });
  }

  /** Les accès au panneau : réservé au propriétaire. Un accès coupé perd ses sessions à la seconde. */
  private async manageAdmins(req: http.IncomingMessage, res: http.ServerResponse, name: string, session: Session & { id: string }) {
    const { auth } = this;
    const { hub } = this.options;
    const body = await readBody(req).catch(() => ({}) as Record<string, unknown>);
    const id = typeof body.id === "string" ? body.id : "";
    const target = auth.list().find(u => u.id === id);
    const answer = (problem: string | null, summary: string) => {
      if (problem) return json(res, 400, { error: problem });
      hub.log("warning", "admin", `${session.name} : ${summary}`);
      json(res, 200, { ok: true });
    };
    const closeSessions = () => {
      for (const [key, other] of this.sessions) if (other.userId === id) this.sessions.delete(key);
    };
    if (name === "invite") {
      if (!isRole(body.role)) return json(res, 400, { error: "Rôle inconnu." });
      const username = typeof body.username === "string" ? body.username.trim().slice(0, 64) : "";
      hub.log("warning", "admin", `${session.name} invite ${username || "un nouvel accès"} (${body.role})`);
      return json(res, 200, { code: auth.invite({ role: body.role, username }) });
    }
    if (name === "cancel") return answer((auth.cancelInvite(id), null), "annule une invitation");
    if (!target) return json(res, 404, { error: "Cet accès n'existe plus." });
    if (name === "reset") {
      hub.log("warning", "admin", `${session.name} crée un lien de mot de passe pour ${target.username}`);
      return json(res, 200, { code: auth.invite({ role: target.role, username: target.username, userId: target.id }) });
    }
    if (name === "role") {
      if (!isRole(body.role)) return json(res, 400, { error: "Rôle inconnu." });
      return answer(auth.setRole(id, body.role), `${target.username} devient ${body.role}`);
    }
    if (name === "app") return answer(auth.linkApp(id, typeof body.appAccount === "string" ? body.appAccount.trim().slice(0, 24) : ""), `change le compte d'application de ${target.username}`);
    if (id === session.userId) return json(res, 400, { error: "Tu ne peux pas faire ça sur ton propre accès." });
    if (name === "disable") {
      const problem = auth.setDisabled(id, body.disabled === true);
      if (!problem && body.disabled === true) closeSessions();
      return answer(problem, `${body.disabled === true ? "désactive" : "réactive"} ${target.username}`);
    }
    if (name === "remove") {
      const problem = auth.remove(id);
      if (!problem) closeSessions();
      return answer(problem, `supprime l'accès ${target.username}`);
    }
    json(res, 404, { error: "Inconnu." });
  }

  private async servicesNow() {
    if (Date.now() - this.services.at < SERVICE_CACHE_MS) return this.services.value;
    const names = ["spokastream-server", "nginx", "coturn"];
    const states = await Promise.all(names.map(isActive));
    this.services = { at: Date.now(), value: Object.fromEntries(names.map((name, i) => [name, states[i]!])) };
    return this.services.value;
  }

  private async releaseNow() {
    if (Date.now() - this.release.at < RELEASE_CACHE_MS) return this.release.value;
    this.release.at = Date.now();
    const repository = this.options.repository ?? "Spokator/SpokaStream";
    const response = await fetch(`https://api.github.com/repos/${repository}/releases?per_page=30`, { headers: { accept: "application/vnd.github+json", "user-agent": "SpokaStream" }, signal: AbortSignal.timeout(6000) }).catch(() => null);
    if (!response?.ok) return this.release.value;
    const releases = (await response.json().catch(() => [])) as { tag_name: string; published_at: string; assets: { name: string; download_count: number }[] }[];
    const installers = (r: (typeof releases)[number]) => r.assets.filter(a => a.name.endsWith(".exe")).reduce((sum, a) => sum + a.download_count, 0);
    if (releases[0]) this.release.value = { tag: releases[0].tag_name, publishedAt: releases[0].published_at, downloads: releases.reduce((sum, r) => sum + installers(r), 0) };
    return this.release.value;
  }

  private certificateNow(host: string) {
    if (Date.now() - this.certificate.at < CERT_CACHE_MS || /^(localhost|127\.|\[)/.test(host)) return Promise.resolve(this.certificate.expires);
    this.certificate.at = Date.now();
    return new Promise<string | null>(resolve => {
      const socket = tls.connect({ host, port: 443, servername: host, timeout: 4000 }, () => {
        this.certificate.expires = socket.getPeerCertificate().valid_to ?? null;
        socket.end();
        resolve(this.certificate.expires);
      });
      socket.on("error", () => resolve(this.certificate.expires));
      socket.on("timeout", () => {
        socket.destroy();
        resolve(this.certificate.expires);
      });
    });
  }

  private disk() {
    try {
      const stats = statfsSync(this.options.dataDir ?? ".");
      return { totalGb: Math.round((stats.blocks * stats.bsize) / 1e9), freeGb: Math.round((stats.bavail * stats.bsize) / 1e9) };
    } catch {
      return null;
    }
  }

  private async overview(host: string) {
    const { hub, push } = this.options;
    const rooms = hub.adminRooms();
    return {
      version: APP_VERSION,
      uptime: Math.round(process.uptime()),
      stats: hub.stats,
      viewers: rooms.flatMap(r => r.streams).reduce((sum, s) => sum + s.viewers, 0),
      parties: rooms.filter(r => r.party).length,
      accounts: hub.accounts.list().length,
      pushSubscriptions: push?.count ?? 0,
      versions: hub.adminVersions(),
      maintenance: hub.maintenance,
      canRestart: !!this.options.canRestart,
      system: { load: os.loadavg()[0], cpus: os.cpus().length, memTotalMb: Math.round(os.totalmem() / 1_048_576), memFreeMb: Math.round(os.freemem() / 1_048_576), processMb: Math.round(process.memoryUsage().rss / 1_048_576), uptime: Math.round(os.uptime()), disk: this.disk() },
      services: await this.servicesNow(),
      certificate: await this.certificateNow(host),
      release: await this.releaseNow(),
      // Le dernier point est toujours l'instant présent : la courbe finit sur le chiffre affiché au-dessus.
      history: [...this.history, this.current()],
      errors: hub.logs.filter(l => l.level === "error").length,
      reports: hub.reports.length,
    };
  }

  private act(body: Record<string, unknown>, session: Session) {
    const { hub } = this.options;
    const action = String(body.action ?? "");
    const need = ACTION_RANK[action];
    if (!need) return "unknown";
    if (ROLE_RANK[session.role] < need) return "forbidden";
    const text = (key: string, max: number) => String(body[key] ?? "").trim().slice(0, max);
    const id = (key: string) => text(key, 64);
    const account = () => hub.accounts.list().find(a => a.id === id("accountId"))?.name ?? "?";
    const audit = (what: string) => hub.log("info", "admin", `${session.name} : ${what}`);
    switch (action) {
      case "announce":
        if (!text("text", 300)) return false;
        hub.announce(text("text", 300), body.level === "warning" ? "warning" : "info");
        return true;
      case "maintenance":
        hub.maintenance = text("text", 300);
        hub.log("warning", "admin", hub.maintenance ? `${session.name} : maintenance, ${hub.maintenance}` : `${session.name} : fin de la maintenance`);
        if (hub.maintenance) hub.announce(hub.maintenance, "warning");
        return true;
      case "stopStream":
        audit("arrête un stream");
        return hub.adminStopStream(id("roomId"), id("ownerId"));
      case "kick":
        audit("retire quelqu'un d'un salon");
        return hub.adminKick(id("roomId"), id("userId"));
      case "lockRoom":
        audit(body.locked === true ? "verrouille un salon" : "déverrouille un salon");
        return hub.adminLockRoom(id("roomId"), body.locked === true);
      case "deleteRoom":
        audit("supprime un salon");
        return hub.adminDeleteRoom(id("roomId"));
      case "renameRoom":
        audit(`renomme un salon en « ${text("name", 48)} »`);
        return hub.adminRenameRoom(id("roomId"), text("name", 48));
      case "transferRoom":
        audit(`donne un salon à ${account()}`);
        return hub.adminTransferRoom(id("roomId"), id("accountId"));
      case "clearBans":
        audit("lève les bannissements d'un salon");
        return hub.adminClearBans(id("roomId"));
      case "ban":
        audit(`${body.banned === true ? "bannit" : "débannit"} ${account()}`);
        return hub.adminBan(id("accountId"), body.banned === true, text("reason", 200));
      case "message":
        if (!text("text", 300)) return false;
        audit(`écrit à ${account()}`);
        return hub.adminMessage(id("accountId"), text("text", 300));
      case "disconnect":
        audit(`déconnecte ${account()}`);
        return hub.adminDisconnect(id("accountId"));
      case "renameUser":
        if (!text("name", 32)) return false;
        audit(`renomme ${account()} en ${text("name", 32)}`);
        return hub.adminProfile(id("accountId"), { name: text("name", 32) });
      case "clearAvatar":
        audit(`retire la photo de ${account()}`);
        return hub.adminProfile(id("accountId"), { avatar: null });
      case "detachDevice":
        audit(`détache un appareil de ${account()}`);
        return hub.adminDetachDevice(id("accountId"), id("deviceId"));
      case "deleteUser":
        audit(`supprime le compte ${account()}`);
        return hub.adminDeleteAccount(id("accountId"), body.rooms === true);
      case "deleteReport": {
        const index = hub.reports.findIndex(r => r.id === id("id"));
        if (index >= 0) hub.reports.splice(index, 1);
        return index >= 0;
      }
      case "restart":
        if (!this.options.canRestart) return false;
        hub.log("warning", "admin", `${session.name} redémarre le serveur`);
        setTimeout(() => process.emit("SIGTERM"), 300);
        return true;
      default:
        return false;
    }
  }

  /** Rend false si l'adresse n'est pas celle du panneau. */
  handle(req: http.IncomingMessage, res: http.ServerResponse, url: URL, ip: string) {
    if (url.pathname === "/admin" || url.pathname === "/admin/") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-security-policy": CSP, "cache-control": "no-cache", "referrer-policy": "no-referrer", "x-frame-options": "DENY" });
      res.end(ADMIN_HTML);
      return true;
    }
    if (url.pathname === "/admin/app.js") {
      res.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-cache" });
      res.end(ADMIN_JS);
      return true;
    }
    if (!url.pathname.startsWith("/admin/api/")) return false;
    void this.route(req, res, url, ip).catch(e => {
      this.options.hub.log("error", "admin", String(e).slice(0, 300));
      if (!res.headersSent) json(res, 500, { error: "Erreur du serveur." });
    });
    return true;
  }

  private async route(req: http.IncomingMessage, res: http.ServerResponse, url: URL, ip: string) {
    const name = url.pathname.slice("/admin/api/".length);
    if (req.method === "POST") {
      // Le cookie est déjà réservé à ce site : on refuse en plus toute requête venue d'une autre origine.
      const origin = req.headers.origin;
      if (origin && new URL(origin).host !== req.headers.host) return json(res, 403, { error: "Origine refusée." });
      if (!String(req.headers["content-type"] ?? "").startsWith("application/json")) return json(res, 415, { error: "JSON attendu." });
    }
    if (name === "auth" && req.method === "GET") return json(res, 200, this.auth.state);
    if (name === "login" && req.method === "POST") return this.login(req, res, ip);
    if (name === "setup" && req.method === "POST") return this.setup(req, res, ip);
    if (name === "invite" && req.method === "POST") {
      const info = this.auth.inviteInfo((await readBody(req).catch(() => ({}) as Record<string, unknown>)).code);
      return info ? json(res, 200, info) : json(res, 404, { error: "Ce lien n'est plus valable." });
    }
    const session = this.session(req);
    if (!session) return json(res, 401, { error: "Connexion requise." });
    const { hub, store } = this.options;
    if (req.method === "GET") {
      if (name === "overview") return json(res, 200, await this.overview(String(req.headers.host ?? "").split(":")[0]!));
      if (name === "rooms") return json(res, 200, hub.adminRooms());
      if (name === "users") return json(res, 200, hub.adminUsers());
      if (name === "logs") return json(res, 200, hub.logs.slice(0, 500));
      if (name === "reports") return json(res, 200, hub.reports);
      if (name === "me") return json(res, 200, { name: session.name, role: session.role, hasLogin: !!session.userId });
      if (name === "security") {
        const user = session.userId ? this.auth.user(session.userId) : null;
        return json(res, 200, user ? { ...user, sessions: [...this.sessions.values()].filter(s => s.userId === user.id).length } : null);
      }
      if (name === "admins") {
        if (session.role !== "owner") return json(res, 403, { error: "Réservé au propriétaire." });
        return json(res, 200, { users: this.auth.list(), invites: this.auth.invites(), self: session.userId });
      }
      if (name === "backup" && session.role !== "owner") return json(res, 403, { error: "Réservé au propriétaire." });
      if (name === "backup") return json(res, 200, { at: new Date().toISOString(), version: APP_VERSION, rooms: store.load(), accounts: hub.accounts.list() }, { "content-disposition": `attachment; filename="spokastream-${new Date().toISOString().slice(0, 10)}.json"` });
    }
    if (req.method === "POST" && name === "logout") {
      this.sessions.delete(session.id);
      return json(res, 200, { ok: true }, { "set-cookie": `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/admin; Max-Age=0` });
    }
    if (req.method === "POST" && /^(password|totp\/\w+|sessions\/revoke)$/.test(name)) return this.security(req, res, name, session);
    if (req.method === "POST" && name.startsWith("admins/")) {
      if (session.role !== "owner") return json(res, 403, { error: "Réservé au propriétaire." });
      return this.manageAdmins(req, res, name.slice("admins/".length), session);
    }
    if (req.method === "POST" && name === "action") {
      const done = this.act(await readBody(req), session);
      if (done === "forbidden") return json(res, 403, { error: "Ton rôle ne permet pas cette action." });
      return json(res, done === true ? 200 : 400, { ok: done === true, ...(done === true ? {} : { error: "Action impossible." }) });
    }
    json(res, 404, { error: "Inconnu." });
  }
}
