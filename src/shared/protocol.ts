// Protocole entre l'application et le serveur de salons. Le serveur ne voit jamais passer la vidéo ni le son :
// il présente les participants les uns aux autres, puis tout circule directement de PC à PC (ou par le relais TURN).

export const PROTOCOL_VERSION = 1;

export const LIMITS = {
  name: 32,
  roomName: 48,
  title: 80,
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
} as const;

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
}

export type SourceKind = "screen" | "window" | "camera" | "file";
export type AudioKind = "none" | "system" | "apps" | "input" | "file";

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
  /** Par émoji, les personnes qui ont réagi. */
  reactions?: Record<string, string[]>;
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
}

/** Une vidéo regardée ensemble : chacun la lit chez lui, en pleine qualité, et le salon garde la même position. */
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

export interface RoomStatus {
  id: string;
  name: string;
  code: string;
  members: number;
  /** Qui est là, pour l'accueil : nom et couleur suffisent, les avatars pèseraient trop. */
  online: { name: string; color: string }[];
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
  | "stream_not_found";

interface Rid {
  rid?: number;
}

export type ClientMessage =
  | ({ t: "hello"; protocol: number; token: string; profile: Profile } & Rid)
  | ({ t: "room.create"; name: string } & Rid)
  | ({ t: "room.join"; code?: string; id?: string } & Rid)
  | { t: "room.leave" }
  | { t: "room.update"; name?: string; settings?: Partial<RoomSettings> }
  | { t: "room.delete" }
  | { t: "room.kick"; userId: string; ban: boolean }
  | { t: "room.subscribe"; ids: string[] }
  | { t: "profile.update"; profile: Profile }
  | { t: "voice.set"; voice: VoiceState | null }
  | { t: "chat.send"; text: string; replyTo?: string | null; image?: string | null }
  | { t: "chat.delete"; id: string }
  | { t: "chat.react"; id: string; emoji: string }
  | { t: "chat.pin"; id: string | null }
  | { t: "chat.typing" }
  | { t: "poll.create"; question: string; options: string[] }
  | { t: "poll.vote"; id: string; option: number }
  | { t: "poll.close"; id: string }
  | { t: "poll.dismiss"; id: string }
  | { t: "together.add"; videoId: string; title: string }
  | { t: "together.control"; playing: boolean; position: number }
  | { t: "together.next"; videoId: string }
  | { t: "together.stop" }
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
  | { t: "welcome"; userId: string; iceServers: IceServer[]; serverName: string }
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
