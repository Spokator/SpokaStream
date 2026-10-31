import type { CameraLayout, ControlInput, Profile } from "./protocol.ts";

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
  /** Durée gardée pour les clips, en secondes. 0 : pas de clips, donc pas d'encodage en plus. */
  clipSeconds: number;
  cameraId: string;
  cameraLayout: CameraLayout;
  /** Les spectateurs peuvent demander la main. Chaque demande attend l'accord du diffuseur. */
  allowControl: boolean;
  /** L'enregistrement démarre avec le stream. */
  autoRecord: boolean;
  screens: WaitScreen[];
}

/** Ce que voient les spectateurs pendant une pause. Le son reste coupé, sauf si l'écran dit le contraire. */
export interface WaitScreen {
  title: string;
  subtitle: string;
  /** Compte à rebours affiché sur l'image. 0 : aucun. */
  minutes: number;
  keepSound: boolean;
}

export type PanelId = "actions" | "health" | "info" | "scenes" | "sources" | "screens" | "mixer" | "quality" | "audience" | "activity" | "chat" | "notes";
export type ActionId = "pause" | "record" | "clip" | "replay" | "marker" | "camera" | "mic" | "deafen" | "clearDraw" | "poll" | "invite";

/** Disposition de la régie : chaque personne a sa façon de travailler, elle la retrouve au prochain direct. */
export interface RegieLayout {
  left: PanelId[];
  center: PanelId[];
  right: PanelId[];
  hidden: PanelId[];
  collapsed: PanelId[];
  actions: ActionId[];
  notes: string;
  /** La régie s'ouvre toute seule au lancement du stream. */
  auto: boolean;
  /** La fenêtre détachée reste au-dessus du jeu. */
  onTop: boolean;
}

export const DEFAULT_REGIE: RegieLayout = {
  left: ["info", "scenes", "sources", "screens", "quality"],
  center: ["actions", "mixer"],
  right: ["health", "chat", "audience", "activity", "notes"],
  hidden: [],
  collapsed: ["info", "screens", "quality", "audience", "activity", "notes"],
  actions: ["pause", "record", "clip", "replay", "marker", "clearDraw"],
  notes: "",
  auto: false,
  onTop: false,
};

export const DEFAULT_SCREENS: WaitScreen[] = [
  { title: "Ça commence bientôt", subtitle: "Installe-toi, on arrive", minutes: 5, keepSound: true },
  { title: "Je reviens", subtitle: "Ça reprend dans un instant", minutes: 0, keepSound: false },
  { title: "Fin du stream", subtitle: "Merci d'avoir regardé", minutes: 0, keepSound: false },
];

/** Ce qu'une scène sait retrouver. Un fichier n'y figure pas : le navigateur ne peut pas le rouvrir seul. */
export type SceneSource = { kind: "screen" | "window"; id: string; name: string } | { kind: "camera"; deviceId: string; label: string } | { kind: "obs" };

export type AudioChoice =
  | { type: "system" }
  | { type: "app"; pid: number; name: string; icon: string | null }
  | { type: "device"; deviceId: string; label: string };

export interface Scene {
  id: string;
  name: string;
  /** null : la scène garde la source en cours. */
  source: SceneSource | null;
  /** Les sons de la table de mixage. Absent d'une scène enregistrée en 1.2 : elle garde le son en cours. */
  audio?: AudioChoice[];
  camera: boolean;
  cameraLayout: CameraLayout;
  banner: string;
  /** Raccourci global : changer de plan sans quitter le jeu. */
  hotkey: string;
}

export interface HotkeyMap {
  toggleMic: string;
  toggleDeafen: string;
  toggleStream: string;
  pauseStream: string;
  saveClip: string;
  /** Accepte une demande de main, ou la reprend. */
  control: string;
  marker: string;
}

export interface OverlaySettings {
  enabled: boolean;
  reactions: boolean;
  chat: boolean;
  viewers: boolean;
  corner: "top-left" | "top-right" | "bottom-left" | "bottom-right";
  /** Taille des messages et du compteur, 1 = normale. */
  size: number;
  opacity: number;
}

/** Comment une personne arrange la scène : ces réglages sont les siens, ils ne changent rien chez les autres. */
export type WallMode = "focus" | "side" | "grid" | "pip" | "free";

/** Position et taille en parts de la scène : une disposition libre survit à un changement de taille de fenêtre. */
export interface WallRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface WallSettings {
  mode: WallMode;
  /** Les personnes dans l'ordre choisi : on retrouve son arrangement au stream suivant. */
  order: string[];
  free: Record<string, WallRect>;
  /** Le diffuseur voit son propre retour. Le masquer économise un décodage. */
  showOwn: boolean;
  /** Seule l'image en grand fait du son. */
  audioFollows: boolean;
  /** Une petite image reçoit une petite définition : le diffuseur et la connexion respirent. */
  fitQuality: boolean;
  /** Ouvrir tous les streams du salon, pas seulement le premier. */
  watchAll: boolean;
}

export const DEFAULT_WALL: WallSettings = { mode: "focus", order: [], free: {}, showOwn: true, audioFollows: false, fitQuality: true, watchAll: false };

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
  /** Couleur d'accent de l'interface. */
  accent: string;
  /** Taille de l'interface, 1 = normale. */
  uiScale: number;
  /** Les bandes autour de l'image prennent ses couleurs. */
  ambient: boolean;
  theme: "dark" | "midnight" | "black";
  reduceMotion: boolean;
  /** Taille du texte du chat, en pixels. */
  chatSize: number;
  chatCompact: boolean;
  /** Volume général des streams et des voix, 1 = normal. */
  streamVolume: number;
  voiceVolume: number;
  /** Volume des petits sons de l'interface, 1 = normal. */
  sfxVolume: number;
  /** Plafond de définition en ouvrant un stream. 0 : tout ce que le diffuseur envoie. */
  watchQuality: number;
  notifyMentions: boolean;
  /** Aucune notification pendant qu'on diffuse : elles finiraient à l'image. */
  quietWhileLive: boolean;
  /** Les erreurs de l'application remontent au serveur. Jamais le chat ni ce qui est diffusé. */
  sendErrors: boolean;
  scenes: Scene[];
  /** Clé de l'entrée OBS : elle ne quitte jamais ce PC. */
  obsKey: string;
  regie: RegieLayout;
  wall: WallSettings;
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
  /** Nom de la personne qui a la main. */
  controller: string | null;
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
  | { type: "poll"; poll: { question: string; closed: boolean; options: { text: string; votes: number }[] } | null }
  | { type: "control"; text: string | null }
  | { type: "stroke"; streamId: string; from: string; color: string; tool: "laser" | "pen"; id: string; points: number[]; end: boolean }
  | { type: "clear" }
  | { type: "settings"; settings: OverlaySettings };

export interface OverlayTarget {
  displayId?: string;
  hwnd?: string;
  settings: OverlaySettings;
}

export interface ControlTarget {
  hwnd?: string;
  displayId?: string;
}

export interface ObsInfo {
  url: string | null;
  key: string;
  /** Adresses de ce PC, pour répondre à OBS sans passer par les noms masqués de Chromium. */
  addresses: string[];
}

export interface NotifyRequest {
  title: string;
  body: string;
  roomId?: string;
}

export interface YoutubeInfo {
  title: string;
}

/** Ce que cache un lien : une vidéo lisible par tout le salon, ou une page qu'il faudra diffuser. */
export interface VideoInfo {
  kind: "direct" | "page";
  url: string;
  title: string;
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
  /** Essais seulement : la capture de Chromium, qui ne sature pas le canal de DevTools. */
  noNative: boolean;
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
  controlArm(target: ControlTarget): Promise<boolean>;
  controlInput(events: ControlInput[]): void;
  controlDisarm(): void;
  onControlBlocked(cb: (blocked: boolean) => void): () => void;
  regieOnTop(onTop: boolean): void;
  obsInfo(): Promise<ObsInfo>;
  obsAnswer(id: string, sdp: string | null): void;
  onObsOffer(cb: (id: string, sdp: string) => void): () => void;
  onObsEnd(cb: (id: string) => void): () => void;

  setTray(state: TrayState): void;
  showWindow(): void;
  /** Une action de HotkeyMap, ou scene:identifiant. */
  onHotkey(cb: (action: string) => void): () => void;
  onTrayAction(cb: (action: "toggleMic" | "toggleDeafen" | "stopStream" | "pauseStream" | "leaveRoom" | "revokeControl") => void): () => void;
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
  /** null : la vidéo n'existe pas, ou YouTube interdit de la lire ailleurs que sur son site. */
  youtubeInfo(videoId: string): Promise<YoutubeInfo | null>;
  /** null : le lien ne répond pas. */
  videoInfo(url: string): Promise<VideoInfo | null>;
  /** Ouvre la page à diffuser. La capture qui suit vise cette page, et rien d'autre. */
  webOpen(url: string): Promise<boolean>;
  webClose(): void;
  soundboardInfo(): Promise<SoundboardInfo>;
  /** Revient aux réglages d'origine en gardant le profil, les salons, les scènes et les clés. */
  resetSettings(): Promise<Settings>;
  openDataFolder(): void;
  onWebClosed(cb: () => void): () => void;
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

export const DEFAULT_SERVER = "wss://stream.chretieno.fr/ws";

const VIRTUAL_INPUT = /CABLE|VB-Audio|Voicemeeter|Virtual Audio|\bLine \d/i;

/** Une entrée qui transporte déjà un mélange préparé : le micro virtuel de SpokaSoundBoard, par exemple. */
export const isVirtualInput = (label: string) => VIRTUAL_INPUT.test(label);

/** État de SpokaSoundBoard sur ce PC. */
export interface SoundboardInfo {
  installed: boolean;
  running: boolean;
}

// Un raccourci global s'empare de la combinaison partout : Ctrl+Maj+M est celui de Discord, Ctrl+Maj+P celui de VS Code.
export const DEFAULT_HOTKEYS: HotkeyMap = {
  toggleMic: "Ctrl+Alt+M",
  toggleDeafen: "Ctrl+Alt+D",
  toggleStream: "Ctrl+Alt+S",
  pauseStream: "Ctrl+Alt+P",
  saveClip: "Ctrl+Alt+C",
  control: "Ctrl+Alt+A",
  marker: "Ctrl+Alt+X",
};
