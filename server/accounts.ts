// Un compte réunit plusieurs appareils : le PC reste l'identité de départ, un téléphone s'y rattache avec un code à usage unique.
// Il n'y a toujours ni mot de passe ni adresse e-mail : chaque appareil garde son jeton, et le serveur n'en connaît que l'empreinte.
import { randomInt } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Profile } from "../src/shared/protocol.ts";

const LINK_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const LINK_LENGTH = 8;
const LINK_TTL_MS = 5 * 60_000;
const MAX_DEVICES = 8;
const SAVE_DELAY_MS = 2000;

export interface DeviceRecord {
  accountId: string;
  label: string;
  client: "app" | "web";
  version: string;
  addedAt: number;
  lastSeen: number;
}

export interface AccountRecord extends Profile {
  id: string;
  firstSeen: number;
  lastSeen: number;
  banned?: boolean;
  banReason?: string;
}

interface AccountsData {
  accounts: Record<string, AccountRecord>;
  devices: Record<string, DeviceRecord>;
}

export class Accounts {
  private data: AccountsData = { accounts: {}, devices: {} };
  private readonly links = new Map<string, { accountId: string; expires: number }>();
  private readonly file?: string;
  private timer: NodeJS.Timeout | null = null;

  constructor(file?: string) {
    this.file = file;
    if (!file) return;
    mkdirSync(path.dirname(file), { recursive: true });
    try {
      this.data = JSON.parse(readFileSync(file, "utf8")) as AccountsData;
    } catch {
      // Premier démarrage : chaque appareil connu est encore son propre compte.
    }
  }

  private save() {
    if (!this.file || this.timer) return;
    this.timer = setTimeout(() => this.flush(), SAVE_DELAY_MS);
    this.timer.unref?.();
  }

  flush() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (!this.file) return;
    const temporary = `${this.file}.tmp`;
    writeFileSync(temporary, JSON.stringify(this.data), { mode: 0o600 });
    renameSync(temporary, this.file);
  }

  accountOf(deviceId: string) {
    return this.data.devices[deviceId]?.accountId ?? deviceId;
  }

  isBanned(accountId: string) {
    return !!this.data.accounts[accountId]?.banned;
  }

  /** Un appareil rattaché reprend le profil du compte : c'est ce qui fait qu'on est la même personne partout. */
  seen(deviceId: string, profile: Profile, meta: { client: "app" | "web"; version: string; label: string }, now: number): { accountId: string; profile: Profile } {
    const accountId = this.accountOf(deviceId);
    const device = this.data.devices[deviceId];
    this.data.devices[deviceId] = { accountId, addedAt: device?.addedAt ?? now, ...meta, lastSeen: now };
    const account = this.data.accounts[accountId];
    const linked = accountId !== deviceId;
    this.data.accounts[accountId] = linked && account ? { ...account, lastSeen: now } : { ...profile, id: accountId, firstSeen: account?.firstSeen ?? now, lastSeen: now, ...(account?.banned ? { banned: true } : {}) };
    this.save();
    const stored = this.data.accounts[accountId]!;
    return { accountId, profile: { name: stored.name, color: stored.color, avatar: stored.avatar } };
  }

  setProfile(accountId: string, profile: Profile) {
    const account = this.data.accounts[accountId];
    if (!account) return;
    Object.assign(account, profile);
    this.save();
  }

  createLink(accountId: string, now: number) {
    for (const [code, link] of this.links) if (link.expires < now || link.accountId === accountId) this.links.delete(code);
    let code = "";
    for (let i = 0; i < LINK_LENGTH; i++) code += LINK_ALPHABET[randomInt(LINK_ALPHABET.length)];
    this.links.set(code, { accountId, expires: now + LINK_TTL_MS });
    return { code, expires: now + LINK_TTL_MS };
  }

  /** Rend le compte rejoint, ou null : code faux, expiré, déjà utilisé, ou trop d'appareils. */
  claim(rawCode: string, deviceId: string, now: number) {
    const code = rawCode.toUpperCase().replace(/[^A-Z0-9]/g, "");
    const link = this.links.get(code);
    if (!link || link.expires < now) return null;
    if (link.accountId === this.accountOf(deviceId)) return null;
    if (this.devicesOf(link.accountId).length >= MAX_DEVICES) return null;
    this.links.delete(code);
    const device = this.data.devices[deviceId];
    if (device) device.accountId = link.accountId;
    else this.data.devices[deviceId] = { accountId: link.accountId, label: "", client: "web", version: "", addedAt: now, lastSeen: now };
    this.data.devices[deviceId]!.addedAt = now;
    if (deviceId !== link.accountId) delete this.data.accounts[deviceId];
    this.save();
    return link.accountId;
  }

  devicesOf(accountId: string) {
    return Object.entries(this.data.devices)
      .filter(([, device]) => device.accountId === accountId)
      .map(([id, device]) => ({ id, ...device }));
  }

  /** Détache un appareil : il redevient son propre compte, et perd tout droit sur celui-ci. */
  revoke(accountId: string, deviceId: string) {
    const device = this.data.devices[deviceId];
    if (!device || device.accountId !== accountId || deviceId === accountId) return false;
    device.accountId = deviceId;
    this.save();
    return true;
  }

  setBanned(accountId: string, banned: boolean, reason = "") {
    const account = this.data.accounts[accountId];
    if (!account) return false;
    if (banned) {
      account.banned = true;
      account.banReason = reason;
    } else {
      delete account.banned;
      delete account.banReason;
    }
    this.save();
    return true;
  }

  profileOf(accountId: string): Profile | null {
    const account = this.data.accounts[accountId];
    return account ? { name: account.name, color: account.color, avatar: account.avatar } : null;
  }

  /** Efface le compte et ses appareils. Un appareil qui revient repart de zéro : pour l'en empêcher, il faut bannir. */
  remove(accountId: string) {
    if (!this.data.accounts[accountId]) return false;
    delete this.data.accounts[accountId];
    for (const [id, device] of Object.entries(this.data.devices)) if (device.accountId === accountId) delete this.data.devices[id];
    this.save();
    return true;
  }

  list() {
    return Object.values(this.data.accounts).map(({ avatar: _avatar, ...account }) => ({ ...account, devices: this.devicesOf(account.id) }));
  }
}
