import { app, BrowserWindow, nativeImage, screen, shell } from "electron";
import type { Display } from "electron";
import path from "node:path";
import type { OverlayEvent, OverlayRegion, OverlayTarget } from "../shared/ipc.ts";
import type { AudioEngine } from "./audioEngine.ts";

const preload = path.join(import.meta.dirname, "../preload/index.cjs");
const rendererUrl = process.env.ELECTRON_RENDERER_URL;

export function appIcon() {
  const file = app.isPackaged ? path.join(process.resourcesPath, "icon.png") : path.join(app.getAppPath(), "build", "icon.png");
  return nativeImage.createFromPath(file);
}

function load(win: BrowserWindow, hash = "") {
  if (rendererUrl) void win.loadURL(`${rendererUrl}#${hash}`);
  else void win.loadFile(path.join(import.meta.dirname, "../renderer/index.html"), { hash });
}

const webPreferences = {
  preload,
  contextIsolation: true,
  sandbox: true,
  // Sans ça, Chromium ralentit tout dès qu'un jeu passe devant la fenêtre : le stream s'effondrerait.
  backgroundThrottling: false,
};

export function createMainWindow(startHidden: boolean, onCloseRequest: (e: Electron.Event) => void) {
  const win = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 960,
    minHeight: 620,
    show: false,
    title: "SpokaStream",
    icon: appIcon(),
    backgroundColor: "#0b0d14",
    titleBarStyle: "hidden",
    titleBarOverlay: { color: "#00000000", symbolColor: "#9aa3b8", height: 40 },
    webPreferences,
  });
  win.removeMenu();
  win.on("close", onCloseRequest);
  win.once("ready-to-show", () => {
    if (!startHidden) win.show();
  });

  win.webContents.setWindowOpenHandler(({ url, frameName }) => {
    if (frameName.startsWith("spoka-popout")) {
      return {
        action: "allow",
        overrideBrowserWindowOptions: {
          width: 480,
          height: 270,
          frame: false,
          resizable: true,
          alwaysOnTop: true,
          skipTaskbar: false,
          backgroundColor: "#000000",
          title: "SpokaStream",
          icon: appIcon(),
          webPreferences: { backgroundThrottling: false },
        },
      };
    }
    if (frameName === "spoka-regie") {
      return {
        action: "allow",
        overrideBrowserWindowOptions: { width: 1180, height: 760, minWidth: 360, minHeight: 300, backgroundColor: "#0b0d14", title: "Régie SpokaStream", icon: appIcon(), webPreferences: { backgroundThrottling: false } },
      };
    }
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("did-create-window", (child, details) => {
    child.removeMenu();
    // La régie reste hors de toute capture : une liste de spectateurs ou des notes ne doivent pas se retrouver à l'image.
    child.setContentProtection(true);
    if (details.frameName === "spoka-regie") return;
    child.setAlwaysOnTop(true, "screen-saver");
    child.setAspectRatio(16 / 9);
  });
  win.webContents.on("will-navigate", (e, url) => {
    if (url !== win.webContents.getURL()) e.preventDefault();
  });

  // Le processus de la page peut tomber, sur un pilote fragile par exemple : sans ça, il ne reste qu'une fenêtre vide.
  win.webContents.on("render-process-gone", (_event, details) => {
    console.error(`page tombée : ${details.reason}`);
    if (details.reason !== "clean-exit" && !win.isDestroyed()) load(win);
  });

  load(win);
  return win;
}

/**
 * Fenêtre transparente au-dessus du jeu : réactions, messages et dessins des spectateurs.
 * Elle laisse passer tous les clics et elle est exclue de la capture, sinon les spectateurs la verraient en double.
 *
 * Elle couvre toujours un écran entier et ne change jamais de taille : pour suivre une fenêtre capturée, c'est son
 * contenu qui se place. La redimensionner figeait la page principale du diffuseur (mesuré, overlay coupé : plus de gel).
 */
export class Overlay {
  private win: BrowserWindow | null = null;
  private tracker: NodeJS.Timeout | null = null;
  private displayId = 0;
  private region: OverlayRegion | null = null;
  private target: OverlayTarget | null = null;
  private readonly engine: AudioEngine;

  constructor(engine: AudioEngine) {
    this.engine = engine;
  }

  async open(target: OverlayTarget) {
    this.close();
    this.target = target;
    const display = screen.getAllDisplays().find(d => String(d.id) === target.displayId) ?? screen.getPrimaryDisplay();
    this.create(display);
    if (target.hwnd) this.follow(target.hwnd);
  }

  private create(display: Display) {
    this.win?.destroy();
    this.displayId = display.id;
    const target = this.target!;
    const win = new BrowserWindow({
      ...display.bounds,
      show: false,
      frame: false,
      transparent: true,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      focusable: false,
      skipTaskbar: true,
      hasShadow: false,
      alwaysOnTop: true,
      webPreferences,
    });
    // Windows rogne la zone de la barre des tâches à la création : les dessins seraient décalés sur un écran partagé.
    win.setBounds(display.bounds);
    win.setAlwaysOnTop(true, "screen-saver");
    win.setIgnoreMouseEvents(true);
    win.setContentProtection(true);
    win.once("ready-to-show", () => {
      win.showInactive();
      win.webContents.send("overlay:event", { type: "settings", settings: target.settings } satisfies OverlayEvent);
      if (this.region) win.webContents.send("overlay:event", { type: "region", region: this.region } satisfies OverlayEvent);
    });
    load(win, "overlay");
    this.win = win;
  }

  /** Une fenêtre capturée peut bouger : le contenu du calque la suit pour que les dessins restent au bon endroit. */
  private follow(hwnd: string) {
    const update = async () => {
      const rect = await this.engine.windowRect(hwnd).catch(() => null);
      if (!rect || !this.win || rect.width <= 0) return;
      const dip = screen.screenToDipRect(null, rect);
      const display = screen.getDisplayMatching(dip);
      if (display.id !== this.displayId) this.create(display);
      const region: OverlayRegion = { x: dip.x - display.bounds.x, y: dip.y - display.bounds.y, width: dip.width, height: dip.height };
      if (JSON.stringify(region) === JSON.stringify(this.region)) return;
      this.region = region;
      this.send({ type: "region", region });
    };
    void update();
    this.tracker = setInterval(() => void update(), 250);
  }

  send(event: OverlayEvent) {
    if (this.win && !this.win.isDestroyed()) this.win.webContents.send("overlay:event", event);
  }

  close() {
    if (this.tracker) clearInterval(this.tracker);
    this.tracker = null;
    this.region = null;
    if (this.win && !this.win.isDestroyed()) this.win.destroy();
    this.win = null;
  }
}
