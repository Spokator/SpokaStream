import { createHmac } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocketServer, type WebSocket } from "ws";
import { LIMITS } from "../src/shared/protocol.ts";
import type { IceServer } from "../src/shared/protocol.ts";
import { Hub } from "./hub.ts";
import type { Store } from "./store.ts";

export interface ServerOptions {
  port: number;
  host: string;
  store: Store;
  serverName?: string;
  turnHost?: string;
  turnSecret?: string;
  turnTtlSeconds?: number;
  downloadUrl?: string;
  /** Derrière nginx : l'adresse réelle du client arrive dans X-Forwarded-For. */
  trustProxy?: boolean;
}

export interface RunningServer {
  port: number;
  hub: Hub;
  close(): Promise<void>;
}

const STUN: IceServer = { urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] };

/** Identifiants TURN temporaires, compatibles avec le coturn de PinoyBot (use-auth-secret). */
export function iceServersFor(userId: string, options: Pick<ServerOptions, "turnHost" | "turnSecret" | "turnTtlSeconds">): IceServer[] {
  const list: IceServer[] = [STUN];
  const { turnHost: host, turnSecret: secret, turnTtlSeconds: ttl = 12 * 3600 } = options;
  if (host && secret) {
    const username = `${Math.floor(Date.now() / 1000) + ttl}:${userId}`;
    const credential = createHmac("sha1", secret).update(username).digest("base64");
    // UDP 3478, UDP 443 (souvent le seul UDP ouvert sur les réseaux d'invités), TCP et TLS en dernier recours.
    list.push({ urls: [`turn:${host}:3478?transport=udp`, `turn:${host}:443?transport=udp`, `turn:${host}:3478?transport=tcp`, `turns:${host}:5349?transport=tcp`], username, credential });
  }
  return list;
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);

/** Discord et les navigateurs ne rendent pas spokastream:// cliquable : l'invitation est donc une page web qui ouvre l'application. */
function invitePage(code: string, downloadUrl: string) {
  const deepLink = `spokastream://join/${encodeURIComponent(code)}`;
  const shown = escapeHtml(code);
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Rejoindre sur SpokaStream</title>
<meta property="og:title" content="Rejoins-moi sur SpokaStream"><meta property="og:description" content="Clique pour ouvrir le salon dans l'application.">
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0f1117;color:#f1f3f9;font:16px/1.5 system-ui,"Segoe UI",sans-serif}main{max-width:420px;padding:32px;text-align:center}h1{font-size:24px;margin:0 0 8px}p{color:#9aa3b8;margin:0 0 24px}a{display:block;padding:13px 18px;border-radius:12px;text-decoration:none;font-weight:600;margin-top:10px}.p{background:linear-gradient(135deg,#7c5cff,#22d3ee);color:#fff}.s{background:#1a1e2b;color:#f1f3f9;border:1px solid #2a3042}code{display:inline-block;margin-top:18px;padding:6px 12px;border-radius:8px;background:#1a1e2b;letter-spacing:.14em}</style></head>
<body><main><h1>Tu es invité sur SpokaStream</h1><p>Ouvre l'application pour rejoindre le salon.</p><a class="p" href="${deepLink}">Ouvrir SpokaStream</a><a class="s" href="${escapeHtml(downloadUrl)}">Je n'ai pas encore l'application</a><code>${shown}</code></main>
<script>location.href=${JSON.stringify(deepLink)}</script></body></html>`;
}

export function startServer(options: ServerOptions): Promise<RunningServer> {
  const downloadUrl = options.downloadUrl ?? "https://github.com/Spokator/SpokaStream/releases/latest";
  const hub = new Hub({ store: options.store, serverName: options.serverName, iceServers: userId => iceServersFor(userId, options) });

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ ok: true, uptime: Math.round(process.uptime()), ...hub.stats }));
    }
    const invite = url.pathname.match(/^\/j\/([A-Za-z0-9]{4,16})$/);
    if (invite) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return res.end(invitePage(invite[1]!, downloadUrl));
    }
    res.writeHead(url.pathname === "/" ? 200 : 404, { "content-type": "text/plain; charset=utf-8" });
    res.end("SpokaStream\n");
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: LIMITS.wsPayload });
  server.on("upgrade", (req, socket, head) => {
    if ((req.url ?? "").split("?")[0] !== "/ws") return socket.destroy();
    wss.handleUpgrade(req, socket, head, ws => wss.emit("connection", ws, req));
  });

  wss.on("connection", (ws: WebSocket & { alive?: boolean }, req) => {
    const forwarded = options.trustProxy ? String(req.headers["x-forwarded-for"] ?? "").split(",")[0]?.trim() : "";
    const conn = hub.connect({
      ip: forwarded || req.socket.remoteAddress || "?",
      send: data => {
        if (ws.readyState === ws.OPEN) ws.send(data);
      },
      close: (code, reason) => ws.close(code, reason),
    });
    ws.alive = true;
    ws.on("pong", () => (ws.alive = true));
    ws.on("message", raw => hub.handle(conn, raw.toString()));
    ws.on("close", () => hub.disconnect(conn));
    ws.on("error", () => ws.terminate());
  });

  const heartbeat = setInterval(() => {
    for (const client of wss.clients as Set<WebSocket & { alive?: boolean }>) {
      if (client.alive === false) {
        client.terminate();
        continue;
      }
      client.alive = false;
      client.ping();
    }
  }, 25_000);
  heartbeat.unref();

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host, () => {
      server.off("error", reject);
      resolve({
        port: (server.address() as AddressInfo).port,
        hub,
        close: () =>
          new Promise(done => {
            clearInterval(heartbeat);
            options.store.flush();
            for (const client of wss.clients) client.terminate();
            wss.close();
            server.close(() => done());
          }),
      });
    });
  });
}
