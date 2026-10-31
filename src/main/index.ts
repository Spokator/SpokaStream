import { app, BrowserWindow, clipboard, desktopCapturer, dialog, globalShortcut, ipcMain, Notification, screen, session, shell, webContents } from "electron";
import { appendFileSync, createWriteStream, mkdirSync, statSync, writeFileSync } from "node:fs";
import type { WriteStream } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AudioApp, CaptureSource, HotkeyMap, NativeVideoRequest, NotifyRequest, OverlayEvent, OverlayTarget, Settings, TrayState } from "../shared/ipc.ts";
import { AudioEngine } from "./audioEngine.ts";
import { LocalHost } from "./host.ts";
import { SettingsStore } from "./settings.ts";
import { AppTray } from "./tray.ts";
import { Updater } from "./updater.ts";
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
let tray: AppTray | null = null;
let quitting = false;
let pendingDeepLink: string | null = null;
const engine = new AudioEngine();
const overlay = new Overlay(engine);
const updater = new Updater();
const host = new LocalHost();
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

function registerHotkeys(map: HotkeyMap) {
  globalShortcut.unregisterAll();
  for (const [action, accelerator] of Object.entries(map)) {
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
    if (a.pid === selfTree) continue;
    result.push({ pid: a.pid, name: a.name, title: a.title, peak: a.peak, icon: await fileIcon(a.path) });
  }
  return result;
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
    e.returnValue = { version: app.getVersion(), isPackaged: app.isPackaged, selfPid: process.pid, testMode: !!testDataDir, forceRelay: !!testDataDir && process.env.SPOKASTREAM_FORCE_RELAY === "1" };
  });
  ipcMain.handle("settings:get", () => settings.current);
  ipcMain.handle("settings:set", (_e, patch: Partial<Settings>) => {
    const before = settings.current;
    const next = settings.update(patch);
    if (patch.hotkeys) registerHotkeys(next.hotkeys);
    if (patch.startWithWindows !== undefined || patch.startMinimized !== undefined) applyLoginItem(next);
    if (next !== before) for (const w of BrowserWindow.getAllWindows()) w.webContents.send("settings:changed", next);
    return next;
  });

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
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(["media", "display-capture", "notifications", "fullscreen", "clipboard-sanitized-write", "speaker-selection"].includes(permission));
  });
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => ["media", "display-capture", "notifications", "fullscreen", "speaker-selection"].includes(permission));

  wireIpc();
  engine.start();
  mainWindow = createMainWindow(process.argv.includes("--hidden"), e => {
    if (quitting || !settings.current.closeToTray) return;
    e.preventDefault();
    mainWindow?.hide();
  });
  mainWindow.webContents.once("did-finish-load", () => {
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
  registerHotkeys(settings.current.hotkeys);
  if (!testDataDir) updater.start();
});

app.on("before-quit", () => {
  quitting = true;
  settings?.flush();
  engine.stop();
  overlay.close();
  void host.stop();
  for (const stream of recordings.values()) stream.end();
  globalShortcut.unregisterAll();
  for (const contents of webContents.getAllWebContents()) contents.setBackgroundThrottling(false);
});
