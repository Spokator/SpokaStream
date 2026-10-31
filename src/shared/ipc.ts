import type { Profile } from "./protocol.ts";

export type Resolution = "source" | "720" | "1080" | "1440" | "2160";
export type VideoPriority = "motion" | "detail";
export type CodecChoice = "auto" | "video/AV1" | "video/H265" | "video/H264" | "video/VP9";
export type LatencyMode = "ultra" | "balanced" | "stable";

export interface StreamDefaults {
  resolution: Resolution;
  fps: number;
  kbps: number;
  codec: CodecChoice;
  priority: VideoPriority;
  audioKbps: number;
  maxViewers: number;
  allowDraw: boolean;
  normalizeAudio: boolean;
}

export interface HotkeyMap {
  toggleMic: string;
  toggleDeafen: string;
  toggleStream: string;
  pauseStream: string;
}

export interface OverlaySettings {
  enabled: boolean;
  reactions: boolean;
  chat: boolean;
  viewers: boolean;
  corner: "top-left" | "top-right" | "bottom-left" | "bottom-right";
}

export interface RecentRoom {
  id: string;
  name: string;
  code: string;
  at: number;
}

export interface Settings {
  token: string;
  profile: Profile;
  onboarded: boolean;
  serverUrl: string;
  startWithWindows: boolean;
  startMinimized: boolean;
  closeToTray: boolean;
  notifyLive: boolean;
  notifyMessages: boolean;
  soundEffects: boolean;
  autoWatch: boolean;
  micId: string;
  outputId: string;
  voiceMode: "open" | "ptt";
  pttKey: number;
  pttKeyName: string;
  noiseSuppression: boolean;
  echoCancellation: boolean;
  autoGain: boolean;
  voiceKbps: number;
  latency: LatencyMode;
  stream: StreamDefaults;
  hotkeys: HotkeyMap;
  overlay: OverlaySettings;
  recordingsDir: string;
  recentRooms: RecentRoom[];
  chatPanelOpen: boolean;
}

export interface CaptureSource {
  id: string;
  name: string;
  kind: "screen" | "window";
  thumbnail: string;
  icon: string | null;
  displayId: string;
  app: { pid: number; name: string } | null;
}

export interface AudioApp {
  pid: number;
  name: string;
  title: string | null;
  icon: string | null;
  peak: number;
}

export type AudioEngineStatus = "starting" | "ready" | "unavailable";

export interface TrayState {
  roomName: string | null;
  live: boolean;
  paused: boolean;
  muted: boolean;
  deafened: boolean;
  viewers: number;
}

export type UpdateStatus =
  | { state: "idle" | "checking" | "none" | "unsupported" }
  | { state: "downloading"; percent: number; version: string }
  | { state: "ready"; version: string }
  | { state: "error"; message: string };

export interface HostStatus {
  running: boolean;
  port: number;
  addresses: string[];
  error: string | null;
}

/** Zone de la fenêtre capturée dans le calque, en points de l'écran. */
export interface OverlayRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type OverlayEvent =
  | { type: "region"; region: OverlayRegion }
  | { type: "reaction"; emoji: string; name: string }
  | { type: "chat"; name: string; color: string; text: string }
  | { type: "viewers"; count: number; names: string[] }
  | { type: "stroke"; streamId: string; from: string; color: string; tool: "laser" | "pen"; id: string; points: number[]; end: boolean }
  | { type: "clear" }
  | { type: "settings"; settings: OverlaySettings };

export interface OverlayTarget {
  displayId?: string;
  hwnd?: string;
  settings: OverlaySettings;
}

export interface NotifyRequest {
  title: string;
  body: string;
  roomId?: string;
}

export interface NativeVideoRequest {
  sourceId: string;
  displayId: string;
  fps: number;
  maxHeight: number;
}

export interface NativeVideo {
  url: string;
  width: number;
  height: number;
}

export interface SpokaApi {
  version: string;
  isPackaged: boolean;
  selfPid: number;
  testMode: boolean;
  forceRelay: boolean;
  getSettings(): Promise<Settings>;
  setSettings(patch: Partial<Settings>): Promise<Settings>;
  onSettings(cb: (settings: Settings) => void): () => void;

  listSources(): Promise<CaptureSource[]>;
  audioStatus(): Promise<AudioEngineStatus>;
  onAudioStatus(cb: (status: AudioEngineStatus) => void): () => void;
  audioApps(): Promise<AudioApp[]>;
  startCapture(mode: "include" | "exclude", pid: number): Promise<number>;
  stopCapture(captureId: number): Promise<void>;
  watchKeys(keys: number[]): Promise<void>;
  onKey(cb: (key: number, down: boolean) => void): () => void;
  /** Rend null quand la capture de Chromium sera meilleure : Windows trop ancien, ou définition trop lourde. */
  startNativeVideo(request: NativeVideoRequest): Promise<NativeVideo | null>;
  configureNativeVideo(fps: number, maxHeight: number): Promise<void>;
  stopNativeVideo(url: string): Promise<void>;
  onNativeVideoEnded(cb: (url: string) => void): () => void;

  setTray(state: TrayState): void;
  showWindow(): void;
  onHotkey(cb: (action: keyof HotkeyMap) => void): () => void;
  onTrayAction(cb: (action: "toggleMic" | "toggleDeafen" | "stopStream" | "pauseStream" | "leaveRoom") => void): () => void;
  onDeepLink(cb: (code: string) => void): () => void;
  onNotificationClick(cb: (roomId: string) => void): () => void;
  notify(request: NotifyRequest): void;

  overlayOpen(target: OverlayTarget): Promise<void>;
  overlayClose(): void;
  overlaySend(event: OverlayEvent): void;
  onOverlayEvent(cb: (event: OverlayEvent) => void): () => void;

  recordStart(fileName: string): Promise<{ id: number; path: string }>;
  recordWrite(id: number, chunk: ArrayBuffer): Promise<void>;
  recordStop(id: number): Promise<void>;
  saveScreenshot(fileName: string, png: ArrayBuffer): Promise<string>;
  reveal(path: string): void;
  pickFolder(): Promise<string | null>;

  updateCheck(): void;
  updateInstall(): void;
  updateStatus(): Promise<UpdateStatus>;
  onUpdateStatus(cb: (status: UpdateStatus) => void): () => void;

  hostStatus(): Promise<HostStatus>;
  hostStart(port: number): Promise<HostStatus>;
  hostStop(): Promise<HostStatus>;

  openExternal(url: string): void;
  copyText(text: string): void;
  logLine(line: string): void;
  diagnostics(): Promise<string>;
}

// Un raccourci global s'empare de la combinaison partout : Ctrl+Maj+M est celui de Discord, Ctrl+Maj+P celui de VS Code.
export const DEFAULT_HOTKEYS: HotkeyMap = {
  toggleMic: "Ctrl+Alt+M",
  toggleDeafen: "Ctrl+Alt+D",
  toggleStream: "Ctrl+Alt+S",
  pauseStream: "Ctrl+Alt+P",
};
