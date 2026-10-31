import { Menu, Tray, nativeImage } from "electron";
import type { TrayState } from "../shared/ipc.ts";
import { appIcon } from "./windows.ts";

type TrayAction = "toggleMic" | "toggleDeafen" | "stopStream" | "pauseStream" | "leaveRoom" | "revokeControl";

export class AppTray {
  private readonly tray: Tray;
  private state: TrayState = { roomName: null, live: false, paused: false, muted: false, deafened: false, viewers: 0, controller: null };
  private readonly onShow: () => void;
  private readonly onQuit: () => void;
  private readonly onAction: (action: TrayAction) => void;

  constructor(onShow: () => void, onQuit: () => void, onAction: (action: TrayAction) => void) {
    this.onShow = onShow;
    this.onQuit = onQuit;
    this.onAction = onAction;
    const icon = appIcon();
    this.tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon.resize({ width: 16, height: 16, quality: "best" }));
    this.tray.on("click", onShow);
    this.render();
  }

  update(state: TrayState) {
    this.state = state;
    this.render();
  }

  private render() {
    const s = this.state;
    const status = s.live
      ? `${s.paused ? "⏸ En pause" : "🔴 En direct"} · ${s.viewers} spectateur${s.viewers > 1 ? "s" : ""}`
      : s.roomName
        ? `Dans ${s.roomName}`
        : "Aucun salon";
    this.tray.setToolTip(`SpokaStream\n${status}`);
    this.tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: status, enabled: false },
        { type: "separator" },
        { label: "Ouvrir SpokaStream", click: this.onShow },
        { type: "separator" },
        { label: "Micro coupé", type: "checkbox", checked: s.muted, click: () => this.onAction("toggleMic") },
        { label: "Sourdine", type: "checkbox", checked: s.deafened, click: () => this.onAction("toggleDeafen") },
        ...(s.controller ? ([{ type: "separator" }, { label: `Reprendre la main à ${s.controller}`, click: () => this.onAction("revokeControl") }] as const) : []),
        ...(s.live
          ? ([
              { type: "separator" },
              { label: s.paused ? "Reprendre le stream" : "Mettre le stream en pause", click: () => this.onAction("pauseStream") },
              { label: "Arrêter le stream", click: () => this.onAction("stopStream") },
            ] as const)
          : []),
        ...(s.roomName ? ([{ type: "separator" }, { label: "Quitter le salon", click: () => this.onAction("leaveRoom") }] as const) : []),
        { type: "separator" },
        { label: "Quitter SpokaStream", click: this.onQuit },
      ]),
    );
  }

  destroy() {
    this.tray.destroy();
  }
}
