import { app } from "electron";
import electronUpdater from "electron-updater";
import { EventEmitter } from "node:events";
import type { UpdateStatus } from "../shared/ipc.ts";

const { autoUpdater } = electronUpdater;
const CHECK_EVERY_MS = 6 * 3600 * 1000;

/** Mises à jour depuis les releases GitHub. Téléchargées en arrière-plan, appliquées à la fermeture ou sur demande. */
export class Updater extends EventEmitter<{ status: [UpdateStatus] }> {
  status: UpdateStatus = { state: app.isPackaged ? "idle" : "unsupported" };

  start() {
    if (!app.isPackaged) return;
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.on("checking-for-update", () => this.set({ state: "checking" }));
    autoUpdater.on("update-not-available", () => this.set({ state: "none" }));
    autoUpdater.on("update-available", info => this.set({ state: "downloading", percent: 0, version: info.version }));
    autoUpdater.on("download-progress", p => {
      if (this.status.state === "downloading") this.set({ ...this.status, percent: Math.round(p.percent) });
    });
    autoUpdater.on("update-downloaded", info => this.set({ state: "ready", version: info.version }));
    autoUpdater.on("error", e => this.set({ state: "error", message: e.message }));
    void this.check();
    setInterval(() => void this.check(), CHECK_EVERY_MS).unref();
  }

  async check() {
    if (!app.isPackaged) return;
    await autoUpdater.checkForUpdates().catch(e => this.set({ state: "error", message: String(e?.message ?? e) }));
  }

  install() {
    if (this.status.state === "ready") autoUpdater.quitAndInstall(true, true);
  }

  private set(status: UpdateStatus) {
    this.status = status;
    this.emit("status", status);
  }
}
