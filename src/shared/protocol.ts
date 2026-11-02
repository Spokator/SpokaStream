// Protocole entre l'application et le serveur de salons. Le serveur ne voit jamais passer la vidéo ni le son :
// il présente les participants les uns aux autres, puis tout circule directement de PC à PC (ou par le relais TURN).

// Version 2 : la bulle caméra ajoute un second flux vidéo, qu'une application 1.0 prendrait pour l'image du stream.
// La 1.2 reste en version 2 : ses clips et sa prise en main sont des ajouts qu'une 1.1 ignore sans rien casser.
export const PROTOCOL_VERSION = 2;
/** Signée par Microsoft : contrairement à l'installeur GitHub, elle ne déclenche pas l'alerte de Windows. */
export const STORE_URL = "https://apps.microsoft.com/detail/9PKH6GKMMQDN";

export const LIMITS = {
  name: 32,
  roomName: 48,
  title: 120,
  url: 2048,
  chat: 2000,
  history: 200,
  avatarBytes: 96_000,
  thumbBytes: 96_000,
  wsPayload: 512_000,
  roomsPerUser: 50,
  membersPerRoom: 32,
  /** Une image collée dans le chat, encodée : le serveur n'en garde que les dernières, et jamais sur disque. */
  image: 400_000,
  imagesPerRoom: 12,
  pollQuestion: 120,
  pollOption: 60,
  pollOptions: 6,
  reactionsPerMessage: 12,
  queue: 30,
  /** Taille annoncée d'un clip : il voyage de PC à PC, le serveur ne garde que sa vignette. */
  clipBytes: 120_000_000,
  clipThumb: 96_000,
} as const;

/** Ce qu'un administrateur autorise à un compte. Le serveur tient ce qu'il peut, l'application applique le reste. */
export interface AccountLimits {
  /** Total envoyé à tous les spectateurs, en kb/s. 0 : sans limite. */
  maxKbps: number;
  /** 0 : sans limite. */
  maxHeight: number;
  maxFps: number;
  maxViewers: number;
  canStream: boolean;
  canCreateRooms: boolean;
  canUseRelay: boolean;
  canWatchParty: boolean;
  /** Fin de la limite. 0 : sans fin. */
  until: number;
}

export const NO_LIMITS: AccountLimits = { maxKbps: 0, maxHeight: 0, maxFps: 0, maxViewers: 0, canStream: true, canCreateRooms: true, canUseRelay: true, canWatchParty: true, until: 0 };

export interface Profile {
  name: string;
  color: string;
  avatar: string | null;
}

export interface VoiceState {
  muted: boolean;
  deafened: boolean;
}

export type Role = "owner" | "member";

export interface Member extends Profile {
  id: string;
  role: Role;
  online: boolean;
  voice: VoiceState | null;
  /** Regarde depuis un navigateur : pas de diffusion ni de prise en main possible. */
  web?: boolean;
  /** Le compte de cet appareil : un PC et un téléphone rattachés sont la même personne. */
  account?: string;
}

export type SourceKind = "screen" | "window" | "camera" | "file" | "obs" | "web";
export type AudioKind = "none" | "system" | "apps" | "input" | "file";

/** Place de la caméra sur l'image, en fractions de sa taille. Chaque spectateur la dessine lui-même au même endroit. */
export interface CameraLayout {
  x: number;
  y: number;
  width: number;
  shape: "rect" | "round" | "circle";
  mirror: boolean;
}

export const DEFAULT_CAMERA_LAYOUT: CameraLayout = { x: 0.78, y: 0.72, width: 0.2, shape: "round", mirror: false };

export interface StreamInfo {
  id: string;
  ownerId: string;
  title: string;
  kind: SourceKind;
  sourceName: string;
  width: number;
  height: number;
  fps: number;
  audio: AudioKind;
  audioLabel: string;
  paused: boolean;
  allowDraw: boolean;
  maxViewers: number;
  startedAt: number;
  viewers: string[];
  thumb: string | null;
  /** Le diffuseur envoie sa caméra en plus de l'image : les spectateurs l'affichent en bulle. */
  camera: boolean;
  cameraLayout: CameraLayout;
  /** Texte posé sur l'image. */
  banner: string;
  /** Les spectateurs peuvent demander la main. Rien ne se passe sans l'accord du diffuseur. */
  allowControl: boolean;
  /** La personne qui a la main en ce moment. */
  controller: string | null;
}

export type StreamAnnounce = Omit<StreamInfo, "id" | "ownerId" | "startedAt" | "viewers" | "thumb">;
export type StreamPatch = Partial<StreamAnnounce>;

export interface RoomSettings {
  whoCanStream: "everyone" | "owner";
  /** Plafond de débit par diffuseur, en kb/s. 0 = libre. */
  maxKbps: number;
  /** Salon verrouillé : plus personne ne peut entrer, même avec le code. */
  locked: boolean;
}

export interface ChatMessage {
  id: string;
  authorId: string;
  authorName: string;
  authorColor: string;
  text: string;
  at: number;
  replyTo: string | null;
  kind: "user" | "system";
  /** Image collée dans le chat. Disparaît au redémarrage du serveur ou quand de nouvelles arrivent. */
  image?: string | null;
  /** Clip partagé : il reste chez son auteur et part de PC à PC quand quelqu'un l'ouvre. */
  clip?: ClipInfo | null;
  /** Par émoji, les personnes qui ont réagi. */
  reactions?: Record<string, string[]>;
}

export interface ClipInfo {
  id: string;
  title: string;
  seconds: number;
  bytes: number;
  thumb: string | null;
}

export interface Poll {
  id: string;
  question: string;
  options: { text: string; voters: string[] }[];
  authorId: string;
  authorName: string;
  closed: boolean;
}

export interface TogetherItem {
  videoId: string;
  title: string;
  byName: string;
  /** Adresse d'un fichier vidéo ou d'un flux HLS. Absente : videoId est une vidéo YouTube. */
  url?: string;
  /** Sous-titres proposés avec la vidéo, en .vtt ou .srt. */
  subtitles?: string;
}

/** La Watch Party : chacun lit la vidéo chez lui, en pleine qualité, et le salon garde la même position. */
export interface Together extends TogetherItem {
  playing: boolean;
  /** Position en secondes, au moment où le serveur a envoyé ce message. */
  position: number;
  queue: TogetherItem[];
}

export interface RoomState {
  id: string;
  code: string;
  name: string;
  ownerId: string;
  settings: RoomSettings;
  members: Member[];
  streams: StreamInfo[];
  history: ChatMessage[];
  pinned: ChatMessage | null;
  poll: Poll | null;
  together: Together | null;
}

/** Ce qu'un PC en direct montre à ses autres appareils : de quoi tenir la régie depuis un téléphone. */
export interface RemoteState {
  roomId: string;
  roomName: string;
  roomCode: string;
  title: string;
  source: string;
  startedAt: number;
  paused: boolean;
  /** Écran d'attente affiché, s'il y en a un. */
  screen: string | null;
  screens: string[];
  scene: string | null;
  scenes: { id: string; name: string }[];
  mix: { id: string; label: string; volume: number; muted: boolean }[];
  viewers: { id: string; name: string }[];
  stats: { height: number; fps: number; kbps: number; codec: string; limit: string | null } | null;
  muted: boolean;
  deafened: boolean;
  camera: boolean;
  banner: string;
  recording: boolean;
  file: { playing: boolean; time: number; duration: number } | null;
  /** Nom de qui demande la main, et de qui l'a. */
  controlAsk: string | null;
  controller: string | null;
  /** Le stream lui-même : le téléphone y envoie ses réactions. */
  streamId?: string;
  allowDraw?: boolean;
  /** Ce que le PC a confirmé avoir fait : la touche du téléphone compte sur ces chiffres, pas sur le toucher. */
  clips?: number;
  markers?: number;
  /** Le PC est allumé mais ne diffuse pas : le téléphone peut proposer de lancer le direct. */
  idle?: boolean;
  /** De quoi lancer depuis le téléphone, si le PC l'autorise. */
  launch?: { rooms: { id: string; name: string }[]; scenes: { id: string; name: string }[]; last: string | null } | null;
}

export type RemoteCommand = "pause" | "resume" | "screen" | "scene" | "mute" | "deafen" | "camera" | "record" | "clip" | "marker" | "clear" | "title" | "banner" | "mixVolume" | "mixMute" | "kick" | "stop" | "controlAccept" | "controlRefuse" | "controlEnd" | "filePlay" | "fileSeek" | "allowDraw" | "goLive";

/** Ce qu'un PC mesure de son direct. Le serveur ne voit passer aucune vidéo : pour qu'un administrateur sache comment va un stream, il faut que les appareils le disent. */
export interface PublishTelemetry {
  streamId: string;
  fps: number;
  kbps: number;
  height: number;
  codec: string;
  encoder: string;
  hardware: boolean;
  encMs: number | null;
  limit: string;
  viewers: { id: string; kbps: number; relay: boolean; protocol: string; rttMs: number | null; retransmitPct: number }[];
}

export interface WatchTelemetry {
  streamId: string;
  fps: number;
  kbps: number;
  height: number;
  lostPct: number;
  jitterMs: number;
  freezes: number;
  relay: boolean;
  protocol: string;
  rttMs: number | null;
}

export interface RoomStatus {
  id: string;
  name: string;
  code: string;
  members: number;
  /** Qui est là, pour l'accueil : nom et couleur suffisent, les avatars pèseraient trop. */
  online: { name: string; color: string }[];
  /** Le titre de la Watch Party en cours. */
  party?: string;
  live: { ownerName: string; title: string; thumb: string | null }[];
  exists: boolean;
}

export type DrawTool = "laser" | "pen";

export interface Stroke {
  id: string;
  tool: DrawTool;
  color: string;
  /** Coordonnées normalisées dans l'image : x0, y0, x1, y1… */
  points: number[];
  end: boolean;
}

export interface IceServer {
  urls: string | string[];
  username?: string;
  credential?: string;
}

export type ErrorCode =
  | "bad_request"
  | "version"
  | "not_authenticated"
  | "room_not_found"
  | "room_full"
  | "room_locked"
  | "banned"
  | "forbidden"
  | "rate_limited"
  | "too_many_rooms"
  | "viewer_limit"
  | "stream_not_found"
  | "maintenance"
  | "muted"
  | "closed"
  | "disabled";

/** Un geste de la personne qui a la main. Les coordonnées vont de 0 à 1 dans l'image. */
export type ControlInput =
  | { k: "move"; x: number; y: number }
  | { k: "rel"; x: number; y: number }
  | { k: "button"; button: 0 | 1 | 2; down: boolean }
  | { k: "wheel"; delta: number }
  | { k: "key"; code: string; down: boolean };

export type ControlScope = "window" | "screen";

/** Canal de contrôle, de PC à PC : le serveur de salons n'en voit rien. */
export type ControlToHost = { t: "ask" } | { t: "release" } | { t: "alive" } | { t: "input"; events: ControlInput[] };
export type ControlToViewer = { t: "granted"; scope: ControlScope } | { t: "refused" } | { t: "revoked" } | { t: "blocked"; blocked: boolean };

interface Rid {
  rid?: number;
}

export type ClientMessage =
  | ({ t: "hello"; protocol: number; token: string; profile: Profile; client?: "web"; version?: string; device?: string } & Rid)
  | ({ t: "room.create"; name: string } & Rid)
  | ({ t: "room.join"; code?: string; id?: string } & Rid)
  | { t: "room.leave" }
  | { t: "room.update"; name?: string; settings?: Partial<RoomSettings> }
  | { t: "room.delete" }
  | { t: "room.kick"; userId: string; ban: boolean }
  | { t: "room.subscribe"; ids: string[] }
  | { t: "profile.update"; profile: Profile }
  | { t: "voice.set"; voice: VoiceState | null }
  | { t: "chat.send"; text: string; replyTo?: string | null; image?: string | null; clip?: ClipInfo | null }
  | { t: "chat.delete"; id: string }
  | { t: "chat.react"; id: string; emoji: string }
  | { t: "chat.pin"; id: string | null }
  | { t: "chat.typing" }
  | { t: "poll.create"; question: string; options: string[] }
  | { t: "poll.vote"; id: string; option: number }
  | { t: "poll.close"; id: string }
  | { t: "poll.dismiss"; id: string }
  | { t: "together.add"; videoId?: string; url?: string; subtitles?: string; title: string }
  | { t: "together.control"; playing: boolean; position: number }
  | { t: "together.next"; videoId: string }
  | { t: "together.remove"; index: number; videoId: string }
  | { t: "together.stop" }
  | ({ t: "account.link" } & Rid)
  | ({ t: "account.claim"; code: string } & Rid)
  | ({ t: "account.devices" } & Rid)
  | ({ t: "account.revoke"; deviceId: string } & Rid)
  | ({ t: "admin.ticket" } & Rid)
  | { t: "remote.state"; state: RemoteState | null }
  | { t: "remote.cmd"; cmd: RemoteCommand; arg?: string | number | boolean }
  | { t: "report"; kind: "error" | "feedback"; text: string; details?: string }
  | { t: "telemetry"; publish?: PublishTelemetry | null; watch?: WatchTelemetry[] }
  | { t: "account.forget"; id: string }
  | ({ t: "account.delete" } & Rid)
  | { t: "push.subscribe"; endpoint: string; p256dh: string; auth: string; rooms: string[] }
  | { t: "push.unsubscribe"; endpoint: string }
  | { t: "reaction"; streamId: string | null; emoji: string }
  | { t: "draw"; streamId: string; stroke: Stroke }
  | { t: "draw.clear"; streamId: string }
  | ({ t: "stream.start"; id: string; stream: StreamAnnounce } & Rid)
  | { t: "stream.update"; patch: StreamPatch }
  | { t: "stream.stop" }
  | { t: "stream.thumb"; data: string }
  | ({ t: "stream.watch"; id: string; on: boolean; quality?: ViewerQuality; resume?: boolean } & Rid)
  | { t: "stream.quality"; id: string; quality: ViewerQuality }
  | { t: "stream.kick"; userId: string }
  | { t: "rtc"; to: string; session: string; data: unknown }
  | { t: "ping"; at: number };

/** Ce qu'un spectateur demande pour lui seul : en maillage, chaque spectateur a son propre encodage. */
export interface ViewerQuality {
  maxHeight: number;
  maxKbps: number;
  maxFps: number;
  /** false : son seul, le diffuseur cesse d'encoder l'image pour ce spectateur. */
  video: boolean;
}

export type ServerMessage =
  | { t: "ack"; rid: number; ok: boolean; error?: ErrorCode; data?: unknown }
  | { t: "welcome"; userId: string; accountId?: string; admin?: boolean; iceServers: IceServer[]; serverName: string }
  | { t: "account.sync"; profile: Profile }
  | { t: "account.limits"; limits: AccountLimits | null; iceServers: IceServer[] }
  | { t: "remote.state"; state: RemoteState | null }
  | { t: "remote.cmd"; cmd: RemoteCommand; arg?: string | number | boolean }
  /** Les salons de la personne : ils la suivent sur tous ses appareils. */
  | { t: "account.rooms"; rooms: { id: string; code: string; name: string }[] }
  /** Un appareil vient de rejoindre le compte : le PC qui montrait le QR code peut le dire. */
  | { t: "account.linked"; label: string }
  | { t: "announce"; text: string; level: "info" | "warning" }
  | { t: "room.state"; room: RoomState }
  | { t: "room.updated"; name: string; settings: RoomSettings }
  | { t: "room.closed"; reason: "deleted" | "kicked" | "banned" | "replaced" }
  | { t: "room.status"; rooms: RoomStatus[] }
  | { t: "member.join"; member: Member }
  | { t: "member.update"; member: Member }
  | { t: "member.leave"; userId: string }
  | { t: "chat"; message: ChatMessage }
  | { t: "chat.deleted"; id: string }
  | { t: "chat.reactions"; id: string; reactions: Record<string, string[]> }
  | { t: "chat.pinned"; message: ChatMessage | null }
  | { t: "chat.typing"; userId: string }
  | { t: "poll"; poll: Poll | null }
  | { t: "together"; together: Together | null }
  | { t: "reaction"; from: string; streamId: string | null; emoji: string }
  | { t: "draw"; from: string; streamId: string; stroke: Stroke }
  | { t: "draw.clear"; streamId: string }
  | { t: "stream.add"; stream: StreamInfo }
  | { t: "stream.update"; id: string; patch: Partial<StreamInfo> }
  | { t: "stream.remove"; id: string }
  | { t: "stream.thumb"; id: string; data: string }
  /** resume : le spectateur se présente de nouveau après une coupure du serveur, sa connexion vidéo est peut-être intacte. */
  | { t: "stream.viewer"; streamId: string; userId: string; on: boolean; quality: ViewerQuality | null; resume: boolean }
  | { t: "stream.quality"; streamId: string; userId: string; quality: ViewerQuality }
  | { t: "stream.kicked"; streamId: string }
  | { t: "rtc"; from: string; session: string; data: unknown }
  | { t: "pong"; at: number }
  | { t: "error"; error: ErrorCode; message?: string };

export const DEFAULT_ROOM_SETTINGS: RoomSettings = { whoCanStream: "everyone", maxKbps: 0, locked: false };
export const DEFAULT_VIEWER_QUALITY: ViewerQuality = { maxHeight: 0, maxKbps: 0, maxFps: 0, video: true };

/** Reconnaît un lien YouTube, ou un identifiant collé tel quel. */
export function youtubeId(input: string): string | null {
  const text = input.trim();
  if (/^[\w-]{11}$/.test(text)) return text;
  const match = text.match(/(?:youtu\.be\/|youtube(?:-nocookie)?\.com\/(?:watch\?(?:[^#\s]*&)?v=|shorts\/|live\/|embed\/))([\w-]{11})(?![\w-])/i);
  return match?.[1] ?? null;
}

/** Une adresse qu'un lecteur peut ouvrir : http ou https, sans identifiants glissés dedans. */
export function videoUrl(input: unknown): string | null {
  if (typeof input !== "string" || input.length > LIMITS.url) return null;
  try {
    const url = new URL(input.trim());
    return /^https?:$/.test(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch {
    return null;
  }
}

export const isHls = (url: string) => /\.m3u8(?:[?#]|$)/i.test(url);

/** Un titre lisible tiré de l'adresse, quand personne n'en donne un. */
export function titleFromUrl(url: string) {
  try {
    const { hostname, pathname } = new URL(url);
    const file = decodeURIComponent(pathname.split("/").pop() ?? "").replace(/\.[a-z0-9]{2,5}$/i, "").replace(/[._]+/g, " ").trim();
    return file || hostname;
  } catch {
    return "Vidéo";
  }
}
