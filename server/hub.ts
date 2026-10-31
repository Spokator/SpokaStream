import { createHash, randomBytes, randomInt } from "node:crypto";
import {
  DEFAULT_CAMERA_LAYOUT,
  DEFAULT_ROOM_SETTINGS,
  DEFAULT_VIEWER_QUALITY,
  LIMITS,
  PROTOCOL_VERSION,
  videoUrl,
  youtubeId,
} from "../src/shared/protocol.ts";
import type {
  CameraLayout,
  ChatMessage,
  ClientMessage,
  ClipInfo,
  ErrorCode,
  IceServer,
  Member,
  Poll,
  Profile,
  RoomSettings,
  RoomState,
  RoomStatus,
  ServerMessage,
  StreamAnnounce,
  StreamInfo,
  StreamPatch,
  RemoteState,
  PublishTelemetry,
  Together,
  TogetherItem,
  ViewerQuality,
  WatchTelemetry,
} from "../src/shared/protocol.ts";
import { Accounts } from "./accounts.ts";
import { DEFAULT_CONFIG, maskWords, olderThan } from "./config.ts";
import type { ConfigStore, ServerConfig } from "./config.ts";
import type { Journal } from "./journal.ts";
import type { Metrics } from "./metrics.ts";
import type { PushService } from "./push.ts";
import type { Store, StoredRoom } from "./store.ts";
import type { Usage } from "./usage.ts";

const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const GRACE_MS = 20_000;
const ROOM_MAX_IDLE_MS = 90 * 24 * 3600 * 1000;
/** Une vignette toutes les 6 s chez chaque abonné serait du gaspillage : l'accueil n'a pas besoin d'être si frais. */
const STATUS_THUMB_MS = 30_000;

export interface Transport {
  send(data: string): void;
  close(code: number, reason: string): void;
  ip: string;
}

/** Seau à jetons : rafales courtes permises, débit moyen plafonné. */
class Bucket {
  private tokens: number;
  private last: number;
  private readonly rate: number;
  private readonly burst: number;
  constructor(rate: number, burst: number, now: number) {
    this.rate = rate;
    this.burst = burst;
    this.tokens = burst;
    this.last = now;
  }
  take(now: number) {
    this.tokens = Math.min(this.burst, this.tokens + ((now - this.last) / 1000) * this.rate);
    this.last = now;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}

interface Conn {
  transport: Transport;
  /** L'appareil : c'est lui qui est dans un salon et que WebRTC adresse. */
  userId: string | null;
  /** La personne : droits, bannissements et profil se décident ici. */
  accountId: string | null;
  /** Ce que ce PC montre à ses autres appareils pendant qu'il diffuse. */
  remote: RemoteState | null;
  device: { client: "app" | "web"; version: string; label: string };
  profile: Profile | null;
  web: boolean;
  room: Room | null;
  subscriptions: Set<string>;
  /** Serveur fermé : cet appareil inconnu peut se rattacher à un compte, mais pas entrer dans un salon. */
  guest: boolean;
  lastChat: number;
  telemetry: { at: number; publish: PublishTelemetry | null; watch: WatchTelemetry[] } | null;
  buckets: Record<"chat" | "image" | "draw" | "reaction" | "signal" | "room" | "misc", Bucket>;
}

interface LiveMember {
  member: Member;
  conn: Conn | null;
  grace: NodeJS.Timeout | null;
}

interface Room {
  data: StoredRoom;
  members: Map<string, LiveMember>;
  streams: Map<string, StreamInfo>;
  qualities: Map<string, Map<string, ViewerQuality>>;
  poll: Poll | null;
  together: LiveTogether | null;
  statusThumbAt: number;
}

/** position vaut à l'instant anchor : le serveur calcule la position réelle au moment d'envoyer. */
interface LiveTogether extends Together {
  anchor: number;
}

export interface HubOptions {
  store: Store;
  push?: PushService;
  accounts?: Accounts;
  /** Les comptes qui ont accès au panneau d'administration. */
  admins?: string[];
  config?: ConfigStore;
  metrics?: Metrics;
  usage?: Usage;
  journal?: Journal;
  iceServers: (userId: string) => IceServer[];
  serverName?: string;
  graceMs?: number;
  now?: () => number;
}

const isString = (v: unknown, max: number): v is string => typeof v === "string" && v.length <= max;
/** Après un redémarrage, les streams en cours s'annoncent à nouveau : ce ne sont pas des nouvelles. */
const PUSH_QUIET_AFTER_BOOT_MS = 60_000;
const REMOTE_STATE_BYTES = 16_000;
const TELEMETRY_FRESH_MS = 30_000;
const MAX_LOGS = 2000;
const MAX_REPORTS = 300;
const MAX_REPORT_DETAILS = 20_000;

export interface LogEntry {
  at: number;
  level: "info" | "warning" | "error";
  topic: string;
  text: string;
}

export interface Report {
  id: string;
  at: number;
  kind: "error" | "feedback";
  name: string;
  accountId: string;
  client: "app" | "web";
  text: string;
  details: string;
}
const clean = (v: unknown, max: number) => (typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max) : "");
const isDataImage = (v: unknown, max: number): v is string =>
  typeof v === "string" && v.length <= max && /^data:image\/(png|jpeg|webp);base64,[a-z0-9+/=]+$/i.test(v);
const isColor = (v: unknown): v is string => typeof v === "string" && /^#[0-9a-f]{6}$/i.test(v);
const clampNumber = (v: unknown, min: number, max: number, fallback: number) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : fallback;
};

const cleanTelemetryPath = (v: { relay?: unknown; protocol?: unknown; rttMs?: unknown; kbps?: unknown }) => ({ kbps: clampNumber(v.kbps, 0, 1_000_000, 0), relay: v.relay === true, protocol: clean(v.protocol, 8), rttMs: v.rttMs == null ? null : clampNumber(v.rttMs, 0, 60_000, 0) });

function cleanPublishTelemetry(p: Partial<PublishTelemetry> | null | undefined): PublishTelemetry | null {
  if (!p || typeof p !== "object" || !isString(p.streamId, 64)) return null;
  return {
    streamId: p.streamId,
    fps: clampNumber(p.fps, 0, 480, 0),
    kbps: clampNumber(p.kbps, 0, 1_000_000, 0),
    height: clampNumber(p.height, 0, 4320, 0),
    codec: clean(p.codec, 16),
    encoder: clean(p.encoder, 48),
    hardware: p.hardware === true,
    encMs: p.encMs == null ? null : clampNumber(p.encMs, 0, 10_000, 0),
    limit: clean(p.limit, 16),
    viewers: (Array.isArray(p.viewers) ? p.viewers : []).slice(0, LIMITS.membersPerRoom).filter(v => v && isString(v.id, 32)).map(v => ({ id: v.id, ...cleanTelemetryPath(v), retransmitPct: Math.max(0, Math.min(100, Number(v.retransmitPct) || 0)) })),
  };
}

function cleanWatchTelemetry(list: unknown): WatchTelemetry[] {
  return (Array.isArray(list) ? (list as Partial<WatchTelemetry>[]) : [])
    .slice(0, 8)
    .filter(w => w && isString(w.streamId, 64))
    .map(w => ({ streamId: w.streamId!, ...cleanTelemetryPath(w), fps: clampNumber(w.fps, 0, 480, 0), height: clampNumber(w.height, 0, 4320, 0), lostPct: Math.max(0, Math.min(100, Number(w.lostPct) || 0)), jitterMs: clampNumber(w.jitterMs, 0, 60_000, 0), freezes: clampNumber(w.freezes, 0, 1_000_000, 0) }));
}

function cleanProfile(p: Partial<Profile> | undefined): Profile {
  return {
    name: clean(p?.name, LIMITS.name) || "Invité",
    color: isColor(p?.color) ? p!.color : "#7c5cff",
    avatar: isDataImage(p?.avatar, LIMITS.avatarBytes) ? p!.avatar : null,
  };
}

function cleanQuality(q: Partial<ViewerQuality> | undefined): ViewerQuality {
  return {
    maxHeight: clampNumber(q?.maxHeight, 0, 4320, 0),
    maxKbps: clampNumber(q?.maxKbps, 0, 500_000, 0),
    maxFps: clampNumber(q?.maxFps, 0, 240, 0),
    video: q?.video !== false,
  };
}

function cleanLayout(l: Partial<CameraLayout> | undefined): CameraLayout {
  const part = (v: unknown, min: number, max: number, fallback: number) => (typeof v === "number" && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback);
  return {
    x: part(l?.x, 0, 1, DEFAULT_CAMERA_LAYOUT.x),
    y: part(l?.y, 0, 1, DEFAULT_CAMERA_LAYOUT.y),
    width: part(l?.width, 0.05, 1, DEFAULT_CAMERA_LAYOUT.width),
    shape: l?.shape === "rect" || l?.shape === "circle" ? l.shape : "round",
    mirror: l?.mirror === true,
  };
}

function cleanAnnounce(s: Partial<StreamAnnounce>): StreamAnnounce {
  return {
    title: clean(s.title, LIMITS.title),
    kind: s.kind === "window" || s.kind === "camera" || s.kind === "file" || s.kind === "obs" || s.kind === "web" ? s.kind : "screen",
    sourceName: clean(s.sourceName, LIMITS.title),
    width: clampNumber(s.width, 0, 8192, 0),
    height: clampNumber(s.height, 0, 4320, 0),
    fps: clampNumber(s.fps, 0, 240, 0),
    audio: s.audio === "system" || s.audio === "apps" || s.audio === "input" || s.audio === "file" ? s.audio : "none",
    audioLabel: clean(s.audioLabel, LIMITS.title),
    paused: s.paused === true,
    allowDraw: s.allowDraw !== false,
    maxViewers: clampNumber(s.maxViewers, 0, LIMITS.membersPerRoom, 0),
    camera: s.camera === true,
    cameraLayout: cleanLayout(s.cameraLayout),
    banner: clean(s.banner, LIMITS.title),
    allowControl: s.allowControl === true,
    controller: isString(s.controller, 32) && s.controller ? s.controller : null,
  };
}

function cleanClip(c: Partial<ClipInfo> | null | undefined): ClipInfo | null {
  if (!c || typeof c !== "object" || typeof c.id !== "string" || !/^[0-9a-f]{16}$/.test(c.id)) return null;
  const bytes = clampNumber(c.bytes, 0, LIMITS.clipBytes, 0);
  if (!bytes) return null;
  return { id: c.id, title: clean(c.title, LIMITS.title), seconds: clampNumber(c.seconds, 1, 600, 1), bytes, thumb: isDataImage(c.thumb, LIMITS.clipThumb) ? c.thumb : null };
}

export class Hub {
  private readonly rooms = new Map<string, Room>();
  private readonly byCode = new Map<string, string>();
  private readonly conns = new Set<Conn>();
  private readonly joinFailures = new Map<string, Bucket>();
  private readonly store: Store;
  private readonly iceServers: (userId: string) => IceServer[];
  private readonly serverName: string;
  private readonly graceMs: number;
  private readonly now: () => number;
  private readonly push?: PushService;
  private readonly bootedAt: number;
  readonly accounts: Accounts;
  private readonly admins: Set<string>;
  /** Les comptes de l'application rattachés à un accès du panneau. */
  linkedAdmin: ((accountId: string) => boolean) | null = null;
  /** Rend le billet à usage unique qui ouvre le panneau depuis l'application. */
  onTicket: ((accountId: string) => string) | null = null;
  readonly logs: LogEntry[] = [];
  readonly reports: Report[] = [];
  /** Message de maintenance : tant qu'il existe, seuls les propriétaires et les administrateurs entrent. */
  maintenance = "";
  private readonly configStore: ConfigStore | null;
  private readonly metrics?: Metrics;
  private readonly usage?: Usage;
  private readonly journal?: Journal;
  /** Pendant un direct : de quoi écrire son résumé quand il s'arrête. */
  private readonly lives = new Map<string, { peakViewers: number; kbpsSum: number; kbpsCount: number; relaySeen: number; viewersSeen: number; lossSum: number; lossCount: number }>();

  constructor(options: HubOptions) {
    this.store = options.store;
    this.push = options.push;
    this.accounts = options.accounts ?? new Accounts();
    this.configStore = options.config ?? null;
    this.metrics = options.metrics;
    this.usage = options.usage;
    this.journal = options.journal;
    this.logs.push(...(options.journal?.load() ?? []));
    this.reports.push(...(options.journal?.loadReports() ?? []));
    this.admins = new Set(options.admins ?? []);
    this.iceServers = options.iceServers;
    this.serverName = options.serverName ?? "SpokaStream";
    this.graceMs = options.graceMs ?? GRACE_MS;
    this.now = options.now ?? Date.now;
    this.bootedAt = this.now();
    const cutoff = this.now() - ROOM_MAX_IDLE_MS;
    for (const data of this.store.load()) {
      if (data.lastActivity < cutoff) continue;
      this.rooms.set(data.id, this.liveRoom(data));
      this.byCode.set(data.code, data.id);
    }
  }

  log(level: LogEntry["level"], topic: string, text: string) {
    const entry = { at: this.now(), level, topic, text };
    this.logs.unshift(entry);
    this.logs.length = Math.min(this.logs.length, MAX_LOGS);
    this.journal?.add(entry, this.logs);
  }

  get config(): ServerConfig {
    return this.configStore?.value ?? DEFAULT_CONFIG;
  }

  // ---------------------------------------------------------------- administration

  announce(text: string, level: "info" | "warning") {
    for (const conn of this.conns) if (conn.userId) this.send(conn, { t: "announce", text, level });
    this.log("info", "admin", `Annonce : ${text}`);
  }

  adminRooms() {
    return [...this.rooms.values()].map(room => ({
      id: room.data.id,
      code: room.data.code,
      name: room.data.name,
      ownerId: room.data.ownerId,
      ownerName: this.adminName(room.data.ownerId),
      locked: room.data.settings.locked,
      createdAt: room.data.createdAt,
      lastActivity: room.data.lastActivity,
      messages: room.data.history.length,
      bans: room.data.bans.length,
      party: room.together?.title ?? null,
      members: [...room.members.values()].map(({ member }) => ({ id: member.id, account: member.account ?? member.id, name: member.name, color: member.color, online: member.online, web: !!member.web, voice: !!member.voice })),
      streams: [...room.streams.values()].map(s => ({ id: s.id, ownerId: s.ownerId, ownerName: room.members.get(s.ownerId)?.member.name ?? "?", title: s.title, kind: s.kind, width: s.width, height: s.height, fps: s.fps, viewers: s.viewers.length, startedAt: s.startedAt, paused: s.paused })),
      liveMinutes: room.data.liveMinutes ?? 0,
    }));
  }

  /** Ce qu'il faut pour modérer un salon sans y entrer. */
  adminRoom(roomId: string) {
    const room = this.rooms.get(roomId);
    if (!room) return null;
    return {
      name: room.data.name,
      settings: room.data.settings,
      history: room.data.history.slice(-200).map(m => ({ id: m.id, at: m.at, kind: m.kind, name: m.authorName, color: m.authorColor, text: m.text, image: !!m.image, clip: !!m.clip })),
      poll: room.poll ? { id: room.poll.id, question: room.poll.question, closed: room.poll.closed } : null,
      together: room.together ? { title: room.together.title, playing: room.together.playing, queue: room.together.queue.length } : null,
      bans: room.data.bans.map(id => ({ id, name: this.adminName(id) })),
    };
  }

  /** Comment va chaque direct, vu des deux côtés : ce que le diffuseur envoie et ce que chaque spectateur reçoit vraiment. */
  adminHealth() {
    const now = this.now();
    const fresh = (conn: Conn | null | undefined) => (conn?.telemetry && now - conn.telemetry.at < TELEMETRY_FRESH_MS ? conn.telemetry : null);
    return [...this.rooms.values()].flatMap(room =>
      [...room.streams.values()].map(stream => {
        const owner = room.members.get(stream.ownerId);
        const sent = fresh(owner?.conn)?.publish;
        const publish = sent?.streamId === stream.id ? sent : null;
        return {
          id: stream.id,
          roomId: room.data.id,
          room: room.data.name,
          ownerId: stream.ownerId,
          owner: owner?.member.name ?? "?",
          title: stream.title,
          kind: stream.kind,
          startedAt: stream.startedAt,
          paused: stream.paused,
          announced: { width: stream.width, height: stream.height, fps: stream.fps },
          publish: publish && { fps: publish.fps, kbps: publish.kbps, height: publish.height, codec: publish.codec, encoder: publish.encoder, hardware: publish.hardware, encMs: publish.encMs, limit: publish.limit },
          viewers: stream.viewers.map(id => {
            const live = room.members.get(id);
            const sentTo = publish?.viewers.find(v => v.id === id);
            const seen = fresh(live?.conn)?.watch.find(w => w.streamId === stream.id);
            return { id, name: live?.member.name ?? "?", web: !!live?.member.web, kbps: seen?.kbps ?? sentTo?.kbps ?? null, fps: seen?.fps ?? null, height: seen?.height ?? null, lostPct: seen?.lostPct ?? null, jitterMs: seen?.jitterMs ?? null, freezes: seen?.freezes ?? null, relay: seen?.relay ?? sentTo?.relay ?? null, protocol: seen?.protocol || sentTo?.protocol || "", rttMs: seen?.rttMs ?? sentTo?.rttMs ?? null };
          }),
        };
      }),
    );
  }

  /** Le résumé de l'instant : ce que les courbes du panneau gardent. Tous ces chiffres sont déclarés par les appareils. */
  telemetrySummary() {
    let relayed = 0;
    let direct = 0;
    let relayKbps = 0;
    let streamKbps = 0;
    let loss = 0;
    let losses = 0;
    let rtt = 0;
    let rtts = 0;
    for (const health of this.adminHealth()) {
      for (const viewer of health.viewers) {
        if (viewer.relay === true) {
          relayed++;
          relayKbps += viewer.kbps ?? 0;
        } else if (viewer.relay === false) direct++;
        streamKbps += viewer.kbps ?? 0;
        if (viewer.lostPct !== null) {
          loss += viewer.lostPct;
          losses++;
        }
        if (viewer.rttMs !== null) {
          rtt += viewer.rttMs;
          rtts++;
        }
      }
    }
    return { relayed, direct, relayKbps, streamKbps, lossPct: losses ? +(loss / losses).toFixed(2) : null, rttMs: rtts ? Math.round(rtt / rtts) : null };
  }

  /** Une minute de plus au compteur : qui diffuse, qui regarde, et ce qu'il faudra écrire à la fin de chaque direct. */
  tickUsage() {
    const usage = this.usage;
    let viewers = 0;
    let streams = 0;
    let parties = 0;
    const health = this.adminHealth();
    for (const room of this.rooms.values()) {
      if (room.together?.playing) parties++;
      if (room.streams.size) room.data.liveMinutes = (room.data.liveMinutes ?? 0) + 1;
      for (const stream of room.streams.values()) {
        streams++;
        viewers += stream.viewers.length;
        this.accounts.addStats(room.members.get(stream.ownerId)?.member.account ?? stream.ownerId, { streamMinutes: 1 });
        for (const id of stream.viewers) this.accounts.addStats(room.members.get(id)?.member.account ?? id, { watchMinutes: 1 });
        const row = health.find(h => h.id === stream.id);
        const live = this.lives.get(stream.id);
        if (!live || !row) continue;
        live.peakViewers = Math.max(live.peakViewers, stream.viewers.length);
        if (row.publish) {
          live.kbpsSum += row.publish.kbps;
          live.kbpsCount++;
        }
        for (const viewer of row.viewers) {
          if (viewer.relay !== null) live.viewersSeen++;
          if (viewer.relay === true) live.relaySeen++;
          if (viewer.lostPct !== null) {
            live.lossSum += viewer.lostPct;
            live.lossCount++;
          }
        }
      }
    }
    if (!usage) return;
    const summary = this.telemetrySummary();
    usage.count("streamMinutes", streams);
    usage.count("watchMinutes", viewers);
    usage.count("partyMinutes", parties);
    usage.count("relayMinutes", summary.relayed);
    usage.count("directMinutes", summary.direct);
    usage.peak("peakStreams", streams);
    usage.peak("peakViewers", viewers);
    usage.connections(this.conns.size);
  }

  adminMute(accountId: string, until: number, reason: string, by: string) {
    if (until && this.isAdminAccount(accountId)) return false;
    if (!this.accounts.setMuted(accountId, until, reason)) return false;
    this.accounts.addSanction(accountId, { at: this.now(), kind: until ? "mute" : "unmute", by, reason, until });
    for (const conn of this.conns) if (conn.accountId === accountId && until) this.send(conn, { t: "announce", text: reason ? `Tu ne peux plus écrire pour l'instant : ${reason}` : "Tu ne peux plus écrire pour l'instant.", level: "warning" });
    return true;
  }

  adminWarn(accountId: string, text: string, by: string) {
    this.accounts.addSanction(accountId, { at: this.now(), kind: "warn", by, reason: text, until: 0 });
    return this.adminMessage(accountId, text);
  }

  adminDeleteMessage(roomId: string, id: string) {
    const room = this.rooms.get(roomId);
    const index = room?.data.history.findIndex(m => m.id === id) ?? -1;
    if (!room || index < 0) return false;
    room.data.history.splice(index, 1);
    if (room.data.pinned?.id === id) {
      room.data.pinned = null;
      this.broadcast(room, { t: "chat.pinned", message: null });
    }
    this.persist();
    this.broadcast(room, { t: "chat.deleted", id });
    return true;
  }

  adminClearChat(roomId: string) {
    const room = this.rooms.get(roomId);
    if (!room) return false;
    for (const message of room.data.history.splice(0)) this.broadcast(room, { t: "chat.deleted", id: message.id });
    this.persist();
    return true;
  }

  adminRoomSay(roomId: string, text: string) {
    const room = this.rooms.get(roomId);
    if (!room) return false;
    this.pushSystem(room, text);
    return true;
  }

  adminRoomSettings(roomId: string, patch: { whoCanStream?: unknown; maxKbps?: unknown }) {
    const room = this.rooms.get(roomId);
    if (!room) return false;
    room.data.settings = { ...room.data.settings, whoCanStream: patch.whoCanStream === "owner" ? "owner" : patch.whoCanStream === "everyone" ? "everyone" : room.data.settings.whoCanStream, maxKbps: patch.maxKbps === undefined ? room.data.settings.maxKbps : clampNumber(patch.maxKbps, 0, 500_000, 0) };
    this.persist();
    this.broadcast(room, { t: "room.updated", name: room.data.name, settings: room.data.settings });
    return true;
  }

  adminStopAll(roomId: string) {
    const room = this.rooms.get(roomId);
    if (!room) return false;
    for (const stream of [...room.streams.values()]) this.stopStreamOf(room, stream.ownerId);
    return true;
  }

  adminStopParty(roomId: string) {
    const room = this.rooms.get(roomId);
    if (!room?.together) return false;
    room.together = null;
    this.pushTogether(room);
    return true;
  }

  adminClosePoll(roomId: string) {
    const room = this.rooms.get(roomId);
    if (!room?.poll) return false;
    room.poll.closed = true;
    this.broadcast(room, { t: "poll", poll: room.poll });
    return true;
  }

  /** Coupe tout de suite les connexions d'une adresse qu'on vient de bloquer. */
  adminDropIp(ip: string) {
    for (const conn of this.conns) if (conn.transport.ip === ip) conn.transport.close(4003, "admin");
  }

  private ipBlocked(ip: string) {
    const now = this.now();
    return this.config.blockedIps.some(row => row.ip === ip && (!row.until || row.until > now));
  }

  /** Ceux que le panneau a écartés et qui le sont encore. */
  adminSanctions() {
    const now = this.now();
    return this.accounts
      .list()
      .filter(a => a.banned || (a.mutedUntil && a.mutedUntil > now))
      .map(a => ({ id: a.id, name: a.name, banned: !!a.banned, banReason: a.banReason ?? "", bannedUntil: a.bannedUntil ?? 0, mutedUntil: a.mutedUntil ?? 0, muteReason: a.muteReason ?? "" }));
  }

  /** Les connexions en cours, y compris celles qui ne sont dans aucun salon. */
  adminConnections() {
    return [...this.conns].map(conn => ({ name: conn.profile?.name ?? "", accountId: conn.accountId, client: conn.web ? "site" : "application", version: conn.device.version, label: conn.device.label, ip: conn.transport.ip, room: conn.room?.data.name ?? null, guest: conn.guest }));
  }

  private adminName(accountId: string) {
    return this.accounts.profileOf(accountId)?.name ?? "?";
  }

  adminUsers() {
    const online = new Set([...this.conns].map(c => c.userId));
    return this.accounts.list().map(account => ({
      ...account,
      admin: this.isAdminAccount(account.id),
      online: account.devices.some(d => online.has(d.id)),
      rooms: [...this.rooms.values()].filter(r => r.data.ownerId === account.id).length,
    }));
  }

  /** Quelles versions tournent en ce moment : on voit tout de suite qui n'a pas pris la mise à jour. */
  adminVersions() {
    const versions: Record<string, number> = {};
    for (const conn of this.conns) {
      if (!conn.userId) continue;
      const device = this.accounts.devicesOf(conn.accountId!).find(d => d.id === conn.userId);
      const key = conn.web ? "site web" : device?.version || "application";
      versions[key] = (versions[key] ?? 0) + 1;
    }
    return versions;
  }

  adminStopStream(roomId: string, ownerId: string) {
    const room = this.rooms.get(roomId);
    if (!room) return false;
    this.stopStreamOf(room, ownerId);
    return true;
  }

  adminKick(roomId: string, userId: string) {
    const room = this.rooms.get(roomId);
    const live = room?.members.get(userId);
    if (!room || !live) return false;
    if (live.conn) {
      this.send(live.conn, { t: "room.closed", reason: "kicked" });
      live.conn.room = null;
    }
    this.removeMember(room, userId);
    return true;
  }

  adminLockRoom(roomId: string, locked: boolean) {
    const room = this.rooms.get(roomId);
    if (!room) return false;
    room.data.settings.locked = locked;
    this.persist();
    this.broadcast(room, { t: "room.updated", name: room.data.name, settings: room.data.settings });
    return true;
  }

  adminDeleteRoom(roomId: string) {
    const room = this.rooms.get(roomId);
    if (!room) return false;
    for (const live of room.members.values()) {
      if (live.grace) clearTimeout(live.grace);
      if (live.conn) {
        this.send(live.conn, { t: "room.closed", reason: "deleted" });
        live.conn.room = null;
      }
    }
    this.rooms.delete(roomId);
    this.byCode.delete(room.data.code);
    this.persist();
    return true;
  }

  adminBan(accountId: string, banned: boolean, reason = "", until = 0, by = "") {
    if ((banned && this.isAdminAccount(accountId)) || !this.accounts.setBanned(accountId, banned, reason, until)) return false;
    this.accounts.addSanction(accountId, { at: this.now(), kind: banned ? "ban" : "unban", by, reason, until });
    if (banned) this.adminDisconnect(accountId, 4003);
    return true;
  }

  adminDisconnect(accountId: string, code = 4002) {
    let count = 0;
    for (const conn of this.conns) {
      if (conn.accountId !== accountId) continue;
      conn.transport.close(code, "admin");
      count++;
    }
    return count > 0;
  }

  adminMessage(accountId: string, text: string) {
    let count = 0;
    for (const conn of this.conns) {
      if (conn.accountId !== accountId) continue;
      this.send(conn, { t: "announce", text, level: "info" });
      count++;
    }
    return count > 0;
  }

  /** Change le profil d'un compte partout où il est en ce moment : salons ouverts et appareils reliés. */
  adminProfile(accountId: string, patch: Partial<Profile>) {
    const current = this.accounts.profileOf(accountId);
    if (!current) return false;
    const profile = cleanProfile({ ...current, ...patch });
    this.accounts.setProfile(accountId, profile);
    for (const conn of this.conns) {
      if (conn.accountId !== accountId) continue;
      conn.profile = profile;
      this.send(conn, { t: "account.sync", profile });
      const live = this.liveOf(conn);
      if (live) {
        Object.assign(live.member, profile);
        this.broadcast(conn.room!, { t: "member.update", member: live.member });
      }
    }
    return true;
  }

  adminDetachDevice(accountId: string, deviceId: string) {
    if (!this.accounts.revoke(accountId, deviceId)) return false;
    for (const conn of this.conns) if (conn.userId === deviceId) conn.transport.close(4001, "revoked");
    return true;
  }

  adminDeleteAccount(accountId: string, withRooms: boolean) {
    if (this.isAdminAccount(accountId)) return false;
    this.adminDisconnect(accountId);
    if (withRooms) for (const room of [...this.rooms.values()]) if (room.data.ownerId === accountId) this.adminDeleteRoom(room.data.id);
    return this.accounts.remove(accountId);
  }

  adminRenameRoom(roomId: string, rawName: string) {
    const room = this.rooms.get(roomId);
    const name = clean(rawName, LIMITS.roomName);
    if (!room || !name) return false;
    room.data.name = name;
    this.persist();
    this.broadcast(room, { t: "room.updated", name, settings: room.data.settings });
    this.touchStatus(room);
    return true;
  }

  /** Donne un salon à un autre compte, par exemple quand son propriétaire n'est plus là. */
  adminTransferRoom(roomId: string, accountId: string) {
    const room = this.rooms.get(roomId);
    if (!room || !this.accounts.profileOf(accountId)) return false;
    room.data.ownerId = accountId;
    this.persist();
    for (const live of room.members.values()) {
      live.member.role = (live.member.account ?? live.member.id) === accountId ? "owner" : "member";
      if (live.conn) this.send(live.conn, { t: "room.state", room: this.snapshot(room) });
    }
    return true;
  }

  adminClearBans(roomId: string) {
    const room = this.rooms.get(roomId);
    if (!room) return false;
    room.data.bans = [];
    this.persist();
    return true;
  }

  get stats() {
    let members = 0;
    let streams = 0;
    let viewers = 0;
    for (const room of this.rooms.values()) {
      members += room.members.size;
      streams += room.streams.size;
      for (const stream of room.streams.values()) viewers += stream.viewers.length;
    }
    return { rooms: this.rooms.size, connections: this.conns.size, members, streams, viewers };
  }

  connect(transport: Transport) {
    const now = this.now();
    const conn: Conn = {
      transport,
      userId: null,
      accountId: null,
      remote: null,
      device: { client: "app", version: "", label: "" },
      profile: null,
      web: false,
      room: null,
      subscriptions: new Set(),
      guest: false,
      lastChat: 0,
      telemetry: null,
      buckets: {
        chat: new Bucket(3, 12, now),
        image: new Bucket(0.2, 4, now),
        draw: new Bucket(90, 180, now),
        reaction: new Bucket(6, 20, now),
        signal: new Bucket(300, 900, now),
        room: new Bucket(2, 20, now),
        misc: new Bucket(30, 90, now),
      },
    };
    this.conns.add(conn);
    if (this.metrics) this.metrics.traffic.wsOpen++;
    return conn;
  }

  disconnect(conn: Conn) {
    this.conns.delete(conn);
    if (this.metrics) this.metrics.traffic.wsClose++;
    if (conn.remote) for (const sibling of this.siblings(conn)) this.send(sibling, { t: "remote.state", state: null });
    const room = conn.room;
    if (!room || !conn.userId) return;
    const live = room.members.get(conn.userId);
    if (!live || live.conn !== conn) return;
    // Les flux vidéo passent de PC à PC : une coupure du serveur ne doit pas les interrompre.
    // On laisse donc le temps de revenir avant de considérer que la personne est partie.
    live.conn = null;
    live.member.online = false;
    this.broadcast(room, { t: "member.update", member: live.member });
    const userId = conn.userId;
    live.grace = setTimeout(() => this.removeMember(room, userId), this.graceMs);
    live.grace.unref?.();
  }

  handle(conn: Conn, raw: string) {
    let msg: ClientMessage;
    try {
      msg = JSON.parse(raw) as ClientMessage;
    } catch {
      return this.fail(conn, "bad_request");
    }
    if (!msg || typeof msg !== "object" || typeof msg.t !== "string") return this.fail(conn, "bad_request");
    if (this.metrics) {
      this.metrics.traffic.msgIn++;
      this.metrics.traffic.wsIn += raw.length;
      const row = this.metrics.messageTypes.get(msg.t);
      if (row) {
        row.count++;
        row.bytes += raw.length;
      } else if (this.metrics.messageTypes.size < 64) this.metrics.messageTypes.set(msg.t, { count: 1, bytes: raw.length });
    }
    if (msg.t === "hello") return this.onHello(conn, msg);
    if (msg.t === "ping") return this.send(conn, { t: "pong", at: Number(msg.at) || 0 });
    if (!conn.userId) return this.reply(conn, msg, false, "not_authenticated");
    try {
      this.dispatch(conn, msg);
    } catch (e) {
      console.error(`[hub] ${msg.t} :`, e);
      this.log("error", "serveur", `${msg.t} : ${String(e).slice(0, 300)}`);
      this.reply(conn, msg, false, "bad_request");
    }
  }

  private dispatch(conn: Conn, msg: ClientMessage) {
    const now = this.now();
    switch (msg.t) {
      case "room.create":
        if (!conn.buckets.room.take(now)) return this.reply(conn, msg, false, "rate_limited");
        return this.onRoomCreate(conn, msg.name, msg.rid);
      case "room.join":
        if (!conn.buckets.room.take(now)) return this.reply(conn, msg, false, "rate_limited");
        return this.onRoomJoin(conn, msg);
      case "room.leave":
        return this.leaveRoom(conn);
      case "room.update":
        return this.onRoomUpdate(conn, msg.name, msg.settings);
      case "room.delete":
        return this.onRoomDelete(conn);
      case "room.kick":
        return this.onRoomKick(conn, msg.userId, msg.ban === true);
      case "room.subscribe":
        conn.subscriptions = new Set(Array.isArray(msg.ids) ? msg.ids.filter(id => isString(id, 32)).slice(0, 100) : []);
        return this.send(conn, { t: "room.status", rooms: [...conn.subscriptions].map(id => this.statusOf(id)) });
      case "profile.update": {
        conn.profile = cleanProfile(msg.profile);
        this.accounts.setProfile(conn.accountId!, conn.profile);
        for (const device of [conn, ...this.siblings(conn)]) {
          device.profile = conn.profile;
          if (device !== conn) this.send(device, { t: "account.sync", profile: conn.profile });
          const live = this.liveOf(device);
          if (live) {
            Object.assign(live.member, conn.profile);
            this.broadcast(device.room!, { t: "member.update", member: live.member });
          }
        }
        return;
      }
      case "account.link":
        if (!conn.buckets.misc.take(now)) return this.reply(conn, msg, false, "rate_limited");
        return this.onAccountLink(conn, msg);
      case "account.claim":
        return this.onAccountClaim(conn, msg);
      case "account.devices":
        return this.reply(conn, msg, true, undefined, this.accounts.devicesOf(conn.accountId!).map(({ id, label, client, version, addedAt, lastSeen }) => ({ id, label, client, version, addedAt, lastSeen, online: [...this.conns].some(c => c.userId === id), self: id === conn.userId, primary: id === conn.accountId })));
      case "account.revoke":
        return this.onAccountRevoke(conn, msg);
      case "account.forget":
        if (isString(msg.id, 32)) this.accounts.forgetRoom(conn.accountId!, msg.id);
        return;
      case "admin.ticket":
        if (!this.isAdmin(conn.accountId!) || !this.onTicket) return this.reply(conn, msg, false, "forbidden");
        return this.reply(conn, msg, true, undefined, { ticket: this.onTicket(conn.accountId!) });
      case "remote.state":
        return this.onRemoteState(conn, msg.state);
      case "remote.cmd":
        if (!conn.buckets.misc.take(now)) return;
        for (const sibling of this.siblings(conn)) if (sibling.remote) this.send(sibling, { t: "remote.cmd", cmd: msg.cmd, arg: msg.arg });
        return;
      case "report":
        if (!conn.buckets.room.take(now) || !isString(msg.text, 4000)) return;
        this.reports.unshift({ id: randomBytes(6).toString("hex"), at: now, kind: msg.kind === "feedback" ? "feedback" : "error", name: conn.profile?.name ?? "?", accountId: conn.accountId!, client: conn.web ? "web" : "app", text: msg.text, details: isString(msg.details, MAX_REPORT_DETAILS) ? msg.details : "" });
        this.reports.length = Math.min(this.reports.length, MAX_REPORTS);
        this.journal?.saveReports(this.reports);
        return;
      case "telemetry":
        if (!conn.buckets.misc.take(now)) return;
        conn.telemetry = { at: now, publish: cleanPublishTelemetry(msg.publish), watch: cleanWatchTelemetry(msg.watch) };
        return;
      case "voice.set": {
        const live = this.liveOf(conn);
        if (!live) return;
        live.member.voice = msg.voice ? { muted: msg.voice.muted === true, deafened: msg.voice.deafened === true } : null;
        return this.broadcast(conn.room!, { t: "member.update", member: live.member });
      }
      case "chat.send":
        if (!conn.buckets.chat.take(now)) return this.fail(conn, "rate_limited");
        if ((msg.image || msg.clip) && !conn.buckets.image.take(now)) return this.fail(conn, "rate_limited");
        return this.onChat(conn, msg.text, msg.replyTo ?? null, msg.image ?? null, msg.clip ?? null);
      case "chat.delete":
        return this.onChatDelete(conn, msg.id);
      case "chat.react":
        if (!conn.buckets.reaction.take(now)) return;
        return this.onChatReact(conn, msg.id, msg.emoji);
      case "chat.pin":
        return this.onChatPin(conn, msg.id);
      case "chat.typing":
        if (conn.room && conn.buckets.misc.take(now)) this.broadcast(conn.room, { t: "chat.typing", userId: conn.userId! }, conn.userId!);
        return;
      case "poll.create":
        if (!conn.buckets.room.take(now)) return this.fail(conn, "rate_limited");
        return this.onPollCreate(conn, msg.question, msg.options);
      case "poll.vote":
        if (!conn.buckets.misc.take(now)) return;
        return this.onPollVote(conn, msg.id, msg.option);
      case "poll.close":
        return this.onPollEnd(conn, msg.id, false);
      case "poll.dismiss":
        return this.onPollEnd(conn, msg.id, true);
      case "together.add":
        if (!conn.buckets.misc.take(now)) return this.fail(conn, "rate_limited");
        return this.onTogetherAdd(conn, msg);
      case "together.control":
        if (!conn.buckets.misc.take(now)) return;
        return this.onTogetherControl(conn, msg.playing === true, msg.position);
      case "together.next":
        return this.onTogetherNext(conn, msg.videoId);
      case "push.subscribe":
        if (!conn.buckets.misc.take(now) || !conn.userId) return;
        this.push?.subscribe({ endpoint: String(msg.endpoint).slice(0, 1024), p256dh: String(msg.p256dh).slice(0, 256), auth: String(msg.auth).slice(0, 64), userId: conn.userId, rooms: (Array.isArray(msg.rooms) ? msg.rooms : []).filter(id => isString(id, 64)).slice(0, 24) });
        return;
      case "push.unsubscribe":
        if (isString(msg.endpoint, 1024)) this.push?.unsubscribe(msg.endpoint);
        return;
      case "together.remove":
        return this.onTogetherRemove(conn, msg.index, msg.videoId);
      case "together.stop":
        return this.onTogetherStop(conn);
      case "reaction": {
        const room = conn.room;
        if (!room || !isString(msg.emoji, 16) || !msg.emoji || !conn.buckets.reaction.take(now)) return;
        return this.broadcast(room, { t: "reaction", from: conn.userId!, streamId: isString(msg.streamId, 64) ? msg.streamId : null, emoji: msg.emoji });
      }
      case "draw": {
        const room = conn.room;
        const stream = room?.streams.get(msg.streamId);
        if (!room || !stream?.allowDraw || !conn.buckets.draw.take(now)) return;
        const s = msg.stroke;
        if (!s || !isString(s.id, 40) || !Array.isArray(s.points) || s.points.length > 512 || !isColor(s.color)) return;
        if (!s.points.every(p => typeof p === "number" && Number.isFinite(p))) return;
        return this.broadcast(
          room,
          { t: "draw", from: conn.userId!, streamId: stream.id, stroke: { id: s.id, tool: s.tool === "pen" ? "pen" : "laser", color: s.color, points: s.points, end: s.end === true } },
          conn.userId!,
        );
      }
      case "draw.clear": {
        const room = conn.room;
        const stream = room?.streams.get(msg.streamId);
        if (!room || !stream || (stream.ownerId !== conn.userId && !this.owns(room, conn))) return;
        return this.broadcast(room, { t: "draw.clear", streamId: stream.id });
      }
      case "stream.start":
        return this.onStreamStart(conn, msg.id, msg.stream, msg.rid);
      case "stream.update":
        return this.onStreamUpdate(conn, msg.patch);
      case "stream.stop":
        return this.stopStreamOf(conn.room, conn.userId!);
      case "stream.thumb": {
        const stream = this.streamOf(conn);
        if (!stream || !isDataImage(msg.data, LIMITS.thumbBytes) || !conn.buckets.misc.take(now)) return;
        stream.thumb = msg.data;
        this.broadcast(conn.room!, { t: "stream.thumb", id: stream.id, data: msg.data }, conn.userId!);
        if (now - conn.room!.statusThumbAt >= STATUS_THUMB_MS) {
          conn.room!.statusThumbAt = now;
          this.touchStatus(conn.room!);
        }
        return;
      }
      case "stream.watch":
        return this.onStreamWatch(conn, msg);
      case "stream.quality": {
        const room = conn.room;
        const stream = room?.streams.get(msg.id);
        if (!room || !stream || !stream.viewers.includes(conn.userId!)) return;
        const quality = cleanQuality(msg.quality);
        room.qualities.get(stream.id)?.set(conn.userId!, quality);
        const owner = room.members.get(stream.ownerId);
        if (owner?.conn) this.send(owner.conn, { t: "stream.quality", streamId: stream.id, userId: conn.userId!, quality });
        return;
      }
      case "stream.kick": {
        const room = conn.room;
        const stream = this.streamOf(conn);
        if (!room || !stream) return;
        const viewer = room.members.get(msg.userId);
        if (viewer?.conn) this.send(viewer.conn, { t: "stream.kicked", streamId: stream.id });
        return this.setViewer(room, stream, msg.userId, false, null);
      }
      case "rtc": {
        if (!conn.buckets.signal.take(now)) return;
        const target = conn.room?.members.get(msg.to);
        if (target?.conn && isString(msg.session, 80)) this.send(target.conn, { t: "rtc", from: conn.userId!, session: msg.session, data: msg.data });
        return;
      }
      default:
        return this.fail(conn, "bad_request");
    }
  }

  private onHello(conn: Conn, msg: Extract<ClientMessage, { t: "hello" }>) {
    if (msg.protocol !== PROTOCOL_VERSION) return this.reply(conn, msg, false, "version");
    if (typeof msg.token !== "string" || !/^[0-9a-f]{64}$/.test(msg.token)) return this.reply(conn, msg, false, "bad_request");
    if (this.ipBlocked(conn.transport.ip)) {
      this.reply(conn, msg, false, "banned");
      return conn.transport.close(4003, "blocked");
    }
    // Pas de compte : le jeton aléatoire de l'appareil EST l'identité. Le serveur n'en garde que l'empreinte.
    const deviceId = createHash("sha256").update(msg.token).digest("hex").slice(0, 24);
    const web = msg.client === "web";
    const device = { client: web ? ("web" as const) : ("app" as const), version: clean(msg.version, 24), label: clean(msg.device, 60) };
    const { closed, minVersion, webViewers, motd } = this.config;
    if (!web && minVersion && device.version && olderThan(device.version, minVersion)) return this.reply(conn, msg, false, "version");
    const fresh = this.accounts.isNew(deviceId);
    // Serveur fermé, ou site réservé aux comptes connus : un inconnu n'est pas enregistré. Il peut seulement présenter un code de liaison, qui en fera un appareil connu.
    const guest = fresh && (closed || (web && !webViewers));
    const known = guest ? { accountId: deviceId, profile: cleanProfile(msg.profile) } : this.accounts.seen(deviceId, cleanProfile(msg.profile), device, this.now());
    if (this.accounts.isBanned(known.accountId, this.now())) return this.reply(conn, msg, false, "banned");
    conn.userId = deviceId;
    conn.accountId = known.accountId;
    conn.device = device;
    conn.profile = known.profile;
    conn.web = web;
    conn.guest = guest;
    if (!guest) {
      this.accounts.noteIp(known.accountId, conn.transport.ip, this.now());
      this.usage?.seen(known.accountId);
      this.usage?.connections(this.conns.size);
      this.usage?.count(web ? "webConnections" : "appConnections");
      if (fresh) this.usage?.count("newAccounts");
    }
    this.send(conn, { t: "welcome", userId: deviceId, accountId: known.accountId, admin: this.isAdmin(known.accountId), iceServers: this.iceServers(deviceId), serverName: this.serverName });
    this.send(conn, { t: "account.sync", profile: known.profile });
    this.sendRooms(conn);
    // Un PC en direct passe après un PC au repos : c'est lui que le téléphone doit garder sous les yeux.
    for (const sibling of this.siblings(conn).filter(s => s.remote).sort((a, b) => Number(!!b.remote!.idle) - Number(!!a.remote!.idle))) this.send(conn, { t: "remote.state", state: sibling.remote });
    if (this.maintenance) this.send(conn, { t: "announce", text: this.maintenance, level: "warning" });
    else if (motd) this.send(conn, { t: "announce", text: motd, level: "info" });
    this.reply(conn, msg, true);
  }

  /** Les salons appartiennent à la personne, pas à l'appareil : ceux dont elle est propriétaire, puis ceux qu'elle fréquente. */
  private roomsOf(accountId: string) {
    const owned = [...this.rooms.values()].filter(room => room.data.ownerId === accountId).sort((a, b) => b.data.lastActivity - a.data.lastActivity);
    const visited = this.accounts.roomsOf(accountId).flatMap(id => this.rooms.get(id) ?? []);
    return [...new Set([...visited, ...owned])].slice(0, 24).map(room => ({ id: room.data.id, code: room.data.code, name: room.data.name }));
  }

  private sendRooms(conn: Conn) {
    if (!conn.guest) this.send(conn, { t: "account.rooms", rooms: this.roomsOf(conn.accountId!) });
  }

  private owns(room: Room, conn: Conn) {
    return room.data.ownerId === conn.accountId;
  }

  private isAdmin(accountId: string) {
    return this.isAdminAccount(accountId);
  }

  isAdminAccount(accountId: string) {
    return this.admins.has(accountId) || !!this.linkedAdmin?.(accountId);
  }

  /** Les autres appareils allumés de la même personne. */
  private siblings(conn: Conn) {
    return [...this.conns].filter(other => other !== conn && other.accountId && other.accountId === conn.accountId);
  }

  private onAccountLink(conn: Conn, msg: Extract<ClientMessage, { t: "account.link" }>) {
    this.reply(conn, msg, true, undefined, this.accounts.createLink(conn.accountId!, this.now()));
  }

  private onAccountClaim(conn: Conn, msg: Extract<ClientMessage, { t: "account.claim" }>) {
    // Le code fait 8 caractères et vit 5 minutes : on empêche surtout d'en essayer à la chaîne.
    const bucket = this.joinFailures.get(conn.transport.ip) ?? new Bucket(0.2, 12, this.now());
    this.joinFailures.set(conn.transport.ip, bucket);
    const before = conn.accountId!;
    const accountId = this.accounts.claim(String(msg.code ?? ""), conn.userId!, this.now());
    if (accountId === "same") return this.reply(conn, msg, true, undefined, { already: true });
    if (!accountId) return this.reply(conn, msg, false, bucket.take(this.now()) ? "bad_request" : "rate_limited");
    // Ce qui appartenait à l'appareil seul suit la personne.
    for (const room of this.rooms.values()) if (room.data.ownerId === before) room.data.ownerId = accountId;
    this.persist();
    conn.accountId = accountId;
    conn.guest = false;
    this.log("info", "compte", `Appareil rattaché à ${conn.profile?.name ?? "?"}`);
    this.leaveRoom(conn);
    const known = this.accounts.seen(conn.userId!, conn.profile!, conn.device, this.now());
    conn.profile = known.profile;
    this.send(conn, { t: "welcome", userId: conn.userId!, accountId, admin: this.isAdmin(accountId), iceServers: this.iceServers(conn.userId!), serverName: this.serverName });
    this.send(conn, { t: "account.sync", profile: known.profile });
    this.sendRooms(conn);
    for (const sibling of this.siblings(conn)) {
      this.send(sibling, { t: "account.linked", label: conn.device.label || "Un appareil" });
      if (sibling.remote) this.send(conn, { t: "remote.state", state: sibling.remote });
    }
    this.reply(conn, msg, true);
  }

  private onAccountRevoke(conn: Conn, msg: Extract<ClientMessage, { t: "account.revoke" }>) {
    if (!isString(msg.deviceId, 24) || !this.accounts.revoke(conn.accountId!, msg.deviceId)) return this.reply(conn, msg, false, "forbidden");
    for (const other of this.conns) if (other.userId === msg.deviceId) other.transport.close(4001, "revoked");
    this.log("info", "compte", `Appareil détaché par ${conn.profile?.name ?? "?"}`);
    this.reply(conn, msg, true);
  }

  private onRemoteState(conn: Conn, state: RemoteState | null) {
    conn.remote = state && JSON.stringify(state).length <= REMOTE_STATE_BYTES ? state : null;
    for (const sibling of this.siblings(conn)) this.send(sibling, { t: "remote.state", state: conn.remote });
  }

  private onRoomCreate(conn: Conn, rawName: string, rid?: number) {
    const name = clean(rawName, LIMITS.roomName);
    const ack = (ok: boolean, error?: ErrorCode, data?: unknown) => rid !== undefined && this.send(conn, { t: "ack", rid, ok, error, data });
    if (!name) return ack(false, "bad_request");
    if (conn.guest) return ack(false, "closed");
    if (this.maintenance && !this.isAdmin(conn.accountId!)) return ack(false, "maintenance");
    if (this.config.roomCreation === "admins" && !this.isAdmin(conn.accountId!)) return ack(false, "disabled");
    const owned = [...this.rooms.values()].filter(r => r.data.ownerId === conn.accountId).length;
    if (owned >= Math.min(this.config.maxRooms, LIMITS.roomsPerUser)) return ack(false, "too_many_rooms");
    const now = this.now();
    const data: StoredRoom = {
      id: randomBytes(9).toString("base64url"),
      code: this.newCode(),
      name,
      ownerId: conn.accountId!,
      settings: { ...DEFAULT_ROOM_SETTINGS },
      bans: [],
      history: [],
      createdAt: now,
      lastActivity: now,
    };
    const room = this.liveRoom(data);
    this.rooms.set(data.id, room);
    this.byCode.set(data.code, data.id);
    this.persist();
    this.usage?.count("roomsCreated");
    this.log("info", "salon", `${conn.profile?.name ?? "?"} crée « ${name} »`);
    this.enter(conn, room);
    ack(true, undefined, { id: data.id, code: data.code });
  }

  private onRoomJoin(conn: Conn, msg: Extract<ClientMessage, { t: "room.join" }>) {
    const code = clean(msg.code, 16).toUpperCase().replace(/[^A-Z0-9]/g, "");
    const id = isString(msg.id, 32) ? msg.id : "";
    const room = this.rooms.get(id || this.byCode.get(code) || "");
    if (conn.guest) return this.reply(conn, msg, false, "closed");
    if (!room) {
      // Un code fait 8 caractères : on empêche surtout d'en essayer à la chaîne depuis une même adresse.
      const bucket = this.joinFailures.get(conn.transport.ip) ?? new Bucket(0.2, 12, this.now());
      this.joinFailures.set(conn.transport.ip, bucket);
      return this.reply(conn, msg, false, bucket.take(this.now()) ? "room_not_found" : "rate_limited");
    }
    const userId = conn.userId!;
    if (room.data.bans.includes(conn.accountId!)) return this.reply(conn, msg, false, "banned");
    const already = room.members.has(userId);
    const isOwner = this.owns(room, conn);
    if (this.maintenance && !isOwner && !this.isAdmin(conn.accountId!)) return this.reply(conn, msg, false, "maintenance");
    if (!already && room.data.settings.locked && !isOwner) return this.reply(conn, msg, false, "room_locked");
    if (!already && room.members.size >= Math.min(this.config.maxMembers, LIMITS.membersPerRoom)) return this.reply(conn, msg, false, "room_full");
    this.enter(conn, room);
    this.reply(conn, msg, true, undefined, { id: room.data.id, code: room.data.code });
  }

  private enter(conn: Conn, room: Room) {
    if (conn.room && conn.room !== room) this.leaveRoom(conn);
    const userId = conn.userId!;
    if (this.accounts.noteRoom(conn.accountId!, room.data.id)) for (const device of [conn, ...this.siblings(conn)]) this.sendRooms(device);
    const existing = room.members.get(userId);
    if (existing) {
      if (existing.grace) clearTimeout(existing.grace);
      existing.grace = null;
      if (existing.conn && existing.conn !== conn) {
        this.send(existing.conn, { t: "room.closed", reason: "replaced" });
        existing.conn.room = null;
      }
      existing.conn = conn;
      existing.member.online = true;
      Object.assign(existing.member, conn.profile, { web: conn.web, account: conn.accountId! });
      conn.room = room;
      this.send(conn, { t: "room.state", room: this.snapshot(room) });
      this.broadcast(room, { t: "member.update", member: existing.member }, userId);
      return;
    }
    const member: Member = {
      ...conn.profile!,
      id: userId,
      role: this.owns(room, conn) ? "owner" : "member",
      online: true,
      voice: null,
      web: conn.web,
      account: conn.accountId!,
    };
    room.members.set(userId, { member, conn, grace: null });
    conn.room = room;
    this.send(conn, { t: "room.state", room: this.snapshot(room) });
    this.broadcast(room, { t: "member.join", member }, userId);
    this.pushSystem(room, `${member.name} a rejoint le salon`);
    this.touchStatus(room);
  }

  private leaveRoom(conn: Conn) {
    const room = conn.room;
    if (!room || !conn.userId) return;
    conn.room = null;
    const live = room.members.get(conn.userId);
    if (live?.conn === conn) this.removeMember(room, conn.userId);
  }

  private removeMember(room: Room, userId: string) {
    const live = room.members.get(userId);
    if (!live) return;
    if (live.grace) clearTimeout(live.grace);
    this.stopStreamOf(room, userId);
    for (const stream of room.streams.values()) this.setViewer(room, stream, userId, false, null);
    room.members.delete(userId);
    this.broadcast(room, { t: "member.leave", userId });
    this.pushSystem(room, `${live.member.name} a quitté le salon`);
    this.touchStatus(room);
  }

  private onRoomUpdate(conn: Conn, name?: string, settings?: Partial<RoomSettings>) {
    const room = conn.room;
    if (!room || !this.owns(room, conn)) return this.fail(conn, "forbidden");
    if (name !== undefined) room.data.name = clean(name, LIMITS.roomName) || room.data.name;
    if (settings) {
      room.data.settings = {
        whoCanStream: settings.whoCanStream === "owner" ? "owner" : settings.whoCanStream === "everyone" ? "everyone" : room.data.settings.whoCanStream,
        maxKbps: settings.maxKbps === undefined ? room.data.settings.maxKbps : clampNumber(settings.maxKbps, 0, 500_000, 0),
        locked: settings.locked === undefined ? room.data.settings.locked : settings.locked === true,
      };
    }
    this.persist();
    this.broadcast(room, { t: "room.updated", name: room.data.name, settings: room.data.settings });
    this.touchStatus(room);
  }

  private onRoomDelete(conn: Conn) {
    const room = conn.room;
    if (!room || !this.owns(room, conn)) return this.fail(conn, "forbidden");
    for (const live of room.members.values()) {
      if (live.grace) clearTimeout(live.grace);
      if (live.conn) {
        this.send(live.conn, { t: "room.closed", reason: "deleted" });
        live.conn.room = null;
      }
    }
    this.rooms.delete(room.data.id);
    this.byCode.delete(room.data.code);
    this.persist();
    this.touchStatus(room);
  }

  private onRoomKick(conn: Conn, userId: string, ban: boolean) {
    const room = conn.room;
    if (!room || !this.owns(room, conn) || userId === conn.userId) return this.fail(conn, "forbidden");
    const live = room.members.get(userId);
    const account = live?.member.account ?? this.accounts.accountOf(userId);
    if (account === conn.accountId) return this.fail(conn, "forbidden");
    if (ban && !room.data.bans.includes(account)) {
      room.data.bans.push(account);
      this.persist();
    }
    if (!live) return;
    if (live.conn) {
      this.send(live.conn, { t: "room.closed", reason: ban ? "banned" : "kicked" });
      live.conn.room = null;
    }
    this.removeMember(room, userId);
  }

  private onChat(conn: Conn, rawText: unknown, replyTo: string | null, rawImage: unknown, rawClip: ClipInfo | null) {
    const room = conn.room;
    const live = this.liveOf(conn);
    if (!room || !live) return;
    if (this.accounts.isMuted(conn.accountId!, this.now())) return this.fail(conn, "muted");
    const { slowSeconds, words } = this.config;
    if (slowSeconds && !this.owns(room, conn) && this.now() - conn.lastChat < slowSeconds * 1000) return this.fail(conn, "rate_limited");
    const clip = cleanClip(rawClip);
    // Le texte d'un clip n'est lu que par les versions qui ne savent pas l'afficher.
    const written = clip ? `🎬 Clip de ${clip.seconds} s` : typeof rawText === "string" ? rawText.trim().slice(0, LIMITS.chat) : "";
    const text = maskWords(written, words);
    if (text !== written) this.log("warning", "modération", `Message de ${live.member.name} filtré dans « ${room.data.name} »`);
    const image = isDataImage(rawImage, LIMITS.image) ? rawImage : null;
    if (!text && !image) return;
    conn.lastChat = this.now();
    this.usage?.count("messages");
    this.accounts.addStats(conn.accountId!, { messages: 1 });
    const message: ChatMessage = {
      id: randomBytes(8).toString("hex"),
      authorId: live.member.id,
      authorName: live.member.name,
      authorColor: live.member.color,
      text,
      at: this.now(),
      replyTo: isString(replyTo, 24) ? replyTo : null,
      kind: "user",
      image,
      clip,
    };
    this.remember(room, message);
    this.broadcast(room, { t: "chat", message });
  }

  private onChatReact(conn: Conn, id: string, emoji: unknown) {
    const room = conn.room;
    const message = room?.data.history.find(m => m.id === id);
    if (!room || !message || message.kind !== "user" || !isString(emoji, 16) || !emoji) return;
    const reactions = (message.reactions ??= {});
    const voters = reactions[emoji] ?? [];
    if (voters.includes(conn.userId!)) {
      const rest = voters.filter(v => v !== conn.userId);
      if (rest.length) reactions[emoji] = rest;
      else delete reactions[emoji];
    } else {
      if (!voters.length && Object.keys(reactions).length >= LIMITS.reactionsPerMessage) return;
      reactions[emoji] = [...voters, conn.userId!];
    }
    this.persist();
    this.broadcast(room, { t: "chat.reactions", id, reactions });
  }

  private onChatPin(conn: Conn, id: string | null) {
    const room = conn.room;
    if (!room || !this.owns(room, conn)) return this.fail(conn, "forbidden");
    const message = id ? room.data.history.find(m => m.id === id && m.kind === "user") : null;
    if (id && !message) return;
    room.data.pinned = message ? { ...message, image: null, clip: null } : null;
    this.persist();
    this.broadcast(room, { t: "chat.pinned", message: room.data.pinned });
  }

  private onPollCreate(conn: Conn, rawQuestion: unknown, rawOptions: unknown) {
    const room = conn.room;
    const live = this.liveOf(conn);
    if (!room || !live) return;
    if (room.poll && !room.poll.closed && room.poll.authorId !== conn.userId && !this.owns(room, conn)) return this.fail(conn, "forbidden");
    const question = clean(rawQuestion, LIMITS.pollQuestion);
    const options = Array.isArray(rawOptions) ? [...new Set(rawOptions.map(o => clean(o, LIMITS.pollOption)).filter(Boolean))].slice(0, LIMITS.pollOptions) : [];
    if (!question || options.length < 2) return this.fail(conn, "bad_request");
    room.poll = { id: randomBytes(6).toString("hex"), question, options: options.map(text => ({ text, voters: [] })), authorId: conn.userId!, authorName: live.member.name, closed: false };
    this.broadcast(room, { t: "poll", poll: room.poll });
    this.pushSystem(room, `${live.member.name} a lancé un sondage`);
  }

  private onPollVote(conn: Conn, id: string, option: unknown) {
    const room = conn.room;
    const poll = room?.poll;
    if (!room || !poll || poll.id !== id || poll.closed || !Number.isInteger(option) || !poll.options[option as number]) return;
    const already = poll.options[option as number]!.voters.includes(conn.userId!);
    for (const entry of poll.options) entry.voters = entry.voters.filter(v => v !== conn.userId);
    // Un second clic sur le même choix retire le vote.
    if (!already) poll.options[option as number]!.voters.push(conn.userId!);
    this.broadcast(room, { t: "poll", poll });
  }

  private onPollEnd(conn: Conn, id: string, dismiss: boolean) {
    const room = conn.room;
    const poll = room?.poll;
    if (!room || !poll || poll.id !== id) return;
    if (poll.authorId !== conn.userId && !this.owns(room, conn)) return this.fail(conn, "forbidden");
    if (dismiss) room.poll = null;
    else poll.closed = true;
    this.broadcast(room, { t: "poll", poll: room.poll });
  }

  private canShare(room: Room, conn: Conn) {
    return room.data.settings.whoCanStream === "everyone" || this.owns(room, conn);
  }

  private togetherPosition(t: LiveTogether) {
    return t.playing ? t.position + (this.now() - t.anchor) / 1000 : t.position;
  }

  private togetherView(t: LiveTogether | null): Together | null {
    if (!t) return null;
    const { anchor: _anchor, ...view } = t;
    return { ...view, position: this.togetherPosition(t) };
  }

  private pushTogether(room: Room) {
    this.broadcast(room, { t: "together", together: this.togetherView(room.together) });
    this.touchStatus(room);
  }

  private onTogetherAdd(conn: Conn, msg: { videoId?: unknown; url?: unknown; subtitles?: unknown; title?: unknown }) {
    const room = conn.room;
    const live = this.liveOf(conn);
    if (!room || !live) return;
    if (!this.canShare(room, conn)) return this.fail(conn, "forbidden");
    if (!this.config.watchParty) return this.fail(conn, "disabled");
    const url = videoUrl(msg.url);
    const videoId = url ? randomBytes(6).toString("hex") : typeof msg.videoId === "string" ? youtubeId(msg.videoId) : null;
    if (!videoId) return this.fail(conn, "bad_request");
    const subtitles = videoUrl(msg.subtitles);
    const item: TogetherItem = { videoId, title: clean(msg.title, LIMITS.title) || "Vidéo", byName: live.member.name, ...(url ? { url } : {}), ...(subtitles ? { subtitles } : {}) };
    if (!room.together) {
      room.together = { ...item, playing: true, position: 0, anchor: this.now(), queue: [] };
      this.usage?.count("parties");
      this.pushSystem(room, `${live.member.name} lance « ${item.title} »`);
      this.notifyPhones(room, `party:${item.videoId}`, conn.userId!, `Watch Party dans ${room.data.name}`, `${live.member.name} lance « ${item.title} »`);
    } else {
      if (room.together.queue.length >= LIMITS.queue) return this.fail(conn, "bad_request");
      room.together.queue.push(item);
    }
    this.pushTogether(room);
  }

  private onTogetherControl(conn: Conn, playing: boolean, rawPosition: unknown) {
    const room = conn.room;
    const together = room?.together;
    if (!room || !together || !this.canShare(room, conn)) return;
    together.position = Number.isFinite(rawPosition) ? Math.max(0, Math.min(86_400, rawPosition as number)) : this.togetherPosition(together);
    together.anchor = this.now();
    together.playing = playing;
    this.pushTogether(room);
  }

  /** Chacun signale la fin de la vidéo : seul le premier message fait avancer, les suivants parlent d'une vidéo déjà passée. */
  private onTogetherNext(conn: Conn, videoId: string) {
    const room = conn.room;
    const together = room?.together;
    if (!room || !together || together.videoId !== videoId) return;
    const next = together.queue.shift();
    room.together = next ? { ...next, playing: true, position: 0, anchor: this.now(), queue: together.queue } : null;
    this.pushTogether(room);
  }

  private onTogetherRemove(conn: Conn, index: unknown, videoId: unknown) {
    const room = conn.room;
    const together = room?.together;
    if (!room || !together || !this.canShare(room, conn)) return;
    if (typeof index !== "number" || together.queue[index]?.videoId !== videoId) return;
    together.queue.splice(index, 1);
    this.pushTogether(room);
  }

  private onTogetherStop(conn: Conn) {
    const room = conn.room;
    if (!room?.together) return;
    if (!this.canShare(room, conn)) return this.fail(conn, "forbidden");
    room.together = null;
    this.pushTogether(room);
  }

  private onChatDelete(conn: Conn, id: string) {
    const room = conn.room;
    if (!room) return;
    const index = room.data.history.findIndex(m => m.id === id);
    if (index < 0) return;
    const message = room.data.history[index]!;
    if (message.authorId !== conn.userId && !this.owns(room, conn)) return this.fail(conn, "forbidden");
    room.data.history.splice(index, 1);
    if (room.data.pinned?.id === id) {
      room.data.pinned = null;
      this.broadcast(room, { t: "chat.pinned", message: null });
    }
    this.persist();
    this.broadcast(room, { t: "chat.deleted", id });
  }

  private pushSystem(room: Room, text: string) {
    const message: ChatMessage = { id: randomBytes(8).toString("hex"), authorId: "", authorName: "", authorColor: "", text, at: this.now(), replyTo: null, kind: "system" };
    this.remember(room, message);
    this.broadcast(room, { t: "chat", message });
  }

  private remember(room: Room, message: ChatMessage) {
    room.data.history.push(message);
    if (room.data.history.length > LIMITS.history) room.data.history.splice(0, room.data.history.length - LIMITS.history);
    let images = 0;
    for (let i = room.data.history.length - 1; i >= 0; i--) {
      const old = room.data.history[i]!;
      if (old.image && ++images > LIMITS.imagesPerRoom) old.image = null;
      if (old.clip?.thumb && ++images > LIMITS.imagesPerRoom) old.clip.thumb = null;
    }
    room.data.lastActivity = message.at;
    this.persist();
  }

  private onStreamStart(conn: Conn, id: string, announce: StreamAnnounce, rid?: number) {
    const room = conn.room;
    const ack = (ok: boolean, error?: ErrorCode, data?: unknown) => rid !== undefined && this.send(conn, { t: "ack", rid, ok, error, data });
    if (!room || !isString(id, 64) || !id) return ack(false, "bad_request");
    const userId = conn.userId!;
    if (room.data.settings.whoCanStream === "owner" && !this.owns(room, conn)) return ack(false, "forbidden");
    const previous = this.streamOf(conn);
    if (previous) {
      // Reprise après une coupure du serveur : le flux continue, on repart de ce qu'on savait de lui.
      if (previous.id === id) {
        Object.assign(previous, cleanAnnounce(announce));
        return ack(true, undefined, { viewers: previous.viewers, startedAt: previous.startedAt });
      }
      this.stopStreamOf(room, userId);
    }
    const stream: StreamInfo = { ...cleanAnnounce(announce), id, ownerId: userId, startedAt: this.now(), viewers: [], thumb: null };
    room.statusThumbAt = 0;
    room.streams.set(id, stream);
    room.qualities.set(id, new Map());
    this.lives.set(id, { peakViewers: 0, kbpsSum: 0, kbpsCount: 0, relaySeen: 0, viewersSeen: 0, lossSum: 0, lossCount: 0 });
    this.usage?.count("streams");
    this.accounts.addStats(conn.accountId!, { streams: 1 });
    this.broadcast(room, { t: "stream.add", stream });
    this.pushSystem(room, `${conn.profile!.name} a lancé un stream`);
    this.touchStatus(room);
    ack(true, undefined, { viewers: [], startedAt: stream.startedAt });
    this.log("info", "stream", `${conn.profile!.name} lance un stream dans « ${room.data.name} »`);
    this.notifyPhones(room, `live:${conn.accountId!}`, userId, `${conn.profile!.name} est en direct`, stream.title ? `${stream.title} · ${room.data.name}` : room.data.name);
  }

  private notifyPhones(room: Room, event: string, author: string, title: string, body: string) {
    const { push } = this;
    if (!push || this.now() - this.bootedAt < PUSH_QUIET_AFTER_BOOT_MS) return;
    const here = new Set([author, ...[...room.members.values()].filter(m => m.member.online).flatMap(m => [m.member.id, m.member.account ?? m.member.id])]);
    void push.notify(room.data.id, here, event, { title, body, url: `/w/${room.data.code}`, tag: room.data.id }).catch(() => {});
  }

  private onStreamUpdate(conn: Conn, patch: StreamPatch) {
    const room = conn.room;
    const stream = this.streamOf(conn);
    if (!room || !stream || !patch) return;
    const next = cleanAnnounce({ ...stream, ...patch });
    Object.assign(stream, next);
    this.broadcast(room, { t: "stream.update", id: stream.id, patch: next });
    this.touchStatus(room);
  }

  private stopStreamOf(room: Room | null, userId: string) {
    if (!room) return;
    for (const stream of room.streams.values()) {
      if (stream.ownerId !== userId) continue;
      room.streams.delete(stream.id);
      room.qualities.delete(stream.id);
      this.writeSession(room, stream);
      this.broadcast(room, { t: "stream.remove", id: stream.id });
      this.touchStatus(room);
    }
  }

  private writeSession(room: Room, stream: StreamInfo) {
    const live = this.lives.get(stream.id);
    this.lives.delete(stream.id);
    const member = room.members.get(stream.ownerId)?.member;
    const endedAt = this.now();
    this.usage?.session({
      id: stream.id,
      startedAt: stream.startedAt,
      endedAt,
      accountId: member?.account ?? stream.ownerId,
      name: member?.name ?? "?",
      room: room.data.name,
      title: stream.title,
      kind: stream.kind,
      height: stream.height,
      fps: stream.fps,
      peakViewers: Math.max(live?.peakViewers ?? 0, stream.viewers.length),
      kbps: live?.kbpsCount ? Math.round(live.kbpsSum / live.kbpsCount) : 0,
      relayShare: live?.viewersSeen ? Math.round((live.relaySeen / live.viewersSeen) * 100) : 0,
      lossPct: live?.lossCount ? +(live.lossSum / live.lossCount).toFixed(2) : 0,
    });
    this.log("info", "stream", `${member?.name ?? "?"} arrête son stream dans « ${room.data.name} » après ${Math.round((endedAt - stream.startedAt) / 60_000)} min`);
  }

  private onStreamWatch(conn: Conn, msg: Extract<ClientMessage, { t: "stream.watch" }>) {
    const room = conn.room;
    const stream = room?.streams.get(msg.id);
    if (!room || !stream) return this.reply(conn, msg, false, "stream_not_found");
    const userId = conn.userId!;
    if (stream.ownerId === userId) return this.reply(conn, msg, false, "bad_request");
    if (msg.on && !stream.viewers.includes(userId) && stream.maxViewers > 0 && stream.viewers.length >= stream.maxViewers) {
      return this.reply(conn, msg, false, "viewer_limit");
    }
    this.setViewer(room, stream, userId, msg.on === true, cleanQuality(msg.quality ?? DEFAULT_VIEWER_QUALITY), msg.resume === true);
    this.reply(conn, msg, true);
  }

  private setViewer(room: Room, stream: StreamInfo, userId: string, on: boolean, quality: ViewerQuality | null, resume = false) {
    const has = stream.viewers.includes(userId);
    const owner = room.members.get(stream.ownerId);
    if (has === on) {
      // Un spectateur qui redemande un flux déjà ouvert veut une nouvelle connexion : le diffuseur doit le savoir.
      if (on && owner?.conn) this.send(owner.conn, { t: "stream.viewer", streamId: stream.id, userId, on, quality, resume });
      return;
    }
    stream.viewers = on ? [...stream.viewers, userId] : stream.viewers.filter(v => v !== userId);
    if (on && quality) room.qualities.get(stream.id)?.set(userId, quality);
    else room.qualities.get(stream.id)?.delete(userId);
    if (owner?.conn) this.send(owner.conn, { t: "stream.viewer", streamId: stream.id, userId, on, quality, resume });
    this.broadcast(room, { t: "stream.update", id: stream.id, patch: { viewers: stream.viewers } });
  }

  private statusOf(id: string): RoomStatus {
    const room = this.rooms.get(id);
    if (!room) return { id, name: "", code: "", members: 0, online: [], live: [], exists: false };
    return {
      id,
      name: room.data.name,
      code: room.data.code,
      members: room.members.size,
      online: [...room.members.values()].slice(0, 12).map(({ member }) => ({ name: member.name, color: member.color })),
      live: [...room.streams.values()].map(s => ({ ownerName: room.members.get(s.ownerId)?.member.name ?? "?", title: s.title, thumb: s.thumb })),
      ...(room.together ? { party: room.together.title } : {}),
      exists: true,
    };
  }

  private touchStatus(room: Room) {
    const status = this.statusOf(room.data.id);
    for (const conn of this.conns) {
      if (conn.subscriptions.has(room.data.id)) this.send(conn, { t: "room.status", rooms: [status] });
    }
  }

  private snapshot(room: Room): RoomState {
    return {
      id: room.data.id,
      code: room.data.code,
      name: room.data.name,
      ownerId: room.data.ownerId,
      settings: room.data.settings,
      members: [...room.members.values()].map(m => m.member),
      streams: [...room.streams.values()],
      history: room.data.history,
      pinned: room.data.pinned ?? null,
      poll: room.poll,
      together: this.togetherView(room.together),
    };
  }

  private newCode() {
    for (;;) {
      let code = "";
      for (let i = 0; i < 8; i++) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
      if (!this.byCode.has(code)) return code;
    }
  }

  private liveOf(conn: Conn) {
    return conn.room && conn.userId ? conn.room.members.get(conn.userId) ?? null : null;
  }

  private streamOf(conn: Conn) {
    if (!conn.room) return null;
    for (const stream of conn.room.streams.values()) if (stream.ownerId === conn.userId) return stream;
    return null;
  }

  private liveRoom(data: StoredRoom): Room {
    return { data, members: new Map(), streams: new Map(), qualities: new Map(), poll: null, together: null, statusThumbAt: 0 };
  }

  /** Les images restent en mémoire : un fichier réécrit à chaque message ne doit pas en porter le poids. */
  private persist() {
    this.store.save([...this.rooms.values()].map(r => ({ ...r.data, history: r.data.history.map(m => (m.image || m.clip?.thumb ? { ...m, image: null, clip: m.clip && { ...m.clip, thumb: null } } : m)) })));
  }

  private broadcast(room: Room, msg: ServerMessage, exceptUserId?: string) {
    const data = JSON.stringify(msg);
    for (const [userId, live] of room.members) {
      if (userId !== exceptUserId && live.conn) this.write(live.conn, data);
    }
  }

  private write(conn: Conn, data: string) {
    if (this.metrics) {
      this.metrics.traffic.msgOut++;
      this.metrics.traffic.wsOut += data.length;
    }
    conn.transport.send(data);
  }

  private send(conn: Conn, msg: ServerMessage) {
    this.write(conn, JSON.stringify(msg));
  }

  private fail(conn: Conn, error: ErrorCode) {
    if (this.metrics && error === "rate_limited") this.metrics.traffic.rejected++;
    this.send(conn, { t: "error", error });
  }

  private reply(conn: Conn, msg: object, ok: boolean, error?: ErrorCode, data?: unknown) {
    const { rid } = msg as { rid?: number };
    if (typeof rid === "number") this.send(conn, { t: "ack", rid, ok, error, data });
    else if (error) this.fail(conn, error);
  }
}
