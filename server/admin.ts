// Le panneau d'administration : ce que le serveur sait, et ce qu'on peut y faire, sans ouvrir une session SSH.
// On y entre avec son compte : un billet à usage unique depuis l'application, ou le jeton d'un appareil déjà connu du navigateur.
import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { statfsSync } from "node:fs";
import type http from "node:http";
import os from "node:os";
import tls from "node:tls";
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
const LOGIN_TRIES = 12;
const LOGIN_WINDOW_MS = 60_000;
const BODY_BYTES = 8192;
const COOKIE = "spoka_admin";
const CSP = ["default-src 'none'", "script-src 'self'", "style-src 'unsafe-inline'", "img-src 'self' data:", "connect-src 'self'", "base-uri 'none'", "form-action 'none'", "frame-ancestors 'none'"].join("; ");

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
  private readonly sessions = new Map<string, { accountId: string; expires: number }>();
  private readonly tickets = new Map<string, { accountId: string; expires: number }>();
  private readonly tries = new Map<string, { count: number; since: number }>();
  private readonly history: Sample[] = [];
  private readonly sampler: NodeJS.Timeout;
  private services: { at: number; value: Record<string, string> } = { at: 0, value: {} };
  private release: { at: number; value: { tag: string; publishedAt: string; downloads: number } | null } = { at: 0, value: null };
  private certificate: { at: number; expires: string | null } = { at: 0, expires: null };

  constructor(options: AdminOptions) {
    this.options = options;
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
    return { id, ...session };
  }

  private tooManyTries(ip: string) {
    const now = Date.now();
    const entry = this.tries.get(ip);
    if (!entry || now - entry.since > LOGIN_WINDOW_MS) {
      this.tries.set(ip, { count: 1, since: now });
      return false;
    }
    entry.count++;
    return entry.count > LOGIN_TRIES;
  }

  private accountFrom(body: Record<string, unknown>) {
    const { hub } = this.options;
    if (typeof body.ticket === "string") {
      const ticket = this.tickets.get(body.ticket);
      this.tickets.delete(body.ticket);
      return ticket && ticket.expires > Date.now() ? ticket.accountId : null;
    }
    if (typeof body.token === "string" && /^[0-9a-f]{64}$/.test(body.token)) {
      const accountId = hub.accounts.accountOf(createHash("sha256").update(body.token).digest("hex").slice(0, 24));
      return hub.isAdminAccount(accountId) ? accountId : null;
    }
    return null;
  }

  private async login(req: http.IncomingMessage, res: http.ServerResponse, ip: string) {
    if (this.tooManyTries(ip)) return json(res, 429, { error: "Trop d'essais, patiente une minute." });
    const body = await readBody(req).catch(() => ({}));
    const accountId = this.accountFrom(body);
    if (!accountId || !this.options.hub.isAdminAccount(accountId)) return json(res, 403, { error: "Ce compte n'a pas accès au panneau." });
    const id = randomBytes(32).toString("base64url");
    this.sessions.set(id, { accountId, expires: Date.now() + SESSION_MS });
    this.options.hub.log("info", "admin", "Connexion au panneau");
    const secure = req.headers["x-forwarded-proto"] === "https" ? "; Secure" : "";
    json(res, 200, { ok: true }, { "set-cookie": `${COOKIE}=${id}; HttpOnly; SameSite=Strict; Path=/admin; Max-Age=${SESSION_MS / 1000}${secure}` });
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

  private act(body: Record<string, unknown>) {
    const { hub } = this.options;
    const text = (key: string, max: number) => String(body[key] ?? "").trim().slice(0, max);
    const id = (key: string) => text(key, 64);
    switch (body.action) {
      case "announce":
        if (!text("text", 300)) return false;
        hub.announce(text("text", 300), body.level === "warning" ? "warning" : "info");
        return true;
      case "maintenance":
        hub.maintenance = text("text", 300);
        hub.log("warning", "admin", hub.maintenance ? `Maintenance : ${hub.maintenance}` : "Fin de la maintenance");
        if (hub.maintenance) hub.announce(hub.maintenance, "warning");
        return true;
      case "stopStream":
        return hub.adminStopStream(id("roomId"), id("ownerId"));
      case "kick":
        return hub.adminKick(id("roomId"), id("userId"));
      case "lockRoom":
        return hub.adminLockRoom(id("roomId"), body.locked === true);
      case "deleteRoom":
        return hub.adminDeleteRoom(id("roomId"));
      case "ban":
        return hub.adminBan(id("accountId"), body.banned === true);
      case "deleteReport": {
        const index = hub.reports.findIndex(r => r.id === id("id"));
        if (index >= 0) hub.reports.splice(index, 1);
        return index >= 0;
      }
      case "restart":
        if (!this.options.canRestart) return false;
        hub.log("warning", "admin", "Redémarrage demandé");
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
    if (name === "login" && req.method === "POST") return this.login(req, res, ip);
    const session = this.session(req);
    if (!session) return json(res, 401, { error: "Connexion requise." });
    const { hub, store } = this.options;
    if (req.method === "GET") {
      if (name === "overview") return json(res, 200, await this.overview(String(req.headers.host ?? "").split(":")[0]!));
      if (name === "rooms") return json(res, 200, hub.adminRooms());
      if (name === "users") return json(res, 200, hub.adminUsers());
      if (name === "logs") return json(res, 200, hub.logs.slice(0, 500));
      if (name === "reports") return json(res, 200, hub.reports);
      if (name === "backup") return json(res, 200, { at: new Date().toISOString(), version: APP_VERSION, rooms: store.load(), accounts: hub.accounts.list() }, { "content-disposition": `attachment; filename="spokastream-${new Date().toISOString().slice(0, 10)}.json"` });
    }
    if (req.method === "POST" && name === "logout") {
      this.sessions.delete(session.id);
      return json(res, 200, { ok: true }, { "set-cookie": `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/admin; Max-Age=0` });
    }
    if (req.method === "POST" && name === "action") {
      const done = this.act(await readBody(req));
      return json(res, done ? 200 : 400, { ok: done });
    }
    json(res, 404, { error: "Inconnu." });
  }
}
