import { app } from "electron";
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DEFAULT_HOTKEYS } from "../shared/ipc.ts";
import type { Settings } from "../shared/ipc.ts";

const COLORS = ["#7c5cff", "#22d3ee", "#34d399", "#f59e0b", "#f472b6", "#fb7185", "#a78bfa", "#60a5fa"];

function defaults(): Settings {
  return {
    token: randomBytes(32).toString("hex"),
    profile: { name: "", color: COLORS[Math.floor(Math.random() * COLORS.length)]!, avatar: null },
    onboarded: false,
    serverUrl: process.env.SPOKASTREAM_SERVER ?? "wss://stream.chretieno.fr/ws",
    startWithWindows: false,
    startMinimized: false,
    closeToTray: true,
    notifyLive: true,
    notifyMessages: false,
    soundEffects: true,
    autoWatch: true,
    micId: "default",
    outputId: "default",
    voiceMode: "open",
    pttKey: 0x56,
    pttKeyName: "V",
    noiseSuppression: true,
    echoCancellation: true,
    autoGain: true,
    voiceKbps: 96,
    latency: "balanced",
    stream: {
      resolution: "source",
      fps: 60,
      kbps: 12_000,
      codec: "auto",
      priority: "motion",
      audioKbps: 256,
      maxViewers: 0,
      allowDraw: true,
      normalizeAudio: false,
      clipSeconds: 30,
      cameraId: "",
    },
    hotkeys: DEFAULT_HOTKEYS,
    overlay: { enabled: true, reactions: true, chat: true, viewers: true, corner: "top-right" },
    recordingsDir: path.join(app.getPath("videos"), "SpokaStream"),
    recentRooms: [],
    chatPanelOpen: true,
    accent: "#7c5cff",
    uiScale: 1,
    ambient: true,
  };
}

/** Réglages locaux. Le jeton d'identité n'existe que sur ce PC : le perdre revient à repartir d'un nouveau profil. */
export class SettingsStore {
  private readonly file = path.join(app.getPath("userData"), "settings.json");
  private value: Settings;
  private timer: NodeJS.Timeout | null = null;

  constructor() {
    const base = defaults();
    try {
      const saved = JSON.parse(readFileSync(this.file, "utf8")) as Partial<Settings>;
      this.value = {
        ...base,
        ...saved,
        profile: { ...base.profile, ...saved.profile },
        stream: { ...base.stream, ...saved.stream },
        hotkeys: { ...base.hotkeys, ...saved.hotkeys },
        overlay: { ...base.overlay, ...saved.overlay },
      };
      if (process.env.SPOKASTREAM_SERVER) this.value.serverUrl = process.env.SPOKASTREAM_SERVER;
    } catch {
      this.value = base;
      this.flush();
    }
  }

  get current() {
    return this.value;
  }

  update(patch: Partial<Settings>) {
    this.value = { ...this.value, ...patch };
    this.timer ??= setTimeout(() => this.flush(), 300);
    return this.value;
  }

  flush() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.value, null, 2));
    renameSync(tmp, this.file);
  }
}
