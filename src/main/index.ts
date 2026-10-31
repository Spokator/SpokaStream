import { app, BrowserWindow, clipboard, desktopCapturer, dialog, globalShortcut, ipcMain, net, Notification, screen, session, shell, webContents } from "electron";
import { execFile } from "node:child_process";
import { appendFileSync, createWriteStream, mkdirSync, statSync, writeFileSync } from "node:fs";
import type { WriteStream } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AudioApp, CaptureSource, ControlTarget, NativeVideoRequest, NotifyRequest, OverlayEvent, OverlayTarget, Settings, SoundboardInfo, TrayState, YoutubeInfo } from "../shared/ipc.ts";
import { AudioEngine } from "./audioEngine.ts";
import { LocalHost } from "./host.ts";
import { SettingsStore } from "./settings.ts";
import { AppTray } from "./tray.ts";
import { Updater } from "./updater.ts";
import { videoInfo, WebSource } from "./webSource.ts";
import { WhipServer } from "./whip.ts";
import { appIcon, createMainWindow, Overlay } from "./windows.ts";

// Mesuré sur Electron 45 avec une RTX 5070 : sans WebRtcAV1HWEncode, AV1 reste sur le processeur (libaom) ; avec, il passe sur NVENC.
// Ne pas ajouter ZeroCopyDesktopCapture seul : plus aucune image ne sort de la capture.
app.commandLine.appendSwitch(
  "enable-features",
  ["AllowWgcScreenCapturer", "AllowWgcWindowCapturer", "AllowWgcDesktopCapturer", "MediaFoundationAV1Encoding", "WebRtcAV1HWEncode", "PlatformHEVCEncoderSupport", "WebRtcAllowH265Send", "WebRtcAllowH265Receive"].join(","),
);
// Un jeu devant la fenêtre ne doit jamais ralentir l'encodage ni le décodage.
app.commandLine.appendSwitch("disable-features", "CalculateNativeWinOcclusion");
app.commandLine.appendSwitch("disable-background-timer-throttling");
app.commandLine.appendSwitch("disable-backgrounding-occluded-windows");
app.commandLine.appendSwitch("disable-renderer-backgrounding");
app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");

const PROTOCOL = "spokastream";
const testDataDir = process.env.SPOKASTREAM_USER_DATA;
if (testDataDir) app.setPath("userData", testDataDir);
app.setAppUserModelId("com.spokator.spokastream");

if (!testDataDir && !app.requestSingleInstanceLock()) {
  app.exit(0);
}

// En développement et en test, on ne touche pas au lien spokastream:// de la version installée.
if (app.isPackaged && !testDataDir) app.setAsDefaultProtocolClient(PROTOCOL);

const logFile = () => path.join(app.getPath("userData"), "spokastream.log");
function logLine(line: string) {
  try {
    appendFileSync(logFile(), `${new Date().toISOString()} ${line}\n`);
  } catch {
    // Un journal illisible ne doit jamais gêner l'application.
  }
}
for (const level of ["error", "warn"] as const) {
  const original = console[level];
  console[level] = (...args: unknown[]) => {
    original(...args);
    logLine(`[${level}] ${args.map(String).join(" ")}`);
  };
}

let settings: SettingsStore;
let mainWindow: BrowserWindow | null = null;
let regieWindow: BrowserWindow | null = null;
let tray: AppTray | null = null;
let quitting = false;
let pendingDeepLink: string | null = null;
const engine = new AudioEngine();
const overlay = new Overlay(engine);
const updater = new Updater();
const host = new LocalHost();
const whip = new WhipServer(() => settings.current.obsKey);
const webSource = new WebSource();
const iconCache = new Map<string, string | null>();
const recordings = new Map<number, WriteStream>();
let nextRecording = 1;

const toRenderer = (channel: string, ...args: unknown[]) => {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, ...args);
};

function showWindow() {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function deepLinkCode(argv: string[]) {
  const link = argv.find(a => a.startsWith(`${PROTOCOL}://`));
  return link?.match(/join\/([A-Za-z0-9]{4,16})/)?.[1] ?? null;
}

function handleDeepLink(code: string) {
  showWindow();
  if (mainWindow?.webContents.isLoading() !== false) pendingDeepLink = code;
  else toRenderer("deep-link", code);
}

app.on("second-instance", (_e, argv) => {
  const code = deepLinkCode(argv);
  if (code) handleDeepLink(code);
  else showWindow();
});

function applyLoginItem(s: Settings) {
  if (!app.isPackaged) return;
  app.setLoginItemSettings({ openAtLogin: s.startWithWindows, args: s.startMinimized ? ["--hidden"] : [] });
}

function registerHotkeys(s: Settings) {
  globalShortcut.unregisterAll();
  const entries = [...Object.entries(s.hotkeys), ...s.scenes.map(scene => [`scene:${scene.id}`, scene.hotkey] as const)];
  for (const [action, accelerator] of entries) {
    if (!accelerator) continue;
    try {
      globalShortcut.register(accelerator, () => toRenderer("hotkey", action));
    } catch (e) {
      console.warn(`raccourci invalide ${accelerator} : ${e}`);
    }
  }
}

async function fileIcon(file: string | null) {
  if (!file) return null;
  if (iconCache.has(file)) return iconCache.get(file)!;
  const icon = await app.getFileIcon(file, { size: "normal" }).then(i => i.toDataURL()).catch(() => null);
  iconCache.set(file, icon);
  return icon;
}

async function listSources(): Promise<CaptureSource[]> {
  const sources = await desktopCapturer.getSources({ types: ["screen", "window"], thumbnailSize: { width: 400, height: 225 }, fetchWindowIcons: true });
  const own = new Set(BrowserWindow.getAllWindows().map(w => w.getMediaSourceId()));
  const result: CaptureSource[] = [];
  for (const source of sources) {
    if (own.has(source.id)) continue;
    const isWindow = source.id.startsWith("window:");
    if (isWindow && source.thumbnail.isEmpty()) continue;
    const hwnd = isWindow ? source.id.split(":")[1] : null;
    const windowApp = hwnd && engine.status === "ready" ? await engine.windowApp(hwnd).catch(() => null) : null;
    result.push({
      id: source.id,
      name: source.name,
      kind: isWindow ? "window" : "screen",
      thumbnail: source.thumbnail.toDataURL(),
      icon: source.appIcon && !source.appIcon.isEmpty() ? source.appIcon.toDataURL() : await fileIcon(windowApp?.path ?? null),
      displayId: source.display_id,
      app: windowApp ? { pid: windowApp.pid, name: windowApp.name } : null,
    });
  }
  return result;
}

async function audioApps(): Promise<AudioApp[]> {
  const apps = await engine.apps();
  const selfTree = process.pid;
  const result: AudioApp[] = [];
  for (const a of apps) {
    // Pendant une capture, Windows liste aussi le moteur audio : il ne produit aucun son, le proposer n'aurait aucun sens.
    if (a.pid === selfTree || path.basename(a.path ?? "").toLowerCase() === "spokaaudio.exe") continue;
    result.push({ pid: a.pid, name: a.name, title: a.title, peak: a.peak, icon: await fileIcon(a.path) });
  }
  return result;
}

/** La page refuse de parler à YouTube (CSP) : c'est ici qu'on vérifie la vidéo et qu'on récupère son titre. */
async function youtubeInfo(videoId: string): Promise<YoutubeInfo | null> {
  if (!/^[\w-]{11}$/.test(videoId)) return null;
  const url = `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(`https://www.youtube.com/watch?v=${videoId}`)}`;
  const response = await net.fetch(url).catch(() => null);
  if (!response?.ok) return null;
  const data = (await response.json().catch(() => null)) as { title?: string } | null;
  return data?.title ? { title: data.title } : null;
}

/** SpokaSoundBoard vit à côté : on regarde seulement s'il est là, sans jamais y toucher. */
async function soundboardInfo(): Promise<SoundboardInfo> {
  const installed = !!statSync(path.join(app.getPath("home"), "AppData", "Local", "Programs", "SpokaSoundBoard", "SpokaSoundBoard.exe"), { throwIfNoEntry: false });
  const running = await new Promise<boolean>(resolve => execFile("tasklist", ["/FI", "IMAGENAME eq SpokaSoundBoard.exe", "/NH"], { windowsHide: true, timeout: 4000 }, (_e, stdout) => resolve(/SpokaSoundBoard\.exe/i.test(stdout))));
  return { installed, running };
}

function applyScale() {
  mainWindow?.webContents.setZoomFactor(settings.current.uiScale);
}

function diagnostics() {
  const lines = [
    `SpokaStream ${app.getVersion()} (${app.isPackaged ? "installé" : "développement"})`,
    `Windows ${os.release()} · ${os.cpus()[0]?.model ?? "?"} · ${Math.round(os.totalmem() / 2 ** 30)} Go`,
    `Electron ${process.versions.electron} · Chromium ${process.versions.chrome}`,
    `Moteur audio : ${engine.status}`,
    `Serveur : ${settings.current.serverUrl}`,
    `GPU : ${JSON.stringify(app.getGPUFeatureStatus())}`,
  ];
  return lines.join("\n");
}

function wireIpc() {
  ipcMain.on("sync:info", e => {
    e.returnValue = { version: app.getVersion(), isPackaged: app.isPackaged, selfPid: process.pid, testMode: !!testDataDir, noNative: !!testDataDir && process.env.SPOKASTREAM_NO_NATIVE === "1", forceRelay: !!testDataDir && process.env.SPOKASTREAM_FORCE_RELAY === "1" };
  });
  ipcMain.handle("settings:get", () => settings.current);
  ipcMain.handle("settings:set", (_e, patch: Partial<Settings>) => {
    const before = settings.current;
    const next = settings.update(patch);
    if (patch.hotkeys || patch.scenes) registerHotkeys(next);
    if (patch.startWithWindows !== undefined || patch.startMinimized !== undefined) applyLoginItem(next);
    if (patch.uiScale !== undefined) applyScale();
    if (next !== before) for (const w of BrowserWindow.getAllWindows()) w.webContents.send("settings:changed", next);
    return next;
  });

  ipcMain.handle("settings:reset", () => {
    const next = settings.reset();
    registerHotkeys(next);
    applyLoginItem(next);
    applyScale();
    for (const w of BrowserWindow.getAllWindows()) w.webContents.send("settings:changed", next);
    return next;
  });
  ipcMain.on("open-data", () => void shell.openPath(app.getPath("userData")));

  ipcMain.handle("sources:list", () => listSources());
  ipcMain.handle("audio:status", () => engine.status);
  ipcMain.handle("audio:apps", () => audioApps());
  ipcMain.handle("audio:capture-start", (e, mode: "include" | "exclude", pid: number) => engine.startCapture(e.sender, mode, pid));
  ipcMain.handle("audio:capture-stop", (_e, captureId: number) => engine.stopCapture(captureId));
  ipcMain.handle("audio:watch-keys", (_e, keys: number[]) => engine.watchKeys(keys));
  ipcMain.handle("video:start", (_e, request: NativeVideoRequest) => {
    const isWindow = request.sourceId.startsWith("window:");
    const display = screen.getAllDisplays().find(d => String(d.id) === request.displayId) ?? screen.getPrimaryDisplay();
    const center = screen.dipToScreenPoint({ x: display.bounds.x + display.bounds.width / 2, y: display.bounds.y + display.bounds.height / 2 });
    const target = isWindow ? { hwnd: Number(request.sourceId.split(":")[1]) } : { x: Math.round(center.x), y: Math.round(center.y) };
    return engine.startVideo(target, request.fps, request.maxHeight).catch(e => {
      console.warn(`capture native indisponible : ${e.message}`);
      return null;
    });
  });
  ipcMain.handle("video:configure", (_e, fps: number, maxHeight: number) => engine.configureVideo(fps, maxHeight).catch(() => {}));
  ipcMain.handle("video:stop", (_e, url: string) => engine.stopVideo(url).catch(() => {}));
  ipcMain.handle("control:arm", async (_e, target: ControlTarget) => {
    const display = screen.getAllDisplays().find(d => String(d.id) === target.displayId) ?? screen.getPrimaryDisplay();
    const center = screen.dipToScreenPoint({ x: display.bounds.x + display.bounds.width / 2, y: display.bounds.y + display.bounds.height / 2 });
    const armed = await engine.armInput(target.hwnd ? { hwnd: Number(target.hwnd) } : { x: Math.round(center.x), y: Math.round(center.y) }, process.pid).then(() => true, () => false);
    return armed;
  });
  ipcMain.on("control:input", (_e, events: unknown) => {
    if (Array.isArray(events)) engine.input(events.slice(0, 256));
  });
  ipcMain.on("regie:on-top", (_e, onTop: boolean) => regieWindow?.setAlwaysOnTop(onTop, "screen-saver"));
  ipcMain.on("control:disarm", () => void engine.disarmInput().catch(() => {}));
  engine.on("inputBlocked", blocked => toRenderer("control:blocked", blocked));
  ipcMain.handle("obs:info", () => ({
    url: whip.port ? `http://127.0.0.1:${whip.port}/whip` : null,
    key: settings.current.obsKey,
    addresses: Object.values(os.networkInterfaces())
      .flatMap(entries => entries ?? [])
      .filter(entry => entry.family === "IPv4" && !entry.internal)
      .map(entry => entry.address),
  }));
  ipcMain.on("obs:answer", (_e, id: string, sdp: string | null) => whip.answer(id, sdp));
  whip.on("offer", (id, sdp) => toRenderer("obs:offer", id, sdp));
  whip.on("end", id => toRenderer("obs:end", id));
  engine.on("videoEnded", url => toRenderer("video:ended", url));
  engine.on("status", status => toRenderer("audio:status", status));
  engine.on("key", (key, down) => toRenderer("audio:key", key, down));

  ipcMain.on("window:show", showWindow);
  ipcMain.on("tray:set", (_e, state: TrayState) => tray?.update(state));
  ipcMain.on("notify", (_e, request: NotifyRequest) => {
    if (!Notification.isSupported()) return;
    const notification = new Notification({ title: request.title, body: request.body, icon: appIcon(), silent: true });
    notification.on("click", () => {
      showWindow();
      if (request.roomId) toRenderer("notification-click", request.roomId);
    });
    notification.show();
  });

  ipcMain.handle("overlay:open", (_e, target: OverlayTarget) => overlay.open(target));
  ipcMain.on("overlay:close", () => overlay.close());
  ipcMain.on("overlay:send", (_e, event: OverlayEvent) => overlay.send(event));

  ipcMain.handle("record:start", (_e, fileName: string) => {
    const dir = settings.current.recordingsDir;
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, path.basename(fileName));
    const id = nextRecording++;
    recordings.set(id, createWriteStream(file));
    return { id, path: file };
  });
  ipcMain.handle("record:write", (_e, id: number, chunk: ArrayBuffer) => {
    const stream = recordings.get(id);
    if (!stream) return;
    return new Promise<void>(resolve => {
      if (stream.write(Buffer.from(chunk))) resolve();
      else stream.once("drain", resolve);
    });
  });
  ipcMain.handle("record:stop", (_e, id: number) => {
    const stream = recordings.get(id);
    recordings.delete(id);
    return new Promise<void>(resolve => (stream ? stream.end(resolve) : resolve()));
  });
  ipcMain.handle("screenshot:save", (_e, fileName: string, png: ArrayBuffer) => {
    const dir = settings.current.recordingsDir;
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, path.basename(fileName));
    writeFileSync(file, Buffer.from(png));
    return file;
  });
  ipcMain.handle("youtube:info", (_e, videoId: string) => youtubeInfo(videoId));
  ipcMain.handle("video:info", (_e, url: string) => videoInfo(url));
  ipcMain.handle("soundboard:info", () => soundboardInfo());
  ipcMain.handle("web:open", (_e, url: string) => webSource.open(url));
  ipcMain.on("web:close", () => webSource.close());
  webSource.onClosed = () => toRenderer("web:closed");
  ipcMain.on("reveal", (_e, file: string) => {
    if (statSync(file, { throwIfNoEntry: false })) shell.showItemInFolder(file);
  });
  ipcMain.handle("pick-folder", async () => {
    const result = await dialog.showOpenDialog(mainWindow!, { properties: ["openDirectory", "createDirectory"] });
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });

  ipcMain.on("update:check", () => void updater.check());
  ipcMain.on("update:install", () => {
    quitting = true;
    updater.install();
  });
  ipcMain.handle("update:status", () => updater.status);
  updater.on("status", status => toRenderer("update:status", status));

  ipcMain.handle("host:status", () => host.status);
  ipcMain.handle("host:start", (_e, port: number) => host.start(port));
  ipcMain.handle("host:stop", () => host.stop());

  ipcMain.on("open-external", (_e, url: string) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
  });
  ipcMain.on("copy-text", (_e, text: string) => clipboard.writeText(text));
  ipcMain.on("log", (_e, line: string) => logLine(line));
  ipcMain.handle("diagnostics", diagnostics);
}

app.whenReady().then(() => {
  settings = new SettingsStore();
  // Le lecteur YouTube est une page tierce : il n'a jamais droit au micro, à la caméra ni à l'écran.
  const isOurPage = (url: string | undefined) => !url || url.startsWith("file:") || (!!process.env.ELECTRON_RENDERER_URL && url.startsWith(new URL(process.env.ELECTRON_RENDERER_URL).origin));
  const allowed = (permission: string, url: string | undefined) => (permission === "media" || permission === "display-capture" ? isOurPage(url) : ["notifications", "fullscreen", "clipboard-sanitized-write", "speaker-selection"].includes(permission));
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback, details) => callback(allowed(permission, details.requestingUrl)));
  session.defaultSession.setPermissionCheckHandler((_wc, permission, origin) => allowed(permission, origin));

  // La seule capture demandée par la page sans passer par une source choisie : celle du site à diffuser, son compris.
  session.defaultSession.setDisplayMediaRequestHandler((_request, callback) => {
    const frame = webSource.frame;
    if (frame) callback({ video: frame, audio: frame });
    else callback({});
  });

  wireIpc();
  engine.start();
  void whip.start();
  mainWindow = createMainWindow(process.argv.includes("--hidden"), e => {
    if (quitting || !settings.current.closeToTray) return;
    e.preventDefault();
    mainWindow?.hide();
  });
  mainWindow.webContents.on("did-create-window", (child, details) => {
    if (details.frameName !== "spoka-regie") return;
    regieWindow = child;
    child.on("closed", () => (regieWindow = null));
    child.setAlwaysOnTop(settings.current.regie.onTop, "screen-saver");
  });
  mainWindow.webContents.once("did-finish-load", () => {
    applyScale();
    if (pendingDeepLink) toRenderer("deep-link", pendingDeepLink);
    pendingDeepLink = null;
  });
  mainWindow.on("closed", () => {
    mainWindow = null;
    app.quit();
  });
  const firstLink = deepLinkCode(process.argv);
  if (firstLink) pendingDeepLink = firstLink;

  tray = new AppTray(
    showWindow,
    () => {
      quitting = true;
      app.quit();
    },
    action => toRenderer("tray-action", action),
  );
  registerHotkeys(settings.current);
  if (!testDataDir) updater.start();
});

app.on("before-quit", () => {
  quitting = true;
  settings?.flush();
  engine.stop();
  overlay.close();
  webSource.close();
  void host.stop();
  whip.stop();
  for (const stream of recordings.values()) stream.end();
  globalShortcut.unregisterAll();
  for (const contents of webContents.getAllWebContents()) contents.setBackgroundThrottling(false);
});
