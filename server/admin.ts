// Le panneau d'administration : ce que le serveur sait, et ce qu'on peut y faire, sans ouvrir une session SSH.
// On y entre avec un identifiant et un mot de passe, depuis n'importe quel navigateur. L'application ajoute un raccourci : un billet à usage unique.
import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { readdirSync, statfsSync, statSync } from "node:fs";
import type http from "node:http";
import os from "node:os";
import path from "node:path";
import tls from "node:tls";
import { AdminAuth, ROLE_RANK } from "./adminAuth.ts";
import type { AdminRole } from "./adminAuth.ts";
import { Alerts, RULES, validWebhook } from "./alerts.ts";
import { Backups } from "./backups.ts";
import { ConfigStore } from "./config.ts";
import type { Hub } from "./hub.ts";
import { logsCsv } from "./journal.ts";
import type { Metrics } from "./metrics.ts";
import type { PushService } from "./push.ts";
import type { Store } from "./store.ts";
import type { Bandwidth } from "./bandwidth.ts";
import type { Usage } from "./usage.ts";
import { cleanLimits } from "./accounts.ts";
import { ADMIN_HTML, ADMIN_ICON_192, ADMIN_ICON_512, ADMIN_JS, APP_VERSION } from "./viewer.gen.ts";

const SESSION_MS = 12 * 3600_000;
const TICKET_MS = 60_000;
const SAMPLE_MS = 10_000;
/** Toutes les 6 mesures : ce qui n'a pas besoin de tourner plus d'une fois par minute. */
const MINUTE_TICKS = 6;
const BACKUP_EVERY_MS = 24 * 3600_000;
const PLAN_NOTICES = [600, 300, 60];
const SERVICE_CACHE_MS = 30_000;
const RELEASE_CACHE_MS = 10 * 60_000;
const CERT_CACHE_MS = 3600_000;
/** Après 5 échecs depuis une même adresse, plus aucun essai pendant 15 minutes : deviner un mot de passe devient sans espoir. */
const LOGIN_FAILURES = 5;
const LOGIN_WINDOW_MS = 15 * 60_000;
const BODY_BYTES = 32_768;
const COOKIE = "spoka_admin";
const CSP = ["default-src 'none'", "script-src 'self'", "style-src 'unsafe-inline'", "img-src 'self' data:", "connect-src 'self'", "manifest-src 'self'", "worker-src 'self'", "base-uri 'none'", "form-action 'none'", "frame-ancestors 'none'"].join("; ");
/** Le panneau s'installe à part du site : sa propre icône, son propre nom, et il ne garde rien hors ligne. */
const MANIFEST = JSON.stringify({
  id: "/admin",
  name: "SpokaStream Administration",
  short_name: "Spoka Admin",
  description: "Surveiller et gérer le serveur SpokaStream.",
  lang: "fr",
  start_url: "/admin",
  scope: "/admin",
  display: "standalone",
  orientation: "any",
  background_color: "#0b0d14",
  theme_color: "#0b0d14",
  icons: [
    { src: "/admin/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any maskable" },
    { src: "/admin/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any maskable" },
  ],
});
const SERVICE_WORKER = `self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", event => event.waitUntil(self.clients.claim()));
`;

interface Session {
  /** null : ouverte depuis l'application par un compte de ADMIN_ACCOUNTS, sans accès du panneau. */
  userId: string | null;
  role: AdminRole;
  name: string;
  expires: number;
  ip: string;
  agent: string;
  createdAt: number;
  seenAt: number;
}

type Who = Pick<Session, "userId" | "role" | "name">;

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
  mute: ROLE_RANK.moderator,
  setLimits: ROLE_RANK.admin,
  warn: ROLE_RANK.moderator,
  addNote: ROLE_RANK.moderator,
  removeNote: ROLE_RANK.moderator,
  deleteMessage: ROLE_RANK.moderator,
  roomSay: ROLE_RANK.moderator,
  closePoll: ROLE_RANK.moderator,
  stopParty: ROLE_RANK.moderator,
  stopAll: ROLE_RANK.moderator,
  deleteRoom: ROLE_RANK.admin,
  clearChat: ROLE_RANK.admin,
  roomSettings: ROLE_RANK.admin,
  blockIp: ROLE_RANK.admin,
  unblockIp: ROLE_RANK.admin,
  setConfig: ROLE_RANK.admin,
  setPlan: ROLE_RANK.admin,
  setRule: ROLE_RANK.admin,
  renameRoom: ROLE_RANK.admin,
  transferRoom: ROLE_RANK.admin,
  clearBans: ROLE_RANK.admin,
  deleteUser: ROLE_RANK.admin,
  detachDevice: ROLE_RANK.admin,
  announce: ROLE_RANK.admin,
  maintenance: ROLE_RANK.admin,
  restart: ROLE_RANK.owner,
  restartIdle: ROLE_RANK.owner,
  setDiscord: ROLE_RANK.owner,
  testDiscord: ROLE_RANK.owner,
  backupCreate: ROLE_RANK.owner,
  backupRestore: ROLE_RANK.owner,
  backupDelete: ROLE_RANK.owner,
};

const isRole = (value: unknown): value is AdminRole => value === "owner" || value === "admin" || value === "moderator";

const parseServices = (text: string) => {
  const services: Record<string, { state: string; since: string; restarts: number }> = {};
  for (const block of text.split("\n\n")) {
    const fields = Object.fromEntries(block.split("\n").map(line => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]));
    if (fields.Id) services[String(fields.Id).replace(/\.service$/, "")] = { state: fields.ActiveState || "inconnu", since: fields.ActiveEnterTimestamp ?? "", restarts: Number(fields.NRestarts) || 0 };
  }
  return services;
};

export interface AdminOptions {
  hub: Hub;
  store: Store;
  metrics: Metrics;
  usage: Usage;
  bandwidth?: Bandwidth;
  config: ConfigStore;
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

const SERVICES = ["spokastream-server", "nginx", "coturn"];

const readServices = () =>
  new Promise<string>(resolve => {
    execFile("systemctl", ["show", ...SERVICES, "--property=Id,ActiveState,NRestarts,ActiveEnterTimestamp"], { timeout: 3000 }, (_error, stdout) => resolve(stdout));
  });

export class AdminPanel {
  private readonly options: AdminOptions;
  private readonly sessions = new Map<string, Session>();
  private readonly tickets = new Map<string, { accountId: string; expires: number }>();
  private readonly failures = new Map<string, { count: number; since: number }>();
  readonly auth: AdminAuth;
  private readonly sampler: NodeJS.Timeout;
  private readonly alerts: Alerts;
  private readonly backups: Backups | null;
  private ticks = 0;
  /** Le serveur redémarre de lui-même dès que plus personne ne diffuse. */
  private restartIdle = false;
  private readonly planNotified = new Set<number>();
  private readonly chatReads = new Map<string, number>();
  private services: { at: number; value: Record<string, { state: string; since: string; restarts: number }> } = { at: 0, value: {} };
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
    this.backups = options.dataDir ? new Backups(options.dataDir) : null;
    this.alerts = new Alerts({ rules: () => options.config.value.rules, notify: text => void this.notify(text), file: options.dataDir && path.join(options.dataDir, "alerts.json") });
    const host = options.config.value.publicHost;
    if (host) options.metrics.setProbeUrl(`https://${host}/health`);
    options.metrics.sample();
    this.sampler = setInterval(() => void this.tick().catch(e => options.hub.log("error", "serveur", `Mesure : ${String(e).slice(0, 200)}`)), SAMPLE_MS);
    this.sampler.unref();
  }

  close() {
    clearInterval(this.sampler);
    this.options.metrics.save(true);
    this.options.metrics.close();
    this.options.usage.flush();
    this.options.bandwidth?.flush();
  }

  private flushAll() {
    const { hub, store, usage, bandwidth } = this.options;
    hub.accounts.flush();
    store.flush();
    usage.flush();
    bandwidth?.flush();
  }

  private async tick() {
    const { metrics, hub } = this.options;
    metrics.sample();
    this.followPlan();
    if (++this.ticks % MINUTE_TICKS) return;
    hub.tickUsage();
    await metrics.probe();
    await this.checkAlerts();
    if (this.backups && Date.now() - this.backups.lastAutoAt >= BACKUP_EVERY_MS) {
      this.flushAll();
      this.backups.create("Automatique", true);
    }
  }

  /** La maintenance prévue et le redémarrage différé tournent ici : personne n'a besoin de rester devant le panneau. */
  private followPlan() {
    const { hub, config } = this.options;
    const { plan } = config.value;
    if (plan) {
      const left = (plan.at - Date.now()) / 1000;
      for (const notice of PLAN_NOTICES) {
        if (left > notice || left <= 0 || this.planNotified.has(notice)) continue;
        this.planNotified.add(notice);
        hub.announce(`Maintenance dans ${Math.ceil(notice / 60)} minute${notice > 60 ? "s" : ""} : ${plan.text}`, "warning");
      }
      if (left <= 0) {
        hub.maintenance = plan.text;
        hub.log("warning", "admin", `Maintenance prévue : ${plan.text}`);
        hub.announce(plan.text, "warning");
        if (plan.restart) this.restartIdle = true;
        this.planNotified.clear();
        config.update({ plan: null });
      }
    }
    if (this.restartIdle && this.options.canRestart && hub.stats.streams === 0) {
      this.restartIdle = false;
      hub.log("warning", "admin", "Redémarrage : plus personne ne diffuse");
      setTimeout(() => process.emit("SIGTERM"), 300);
    }
  }

  private async checkAlerts() {
    const { metrics, hub } = this.options;
    const disk = this.disk();
    const { limits } = metrics.services();
    const memMb = metrics.latest.procMb ?? null;
    const failed = (value: boolean | null) => (value === null ? null : value ? 1 : 0);
    const since = Date.now() - 5 * 60_000;
    const certificate = await this.certificateNow(this.options.config.value.publicHost);
    this.alerts.check({
      point: { ...metrics.latest, stunFailed: failed(metrics.probeFailed.stun), httpsFailed: failed(metrics.probeFailed.https) },
      services: await this.servicesNow(),
      certificateDays: certificate ? Math.round((Date.parse(certificate) - Date.now()) / 86_400_000) : null,
      diskPct: disk?.usedPct ?? null,
      errors5min: hub.logs.filter(l => l.level === "error" && l.at >= since).length,
      memMaxPct: limits.memMaxMb && memMb ? Math.round((memMb / limits.memMaxMb) * 100) : null,
      throttledPct: limits.throttledPct,
      ...hub.relayLoad(),
    });
  }

  private async notify(text: string) {
    const url = this.options.config.value.discord;
    if (!validWebhook(url)) return false;
    const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "SpokaStream", content: text.slice(0, 1900), allowed_mentions: { parse: [] } }), signal: AbortSignal.timeout(6000) }).catch(() => null);
    return !!response?.ok;
  }

  private session(req: http.IncomingMessage) {
    const id = String(req.headers.cookie ?? "").match(new RegExp(`(?:^|; )${COOKIE}=([\\w-]+)`))?.[1];
    const session = id ? this.sessions.get(id) : undefined;
    if (!id || !session) return null;
    if (session.expires < Date.now()) {
      this.sessions.delete(id);
      return null;
    }
    session.seenAt = Date.now();
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
    this.options.hub.log("warning", "admin", `Connexion refusée au panneau depuis ${ip}`);
  }

  private open(req: http.IncomingMessage, res: http.ServerResponse, ip: string, who: Who, how: string) {
    this.failures.delete(ip);
    const id = randomBytes(32).toString("base64url");
    const now = Date.now();
    this.sessions.set(id, { ...who, expires: now + SESSION_MS, ip, agent: String(req.headers["user-agent"] ?? "").slice(0, 160), createdAt: now, seenAt: now });
    this.options.hub.log("info", "admin", `${who.name} se connecte au panneau (${how}) depuis ${ip}`);
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
    const found = parseServices(await readServices());
    this.services = { at: Date.now(), value: Object.fromEntries(SERVICES.map(name => [name, found[name] ?? { state: "inconnu", since: "", restarts: 0 }])) };
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
    if (!host || Date.now() - this.certificate.at < CERT_CACHE_MS || /^(localhost|127\.|\[)/.test(host)) return Promise.resolve(this.certificate.expires);
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
      return { totalGb: Math.round((stats.blocks * stats.bsize) / 1e9), freeGb: Math.round((stats.bavail * stats.bsize) / 1e9), usedPct: Math.round((1 - stats.bavail / stats.blocks) * 100) };
    } catch {
      return null;
    }
  }

  /** Ce que pèsent les données de SpokaStream elles-mêmes. */
  private dataFiles() {
    const { dataDir } = this.options;
    if (!dataDir) return [];
    try {
      return readdirSync(dataDir, { withFileTypes: true })
        .filter(entry => entry.isFile() && !entry.name.endsWith(".tmp"))
        .map(entry => ({ name: entry.name, bytes: statSync(path.join(dataDir, entry.name)).size }))
        .sort((a, b) => b.bytes - a.bytes);
    } catch {
      return [];
    }
  }

  private async overview(host: string) {
    const { hub, push, metrics } = this.options;
    const rooms = hub.adminRooms();
    const certificate = await this.certificateNow(host);
    const services = await this.servicesNow();
    const { rows, limits } = metrics.services();
    const active = this.alerts.active;
    return {
      point: metrics.latest,
      limits,
      alerts: active,
      serviceRows: rows.slice(0, 6),
      dataFiles: this.dataFiles(),
      restartIdle: this.restartIdle,
      plan: this.options.config.value.plan,
      version: APP_VERSION,
      uptime: Math.round(process.uptime()),
      stats: hub.stats,
      viewers: hub.stats.viewers,
      parties: rooms.filter(r => r.party).length,
      accounts: hub.accounts.list().length,
      pushSubscriptions: push?.count ?? 0,
      versions: hub.adminVersions(),
      maintenance: hub.maintenance,
      canRestart: !!this.options.canRestart,
      system: { load: os.loadavg()[0], cpus: os.cpus().length, memTotalMb: Math.round(os.totalmem() / 1_048_576), memFreeMb: Math.round(os.freemem() / 1_048_576), processMb: Math.round(process.memoryUsage().rss / 1_048_576), uptime: Math.round(os.uptime()), disk: this.disk() },
      services,
      certificate,
      release: await this.releaseNow(),
      errors: hub.logs.filter(l => l.level === "error" && l.at >= Date.now() - 24 * 3600_000).length,
      reports: hub.reports.length,
    };
  }

  /** Seuls ces réglages passent : un champ inconnu est ignoré, et chaque valeur est bornée ici, pas dans la page. */
  private setConfig(body: Record<string, unknown>, session: Who) {
    const { hub, config } = this.options;
    const patch = (body.patch ?? {}) as Record<string, unknown>;
    const whole = (key: string, min: number, max: number) => Math.max(min, Math.min(max, Math.round(Number(patch[key])) || 0));
    const next: Partial<typeof config.value> = {};
    if (typeof patch.closed === "boolean") next.closed = patch.closed;
    if (typeof patch.webViewers === "boolean") next.webViewers = patch.webViewers;
    if (typeof patch.watchParty === "boolean") next.watchParty = patch.watchParty;
    if (patch.roomCreation === "everyone" || patch.roomCreation === "admins") next.roomCreation = patch.roomCreation;
    if (patch.maxMembers !== undefined) next.maxMembers = whole("maxMembers", 2, 32);
    if (patch.maxRooms !== undefined) next.maxRooms = whole("maxRooms", 1, 50);
    if (patch.slowSeconds !== undefined) next.slowSeconds = whole("slowSeconds", 0, 300);
    if (typeof patch.motd === "string") next.motd = patch.motd.trim().slice(0, 300);
    if (typeof patch.minVersion === "string") next.minVersion = /^\d+(\.\d+){0,2}$/.test(patch.minVersion.trim()) ? patch.minVersion.trim() : "";
    if (patch.defaultLimits !== undefined) next.defaultLimits = patch.defaultLimits ? cleanLimits(patch.defaultLimits, 0) : null;
    if (Array.isArray(patch.words)) next.words = [...new Set(patch.words.map(word => String(word).trim().slice(0, 40)).filter(Boolean))].slice(0, 200);
    config.update(next);
    if ("defaultLimits" in next) hub.applyLimits();
    hub.log("warning", "admin", `${session.name} change les réglages : ${Object.keys(next).join(", ")}`);
    return true;
  }

  private async act(body: Record<string, unknown>, session: Who) {
    const { hub, config } = this.options;
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
      case "ban": {
        const hours = Math.max(0, Number(body.hours) || 0);
        audit(`${body.banned === true ? `bannit${hours ? ` pour ${hours} h` : ""}` : "débannit"} ${account()}`);
        return hub.adminBan(id("accountId"), body.banned === true, text("reason", 200), hours ? Date.now() + hours * 3600_000 : 0, session.name);
      }
      case "mute": {
        const hours = Math.max(0, Number(body.hours) || 0);
        audit(hours ? `rend muet ${account()} pour ${hours} h` : `rend la parole à ${account()}`);
        return hub.adminMute(id("accountId"), hours ? Date.now() + hours * 3600_000 : 0, text("reason", 200), session.name);
      }
      case "setLimits": {
        const hours = Math.max(0, Number(body.hours) || 0);
        const limits = body.limits ? cleanLimits(body.limits, hours ? Date.now() + hours * 3600_000 : 0) : null;
        audit(limits ? `limite ${account()}${hours ? ` pour ${hours} h` : ""}` : `lève les limites de ${account()}`);
        return hub.adminSetLimits(id("accountId"), limits, text("reason", 200), session.name);
      }
      case "warn":
        if (!text("text", 300)) return false;
        audit(`avertit ${account()}`);
        hub.adminWarn(id("accountId"), text("text", 300), session.name);
        return true;
      case "addNote":
        if (!text("text", 500)) return false;
        return hub.accounts.addNote(id("accountId"), session.name, text("text", 500), Date.now());
      case "removeNote":
        return hub.accounts.removeNote(id("accountId"), Number(body.at));
      case "deleteMessage":
        audit("supprime un message");
        return hub.adminDeleteMessage(id("roomId"), id("id"));
      case "clearChat":
        audit("vide le chat d'un salon");
        return hub.adminClearChat(id("roomId"));
      case "roomSay":
        if (!text("text", 300)) return false;
        audit("écrit dans un salon");
        return hub.adminRoomSay(id("roomId"), text("text", 300));
      case "roomSettings":
        audit("change les réglages d'un salon");
        return hub.adminRoomSettings(id("roomId"), { whoCanStream: body.whoCanStream, maxKbps: body.maxKbps });
      case "stopAll":
        audit("arrête tous les streams d'un salon");
        return hub.adminStopAll(id("roomId"));
      case "stopParty":
        audit("arrête une Watch Party");
        return hub.adminStopParty(id("roomId"));
      case "closePoll":
        audit("ferme un sondage");
        return hub.adminClosePoll(id("roomId"));
      case "blockIp": {
        const ip = text("ip", 64);
        const hours = Math.max(0, Number(body.hours) || 0);
        if (!ip) return false;
        config.update({ blockedIps: [...config.value.blockedIps.filter(row => row.ip !== ip), { ip, reason: text("reason", 200), by: session.name, at: Date.now(), until: hours ? Date.now() + hours * 3600_000 : 0 }] });
        hub.adminDropIp(ip);
        audit(`bloque l'adresse ${ip}`);
        return true;
      }
      case "unblockIp":
        config.update({ blockedIps: config.value.blockedIps.filter(row => row.ip !== text("ip", 64)) });
        audit(`débloque l'adresse ${text("ip", 64)}`);
        return true;
      case "setConfig":
        return this.setConfig(body, session);
      case "setPlan": {
        const at = Number(body.at) || 0;
        if (!at) {
          this.planNotified.clear();
          config.update({ plan: null });
          audit("annule la maintenance prévue");
          return true;
        }
        if (at <= Date.now() || !text("text", 300)) return false;
        this.planNotified.clear();
        config.update({ plan: { at, text: text("text", 300), restart: body.restart === true } });
        audit(`prévoit une maintenance le ${new Date(at).toISOString()}`);
        return true;
      }
      case "setRule": {
        const rule = RULES.find(r => r.id === id("rule"));
        if (!rule) return false;
        config.update({ rules: { ...config.value.rules, [rule.id]: { on: body.on !== false, limit: Number.isFinite(Number(body.limit)) ? Number(body.limit) : rule.limit } } });
        audit(`règle l'alerte « ${rule.label} »`);
        return true;
      }
      case "setDiscord": {
        const url = text("url", 300);
        if (url && !validWebhook(url)) return false;
        config.update({ discord: url });
        audit(url ? "branche les alertes sur Discord" : "débranche les alertes de Discord");
        return true;
      }
      case "testDiscord":
        return this.notify(`SpokaStream : essai envoyé par ${session.name} depuis le panneau.`);
      case "restartIdle":
        if (!this.options.canRestart) return false;
        this.restartIdle = body.on !== false;
        audit(this.restartIdle ? "demande un redémarrage dès que plus personne ne diffuse" : "annule le redémarrage différé");
        return true;
      case "backupCreate":
        if (!this.backups) return false;
        this.flushAll();
        this.backups.create(text("label", 80) || `Par ${session.name}`, false);
        audit("crée une sauvegarde");
        return true;
      case "backupDelete":
        audit("supprime une sauvegarde");
        return !!this.backups?.remove(text("id", 80));
      case "backupRestore": {
        const backup = text("id", 80);
        if (!this.backups?.has(backup) || !this.options.canRestart) return false;
        this.flushAll();
        this.backups.create("Avant restauration", false);
        this.backups.markRestore(backup);
        hub.log("warning", "admin", `${session.name} restaure la sauvegarde ${backup}`);
        setTimeout(() => process.emit("SIGTERM"), 300);
        return true;
      }
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
    if (url.pathname === "/admin/manifest.webmanifest") {
      res.writeHead(200, { "content-type": "application/manifest+json", "cache-control": "no-cache" });
      res.end(MANIFEST);
      return true;
    }
    if (url.pathname === "/admin/sw.js") {
      // Le fichier vit sous /admin/ et doit couvrir /admin elle-même : c'est ce qu'autorise cet en-tête.
      res.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-cache", "service-worker-allowed": "/admin" });
      res.end(SERVICE_WORKER);
      return true;
    }
    if (url.pathname === "/admin/icon-192.png" || url.pathname === "/admin/icon-512.png") {
      res.writeHead(200, { "content-type": "image/png", "cache-control": "public, max-age=86400" });
      res.end(Buffer.from(url.pathname.includes("192") ? ADMIN_ICON_192 : ADMIN_ICON_512, "base64"));
      return true;
    }
    if (!url.pathname.startsWith("/admin/api/")) return false;
    if (url.pathname === "/admin/api/logs.csv" && req.method === "GET") {
      const session = this.session(req);
      if (!session) return (json(res, 401, { error: "Connexion requise." }), true);
      res.writeHead(200, { "content-type": "text/csv; charset=utf-8", "cache-control": "no-store", "content-disposition": `attachment; filename="spokastream-journal-${new Date().toISOString().slice(0, 10)}.csv"` });
      res.end(logsCsv(this.options.hub.logs));
      return true;
    }
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
    const { hub, store, metrics, usage, config } = this.options;
    const host = String(req.headers.host ?? "").split(":")[0]!;
    if (host.includes(".") && !/^\d+\.\d+\.\d+\.\d+$/.test(host) && host !== config.value.publicHost) {
      config.update({ publicHost: host });
      metrics.setProbeUrl(`https://${host}/health`);
    }
    const rank = ROLE_RANK[session.role];
    if (req.method === "GET") {
      if (name === "overview") return json(res, 200, await this.overview(host));
      if (name === "metrics") return json(res, 200, { ...metrics.range(url.searchParams.get("range") ?? "1h"), services: metrics.services(), messages: metrics.topMessages(), traffic: metrics.traffic, os: { cpus: os.cpus().length, memTotalMb: Math.round(os.totalmem() / 1_048_576), node: process.version }, dataFiles: this.dataFiles(), disk: this.disk() });
      if (name === "health") return json(res, 200, { streams: hub.adminHealth(), sessions: usage.sessions().slice(0, 100), summary: hub.telemetrySummary() });
      if (name === "bandwidth") {
        const { bandwidth } = this.options;
        const account = url.searchParams.get("id");
        if (account) return json(res, 200, { timeline: bandwidth?.timeline(account), daily: bandwidth?.daily(30, account) });
        const days = Number(url.searchParams.get("days"));
        return json(res, 200, { accounts: hub.adminBandwidth([7, 30].includes(days) ? days : 1), timeline: bandwidth?.timeline(), daily: bandwidth?.daily(30), now: hub.telemetrySummary() });
      }
      if (name === "usage") return json(res, 200, { days: usage.days(90), sessions: usage.sessions().length, topStreamers: hub.accounts.list().filter(a => a.stats?.streamMinutes).sort((a, b) => b.stats!.streamMinutes - a.stats!.streamMinutes).slice(0, 10).map(a => ({ id: a.id, name: a.name, ...a.stats! })), topViewers: hub.accounts.list().filter(a => a.stats?.watchMinutes).sort((a, b) => b.stats!.watchMinutes - a.stats!.watchMinutes).slice(0, 10).map(a => ({ id: a.id, name: a.name, ...a.stats! })), topRooms: hub.adminRooms().filter(r => r.liveMinutes).sort((a, b) => b.liveMinutes - a.liveMinutes).slice(0, 10).map(r => ({ id: r.id, name: r.name, liveMinutes: r.liveMinutes, messages: r.messages })) });
      if (name === "alerts") return json(res, 200, { active: this.alerts.active, history: this.alerts.history, rules: RULES.map(({ id, label, unit, limit, minutes, below }) => ({ id, label, unit, minutes, below: !!below, limit: config.value.rules[id]?.limit ?? limit, on: config.value.rules[id]?.on !== false })), discord: !!config.value.discord });
      if (name === "room") {
        const room = hub.adminRoom(url.searchParams.get("id") ?? "");
        if (!room) return json(res, 404, { error: "Ce salon n'existe plus." });
        // Lire un chat se voit au journal : la page se rafraîchit toutes les 5 secondes, une ligne par heure suffit.
        const read = `${session.name}:${url.searchParams.get("id")}`;
        if (Date.now() - (this.chatReads.get(read) ?? 0) > 3600_000) {
          this.chatReads.set(read, Date.now());
          hub.log("info", "admin", `${session.name} ouvre le salon « ${room.name} »`);
        }
        return json(res, 200, room);
      }
      if (name === "account") {
        const account = hub.accounts.detail(url.searchParams.get("id") ?? "");
        return account ? json(res, 200, { ...account, avatar: undefined }) : json(res, 404, { error: "Ce compte n'existe plus." });
      }
      if (name === "moderation") return json(res, 200, { sanctions: hub.adminSanctions(), blockedIps: config.value.blockedIps.filter(row => !row.until || row.until > Date.now()), words: config.value.words, slowSeconds: config.value.slowSeconds, connections: hub.adminConnections() });
      if (name === "config") {
        if (rank < ROLE_RANK.admin) return json(res, 403, { error: "Ton rôle ne permet pas de voir ça." });
        const { discord: _discord, blockedIps: _blocked, rules: _rules, words: _words, ...visible } = config.value;
        return json(res, 200, { ...visible, maintenance: hub.maintenance });
      }
      if (name === "rooms") return json(res, 200, hub.adminRooms());
      if (name === "users") return json(res, 200, hub.adminUsers());
      if (name === "logs") return json(res, 200, hub.logs);
      if (name === "reports") return json(res, 200, hub.reports);
      if (name === "backups") {
        if (session.role !== "owner") return json(res, 403, { error: "Réservé au propriétaire." });
        return json(res, 200, { list: this.backups?.list() ?? [], canRestore: !!this.options.canRestart });
      }
      if (name === "backups/download") {
        if (session.role !== "owner") return json(res, 403, { error: "Réservé au propriétaire." });
        const id = url.searchParams.get("id") ?? "";
        const content = this.backups?.read(id);
        return content ? json(res, 200, content, { "content-disposition": `attachment; filename="spokastream-${id}.json"` }) : json(res, 404, { error: "Cette sauvegarde n'existe plus." });
      }
      if (name === "sessions") {
        if (session.role !== "owner") return json(res, 403, { error: "Réservé au propriétaire." });
        return json(res, 200, {
          sessions: [...this.sessions.entries()].map(([id, s]) => ({ id: createHash("sha256").update(id).digest("hex").slice(0, 16), name: s.name, ip: s.ip, agent: s.agent, createdAt: s.createdAt, seenAt: s.seenAt, self: id === session.id })),
          locks: [...this.failures.entries()].filter(([, entry]) => Date.now() - entry.since <= LOGIN_WINDOW_MS).map(([ip, entry]) => ({ ip, count: entry.count, since: entry.since, locked: entry.count >= LOGIN_FAILURES })),
        });
      }
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
    if (req.method === "POST" && (name === "sessions/close" || name === "locks/clear")) {
      if (session.role !== "owner") return json(res, 403, { error: "Réservé au propriétaire." });
      const body = await readBody(req).catch(() => ({}) as Record<string, unknown>);
      if (name === "locks/clear") {
        this.failures.delete(String(body.ip));
        hub.log("warning", "admin", `${session.name} débloque ${String(body.ip).slice(0, 64)}`);
        return json(res, 200, { ok: true });
      }
      for (const key of this.sessions.keys()) if (createHash("sha256").update(key).digest("hex").slice(0, 16) === body.id && key !== session.id) this.sessions.delete(key);
      hub.log("warning", "admin", `${session.name} ferme une session du panneau`);
      return json(res, 200, { ok: true });
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
      const done = await this.act(await readBody(req), session);
      if (done === "forbidden") return json(res, 403, { error: "Ton rôle ne permet pas cette action." });
      return json(res, done === true ? 200 : 400, { ok: done === true, ...(done === true ? {} : { error: "Action impossible." }) });
    }
    json(res, 404, { error: "Inconnu." });
  }
}
