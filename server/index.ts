import { createHmac } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { WebSocketServer, type WebSocket } from "ws";
import { Bucket, GUARD, Guard } from "./guard.ts";
import { LIMITS } from "../src/shared/protocol.ts";
import type { IceServer } from "../src/shared/protocol.ts";
import { AdminPanel } from "./admin.ts";
import type { AdminAuth } from "./adminAuth.ts";
import type { Accounts } from "./accounts.ts";
import { ConfigStore } from "./config.ts";
import { Hub } from "./hub.ts";
import { Journal } from "./journal.ts";
import { Metrics } from "./metrics.ts";
import type { PushService } from "./push.ts";
import { privacyPage } from "./privacy.ts";
import type { Store } from "./store.ts";
import { Usage } from "./usage.ts";
import { HLS_JS, ICON_192, ICON_512, VIEWER_HTML, VIEWER_JS } from "./viewer.gen.ts";

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
  /** Notifications sur téléphone. Absent : le site n'en propose pas. */
  push?: PushService;
  accounts?: Accounts;
  /** Les comptes qui ont accès au panneau d'administration. */
  admins?: string[];
  /** Dossier des données, pour surveiller le disque. */
  dataDir?: string;
  /** Sous systemd, quitter revient à redémarrer. */
  canRestart?: boolean;
  adminAuth?: AdminAuth;
  /** Le nom du service systemd : ses limites de mémoire et de processeur se lisent dans son cgroup. */
  serviceName?: string;
}

export interface RunningServer {
  port: number;
  hub: Hub;
  admin: AdminPanel;
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

/**
 * nginx ajoute la vraie adresse à la fin de X-Forwarded-For, après ce que le client a pu écrire lui-même.
 * Seule la dernière valeur est fiable : lire la première laisserait contourner tout blocage avec un en-tête inventé.
 */
export function clientIp(req: http.IncomingMessage, options: Pick<ServerOptions, "trustProxy">) {
  const forwarded = options.trustProxy ? String(req.headers["x-forwarded-for"] ?? "").split(",").pop()?.trim() : "";
  return forwarded || req.socket.remoteAddress || "?";
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);

/** Le lecteur web ne parle qu'à ce serveur. Les seuls contenus extérieurs sont les miniatures YouTube et les vidéos de la Watch Party, qu'il faut vérifier avant de les lancer. */
const VIEWER_CSP = ["default-src 'self'", "script-src 'self'", "style-src 'unsafe-inline'", "img-src 'self' data: blob: https://i.ytimg.com", "media-src 'self' blob: http: https:", "connect-src 'self' ws: wss:", "frame-src 'self'", "worker-src 'self'", "manifest-src 'self'", "base-uri 'none'", "form-action 'none'"].join("; ");

const VIEWER_JS_GZIP = gzipSync(VIEWER_JS);
const HLS_JS_GZIP = gzipSync(HLS_JS);

/** De quoi ajouter SpokaStream à l'écran d'accueil d'un téléphone : il s'ouvre alors comme une application, sans barre de navigateur. */
const MANIFEST = JSON.stringify({
  name: "SpokaStream",
  short_name: "SpokaStream",
  description: "Regarde tes amis en direct et parle avec eux.",
  lang: "fr",
  start_url: "/",
  scope: "/",
  display: "standalone",
  background_color: "#0b0d14",
  theme_color: "#0b0d14",
  icons: [
    { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any maskable" },
    { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any maskable" },
  ],
});

/** Rien n'est gardé hors ligne : un salon n'a de sens que connecté. Le fichier sert à l'installation et aux notifications. */
const SERVICE_WORKER = `self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", event => event.waitUntil(self.clients.claim()));
self.addEventListener("fetch", () => {});
self.addEventListener("push", event => {
  const data = event.data ? event.data.json() : {};
  event.waitUntil(self.registration.showNotification(data.title || "SpokaStream", { body: data.body, icon: "/icon-192.png", badge: "/icon-192.png", tag: data.tag, data: { url: data.url } }));
});
self.addEventListener("notificationclick", event => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || "/";
  event.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(list => {
    const open = list.find(client => "focus" in client);
    if (!open) return self.clients.openWindow(url);
    open.navigate(url);
    return open.focus();
  }));
});
`;

/** Le titre d'une vidéo : YouTube ne le donne pas à une page web, le serveur le demande à sa place. */
async function youtubeTitle(id: string) {
  const url = `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(`https://www.youtube.com/watch?v=${id}`)}`;
  const response = await fetch(url, { signal: AbortSignal.timeout(5000) }).catch(() => null);
  if (!response?.ok) return null;
  const data = (await response.json().catch(() => null)) as { title?: string } | null;
  return data?.title ?? null;
}

const PAGE_STYLE = `body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0f1117;color:#f1f3f9;font:16px/1.5 system-ui,"Segoe UI",sans-serif}main{width:100%;max-width:420px;box-sizing:border-box;padding:32px;text-align:center}h1{font-size:24px;margin:0 0 8px}p{color:#9aa3b8;margin:0 0 24px}a,button{display:block;box-sizing:border-box;width:100%;padding:13px 18px;border:0;border-radius:12px;font:inherit;font-weight:600;text-decoration:none;margin-top:10px;cursor:pointer}.p{background:linear-gradient(135deg,#7c5cff,#22d3ee);color:#fff}.s{background:#1a1e2b;color:#f1f3f9;border:1px solid #2a3042}code{display:inline-block;margin-top:18px;padding:6px 12px;border-radius:8px;background:#1a1e2b;letter-spacing:.14em}input{box-sizing:border-box;width:100%;padding:13px 14px;border:1px solid #2a3042;border-radius:12px;background:#1a1e2b;color:#f1f3f9;font:inherit;font-size:20px;font-weight:600;letter-spacing:.14em;text-align:center;text-transform:uppercase}input::placeholder{color:#6c758a;font-size:16px;font-weight:400;letter-spacing:normal;text-transform:none}`;

/**
 * Discord et les navigateurs ne rendent pas spokastream:// cliquable : l'invitation est donc une page web.
 * Sur un PC, elle ouvre l'application. Sur un téléphone, il n'y a pas d'application : elle passe droit au lecteur web.
 */
function invitePage(code: string, downloadUrl: string) {
  const deepLink = `spokastream://join/${encodeURIComponent(code)}`;
  const viewer = `/w/${encodeURIComponent(code)}`;
  const shown = escapeHtml(code);
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Rejoindre sur SpokaStream</title>
<meta property="og:title" content="Rejoins-moi sur SpokaStream"><meta property="og:description" content="Regarde dans ton navigateur, ou ouvre le salon dans l'application.">
<style>${PAGE_STYLE}</style></head>
<body><main><h1>Tu es invité sur SpokaStream</h1><p>Regarde tout de suite, ou ouvre l'application.</p><a class="p" href="${viewer}">Regarder dans le navigateur</a><a class="s" href="${deepLink}">Ouvrir SpokaStream</a><a class="s" href="${escapeHtml(downloadUrl)}">Installer l'application</a><code>${shown}</code></main>
<script>if(/Android|iPhone|iPad|iPod/i.test(navigator.userAgent))location.replace(${JSON.stringify(viewer)});else location.href=${JSON.stringify(deepLink)}</script></body></html>`;
}

/**
 * Le lecteur de la Watch Party. YouTube refuse une page sans vraie origine, et l'application est chargée depuis un
 * fichier local : elle affiche donc cette page en cadre et la pilote par messages. Un fichier ou un flux HLS passe par
 * le même chemin : pour l'application et pour le site, les deux lecteurs se commandent de la même façon.
 */
const PLAYER_PAGE = `<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>SpokaStream</title>
<style>html,body,#player,#file{margin:0;width:100%;height:100%;background:#000;overflow:hidden}#file{display:none;object-fit:contain}video::cue{font:500 clamp(14px,3.4vh,34px)/1.3 system-ui,"Segoe UI",sans-serif;background:rgba(0,0,0,.62)}</style></head>
<body><div id="player"></div><video id="file" playsinline></video><script>
var yt = null, requested = false, waiting = null, mode = "", hls = null, volume = 100, seekTo = 0;
var file = document.getElementById("file");
function send(message) { message.spoka = true; parent.postMessage(message, "*"); }
function fileState() { return file.ended ? 0 : file.paused ? 2 : file.readyState < 3 || file.seeking ? 3 : 1; }
function report() {
  if (mode === "file") return send({ type: "time", time: file.currentTime, duration: isFinite(file.duration) ? file.duration : 0, state: fileState() });
  if (yt && yt.getCurrentTime) send({ type: "time", time: yt.getCurrentTime(), duration: yt.getDuration(), state: yt.getPlayerState() });
}
function show(name) {
  var frame = document.getElementById("player");
  frame.style.display = name === "file" ? "none" : "block";
  file.style.display = name === "file" ? "block" : "none";
  mode = name;
}
function onYouTubeIframeAPIReady() {
  yt = new YT.Player("player", {
    width: "100%", height: "100%",
    playerVars: { controls: 0, disablekb: 1, fs: 0, rel: 0, iv_load_policy: 3, playsinline: 1, origin: location.origin },
    events: {
      onReady: function () { yt.setVolume(volume); if (waiting) { var next = waiting; waiting = null; loadYoutube(next); } },
      onStateChange: function (e) { send({ type: "state", state: e.data }); report(); },
      onError: function (e) { send({ type: "error", code: e.data }); }
    }
  });
}
function loadYoutube(m) {
  clearFile();
  show("youtube");
  if (!yt || !yt.loadVideoById) {
    waiting = m;
    if (requested) return;
    requested = true;
    var script = document.createElement("script");
    script.src = "https://www.youtube.com/iframe_api";
    script.onerror = function () { send({ type: "error", code: 5 }); };
    return document.body.append(script);
  }
  yt.loadVideoById({ videoId: m.id, startSeconds: m.time || 0 });
  if (!m.playing) yt.pauseVideo();
}
function clearFile() {
  if (hls) { hls.destroy(); hls = null; }
  file.pause();
  file.removeAttribute("src");
  file.load();
  subtitles(null);
}
function playFile() {
  var started = file.play();
  if (started) started.catch(function (e) {
    if (e.name !== "NotAllowedError") return;
    file.muted = true;
    send({ type: "muted" });
    file.play().catch(function () {});
  });
}
function startHls(m) {
  hls = new Hls();
  hls.on(Hls.Events.ERROR, function (_, data) { if (data.fatal) send({ type: "error", code: 1002 }); });
  hls.loadSource(m.url);
  hls.attachMedia(file);
}
function loadFile(m) {
  if (yt && yt.stopVideo) yt.stopVideo();
  clearFile();
  show("file");
  seekTo = m.time || 0;
  var stream = /\\.m3u8(?:[?#]|$)/i.test(m.url);
  if (stream && !file.canPlayType("application/vnd.apple.mpegurl")) {
    if (window.Hls) startHls(m);
    else {
      var script = document.createElement("script");
      script.src = "/hls.js";
      script.onload = function () { startHls(m); };
      script.onerror = function () { send({ type: "error", code: 1002 }); };
      document.body.append(script);
    }
  } else file.src = m.url;
  if (m.playing) playFile();
  if (m.subtitles) fetch(m.subtitles).then(function (r) { return r.ok ? r.text() : ""; }).then(function (text) { if (text) subtitles(text); }, function () {});
}
function subtitles(text) {
  for (var old = file.querySelector("track"); old; old = file.querySelector("track")) { URL.revokeObjectURL(old.src); old.remove(); }
  if (!text) return;
  var vtt = /^\\s*WEBVTT/.test(text) ? text : "WEBVTT\\n\\n" + text.replace(/\\r/g, "").replace(/(\\d\\d:\\d\\d:\\d\\d),(\\d\\d\\d)/g, "$1.$2");
  var track = document.createElement("track");
  track.kind = "subtitles";
  track.label = "Sous-titres";
  track.default = true;
  track.src = URL.createObjectURL(new Blob([vtt], { type: "text/vtt" }));
  file.append(track);
  track.track.mode = "showing";
}
file.addEventListener("loadedmetadata", function () { if (seekTo) { file.currentTime = seekTo; seekTo = 0; } report(); });
file.addEventListener("ended", function () { send({ type: "state", state: 0 }); });
file.addEventListener("error", function () { if (file.getAttribute("src") && file.error) send({ type: "error", code: 1000 + file.error.code }); });
addEventListener("message", function (e) {
  var m = e.data;
  if (e.source !== parent || !m || !m.spoka) return;
  if (m.cmd === "load") return m.url ? loadFile(m) : loadYoutube(m);
  if (m.cmd === "subtitles") return subtitles(m.text);
  if (m.cmd === "volume") {
    volume = m.volume;
    file.volume = m.volume / 100;
    file.muted = m.volume <= 0;
    if (yt && yt.setVolume) { yt.setVolume(m.volume); if (m.volume > 0) yt.unMute(); else yt.mute(); }
    return;
  }
  if (mode === "file") {
    if (m.cmd === "play") playFile();
    else if (m.cmd === "pause") file.pause();
    else if (m.cmd === "seek") { if (file.readyState) file.currentTime = m.time; else seekTo = m.time; }
    return;
  }
  if (!yt || !yt.loadVideoById) return;
  if (m.cmd === "play") yt.playVideo();
  else if (m.cmd === "pause") yt.pauseVideo();
  else if (m.cmd === "seek") yt.seekTo(m.time, true);
});
setInterval(report, 500);
send({ type: "ready" });
</script></body></html>`;

export function startServer(options: ServerOptions): Promise<RunningServer> {
  const downloadUrl = options.downloadUrl ?? "https://github.com/Spokator/SpokaStream/releases/latest";
  const data = (file: string) => options.dataDir && path.join(options.dataDir, file);
  const config = new ConfigStore(data("config.json"));
  const usage = new Usage(data("usage.json"));
  const metrics = new Metrics({
    file: data("metrics.json"),
    stunHost: options.turnHost,
    self: options.serviceName,
    source: () => ({ ...hub.stats, ...hub.telemetrySummary() }),
  });
  const guard = new Guard();
  const hub = new Hub({ guard, store: options.store, serverName: options.serverName, push: options.push, accounts: options.accounts, admins: options.admins, config, metrics, usage, journal: new Journal(options.dataDir), iceServers: userId => iceServersFor(userId, options) });
  const admin = new AdminPanel({ hub, store: options.store, metrics, usage, config, push: options.push, dataDir: options.dataDir, canRestart: options.canRestart, auth: options.adminAuth });

  const server = http.createServer((req, res) => {
    const started = performance.now();
    metrics.traffic.http++;
    res.once("finish", () => {
      metrics.traffic.httpMs += performance.now() - started;
      if (res.statusCode >= 500) metrics.traffic.httpErrors++;
    });
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname.startsWith("/admin") && admin.handle(req, res, url, clientIp(req, options))) return;
    if (url.pathname === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ ok: true, uptime: Math.round(process.uptime()), ...hub.stats }));
    }
    if (url.pathname === "/confidentialite") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return res.end(privacyPage(PAGE_STYLE));
    }
    const invite = url.pathname.match(/^\/j\/([A-Za-z0-9]{4,16})$/);
    if (invite) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return res.end(invitePage(invite[1]!, downloadUrl));
    }
    if (url.pathname === "/" || /^\/(?:w|link)\/[A-Za-z0-9]{4,16}$/.test(url.pathname)) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-security-policy": VIEWER_CSP, "cache-control": "no-cache", "referrer-policy": "no-referrer" });
      return res.end(VIEWER_HTML);
    }
    if (url.pathname === "/w/app.js") {
      const gzip = /\bgzip\b/.test(String(req.headers["accept-encoding"] ?? ""));
      res.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-cache", vary: "accept-encoding", ...(gzip ? { "content-encoding": "gzip" } : {}) });
      return res.end(gzip ? VIEWER_JS_GZIP : VIEWER_JS);
    }
    if (url.pathname === "/push/key" && options.push) {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ key: options.push.publicKey }));
    }
    if (url.pathname === "/hls.js") {
      const gzip = /\bgzip\b/.test(String(req.headers["accept-encoding"] ?? ""));
      res.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "public, max-age=86400", vary: "accept-encoding", ...(gzip ? { "content-encoding": "gzip" } : {}) });
      return res.end(gzip ? HLS_JS_GZIP : HLS_JS);
    }
    if (url.pathname === "/manifest.webmanifest") {
      res.writeHead(200, { "content-type": "application/manifest+json" });
      return res.end(MANIFEST);
    }
    if (url.pathname === "/sw.js") {
      res.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-cache" });
      return res.end(SERVICE_WORKER);
    }
    if (url.pathname === "/icon-192.png" || url.pathname === "/icon-512.png") {
      res.writeHead(200, { "content-type": "image/png", "cache-control": "public, max-age=86400" });
      return res.end(Buffer.from(url.pathname.includes("192") ? ICON_192 : ICON_512, "base64"));
    }
    if (url.pathname === "/oembed") {
      const id = url.searchParams.get("id") ?? "";
      if (!/^[\w-]{11}$/.test(id)) {
        res.writeHead(400);
        return res.end();
      }
      void youtubeTitle(id).then(title => {
        res.writeHead(title ? 200 : 404, { "content-type": "application/json" });
        res.end(JSON.stringify({ title }));
      });
      return;
    }
    if (url.pathname === "/player") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return res.end(PLAYER_PAGE);
    }
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("SpokaStream\n");
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: LIMITS.wsPayload });
  server.on("upgrade", (req, socket, head) => {
    if ((req.url ?? "").split("?")[0] !== "/ws") return socket.destroy();
    const ip = clientIp(req, options);
    if (!guard.admit(ip)) {
      if (guard.shouldWarn("connexions")) hub.log("warning", "abus", `Connexion refusée : trop de connexions, dernier essai depuis ${ip}`);
      socket.write("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n");
      return socket.destroy();
    }
    wss.handleUpgrade(req, socket, head, ws => wss.emit("connection", ws, req));
  });

  wss.on("connection", (ws: WebSocket & { alive?: boolean }, req) => {
    const ip = clientIp(req, options);
    const conn = hub.connect({
      ip,
      send: data => {
        if (ws.readyState === ws.OPEN) ws.send(data);
      },
      close: (code, reason) => ws.close(code, reason),
    });
    ws.alive = true;
    const now = Date.now();
    const bytes = new Bucket(GUARD.bytesPerSecond, GUARD.bytesBurst, now);
    const messages = new Bucket(GUARD.messagesPerSecond, GUARD.messagesBurst, now);
    const silent = setTimeout(() => !conn.userId && ws.terminate(), GUARD.helloMs);
    silent.unref();
    ws.on("pong", () => (ws.alive = true));
    ws.on("message", (raw: Buffer) => {
      const at = Date.now();
      if (bytes.take(at, raw.length) && messages.take(at)) return hub.handle(conn, raw.toString());
      if (guard.shouldWarn("débit")) hub.log("warning", "abus", `Connexion coupée : trop de messages depuis ${ip}`);
      ws.terminate();
    });
    ws.on("close", () => {
      clearTimeout(silent);
      guard.release(ip);
      hub.disconnect(conn);
    });
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
        admin,
        close: () =>
          new Promise(done => {
            clearInterval(heartbeat);
            admin.close();
            hub.accounts.flush();
            options.store.flush();
            for (const client of wss.clients) client.terminate();
            wss.close();
            server.close(() => done());
          }),
      });
    });
  });
}
