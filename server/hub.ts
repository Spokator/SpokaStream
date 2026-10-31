import { createHash, randomBytes, randomInt } from "node:crypto";
import {
  DEFAULT_ROOM_SETTINGS,
  DEFAULT_VIEWER_QUALITY,
  LIMITS,
  PROTOCOL_VERSION,
  youtubeId,
} from "../src/shared/protocol.ts";
import type {
  ChatMessage,
  ClientMessage,
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
  Together,
  TogetherItem,
  ViewerQuality,
} from "../src/shared/protocol.ts";
import type { Store, StoredRoom } from "./store.ts";

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
  userId: string | null;
  profile: Profile | null;
  room: Room | null;
  subscriptions: Set<string>;
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
  iceServers: (userId: string) => IceServer[];
  serverName?: string;
  graceMs?: number;
  now?: () => number;
}

const isString = (v: unknown, max: number): v is string => typeof v === "string" && v.length <= max;
const clean = (v: unknown, max: number) => (typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max) : "");
const isDataImage = (v: unknown, max: number): v is string =>
  typeof v === "string" && v.length <= max && /^data:image\/(png|jpeg|webp);base64,[a-z0-9+/=]+$/i.test(v);
const isColor = (v: unknown): v is string => typeof v === "string" && /^#[0-9a-f]{6}$/i.test(v);
const clampNumber = (v: unknown, min: number, max: number, fallback: number) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : fallback;
};

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

function cleanAnnounce(s: Partial<StreamAnnounce>): StreamAnnounce {
  return {
    title: clean(s.title, LIMITS.title),
    kind: s.kind === "window" || s.kind === "camera" || s.kind === "file" ? s.kind : "screen",
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
  };
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

  constructor(options: HubOptions) {
    this.store = options.store;
    this.iceServers = options.iceServers;
    this.serverName = options.serverName ?? "SpokaStream";
    this.graceMs = options.graceMs ?? GRACE_MS;
    this.now = options.now ?? Date.now;
    const cutoff = this.now() - ROOM_MAX_IDLE_MS;
    for (const data of this.store.load()) {
      if (data.lastActivity < cutoff) continue;
      this.rooms.set(data.id, this.liveRoom(data));
      this.byCode.set(data.code, data.id);
    }
  }

  get stats() {
    let members = 0;
    let streams = 0;
    for (const room of this.rooms.values()) {
      members += room.members.size;
      streams += room.streams.size;
    }
    return { rooms: this.rooms.size, connections: this.conns.size, members, streams };
  }

  connect(transport: Transport) {
    const now = this.now();
    const conn: Conn = {
      transport,
      userId: null,
      profile: null,
      room: null,
      subscriptions: new Set(),
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
    return conn;
  }

  disconnect(conn: Conn) {
    this.conns.delete(conn);
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
    if (msg.t === "hello") return this.onHello(conn, msg);
    if (msg.t === "ping") return this.send(conn, { t: "pong", at: Number(msg.at) || 0 });
    if (!conn.userId) return this.reply(conn, msg, false, "not_authenticated");
    try {
      this.dispatch(conn, msg);
    } catch (e) {
      console.error(`[hub] ${msg.t} :`, e);
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
        const live = this.liveOf(conn);
        if (live) {
          Object.assign(live.member, conn.profile);
          this.broadcast(conn.room!, { t: "member.update", member: live.member });
        }
        return;
      }
      case "voice.set": {
        const live = this.liveOf(conn);
        if (!live) return;
        live.member.voice = msg.voice ? { muted: msg.voice.muted === true, deafened: msg.voice.deafened === true } : null;
        return this.broadcast(conn.room!, { t: "member.update", member: live.member });
      }
      case "chat.send":
        if (!conn.buckets.chat.take(now)) return this.fail(conn, "rate_limited");
        if (msg.image && !conn.buckets.image.take(now)) return this.fail(conn, "rate_limited");
        return this.onChat(conn, msg.text, msg.replyTo ?? null, msg.image ?? null);
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
        return this.onTogetherAdd(conn, msg.videoId, msg.title);
      case "together.control":
        if (!conn.buckets.misc.take(now)) return;
        return this.onTogetherControl(conn, msg.playing === true, msg.position);
      case "together.next":
        return this.onTogetherNext(conn, msg.videoId);
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
        if (!room || !stream || (stream.ownerId !== conn.userId && room.data.ownerId !== conn.userId)) return;
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
    // Pas de compte : le jeton aléatoire de l'appareil EST l'identité. Le serveur n'en garde que l'empreinte.
    conn.userId = createHash("sha256").update(msg.token).digest("hex").slice(0, 24);
    conn.profile = cleanProfile(msg.profile);
    this.send(conn, { t: "welcome", userId: conn.userId, iceServers: this.iceServers(conn.userId), serverName: this.serverName });
    this.reply(conn, msg, true);
  }

  private onRoomCreate(conn: Conn, rawName: string, rid?: number) {
    const name = clean(rawName, LIMITS.roomName);
    const ack = (ok: boolean, error?: ErrorCode, data?: unknown) => rid !== undefined && this.send(conn, { t: "ack", rid, ok, error, data });
    if (!name) return ack(false, "bad_request");
    const owned = [...this.rooms.values()].filter(r => r.data.ownerId === conn.userId).length;
    if (owned >= LIMITS.roomsPerUser) return ack(false, "too_many_rooms");
    const now = this.now();
    const data: StoredRoom = {
      id: randomBytes(9).toString("base64url"),
      code: this.newCode(),
      name,
      ownerId: conn.userId!,
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
    this.enter(conn, room);
    ack(true, undefined, { id: data.id, code: data.code });
  }

  private onRoomJoin(conn: Conn, msg: Extract<ClientMessage, { t: "room.join" }>) {
    const code = clean(msg.code, 16).toUpperCase().replace(/[^A-Z0-9]/g, "");
    const id = isString(msg.id, 32) ? msg.id : "";
    const room = this.rooms.get(id || this.byCode.get(code) || "");
    if (!room) {
      // Un code fait 8 caractères : on empêche surtout d'en essayer à la chaîne depuis une même adresse.
      const bucket = this.joinFailures.get(conn.transport.ip) ?? new Bucket(0.2, 12, this.now());
      this.joinFailures.set(conn.transport.ip, bucket);
      return this.reply(conn, msg, false, bucket.take(this.now()) ? "room_not_found" : "rate_limited");
    }
    const userId = conn.userId!;
    if (room.data.bans.includes(userId)) return this.reply(conn, msg, false, "banned");
    const already = room.members.has(userId);
    const isOwner = room.data.ownerId === userId;
    if (!already && room.data.settings.locked && !isOwner) return this.reply(conn, msg, false, "room_locked");
    if (!already && room.members.size >= LIMITS.membersPerRoom) return this.reply(conn, msg, false, "room_full");
    this.enter(conn, room);
    this.reply(conn, msg, true, undefined, { id: room.data.id, code: room.data.code });
  }

  private enter(conn: Conn, room: Room) {
    if (conn.room && conn.room !== room) this.leaveRoom(conn);
    const userId = conn.userId!;
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
      Object.assign(existing.member, conn.profile);
      conn.room = room;
      this.send(conn, { t: "room.state", room: this.snapshot(room) });
      this.broadcast(room, { t: "member.update", member: existing.member }, userId);
      return;
    }
    const member: Member = {
      ...conn.profile!,
      id: userId,
      role: room.data.ownerId === userId ? "owner" : "member",
      online: true,
      voice: null,
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
    if (!room || room.data.ownerId !== conn.userId) return this.fail(conn, "forbidden");
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
    if (!room || room.data.ownerId !== conn.userId) return this.fail(conn, "forbidden");
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
    if (!room || room.data.ownerId !== conn.userId || userId === conn.userId) return this.fail(conn, "forbidden");
    const live = room.members.get(userId);
    if (ban && !room.data.bans.includes(userId)) {
      room.data.bans.push(userId);
      this.persist();
    }
    if (!live) return;
    if (live.conn) {
      this.send(live.conn, { t: "room.closed", reason: ban ? "banned" : "kicked" });
      live.conn.room = null;
    }
    this.removeMember(room, userId);
  }

  private onChat(conn: Conn, rawText: unknown, replyTo: string | null, rawImage: unknown) {
    const room = conn.room;
    const live = this.liveOf(conn);
    if (!room || !live) return;
    const text = typeof rawText === "string" ? rawText.trim().slice(0, LIMITS.chat) : "";
    const image = isDataImage(rawImage, LIMITS.image) ? rawImage : null;
    if (!text && !image) return;
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
    if (!room || room.data.ownerId !== conn.userId) return this.fail(conn, "forbidden");
    const message = id ? room.data.history.find(m => m.id === id && m.kind === "user") : null;
    if (id && !message) return;
    room.data.pinned = message ? { ...message, image: null } : null;
    this.persist();
    this.broadcast(room, { t: "chat.pinned", message: room.data.pinned });
  }

  private onPollCreate(conn: Conn, rawQuestion: unknown, rawOptions: unknown) {
    const room = conn.room;
    const live = this.liveOf(conn);
    if (!room || !live) return;
    if (room.poll && !room.poll.closed && room.poll.authorId !== conn.userId && room.data.ownerId !== conn.userId) return this.fail(conn, "forbidden");
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
    if (poll.authorId !== conn.userId && room.data.ownerId !== conn.userId) return this.fail(conn, "forbidden");
    if (dismiss) room.poll = null;
    else poll.closed = true;
    this.broadcast(room, { t: "poll", poll: room.poll });
  }

  private canShare(room: Room, userId: string) {
    return room.data.settings.whoCanStream === "everyone" || room.data.ownerId === userId;
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
  }

  private onTogetherAdd(conn: Conn, rawId: unknown, rawTitle: unknown) {
    const room = conn.room;
    const live = this.liveOf(conn);
    if (!room || !live) return;
    if (!this.canShare(room, conn.userId!)) return this.fail(conn, "forbidden");
    const videoId = typeof rawId === "string" ? youtubeId(rawId) : null;
    if (!videoId) return this.fail(conn, "bad_request");
    const item: TogetherItem = { videoId, title: clean(rawTitle, LIMITS.title) || "Vidéo YouTube", byName: live.member.name };
    if (!room.together) {
      room.together = { ...item, playing: true, position: 0, anchor: this.now(), queue: [] };
      this.pushSystem(room, `${live.member.name} lance « ${item.title} »`);
    } else {
      if (room.together.queue.length >= LIMITS.queue) return this.fail(conn, "bad_request");
      room.together.queue.push(item);
    }
    this.pushTogether(room);
  }

  private onTogetherControl(conn: Conn, playing: boolean, rawPosition: unknown) {
    const room = conn.room;
    const together = room?.together;
    if (!room || !together || !this.canShare(room, conn.userId!)) return;
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

  private onTogetherStop(conn: Conn) {
    const room = conn.room;
    if (!room?.together) return;
    if (!this.canShare(room, conn.userId!)) return this.fail(conn, "forbidden");
    room.together = null;
    this.pushTogether(room);
  }

  private onChatDelete(conn: Conn, id: string) {
    const room = conn.room;
    if (!room) return;
    const index = room.data.history.findIndex(m => m.id === id);
    if (index < 0) return;
    const message = room.data.history[index]!;
    if (message.authorId !== conn.userId && room.data.ownerId !== conn.userId) return this.fail(conn, "forbidden");
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
    }
    room.data.lastActivity = message.at;
    this.persist();
  }

  private onStreamStart(conn: Conn, id: string, announce: StreamAnnounce, rid?: number) {
    const room = conn.room;
    const ack = (ok: boolean, error?: ErrorCode, data?: unknown) => rid !== undefined && this.send(conn, { t: "ack", rid, ok, error, data });
    if (!room || !isString(id, 64) || !id) return ack(false, "bad_request");
    const userId = conn.userId!;
    if (room.data.settings.whoCanStream === "owner" && room.data.ownerId !== userId) return ack(false, "forbidden");
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
    this.broadcast(room, { t: "stream.add", stream });
    this.pushSystem(room, `${conn.profile!.name} a lancé un stream`);
    this.touchStatus(room);
    ack(true, undefined, { viewers: [], startedAt: stream.startedAt });
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
      this.broadcast(room, { t: "stream.remove", id: stream.id });
      this.touchStatus(room);
    }
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
    this.store.save([...this.rooms.values()].map(r => ({ ...r.data, history: r.data.history.map(m => (m.image ? { ...m, image: null } : m)) })));
  }

  private broadcast(room: Room, msg: ServerMessage, exceptUserId?: string) {
    const data = JSON.stringify(msg);
    for (const [userId, live] of room.members) {
      if (userId !== exceptUserId && live.conn) live.conn.transport.send(data);
    }
  }

  private send(conn: Conn, msg: ServerMessage) {
    conn.transport.send(JSON.stringify(msg));
  }

  private fail(conn: Conn, error: ErrorCode) {
    this.send(conn, { t: "error", error });
  }

  private reply(conn: Conn, msg: object, ok: boolean, error?: ErrorCode, data?: unknown) {
    const { rid } = msg as { rid?: number };
    if (typeof rid === "number") this.send(conn, { t: "ack", rid, ok, error, data });
    else if (error) this.fail(conn, error);
  }
}
