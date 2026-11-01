import { DEFAULT_REGIE } from "@shared/ipc.ts";
import type { ActionId, AudioChoice, ControlTarget, PanelId, RegieLayout, Resolution, Scene, SceneSource, Settings, VideoInfo, WaitScreen, WallMode, WallRect, WallSettings } from "@shared/ipc.ts";
import { DEFAULT_VIEWER_QUALITY, isHls, videoUrl, youtubeId } from "@shared/protocol.ts";
import type { AudioKind, CameraLayout, ChatMessage, RemoteCommand, RemoteState, ControlInput, ControlToHost, ControlToViewer, ErrorCode, Poll, Profile, RoomSettings, RoomState, RoomStatus, ServerMessage, Stroke, StreamAnnounce, StreamInfo, Together, ViewerQuality } from "@shared/protocol.ts";
import { get, memberOf, patchPublish, patchRoom, patchSub, set, soloOf, toast, TOGETHER, useApp } from "../state/store.ts";
import type { ActivityItem } from "../state/store.ts";
import { duration, limitText, mentionsName } from "../ui/format.ts";
import { clipThumb, frameForChat } from "../ui/image.ts";
import { StreamMixer } from "./audio/mixer.ts";
import { Playback } from "./audio/playback.ts";
import { captureThumbnail, createPauseCard, openSource } from "./capture.ts";
import type { OpenedSource, VideoSource } from "./capture.ts";
import { ClipBuffer } from "./clips.ts";
import type { ClipSource } from "./clips.ts";
import { CLIP_SESSION, ClipShare } from "./clipShare.ts";
import { benchClass, cachedBench, measureEncoders, rankResults } from "./encoders.ts";
import type { BenchResult } from "./encoders.ts";
import { rememberRoom } from "@shared/rooms.ts";
import { assembleClip, fragmentTimes } from "./mp4.ts";
import { ObsIngest } from "./obs.ts";
import { Publisher } from "./publisher.ts";
import type { EncodingTarget } from "./publisher.ts";
import { Recorder, saveClipFile, saveVideoFrame } from "./recorder.ts";
import { playSound, setSfxVolume } from "./sfx.ts";
import { RequestError, Signal } from "./signal.ts";
import { Subscription } from "./subscription.ts";
import { canPlay } from "./videoProbe.ts";
import { VOICE_SESSION, Voice } from "./voice.ts";

const api = window.spoka;

export type { AudioChoice };

export interface AccountDevice {
  id: string;
  label: string;
  client: "app" | "web";
  version: string;
  addedAt: number;
  lastSeen: number;
  online: boolean;
  self: boolean;
  primary: boolean;
}

export interface GoLiveConfig {
  source: VideoSource;
  audio: AudioChoice[];
  title: string;
  resolution: Resolution;
  fps: number;
  kbps: number;
  codec: Settings["stream"]["codec"];
  priority: Settings["stream"]["priority"];
  audioKbps: number;
  allowDraw: boolean;
  maxViewers: number;
}

export type DrawListener = (event: { streamId: string; from: string; stroke: Stroke } | { streamId: string; clear: true }) => void;
export type ReactionListener = (event: { streamId: string | null; emoji: string; from: string }) => void;

const ERROR_TEXT: Partial<Record<ErrorCode, string>> = {
  room_not_found: "Ce salon n'existe pas. Vérifie le code.",
  room_full: "Ce salon est complet.",
  room_locked: "Ce salon est verrouillé par son propriétaire.",
  banned: "Tu as été banni de ce salon.",
  forbidden: "Tu n'as pas la permission de faire ça.",
  rate_limited: "Trop de demandes d'un coup, patiente un instant.",
  too_many_rooms: "Tu as atteint le nombre maximum de salons.",
  viewer_limit: "Ce stream a atteint sa limite de spectateurs.",
  stream_not_found: "Ce stream vient de se terminer.",
  muted: "Tu ne peux plus écrire pour l'instant.",
  closed: "Ce serveur n'accepte plus de nouveaux appareils.",
  disabled: "L'administrateur a désactivé cette fonction.",
  maintenance: "Le serveur est en maintenance, réessaie dans un moment.",
};

const TELEMETRY_MS = 10_000;
/** Le retour de son propre stream quand l'application n'a pas le focus. La piste envoyée n'est pas touchée. */
const BACKGROUND_PREVIEW_FPS = 15;
const LAYOUT_SEND_MS = 80;
const HEALTH_POINTS = 120;
const ACTIVITY_ITEMS = 120;
const SAME_EVENT_MS = 3000;
const ASK_COOLDOWN_MS = 10_000;
const ASK_TIMEOUT_MS = 30_000;
const FIT_DELAY_MS = 1500;
const REMOTE_PUSH_MS = 1000;
const MAX_ERROR_REPORTS = 8;
const START_QUALITIES = [
  { maxHeight: 1080, maxKbps: 12000 },
  { maxHeight: 720, maxKbps: 5000 },
  { maxHeight: 480, maxKbps: 1500 },
];
/** Hauteur réelle de l'image à l'écran, et ce qu'il suffit de recevoir pour l'afficher nettement. */
const FIT_TIERS = [
  { upTo: 300, maxHeight: 360, maxKbps: 900 },
  { upTo: 520, maxHeight: 540, maxKbps: 2500 },
  { upTo: 760, maxHeight: 720, maxKbps: 5000 },
];

const resolutionHeight = (r: Resolution) => (r === "source" ? 0 : Number(r));
const savedVolume = (ownerId: string) => {
  try {
    return Number(localStorage.getItem(`volume:${ownerId}`) ?? 1) || 1;
  } catch {
    return 1;
  }
};

class Core {
  private readonly signal = new Signal();
  private readonly playback = new Playback();
  private readonly subs = new Map<string, Subscription>();
  private voice: Voice | null = null;
  private publisher: Publisher | null = null;
  private mixer: StreamMixer | null = null;
  private opened: OpenedSource | null = null;
  private sourceGone = false;
  private pauseCard: ReturnType<typeof createPauseCard> | null = null;
  private previewElement: HTMLVideoElement | null = null;
  private previewTrack: MediaStreamTrack | null = null;
  private previewTimer: ReturnType<typeof setInterval> | undefined;
  private recorder: Recorder | null = null;
  private clipBuffer: ClipBuffer | null = null;
  private clipSource: string | null = null;
  private clipHardware = true;
  /** Le clip ouvert : ses fragments s'il vient d'être pris, ses octets s'il vient de quelqu'un d'autre. */
  private openedClip: { source: ClipSource | null; bytes: Uint8Array | null } | null = null;
  private readonly clipShares = new ClipShare(() => get().iceServers, (to, session, data) => this.signal.send({ t: "rtc", to, session, data }));
  private lastTyping = 0;
  private readonly obs = new ObsIngest();
  /** Les deux dernières minutes de cadence et de débit, pour le graphique de la régie. */
  readonly healthHistory: { fps: number; kbps: number }[] = [];
  private lastViewers = new Set<string>();
  private nextActivity = 1;
  private currentSource: VideoSource | null = null;
  /** Ce qui a été ajouté à la table, pour qu'une scène puisse le retrouver. */
  private readonly mixChoices = new Map<string, AudioChoice>();
  private layoutSentAt = 0;
  private controlTarget: ControlTarget | null = null;
  private readonly askedAt = new Map<string, number>();
  private askTimer: ReturnType<typeof setTimeout> | undefined;
  private cameraStream: MediaStream | null = null;
  private sourceMixId: string | null = null;
  private announce: StreamAnnounce | null = null;
  private timers: ReturnType<typeof setInterval>[] = [];
  private pttHeld = false;
  private lastLive = new Map<string, Set<string>>();
  private readonly drawListeners = new Set<DrawListener>();
  private readonly reactionListeners = new Set<ReactionListener>();
  private readonly speakHold = new Map<string, number>();
  private strokeCount = 0;
  /** La définition qui suffit à la tuile de chaque stream. 0 : tout ce que le diffuseur envoie. */
  private readonly fits = new Map<string, number>();
  private readonly fitTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private lastSolo: string | null = null;
  private fileLoop = false;
  private lastRemote = "";
  private clipsSaved = 0;
  private fileSeek = false;

  async boot() {
    // S'abonner avant de lire : un changement arrivé entre les deux serait perdu, et l'interface resterait fausse.
    api.onSettings(next => set({ settings: next }));
    api.onAudioStatus(status => set({ audioEngine: status }));
    api.onUpdateStatus(update => set({ update }));
    const settings = await api.getSettings();
    set({ settings, audioEngine: await api.audioStatus(), update: await api.updateStatus() });
    this.playback.setOutput(settings.outputId);
    this.applyVolumes(settings);
    useApp.subscribe(state => {
      const solo = soloOf(state);
      if (solo === this.lastSolo) return;
      this.lastSolo = solo;
      for (const id of this.subs.keys()) this.applyMuted(id);
    });

    api.onDeepLink(code => void this.joinRoom(code));
    api.onNotificationClick(roomId => void this.openRoom(roomId));
    api.onHotkey(action => this.onHotkey(action));
    api.onTrayAction(action => {
      if (action === "toggleMic") this.toggleMute();
      else if (action === "toggleDeafen") this.toggleDeafen();
      else if (action === "stopStream") void this.stopLive();
      else if (action === "pauseStream") void this.setPaused(!get().publish?.paused);
      else if (action === "revokeControl") this.endControl();
      else this.leaveRoom();
    });
    this.obs.onChange = obs => set({ obs });
    api.onObsOffer((id, sdp) => void this.onObsOffer(id, sdp));
    api.onObsEnd(id => this.obs.end(id));
    api.onControlBlocked(blocked => {
      const controller = get().publish?.controller;
      if (!controller) return;
      patchPublish({ controlBlocked: blocked });
      this.publisher?.sendControl(controller, { t: "blocked", blocked });
    });
    api.onKey((key, down) => {
      if (key !== get().settings?.pttKey) return;
      this.pttHeld = down;
      this.applyTransmit();
    });

    this.signal.onState = connection => set({ connection, unreachable: connection === "connecting" && this.signal.failedAttempts >= 3 });
    this.signal.onMessage = message => this.onServer(message);
    this.signal.onReady = () => {
      this.lastRemote = "";
      this.onConnected();
    };
    setInterval(() => this.pushRemote(), REMOTE_PUSH_MS);
    this.watchErrors();

    this.timers.push(setInterval(() => void this.pollStats(), 1000));
    this.timers.push(setInterval(() => this.sendTelemetry(), TELEMETRY_MS));
    this.timers.push(setInterval(() => this.pollSpeaking(), 120));
    this.timers.push(setInterval(() => this.expireTyping(), 1000));
    this.timers.push(setInterval(() => this.followClips(), 1500));
    this.timers.push(setInterval(() => get().hand?.state === "granted" && this.handSub()?.sendControl({ t: "alive" }), 1000));

    window.addEventListener("focus", () => this.followFocus());
    window.addEventListener("blur", () => this.followFocus());
    this.followFocus();

    void ClipBuffer.hasHardwareEncoder().then(hardware => (this.clipHardware = hardware));
    if (settings.onboarded) this.connect();
    this.applyPttWatch();
    this.pushTray();
  }

  connect() {
    const s = get().settings!;
    this.signal.start(s.serverUrl, s.token, s.profile, undefined, api.version, "PC Windows");
  }

  async updateSettings(patch: Partial<Settings>) {
    const before = get().settings!;
    const next = await api.setSettings(patch);
    set({ settings: next });
    if (patch.serverUrl && patch.serverUrl !== before.serverUrl) {
      this.leaveRoom();
      this.connect();
    }
    if (patch.outputId !== undefined) this.playback.setOutput(next.outputId);
    this.applyVolumes(next);
    if (patch.voiceMode !== undefined || patch.pttKey !== undefined) {
      this.applyPttWatch();
      this.applyTransmit();
    }
    if (["micId", "noiseSuppression", "echoCancellation", "autoGain"].some(k => k in patch)) await this.voice?.reconfigure(next).catch(e => toast(`Micro : ${e.message}`, "error"));
    return next;
  }

  async updateProfile(profile: Profile) {
    await this.updateSettings({ profile });
    this.signal.send({ t: "profile.update", profile });
  }

  private applyPttWatch() {
    const s = get().settings;
    if (!s) return;
    void api.watchKeys(s.voiceMode === "ptt" ? [s.pttKey] : []).catch(() => {});
  }

  // ---------------------------------------------------------------- serveur

  private onConnected() {
    const s = get().settings!;
    this.signal.send({ t: "room.subscribe", ids: s.recentRooms.map(r => r.id) });
    const room = get().room;
    if (room) void this.signal.request({ t: "room.join", id: room.id }).catch(() => {});
  }

  private onServer(m: ServerMessage) {
    switch (m.t) {
      case "welcome":
        return set({ userId: m.userId, accountId: m.accountId ?? m.userId, admin: !!m.admin, iceServers: m.iceServers, serverName: m.serverName });
      case "account.sync":
        return void this.applyAccountProfile(m.profile);
      case "account.rooms":
        return this.onAccountRooms(m.rooms);
      case "account.linked":
        toast(`${m.label} est lié à ton compte`, "success");
        return set({ linkedAt: Date.now() });
      case "remote.cmd":
        // Le téléphone voit le résultat tout de suite : une touche qui s'allume une seconde plus tard donne envie d'appuyer deux fois.
        return void this.onRemoteCommand(m.cmd, m.arg).finally(() => this.pushRemote());
      case "announce":
        return toast(m.text, m.level === "warning" ? "warning" : "info", 12_000);
      case "room.state":
        return this.onRoomState(m.room);
      case "room.updated":
        return patchRoom(() => ({ name: m.name, settings: m.settings }));
      case "room.closed":
        if (m.reason === "replaced") toast("Ce compte vient de rejoindre le salon depuis un autre appareil.", "warning");
        else toast(m.reason === "deleted" ? "Le salon a été supprimé." : m.reason === "banned" ? "Tu as été banni du salon." : "Tu as été exclu du salon.", "warning");
        return this.leftRoom();
      case "room.status":
        return this.onStatus(m.rooms);
      case "member.join":
        this.log("people", `${m.member.name} a rejoint le salon`);
        playSound("join", !!get().settings?.soundEffects && !!get().voiceJoined);
        patchRoom(r => ({ members: [...r.members.filter(x => x.id !== m.member.id), m.member] }));
        return;
      case "member.update":
        patchRoom(r => ({ members: r.members.map(x => (x.id === m.member.id ? m.member : x)) }));
        return this.syncVoice();
      case "member.leave":
        this.log("people", `${memberOf(m.userId)?.name ?? "Quelqu'un"} a quitté le salon`);
        patchRoom(r => ({ members: r.members.filter(x => x.id !== m.userId) }));
        return this.syncVoice();
      case "chat":
        return this.onChat(m.message);
      case "chat.deleted":
        return patchRoom(r => ({ history: r.history.filter(x => x.id !== m.id) }));
      case "chat.reactions":
        return patchRoom(r => ({ history: r.history.map(x => (x.id === m.id ? { ...x, reactions: m.reactions } : x)) }));
      case "chat.pinned":
        return patchRoom(() => ({ pinned: m.message }));
      case "chat.typing":
        return set(s => ({ typing: { ...s.typing, [m.userId]: Date.now() + 4000 } }));
      case "poll":
        return this.onPoll(m.poll);
      case "together":
        return this.onTogether(m.together);
      case "reaction":
        return this.onReaction(m.streamId, m.emoji, m.from);
      case "draw":
        return this.onDraw(m.streamId, m.from, m.stroke);
      case "draw.clear":
        for (const listener of this.drawListeners) listener({ streamId: m.streamId, clear: true });
        if (m.streamId === get().publish?.streamId) api.overlaySend({ type: "clear" });
        return;
      case "stream.add":
        return this.onStreamAdd(m.stream);
      case "stream.update":
        patchRoom(r => ({ streams: r.streams.map(s => (s.id === m.id ? { ...s, ...m.patch } : s)) }));
        if (m.id === get().publish?.streamId && m.patch.viewers) this.onViewersChanged(m.patch.viewers);
        return;
      case "stream.remove":
        this.closeSub(m.id);
        patchRoom(r => ({ streams: r.streams.filter(s => s.id !== m.id) }));
        if (get().focused === m.id) set({ focused: null });
        return;
      case "stream.thumb":
        return patchRoom(r => ({ streams: r.streams.map(s => (s.id === m.id ? { ...s, thumb: m.data } : s)) }));
      case "stream.viewer":
        if (m.streamId !== this.publisher?.sessionId) return;
        if (!m.on) return this.publisher.removeViewer(m.userId);
        if (m.resume && this.publisher.peers.some(p => p.id === m.userId && p.pc.connectionState === "connected")) return;
        return void this.publisher.addViewer(m.userId, m.quality).catch(e => console.error("viewer :", e));
      case "stream.quality":
        return void this.publisher?.setQuality(m.userId, m.quality);
      case "stream.kicked":
        toast("Le diffuseur t'a retiré de ce stream.", "warning");
        return this.closeSub(m.streamId);
      case "rtc":
        return this.onRtc(m.from, m.session, m.data);
      case "error":
        if (ERROR_TEXT[m.error]) toast(ERROR_TEXT[m.error]!, "warning");
        return;
      default:
        return;
    }
  }

  private onRtc(from: string, session: string, data: unknown) {
    const signal = data as { sdp?: RTCSessionDescriptionInit; candidate?: RTCIceCandidateInit };
    if (session.startsWith(CLIP_SESSION)) return void this.clipShares.onSignal(from, session, signal).catch(e => console.warn("clip :", e));
    if (session === VOICE_SESSION) return void this.voice?.onSignal(from, signal).catch(e => console.error("voix :", e));
    if (session === this.publisher?.sessionId) return void this.publisher.onSignal(from, signal).catch(e => console.error("stream :", e));
    void this.subs.get(session)?.onSignal(signal).catch(e => console.error("réception :", e));
  }

  private onRoomState(room: RoomState) {
    set({ room, togetherAt: performance.now(), focused: room.together && !get().focused ? TOGETHER : get().focused, view: get().view === "settings" ? "settings" : "room" });
    this.rememberRoom(room.id, room.name, room.code);
    if (this.publisher && this.announce) {
      void this.signal
        .request<{ viewers: string[] }>({ t: "stream.start", id: this.publisher.sessionId, stream: this.announce })
        .catch(e => this.reportError(e));
    }
    for (const stream of room.streams) {
      if (this.subs.has(stream.id)) void this.signal.request({ t: "stream.watch", id: stream.id, on: true, resume: true, quality: get().subs[stream.id]?.quality }).catch(() => {});
    }
    // Serveur redémarré : les streams en cours reviennent quelques secondes après leur diffuseur.
    setTimeout(() => {
      const known = new Set(get().room?.streams.map(s => s.id));
      for (const id of this.subs.keys()) if (!known.has(id)) this.closeSub(id);
    }, 8000);
    if (this.voice?.active) {
      const { muted, deafened } = get();
      this.signal.send({ t: "voice.set", voice: { muted, deafened } });
    }
    this.syncVoice();
    this.maybeAutoWatch();
    this.pushTray();
  }

  private rememberRoom(id: string, name: string, code: string) {
    const settings = get().settings!;
    const recentRooms = rememberRoom(settings.recentRooms, { id, name, code, at: Date.now() });
    void this.updateSettings({ recentRooms });
    this.signal.send({ t: "room.subscribe", ids: recentRooms.map(r => r.id) });
  }

  private onStatus(rooms: RoomStatus[]) {
    const s = get().settings!;
    const statuses = { ...get().statuses };
    for (const status of rooms) {
      statuses[status.id] = status;
      const seen = this.lastLive.get(status.id);
      const now = new Set(status.live.map(l => l.ownerName));
      if (seen && s.notifyLive && !this.quiet() && (status.id !== get().room?.id || !document.hasFocus())) {
        for (const name of now) {
          if (!seen.has(name)) api.notify({ title: `${name} est en direct`, body: `Dans ${status.name}`, roomId: status.id });
        }
      }
      this.lastLive.set(status.id, now);
    }
    set({ statuses });
  }

  private onChat(message: ChatMessage) {
    patchRoom(r => ({ history: [...r.history, message].slice(-300) }));
    set(state => {
      if (!state.typing[message.authorId]) return {};
      const typing = { ...state.typing };
      delete typing[message.authorId];
      return { typing };
    });
    if (message.kind !== "user" || message.authorId === get().userId) return;
    const s = get().settings!;
    const mentioned = mentionsName(message.text, s.profile.name);
    if (message.clip) this.log("clip", `${message.authorName} a partagé un clip de ${message.clip.seconds} s`);
    else if (mentioned) this.log("people", `${message.authorName} t'a mentionné : ${message.text.slice(0, 60)}`);
    if (get().panelTab !== "chat" || !s.chatPanelOpen) set(state => ({ unread: state.unread + 1 }));
    playSound(mentioned ? "live" : "message", s.soundEffects && (mentioned || !document.hasFocus()));
    if ((s.notifyMessages || (mentioned && s.notifyMentions)) && !this.quiet() && !document.hasFocus()) api.notify({ title: mentioned ? `${message.authorName} t'a mentionné` : message.authorName, body: message.text.slice(0, 140), roomId: get().room?.id });
    if (this.publisher) api.overlaySend({ type: "chat", name: message.authorName, color: message.authorColor, text: message.text.slice(0, 200) });
  }

  private expireTyping() {
    const now = Date.now();
    const { typing } = get();
    const keys = Object.keys(typing);
    const alive = keys.filter(k => typing[k]! > now);
    if (alive.length !== keys.length) set({ typing: Object.fromEntries(alive.map(k => [k, typing[k]!])) });
  }

  private onPoll(poll: Poll | null) {
    if (poll && poll.id !== get().room?.poll?.id) this.log("poll", `${poll.authorName} a lancé un sondage : ${poll.question}`);
    patchRoom(() => ({ poll }));
    if (!this.publisher) return;
    api.overlaySend({ type: "poll", poll: poll && { question: poll.question, closed: poll.closed, options: poll.options.map(o => ({ text: o.text, votes: o.voters.length })) } });
  }

  private onTogether(together: Together | null) {
    const before = get().room?.together;
    set({ togetherAt: performance.now() });
    patchRoom(() => ({ together }));
    if (together && !before) set({ focused: TOGETHER });
    if (!together && get().focused === TOGETHER) set({ focused: Object.keys(get().subs)[0] ?? null });
  }

  private onReaction(streamId: string | null, emoji: string, from: string) {
    for (const listener of this.reactionListeners) listener({ streamId, emoji, from });
    if (streamId !== get().publish?.streamId) return;
    api.overlaySend({ type: "reaction", emoji, name: memberOf(from)?.name ?? "" });
    this.log("reaction", `${memberOf(from)?.name ?? "Quelqu'un"} ${emoji}`);
  }

  private onDraw(streamId: string, from: string, stroke: Stroke) {
    for (const listener of this.drawListeners) listener({ streamId, from, stroke });
    if (streamId === get().publish?.streamId) {
      api.overlaySend({ type: "stroke", streamId, from, color: stroke.color, tool: stroke.tool, id: stroke.id, points: stroke.points, end: stroke.end });
    }
  }

  private onStreamAdd(stream: StreamInfo) {
    patchRoom(r => ({ streams: [...r.streams.filter(s => s.id !== stream.id), stream] }));
    if (stream.ownerId === get().userId) return;
    playSound("live", !!get().settings?.soundEffects);
    if (this.subs.has(stream.id)) {
      void this.signal.request({ t: "stream.watch", id: stream.id, on: true, resume: true, quality: this.sentQuality(stream.id) }).catch(() => {});
      return;
    }
    this.maybeAutoWatch();
    if (!this.subs.has(stream.id) && (get().publish || this.subs.size)) {
      toast(`${memberOf(stream.ownerId)?.name ?? "Quelqu'un"} diffuse aussi`, "info", 8000, { label: "Regarder", run: () => void this.watch(stream.id) });
    }
  }

  private maybeAutoWatch() {
    const settings = get().settings;
    if (!settings?.autoWatch) return;
    const others = get().room?.streams.filter(s => s.ownerId !== get().userId) ?? [];
    if (settings.wall.watchAll) return others.forEach(s => void this.watch(s.id));
    if (!this.subs.size && others[0] && !get().room?.together) void this.watch(others[0].id);
  }

  /** Un autre appareil du compte a changé le profil, ou celui-ci vient d'être rattaché. */
  private async applyAccountProfile(profile: Profile) {
    const settings = get().settings;
    if (!settings || JSON.stringify(settings.profile) === JSON.stringify(profile)) return;
    set({ settings: await api.setSettings({ profile }) });
  }

  /** Les salons du compte rejoignent ceux que ce PC connaissait : un PC rattaché les retrouve tout de suite. */
  private onAccountRooms(rooms: { id: string; code: string; name: string }[]) {
    const { recentRooms } = get().settings ?? { recentRooms: [] };
    const known = new Set(recentRooms.map(r => r.id));
    const added = rooms.filter(r => !known.has(r.id)).map(r => ({ ...r, at: 0 }));
    if (!added.length) return;
    const next = [...recentRooms, ...added].slice(0, 30);
    void this.updateSettings({ recentRooms: next });
    this.signal.send({ t: "room.subscribe", ids: next.map(r => r.id) });
  }

  linkDevice() {
    return this.signal.request<{ code: string; expires: number }>({ t: "account.link" });
  }

  linkUrl(code: string) {
    return `${this.playerUrl().replace(/\/player$/, "")}/link/${code}`;
  }

  claimLink(code: string) {
    return this.signal.request({ t: "account.claim", code });
  }

  listDevices() {
    return this.signal.request<AccountDevice[]>({ t: "account.devices" });
  }

  revokeDevice(deviceId: string) {
    return this.signal.request({ t: "account.revoke", deviceId });
  }

  /** Un billet à usage unique : le navigateur entre sans que le jeton de ce PC quitte l'application. */
  async openAdmin() {
    const { ticket } = await this.signal.request<{ ticket: string }>({ t: "admin.ticket" });
    api.openExternal(`${this.playerUrl().replace(/\/player$/, "")}/admin#t=${ticket}`);
  }

  private sendError: (text: string, details: string) => void = () => {};

  reportCrash(error: Error, stack: string) {
    this.sendError(error.message, `${error.stack ?? ""}\n${stack}`);
  }

  private watchErrors() {
    const seen = new Set<string>();
    const send = (text: string, details: string) => {
      if (!get().settings?.sendErrors || seen.has(text) || seen.size >= MAX_ERROR_REPORTS) return;
      seen.add(text);
      this.signal.send({ t: "report", kind: "error", text: `${api.version} : ${text}`.slice(0, 1000), details: details.slice(0, 8000) });
    };
    this.sendError = send;
    window.addEventListener("error", e => send(e.message, String((e.error as Error | undefined)?.stack ?? `${e.filename}:${e.lineno}`)));
    window.addEventListener("unhandledrejection", e => send(String((e.reason as Error | undefined)?.message ?? e.reason), String((e.reason as Error | undefined)?.stack ?? "")));
  }

  async sendFeedback(text: string) {
    this.signal.send({ t: "report", kind: "feedback", text: text.slice(0, 3000), details: (await this.diagnostics()).slice(0, 18_000) });
  }

  /** Ce que voient les autres appareils du compte. Rien ne part tant que rien n'a changé. */
  private pushRemote() {
    const { publish, room, settings, muted, deafened, recording } = get();
    const name = (id: string | null) => (id ? (memberOf(id)?.name ?? "?") : null);
    const state: RemoteState | null = !settings
      ? null
      : !publish || !room
        ? this.idleRemote(settings)
        : {
            roomId: room.id,
            roomName: room.name,
            roomCode: room.code,
            title: publish.title,
            source: publish.sourceName,
            startedAt: room.streams.find(s => s.id === publish.streamId)?.startedAt ?? Date.now(),
            paused: publish.paused,
            screen: publish.screen,
            screens: settings.stream.screens.map(s => s.title),
            scene: publish.scene,
            scenes: settings.scenes.map(({ id, name: label }) => ({ id, name: label })),
            mix: publish.mix.map(({ id, label, volume, muted: off }) => ({ id, label, volume, muted: off })),
            viewers: publish.viewers.map(v => ({ id: v.id, name: name(v.id) ?? "?" })),
            stats: publish.stats ? { height: publish.stats.height, fps: publish.stats.fps, kbps: publish.stats.kbps, codec: publish.stats.codec, limit: limitText(publish.stats.limit) || null } : null,
            muted,
            deafened,
            camera: !!publish.camera,
            banner: publish.banner,
            recording: recording?.streamId === publish.streamId,
            file: publish.file ? { playing: publish.file.playing, time: Math.floor(publish.file.time), duration: publish.file.duration } : null,
            controlAsk: name(publish.controlAsk),
            controller: name(publish.controller),
            streamId: publish.streamId,
            allowDraw: publish.allowDraw,
            clips: this.clipsSaved,
            markers: get().activity.filter(a => a.kind === "marker").length,
          };
    const text = JSON.stringify(state);
    if (text === this.lastRemote) return;
    this.lastRemote = text;
    this.signal.send({ t: "remote.state", state });
  }

  /** Ce PC est allumé et ne diffuse pas. Le téléphone ne reçoit de quoi lancer un direct que si la personne l'a autorisé ici. */
  private idleRemote(settings: Settings): RemoteState {
    const room = get().room;
    return {
      roomId: room?.id ?? "",
      roomName: room?.name ?? "",
      roomCode: room?.code ?? "",
      title: "",
      source: "",
      startedAt: 0,
      paused: false,
      screen: null,
      screens: [],
      scene: null,
      scenes: [],
      mix: [],
      viewers: [],
      stats: null,
      muted: get().muted,
      deafened: get().deafened,
      camera: false,
      banner: "",
      recording: false,
      file: null,
      controlAsk: null,
      controller: null,
      idle: true,
      launch: settings.allowRemoteStart
        ? {
            rooms: settings.recentRooms.slice(0, 8).map(({ id, name }) => ({ id, name })),
            scenes: settings.scenes.filter(s => s.source).map(({ id, name }) => ({ id, name })),
            last: settings.lastLive?.name ?? null,
          }
        : null,
    };
  }

  /** Lance le direct depuis le téléphone : la source vient d'une scène, ou de la dernière diffusion. */
  private async remoteGoLive(text: string) {
    const settings = get().settings!;
    if (!settings.allowRemoteStart || this.publisher) return;
    const [roomId = "", sceneId = ""] = text.split("|");
    const scene = settings.scenes.find(s => s.id === sceneId);
    const saved = scene?.source ? { source: scene.source, audio: scene.audio ?? [] } : settings.lastLive;
    if (!saved) return toast("Aucune source connue : lance un premier direct depuis ce PC.", "warning");
    const source = await this.resolveScene(saved.source);
    if (!source) return toast("La source demandée par le téléphone n'est plus disponible.", "warning");
    if (get().room?.id !== roomId) {
      const code = settings.recentRooms.find(r => r.id === roomId)?.code;
      if (!code) return;
      await this.joinRoom(code);
      if (get().room?.id !== roomId) return;
    }
    const { stream } = settings;
    toast("Direct lancé depuis ton téléphone", "info", 8000);
    await this.goLive({ source, audio: await this.currentChoices(saved.audio), title: "", resolution: stream.resolution, fps: stream.fps, kbps: stream.kbps, codec: stream.codec, priority: stream.priority, audioKbps: stream.audioKbps, allowDraw: stream.allowDraw, maxViewers: stream.maxViewers });
    if (scene) await this.applyScene(scene.id);
  }

  /** Le serveur ne relaie que les appareils du même compte. Ici, seules ces commandes existent : un téléphone ne peut rien faire d'autre. */
  private async onRemoteCommand(cmd: RemoteCommand, arg?: string | number | boolean) {
    if (cmd === "goLive") return this.remoteGoLive(String(arg ?? ""));
    const publish = get().publish;
    if (!publish) return;
    const text = String(arg ?? "");
    const [id = "", value = ""] = text.split("|");
    switch (cmd) {
      case "pause":
        return this.setPaused(true);
      case "resume":
        return this.setPaused(false);
      case "screen": {
        const screen = get().settings!.stream.screens[Number(arg)];
        return screen ? this.setPaused(true, screen) : undefined;
      }
      case "scene":
        return this.applyScene(text);
      case "mute":
        return this.toggleMute();
      case "deafen":
        return this.toggleDeafen();
      case "camera":
        return this.setCamera(publish.camera ? null : get().settings!.stream.cameraId);
      case "record":
        return get().recording ? this.stopRecording() : this.startRecording();
      case "clip":
        return this.saveClip();
      case "marker":
        return this.addMarker();
      case "clear":
        return this.clearDrawings(publish.streamId);
      case "title":
        return this.updateStreamInfo({ title: text.slice(0, 80) });
      case "banner":
        return this.setBanner(text.slice(0, 80));
      case "mixVolume":
        return this.setMixVolume(id, Math.max(0, Math.min(1.5, Number(value) || 0)));
      case "mixMute":
        return this.setMixMuted(id, value === "1");
      case "kick":
        return this.kickViewer(text);
      case "stop":
        return this.stopLive();
      case "controlAccept":
        return this.acceptControl();
      case "controlRefuse":
        return this.refuseControl();
      case "controlEnd":
        return this.endControl();
      case "filePlay":
        return this.fileControl({ playing: arg === true });
      case "fileSeek":
        return this.fileControl({ time: Number(arg) || 0 });
      case "allowDraw":
        return this.updateStreamInfo({ allowDraw: arg === true });
    }
  }

  private quiet() {
    return !!get().publish && !!get().settings?.quietWhileLive;
  }

  private applyVolumes(settings: Settings) {
    this.playback.setBus("stream", settings.streamVolume);
    this.playback.setBus("voice", settings.voiceVolume);
    setSfxVolume(settings.sfxVolume);
  }

  /** Réglages de retour d'origine : le micro et le reste du moteur suivent comme après un changement à la main. */
  async resetSettings() {
    const next = await api.resetSettings();
    set({ settings: next });
    this.playback.setOutput(next.outputId);
    this.applyVolumes(next);
  }

  /** Montre l'overlay quelques secondes, sans avoir à lancer un stream. */
  async testOverlay() {
    if (get().publish) return toast("L'overlay est déjà affiché pendant ton stream.", "info");
    await api.overlayOpen({ settings: get().settings!.overlay });
    setTimeout(() => {
      api.overlaySend({ type: "viewers", count: 3, names: ["Pinoy", "Léa", "Sam"] });
      api.overlaySend({ type: "chat", name: "Pinoy", color: "#34d399", text: "Voilà à quoi ressemble un message" });
      api.overlaySend({ type: "reaction", emoji: "🔥", name: "Léa" });
    }, 900);
    setTimeout(() => api.overlayClose(), 6000);
  }

  /** Ouvre tous les streams du salon, y compris quand on diffuse soi-même. */
  watchAll() {
    for (const stream of get().room?.streams ?? []) if (stream.ownerId !== get().userId) void this.watch(stream.id);
  }

  private reportError(e: unknown) {
    const code = e instanceof RequestError ? e.code : null;
    toast((code && ERROR_TEXT[code]) || (e as Error).message || "Une erreur est survenue.", "error");
  }

  // ---------------------------------------------------------------- salons

  async createRoom(name: string) {
    try {
      await this.signal.request({ t: "room.create", name });
    } catch (e) {
      this.reportError(e);
    }
  }

  /** Accepte un code, ou un lien d'invitation collé tel quel. */
  async joinRoom(input: string) {
    const code = input.trim().match(/([A-Za-z0-9]{8})\s*$/)?.[1] ?? input.trim();
    try {
      await this.signal.request({ t: "room.join", code });
    } catch (e) {
      this.reportError(e);
    }
  }

  async openRoom(id: string) {
    if (get().room?.id === id) return set({ view: "room" });
    try {
      await this.signal.request({ t: "room.join", id });
    } catch (e) {
      this.reportError(e);
      if (e instanceof RequestError && e.code === "room_not_found") {
        this.signal.send({ t: "account.forget", id });
        await this.updateSettings({ recentRooms: get().settings!.recentRooms.filter(r => r.id !== id) });
      }
    }
  }

  leaveRoom() {
    if (!get().room) return;
    this.signal.send({ t: "room.leave" });
    this.leftRoom();
  }

  private leftRoom() {
    void this.stopLive();
    this.voiceLeave();
    for (const id of [...this.subs.keys()]) this.closeSub(id);
    set({ room: null, focused: null, view: get().view === "settings" ? "settings" : "home", replyTo: null, unread: 0 });
    this.pushTray();
  }

  updateRoom(name?: string, settings?: Partial<RoomSettings>) {
    this.signal.send({ t: "room.update", name, settings });
  }

  deleteRoom() {
    const id = get().room?.id;
    this.signal.send({ t: "room.delete" });
    if (id) {
      this.signal.send({ t: "account.forget", id });
      void this.updateSettings({ recentRooms: get().settings!.recentRooms.filter(r => r.id !== id) });
    }
  }

  kickMember(userId: string, ban: boolean) {
    this.signal.send({ t: "room.kick", userId, ban });
  }

  inviteLink(code: string) {
    const url = get().settings!.serverUrl;
    if (/^wss:\/\//.test(url)) return `${url.replace(/^wss:/, "https:").replace(/\/ws$/, "")}/j/${code}`;
    return `spokastream://join/${code}`;
  }

  // ---------------------------------------------------------------- chat et interactions

  sendChat(text: string, image: string | null = null) {
    this.signal.send({ t: "chat.send", text, replyTo: get().replyTo?.id ?? null, image });
    set({ replyTo: null });
  }

  deleteChat(id: string) {
    this.signal.send({ t: "chat.delete", id });
  }

  reactChat(id: string, emoji: string) {
    this.signal.send({ t: "chat.react", id, emoji });
  }

  pinChat(id: string | null) {
    this.signal.send({ t: "chat.pin", id });
  }

  /** Une indication toutes les 2,5 s suffit : elle reste affichée 4 s chez les autres. */
  sendTyping() {
    const now = Date.now();
    if (now - this.lastTyping < 2500) return;
    this.lastTyping = now;
    this.signal.send({ t: "chat.typing" });
  }

  createPoll(question: string, options: string[]) {
    this.signal.send({ t: "poll.create", question, options });
    set({ panelTab: "chat" });
    if (!get().settings!.chatPanelOpen) void this.updateSettings({ chatPanelOpen: true });
  }

  votePoll(id: string, option: number) {
    this.signal.send({ t: "poll.vote", id, option });
  }

  closePoll(id: string) {
    this.signal.send({ t: "poll.close", id });
  }

  dismissPoll(id: string) {
    this.signal.send({ t: "poll.dismiss", id });
  }

  // ---------------------------------------------------------------- regarder ensemble

  playerUrl() {
    return `${get().settings!.serverUrl.replace(/^ws/, "http").replace(/\/ws$/, "")}/player`;
  }

  /** Rend true quand la vidéo part, false si le lien ne mène à rien, ou la page à diffuser quand aucun lecteur ne peut l'ouvrir pour tout le salon. */
  async togetherAdd(link: string, subtitles = ""): Promise<boolean | VideoInfo> {
    const videoId = youtubeId(link);
    if (videoId) {
      const info = await api.youtubeInfo(videoId).catch(() => null);
      if (info) this.signal.send({ t: "together.add", videoId, title: info.title });
      else toast("Cette vidéo n'existe pas, ou YouTube interdit de la regarder hors de son site.", "warning", 6000);
      return !!info;
    }
    const url = videoUrl(/^[a-z]+:\/\//i.test(link.trim()) ? link : `https://${link.trim()}`);
    if (!url) {
      toast("Ce lien n'est pas valable.", "warning");
      return false;
    }
    const info = await api.videoInfo(url).catch(() => null);
    if (!info) {
      toast("Ce lien ne répond pas.", "warning");
      return false;
    }
    // Une page https refuse une vidéo http, et un format que Chromium ne sait pas lire ne marcherait chez personne.
    const blocked = this.playerUrl().startsWith("https:") && info.url.startsWith("http:");
    if (info.kind === "page" || blocked || (!isHls(info.url) && !(await canPlay(info.url)))) return { ...info, kind: "page", url };
    this.signal.send({ t: "together.add", url: info.url, title: info.title, ...(subtitles.trim() ? { subtitles: subtitles.trim() } : {}) });
    return true;
  }

  togetherControl(playing: boolean, position: number) {
    this.signal.send({ t: "together.control", playing, position });
  }

  togetherNext(videoId: string) {
    this.signal.send({ t: "together.next", videoId });
  }

  togetherRemove(index: number, videoId: string) {
    this.signal.send({ t: "together.remove", index, videoId });
  }

  togetherStop() {
    this.signal.send({ t: "together.stop" });
  }

  togetherPosition() {
    const { room, togetherAt } = get();
    const together = room?.together;
    if (!together) return 0;
    return together.playing ? together.position + (performance.now() - togetherAt) / 1000 : together.position;
  }

  react(streamId: string | null, emoji: string) {
    this.signal.send({ t: "reaction", streamId, emoji });
  }

  newStrokeId() {
    return `${get().userId.slice(0, 6)}-${++this.strokeCount}`;
  }

  sendStroke(streamId: string, stroke: Stroke) {
    this.signal.send({ t: "draw", streamId, stroke });
    this.onDraw(streamId, get().userId, stroke);
  }

  clearDrawings(streamId: string) {
    this.signal.send({ t: "draw.clear", streamId });
  }

  onDrawEvent(listener: DrawListener) {
    this.drawListeners.add(listener);
    return () => void this.drawListeners.delete(listener);
  }

  onReactionEvent(listener: ReactionListener) {
    this.reactionListeners.add(listener);
    return () => void this.reactionListeners.delete(listener);
  }

  // ---------------------------------------------------------------- regarder

  async watch(streamId: string) {
    const stream = get().room?.streams.find(s => s.id === streamId);
    if (!stream || this.subs.has(streamId)) return;
    const settings = get().settings!;
    const sub = new Subscription(streamId, stream.ownerId, settings.latency, () => get().iceServers, data =>
      this.signal.send({ t: "rtc", to: stream.ownerId, session: streamId, data }),
    );
    this.subs.set(streamId, sub);
    const { maxHeight, maxKbps } = START_QUALITIES.find(q => q.maxHeight === settings.watchQuality) ?? { maxHeight: 0, maxKbps: 0 };
    const quality: ViewerQuality = { ...DEFAULT_VIEWER_QUALITY, maxHeight, maxKbps };
    const volume = savedVolume(stream.ownerId);
    set(s => ({
      subs: { ...s.subs, [streamId]: { streamId, ownerId: stream.ownerId, state: "connecting", media: sub.media, camera: sub.camera, volume, muted: false, quality, stats: null, hasAudio: false } },
      focused: s.focused && s.focused !== TOGETHER ? s.focused : s.room?.together ? s.focused : streamId,
    }));
    sub.onState = state => patchSub(streamId, { state });
    sub.onTrack = track => {
      if (track.kind !== "audio") return;
      const view = get().subs[streamId];
      this.playback.add(streamId, "stream", track, view?.volume ?? 1, this.isSilent(streamId));
      patchSub(streamId, { hasAudio: true });
    };
    sub.onControl = message => this.onHandMessage(streamId, message);
    sub.onLost = () => {
      if (this.subs.has(streamId)) void this.signal.request({ t: "stream.watch", id: streamId, on: true, quality: this.sentQuality(streamId) }).catch(() => {});
    };
    try {
      await this.signal.request({ t: "stream.watch", id: streamId, on: true, quality });
    } catch (e) {
      this.closeSub(streamId);
      this.reportError(e);
    }
  }

  unwatch(streamId: string) {
    this.signal.send({ t: "stream.watch", id: streamId, on: false });
    this.closeSub(streamId);
  }

  private closeSub(streamId: string) {
    const sub = this.subs.get(streamId);
    if (!sub) return;
    if (get().recording?.streamId === streamId) void this.stopRecording();
    if (get().hand?.streamId === streamId) set({ hand: null });
    sub.close();
    this.subs.delete(streamId);
    this.playback.remove(streamId);
    this.fits.delete(streamId);
    clearTimeout(this.fitTimers.get(streamId));
    this.fitTimers.delete(streamId);
    set(s => {
      const subs = { ...s.subs };
      delete subs[streamId];
      return { subs, solo: s.solo === streamId ? null : s.solo, focused: s.focused === streamId ? (Object.keys(subs)[0] ?? null) : s.focused };
    });
  }

  setSubVolume(streamId: string, volume: number) {
    this.playback.setVolume(streamId, volume);
    patchSub(streamId, { volume, muted: false });
    this.applyMuted(streamId);
    const ownerId = get().subs[streamId]?.ownerId;
    try {
      if (ownerId) localStorage.setItem(`volume:${ownerId}`, String(volume));
    } catch {
      // Le volume reste valable pour cette séance.
    }
  }

  setSubMuted(streamId: string, muted: boolean) {
    patchSub(streamId, { muted });
    this.applyMuted(streamId);
  }

  private isSilent(streamId: string) {
    const solo = soloOf(get());
    return !!get().subs[streamId]?.muted || (solo !== null && solo !== streamId);
  }

  private applyMuted(streamId: string) {
    this.playback.setMuted(streamId, this.isSilent(streamId));
  }

  toggleSolo(id: string) {
    set(s => ({ solo: s.solo === id ? null : id }));
  }

  setSubQuality(streamId: string, quality: ViewerQuality) {
    patchSub(streamId, { quality });
    this.signal.send({ t: "stream.quality", id: streamId, quality: this.sentQuality(streamId) });
  }

  /** La qualité choisie, plafonnée à ce que la tuile peut afficher. Un seul stream ouvert garde toujours tout. */
  private sentQuality(streamId: string): ViewerQuality {
    const quality = get().subs[streamId]?.quality ?? DEFAULT_VIEWER_QUALITY;
    const fit = FIT_TIERS.find(tier => tier.maxHeight === this.fits.get(streamId));
    if (!fit || this.subs.size < 2 || !get().settings?.wall.fitQuality) return quality;
    return { ...quality, maxHeight: quality.maxHeight ? Math.min(quality.maxHeight, fit.maxHeight) : fit.maxHeight, maxKbps: quality.maxKbps ? Math.min(quality.maxKbps, fit.maxKbps) : fit.maxKbps };
  }

  /** Une tuile vient de changer de taille. On attend qu'elle se pose : un glissement ne doit pas renégocier à chaque pixel. */
  fitSub(streamId: string, height: number) {
    const target = FIT_TIERS.find(tier => height * devicePixelRatio <= tier.upTo)?.maxHeight ?? 0;
    clearTimeout(this.fitTimers.get(streamId));
    if (target === (this.fits.get(streamId) ?? 0)) return;
    this.fitTimers.set(
      streamId,
      setTimeout(() => {
        this.fits.set(streamId, target);
        for (const id of this.subs.keys()) this.signal.send({ t: "stream.quality", id, quality: this.sentQuality(id) });
      }, FIT_DELAY_MS),
    );
  }

  updateWall(patch: Partial<WallSettings>) {
    void this.updateSettings({ wall: { ...get().settings!.wall, ...patch } });
  }

  /** La disposition libre part de ce qu'on voit : on déplace ce qui est à l'écran, sans repartir de zéro. */
  setWallMode(mode: WallMode, shown: Record<string, WallRect> = {}) {
    const { free } = get().settings!.wall;
    this.updateWall(mode === "free" ? { mode, free: { ...shown, ...free } } : { mode });
  }

  setLatency(latency: Settings["latency"]) {
    void this.updateSettings({ latency });
    for (const sub of this.subs.values()) sub.setLatency(latency);
  }

  streamLevel(streamId: string) {
    return this.playback.level(streamId);
  }

  voiceLevel(userId: string) {
    return this.playback.level(`voice:${userId}`);
  }

  /** Le spectateur garde ce qu'il voit, le son du stream compris. */
  async recordWatching(streamId: string) {
    const view = get().subs[streamId];
    if (!view) return;
    await this.record(new MediaStream(view.media.getTracks()), memberOf(view.ownerId)?.name ?? "stream", view.stats?.kbps ?? 8000, streamId);
  }

  async screenshot(video: HTMLVideoElement, name: string) {
    try {
      const file = await saveVideoFrame(video, name);
      const image = frameForChat(video);
      toast("Capture enregistrée", "success", 6000, { label: "Envoyer au chat", run: () => void image.then(data => data && this.sendChat("", data)) });
      return file;
    } catch (e) {
      this.reportError(e);
      return null;
    }
  }

  // ---------------------------------------------------------------- diffuser

  private buildTarget(config: Pick<GoLiveConfig, "resolution" | "fps" | "kbps" | "priority" | "codec" | "audioKbps">): EncodingTarget {
    return {
      kbps: config.kbps,
      roomMaxKbps: get().room?.settings.maxKbps ?? 0,
      fps: config.fps,
      maxHeight: resolutionHeight(config.resolution),
      priority: config.priority,
      codec: config.codec,
      audioKbps: config.audioKbps,
    };
  }

  private async ensureBench(config: GoLiveConfig, height: number): Promise<BenchResult[]> {
    const wanted = resolutionHeight(config.resolution) || height;
    const key = benchClass(Math.min(wanted, height) || 1080);
    const cached = cachedBench(key, config.fps);
    if (cached) return cached;
    const sources = await api.listSources();
    const screen = sources.find(s => s.kind === "screen");
    const results = await measureEncoders(screen?.id ?? null, Math.round((key * 16) / 9), key, config.fps, config.kbps, label => set({ benching: label }));
    set({ benching: null });
    return results;
  }

  async addAudio(choice: AudioChoice) {
    const mixer = this.mixer;
    if (!mixer) return;
    try {
      const id = choice.type === "system" ? await mixer.addCapture("exclude", api.selfPid, "Tout le PC", null) : choice.type === "app" ? await mixer.addCapture("include", choice.pid, choice.name, choice.icon) : await mixer.addDevice(choice.deviceId, choice.label);
      this.mixChoices.set(id, choice);
    } catch (e) {
      toast(`Son : ${(e as Error).message}`, "error");
    }
    this.afterMixChange();
  }

  private afterMixChange() {
    const mix = this.mixer?.list ?? [];
    patchPublish({ mix });
    const audio: AudioKind = mix.some(m => m.label === "Tout le PC") ? "system" : mix.some(m => m.kind === "capture") ? "apps" : mix.some(m => m.kind === "media") ? "file" : mix.length ? "input" : "none";
    this.updateAnnounce({ audio, audioLabel: mix.map(m => m.label).join(", ") });
  }

  private updateAnnounce(patch: Partial<StreamAnnounce>) {
    if (!this.announce) return;
    this.announce = { ...this.announce, ...patch };
    this.signal.send({ t: "stream.update", patch });
  }

  removeMix(id: string) {
    this.mixer?.remove(id);
    this.mixChoices.delete(id);
    this.afterMixChange();
  }

  setMixVolume(id: string, volume: number) {
    this.mixer?.setVolume(id, volume);
    patchPublish({ mix: this.mixer?.list ?? [] });
  }

  setMixMuted(id: string, muted: boolean) {
    this.mixer?.setMuted(id, muted);
    patchPublish({ mix: this.mixer?.list ?? [] });
  }

  mixLevels() {
    return this.mixer?.levels() ?? {};
  }

  private captureOptions() {
    return { game: get().settings!.stream.gameCapture };
  }

  private reportCapture(opened: OpenedSource) {
    if (opened.gameCapture === "active") toast("Capture de jeu active : ta souris reste visible.");
    if (opened.gameCapture === "protected") toast("Anti-triche détecté : capture normale, SpokaStream n'entre pas dans ce jeu.", "info", 8000);
    if (opened.gameCapture === "failed") toast("La capture de jeu n'a pas pris sur ce jeu : capture normale.", "warning", 10_000);
  }

  async goLive(config: GoLiveConfig) {
    if (this.publisher) return;
    const streamId = `${get().userId.slice(0, 8)}-${Date.now().toString(36)}`;
    let opened: OpenedSource;
    try {
      opened = await openSource(config.source, config.fps, resolutionHeight(config.resolution), this.captureOptions());
      this.reportCapture(opened);
    } catch (e) {
      this.reportError(e);
      return false;
    }
    opened.track.contentHint = config.priority === "detail" ? "detail" : "motion";
    const { width, height } = opened;
    const bench = await this.ensureBench(config, height).catch(() => [] as BenchResult[]);
    const mixer = new StreamMixer();
    this.mixer = mixer;
    mixer.setNormalize(get().settings!.stream.normalizeAudio);
    this.opened = opened;
    const target = this.buildTarget(config);
    this.publisher = new Publisher({
      session: streamId,
      video: opened.track,
      sourceHeight: height,
      audio: mixer.track,
      target,
      bench,
      iceServers: () => get().iceServers,
      sendSignal: (to, data) => this.signal.send({ t: "rtc", to, session: streamId, data }),
    });
    this.publisher.onControl = (from, message) => this.onHostControl(from, message);
    this.publisher.onViewerGone = id => {
      if (get().publish?.controller === id) this.endControl();
      if (get().publish?.controlAsk === id) patchPublish({ controlAsk: null });
    };
    mixer.talkLevel = () => this.voice?.level ?? 0;
    this.currentSource = config.source;
    this.controlTarget = this.controlTargetOf(config.source);
    const allowControl = !!this.controlTarget && get().settings!.stream.allowControl;
    const { cameraLayout } = get().settings!.stream;
    this.healthHistory.length = 0;
    this.lastViewers = new Set();
    const preview = this.openPreview(opened.track);
    set({
      publish: {
        streamId,
        preview,
        sourceName: opened.name,
        kind: opened.kind,
        file: null,
        nativeCapture: opened.native,
        gameCapture: opened.gameCapture === "active",
        stats: null,
        viewers: [],
        mix: [],
        paused: false,
        target,
        bench,
        title: config.title,
        allowDraw: config.allowDraw,
        maxViewers: config.maxViewers,
        camera: null,
        cameraLayout,
        banner: "",
        scene: null,
        screen: null,
        allowControl,
        controlScope: this.controlTarget?.hwnd ? "window" : this.controlTarget ? "screen" : null,
        controlAsk: null,
        controller: null,
        controlBlocked: false,
      },
      panelTab: "studio",
      activity: [],
      regie: get().settings!.regie.auto,
      focused: get().settings!.regie.auto ? streamId : get().focused,
    });
    for (const choice of config.audio) await this.addAudio(choice);
    this.sourceMixId = opened.audio ? mixer.addMediaStream(opened.audio, opened.name) : null;
    const mix = mixer.list;
    patchPublish({ mix });
    this.announce = {
      title: config.title,
      kind: opened.kind,
      sourceName: opened.name,
      width,
      height,
      fps: config.fps,
      audio: mix.some(m => m.label === "Tout le PC") ? "system" : mix.some(m => m.kind === "capture") ? "apps" : opened.audio ? "file" : mix.length ? "input" : "none",
      audioLabel: mix.map(m => m.label).join(", "),
      paused: false,
      allowDraw: config.allowDraw,
      maxViewers: config.maxViewers,
      camera: false,
      cameraLayout,
      banner: "",
      allowControl,
      controller: null,
    };
    try {
      await this.signal.request({ t: "stream.start", id: streamId, stream: this.announce });
    } catch (e) {
      this.reportError(e);
      await this.stopLive();
      return false;
    }
    this.watchSource(opened);
    this.startPreviewLoop(preview);
    this.clipsSaved = 0;
    const remembered = this.sceneSourceOf(config.source);
    if (remembered) void this.updateSettings({ lastLive: { source: remembered, name: opened.name, audio: config.audio } });
    this.openOverlay(config.source);
    playSound("live", get().settings!.soundEffects);
    this.pushTray();
    if (get().settings!.stream.autoRecord) void this.startRecording();
    return true;
  }

  private openOverlay(source: VideoSource) {
    const overlay = get().settings!.overlay;
    if (!overlay.enabled || (source.kind !== "screen" && source.kind !== "window")) return api.overlayClose();
    void api.overlayOpen({ displayId: source.kind === "screen" ? source.source.displayId : undefined, hwnd: source.kind === "window" ? source.source.id.split(":")[1] : undefined, settings: overlay });
  }

  /** Le fichier diffusé reste entre les mains du diffuseur : pause, position et boucle passent par ici. */
  private followFile(opened: OpenedSource) {
    const element = opened.element;
    if (!element) return patchPublish({ file: null });
    const push = () => {
      if (this.opened === opened) patchPublish({ file: { playing: !element.paused, time: element.currentTime, duration: Number.isFinite(element.duration) ? element.duration : 0, loop: this.fileLoop } });
    };
    this.fileLoop = false;
    for (const type of ["timeupdate", "play", "pause", "durationchange", "seeked"]) element.addEventListener(type, push);
    // Le seul retour au début qu'on n'a pas demandé, c'est la fin du fichier.
    element.addEventListener("seeking", () => {
      if (this.fileSeek) return void (this.fileSeek = false);
      if (this.fileLoop || this.opened !== opened) return;
      element.pause();
      toast("Le fichier est terminé", "info");
    });
    push();
  }

  fileControl(change: { playing?: boolean; time?: number; loop?: boolean }) {
    const element = this.opened?.element;
    const file = get().publish?.file;
    if (!element || !file) return;
    if (change.time !== undefined) {
      this.fileSeek = true;
      element.currentTime = change.time;
    }
    if (change.loop !== undefined) {
      this.fileLoop = change.loop;
      patchPublish({ file: { ...file, loop: change.loop } });
    }
    if (change.playing === true) void element.play().catch(() => {});
    if (change.playing === false) element.pause();
  }

  private watchSource(opened: OpenedSource) {
    this.followFile(opened);
    opened.onEnded(() => {
      if (this.opened !== opened) return;
      this.sourceGone = true;
      toast("La source n'est plus disponible. Stream mis en pause : choisis une autre source.", "warning", 7000);
      void this.setPaused(true);
    });
    opened.onResize((width, height) => {
      if (this.opened !== opened) return;
      void this.publisher?.setSourceHeight(height);
      this.updateAnnounce({ width, height });
    });
  }

  private openPreview(track: MediaStreamTrack) {
    this.previewTrack?.stop();
    this.previewTrack = track.clone();
    this.followFocus();
    return new MediaStream([this.previewTrack]);
  }

  /** Quand on joue, rien ne doit forcer la fenêtre à se redessiner à chaque image : c'est le jeu qui en paierait le prix. */
  private followFocus() {
    const focused = document.hasFocus();
    document.documentElement.classList.toggle("is-blurred", !focused);
    const fps = focused ? (get().publish?.target.fps ?? 60) : BACKGROUND_PREVIEW_FPS;
    void this.previewTrack?.applyConstraints({ frameRate: { max: fps } }).catch(() => {});
  }

  private startPreviewLoop(preview: MediaStream) {
    const video = document.createElement("video");
    video.muted = true;
    video.srcObject = preview;
    void video.play();
    this.previewElement = video;
    const send = () => {
      if (get().publish?.paused || this.previewElement !== video) return;
      const data = captureThumbnail(video);
      if (data) this.signal.send({ t: "stream.thumb", data });
    };
    setTimeout(send, 1500);
    this.previewTimer = setInterval(send, 6000);
  }

  /** audio : le nouveau son du stream, ou null pour garder celui en cours. Le son propre à un fichier suit toujours sa source. */
  async switchSource(source: VideoSource, audio: AudioChoice[] | null) {
    if (!this.publisher || !this.opened) return;
    const { fps, maxHeight, priority } = get().publish!.target;
    let next: OpenedSource;
    try {
      next = await openSource(source, fps, maxHeight, this.captureOptions());
      this.reportCapture(next);
    } catch (e) {
      return this.reportError(e);
    }
    const previous = this.opened;
    next.track.contentHint = priority === "detail" ? "detail" : "motion";
    // La main donnée visait l'ancienne source : elle ne suit jamais un changement.
    this.endControl();
    this.currentSource = source;
    this.controlTarget = this.controlTargetOf(source);
    const allowControl = !!this.controlTarget && get().settings!.stream.allowControl;
    patchPublish({ allowControl, controlScope: this.controlTarget?.hwnd ? "window" : this.controlTarget ? "screen" : null });
    this.updateAnnounce({ allowControl });
    this.opened = next;
    this.sourceGone = false;
    this.watchSource(next);
    if (!get().publish!.paused) await this.publisher.replaceVideo(next.track, next.height);
    previous.stop();
    const preview = this.openPreview(next.track);
    if (this.previewElement) this.previewElement.srcObject = preview;
    patchPublish({ preview, sourceName: next.name, kind: next.kind, nativeCapture: next.native, gameCapture: next.gameCapture === "active" });
    this.updateAnnounce({ kind: next.kind, sourceName: next.name, width: next.width, height: next.height });
    if (audio) {
      this.mixer?.clear();
      this.mixChoices.clear();
      for (const choice of audio) await this.addAudio(choice);
    } else if (this.sourceMixId) {
      this.mixer?.remove(this.sourceMixId);
    }
    this.sourceMixId = next.audio ? (this.mixer?.addMediaStream(next.audio, next.name) ?? null) : null;
    this.afterMixChange();
    this.openOverlay(source);
    toast("Source changée", "success");
  }

  /** screen : l'écran d'attente à montrer à la place de l'image. Un autre écran peut en remplacer un déjà affiché. */
  async setPaused(paused: boolean, screen?: WaitScreen) {
    const publish = get().publish;
    if (!publish || !this.publisher || (publish.paused === paused && !(paused && screen))) return;
    if (paused) {
      this.endControl();
      const previous = this.pauseCard;
      this.pauseCard = createPauseCard(screen);
      await this.publisher.replaceVideo(this.pauseCard.track, 720);
      previous?.stop();
    } else {
      if (!this.opened || this.sourceGone) return toast("La source n'existe plus : choisis-en une autre pour reprendre.", "warning");
      await this.publisher.replaceVideo(this.opened.track, this.opened.height);
      this.pauseCard?.stop();
      this.pauseCard = null;
    }
    this.mixer?.setSilenced(paused && !screen?.keepSound);
    patchPublish({ paused, screen: paused ? (screen?.title ?? null) : null });
    this.updateAnnounce({ paused });
    this.pushTray();
  }

  async updateEncoding(patch: Partial<EncodingTarget>) {
    const publish = get().publish;
    if (!publish || !this.publisher) return;
    const target = { ...publish.target, ...patch };
    patchPublish({ target });
    if (patch.priority && this.opened) this.opened.track.contentHint = patch.priority === "detail" ? "detail" : "motion";
    if (patch.fps) this.updateAnnounce({ fps: patch.fps });
    if (patch.fps !== undefined || patch.maxHeight !== undefined) this.opened?.configure(target.fps, target.maxHeight);
    await this.publisher.applyTarget(target, publish.bench);
  }

  setMixOffset(id: string, offsetMs: number) {
    this.mixer?.setOffset(id, offsetMs);
    patchPublish({ mix: this.mixer?.list ?? [] });
  }

  setMixDuck(id: string, duck: boolean) {
    this.mixer?.setDuck(id, duck);
    patchPublish({ mix: this.mixer?.list ?? [] });
  }

  updateStreamInfo(patch: { title?: string; allowDraw?: boolean; maxViewers?: number; allowControl?: boolean }) {
    if (patch.allowControl === false) this.endControl();
    if (patch.allowDraw !== undefined) void this.updateSettings({ stream: { ...get().settings!.stream, allowDraw: patch.allowDraw } });
    if (patch.maxViewers !== undefined) void this.updateSettings({ stream: { ...get().settings!.stream, maxViewers: patch.maxViewers } });
    patchPublish(patch);
    this.updateAnnounce(patch);
    if (patch.allowDraw === false && get().publish) this.clearDrawings(get().publish!.streamId);
  }

  kickViewer(userId: string) {
    this.publisher?.removeViewer(userId);
    this.signal.send({ t: "stream.kick", userId });
  }

  async stopLive() {
    const publish = get().publish;
    if (!publish && !this.publisher) return;
    if (get().recording?.streamId === publish?.streamId) await this.stopRecording();
    this.endControl();
    this.controlTarget = null;
    this.currentSource = null;
    this.mixChoices.clear();
    this.stopClips();
    this.cameraStream?.getTracks().forEach(t => t.stop());
    this.cameraStream = null;
    api.overlayClose();
    this.signal.send({ t: "stream.stop" });
    this.publisher?.close();
    this.publisher = null;
    this.announce = null;
    this.opened?.stop();
    this.opened = null;
    this.sourceGone = false;
    this.pauseCard?.stop();
    this.pauseCard = null;
    this.mixer?.dispose();
    this.mixer = null;
    clearInterval(this.previewTimer);
    if (this.previewElement) this.previewElement.srcObject = null;
    this.previewElement = null;
    this.previewTrack?.stop();
    this.previewTrack = null;
    set(s => ({ publish: null, panelTab: s.panelTab === "studio" ? "chat" : s.panelTab }));
    this.pushTray();
  }

  private async record(stream: MediaStream, name: string, kbps: number, streamId: string) {
    if (this.recorder) return;
    const recorder = new Recorder();
    try {
      await recorder.start(stream, name, kbps);
      this.recorder = recorder;
      set({ recording: { path: recorder.path, startedAt: Date.now(), streamId } });
      toast("Enregistrement démarré", "success");
    } catch (e) {
      this.reportError(e);
    }
  }

  async startRecording() {
    const publish = get().publish;
    if (!publish || !this.opened || !this.mixer) return;
    await this.record(new MediaStream([this.opened.track, this.mixer.track]), publish.title || publish.sourceName, publish.target.kbps, publish.streamId);
  }

  async stopRecording() {
    const recorder = this.recorder;
    if (!recorder) return;
    this.recorder = null;
    await recorder.stop();
    set({ recording: null, lastRecording: recorder.path });
    toast("Enregistrement terminé", "success");
  }

  // ---------------------------------------------------------------- clips

  /**
   * Les clips suivent ce qu'on a sous les yeux : son propre stream, sinon celui qu'on regarde en grand.
   * Une seule mémoire tourne à la fois, et elle repart de zéro si la source change.
   */
  private followClips() {
    const { publish, subs, focused, settings } = get();
    const seconds = settings?.stream.clipSeconds ?? 0;
    const sub = !publish ? (subs[focused ?? ""] ?? Object.values(subs)[0]) : undefined;
    const media = publish ? (this.opened && this.mixer ? new MediaStream([this.opened.track, this.mixer.track]) : null) : sub && sub.quality.video && sub.state === "connected" ? new MediaStream(sub.media.getTracks()) : null;
    const key = media?.getVideoTracks()[0] && !publish?.paused && seconds ? `${media.getVideoTracks()[0]!.id}:${seconds}` : null;
    if (key === this.clipSource) return;
    this.stopClips();
    if (!key || !media || !ClipBuffer.supported || !this.clipHardware) return;
    this.clipSource = key;
    this.clipBuffer = new ClipBuffer(seconds);
    try {
      this.clipBuffer.start(media, publish ? publish.target.kbps : (sub?.stats?.kbps ?? 8000));
    } catch (e) {
      console.warn("clips :", e);
      this.stopClips();
    }
  }

  private stopClips() {
    this.clipBuffer?.stop();
    this.clipBuffer = null;
    this.clipSource = null;
  }

  private async takeClip() {
    const buffer = this.clipBuffer;
    if (get().clipSaving) return null;
    if (!buffer) {
      const reason = !this.clipHardware ? "Ce PC n'a pas d'encodeur matériel H.264 : les clips restent coupés pour ne pas ralentir le stream." : get().settings?.stream.clipSeconds ? "Rien à garder pour l'instant : diffuse ou regarde un stream." : "Les clips sont coupés dans Paramètres, Diffusion.";
      toast(reason, "info");
      return null;
    }
    set({ clipSaving: true });
    try {
      const source = await buffer.save();
      if (!source) toast("Clip trop court : réessaie dans quelques secondes.", "info");
      return source;
    } finally {
      set({ clipSaving: false });
    }
  }

  private clipTitle() {
    const publish = get().publish;
    return publish ? publish.title || publish.sourceName : memberOf(get().subs[get().focused ?? ""]?.ownerId ?? "")?.name ?? "Stream";
  }

  async saveClip() {
    try {
      const source = await this.takeClip();
      if (!source) return;
      const title = this.clipTitle();
      const file = await saveClipFile(assembleClip(source.header, source.fragments), title);
      this.clipsSaved++;
      playSound("unmute", get().settings!.soundEffects);
      toast(`Clip gardé : ${Math.round(source.seconds)} s`, "success", 7000, { label: "Revoir", run: () => this.showTaken(source, title, file) });
    } catch (e) {
      this.reportError(e);
    }
  }

  /** Revoir ce qui vient de se passer : rien n'est écrit tant qu'on ne le demande pas. */
  async replay() {
    const title = this.clipTitle();
    const source = await this.takeClip().catch(e => (this.reportError(e), null));
    if (source) this.showTaken(source, title, null);
  }

  private showClip(view: { title: string; seconds: number; times: number[] | null; path: string | null }, bytes: Uint8Array, opened: { source: ClipSource | null; bytes: Uint8Array | null }) {
    this.closeClip();
    this.openedClip = opened;
    set({ clip: { ...view, url: URL.createObjectURL(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: "video/mp4" })) } });
  }

  private showTaken(source: ClipSource, title: string, path: string | null) {
    const bytes = assembleClip(source.header, source.fragments);
    this.showClip({ title, seconds: source.seconds, times: fragmentTimes(source.header, source.fragments), path }, bytes, { source, bytes: null });
  }

  closeClip() {
    const clip = get().clip;
    if (clip) URL.revokeObjectURL(clip.url);
    this.openedClip = null;
    set({ clip: null });
  }

  private clipRange(start: number, end: number) {
    const source = this.openedClip?.source;
    return source ? assembleClip(source.header, source.fragments.slice(start, end)) : null;
  }

  /** Rend le chemin du fichier écrit. */
  async keepClip(start: number, end: number) {
    const bytes = this.clipRange(start, end) ?? this.openedClip?.bytes;
    const title = get().clip?.title;
    if (!bytes || !title) return null;
    try {
      const file = await saveClipFile(bytes, title);
      toast("Clip enregistré", "success");
      return file;
    } catch (e) {
      this.reportError(e);
      return null;
    }
  }

  /** Le clip reste ici : le salon n'en reçoit que la vignette, et chacun le demande en l'ouvrant. */
  async shareClip(start: number, end: number, video: HTMLVideoElement) {
    const source = this.openedClip?.source;
    const bytes = this.clipRange(start, end);
    const clip = get().clip;
    if (!source || !bytes || !clip) return;
    const times = clip.times!;
    const seconds = Math.max(1, Math.round((times[end] ?? clip.seconds) - times[start]!));
    const id = [...crypto.getRandomValues(new Uint8Array(8))].map(b => b.toString(16).padStart(2, "0")).join("");
    this.clipShares.hold(id, bytes);
    this.signal.send({ t: "chat.send", text: "", clip: { id, title: clip.title, seconds, bytes: bytes.length, thumb: clipThumb(video) } });
  }

  async openClip(message: ChatMessage) {
    const clip = message.clip;
    if (!clip || get().clipLoading) return;
    const own = this.clipShares.get(clip.id);
    if (own) return this.showClip({ title: clip.title, seconds: clip.seconds, times: null, path: null }, own, { source: null, bytes: own });
    set({ clipLoading: { id: clip.id, share: 0 } });
    try {
      const bytes = await this.clipShares.fetch(message.authorId, clip.id, clip.bytes, share => set({ clipLoading: { id: clip.id, share } }));
      this.showClip({ title: clip.title, seconds: clip.seconds, times: null, path: null }, bytes, { source: null, bytes });
    } catch (e) {
      toast((e as Error).message, "warning");
    } finally {
      set({ clipLoading: null });
    }
  }

  // ---------------------------------------------------------------- obs

  private async onObsOffer(id: string, sdp: string) {
    const wasLive = this.currentSource?.kind === "obs";
    try {
      const { addresses } = await api.obsInfo();
      api.obsAnswer(id, await this.obs.accept(id, sdp, addresses));
    } catch (e) {
      console.warn("obs :", e);
      return api.obsAnswer(id, null);
    }
    await this.waitForObs();
    // OBS relancé en plein direct : le stream reprend tout seul là où il s'était arrêté.
    if (wasLive && this.publisher) {
      await this.switchSource({ kind: "obs", ingest: this.obs }, []);
      return void this.setPaused(false);
    }
    if (get().room && !get().publish) toast("OBS est connecté.", "success", 8000, { label: "Diffuser", run: () => set({ goLiveOpen: true, view: "room" }) });
  }

  private async waitForObs() {
    for (let i = 0; i < 40 && !this.obs.connected; i++) await new Promise(resolve => setTimeout(resolve, 100));
  }

  obsSource(): VideoSource {
    return { kind: "obs", ingest: this.obs };
  }

  obsPreview() {
    const track = this.obs.videoTrack;
    return track ? new MediaStream([track]) : null;
  }

  // ---------------------------------------------------------------- régie

  private log(kind: ActivityItem["kind"], text: string) {
    if (!get().publish) return;
    const at = Date.now();
    set(s => {
      const last = s.activity.at(-1);
      // Une rafale de réactions identiques n'apporte rien de plus qu'une seule ligne.
      if (last?.text === text && at - last.at < SAME_EVENT_MS) return {};
      return { activity: [...s.activity, { id: this.nextActivity++, at, kind, text }].slice(-ACTIVITY_ITEMS) };
    });
  }

  addMarker() {
    const startedAt = get().room?.streams.find(s => s.id === get().publish?.streamId)?.startedAt;
    if (!startedAt) return;
    this.log("marker", `Marqueur à ${duration(Date.now() - startedAt)}`);
    playSound("unmute", get().settings!.soundEffects);
  }

  copyMarkers() {
    api.copyText(get().activity.filter(a => a.kind === "marker").map(a => a.text).join("\n"));
    toast("Marqueurs copiés", "success");
  }

  updateRegie(patch: Partial<RegieLayout>) {
    void this.updateSettings({ regie: { ...get().settings!.regie, ...patch } });
  }

  togglePanel(id: PanelId) {
    const { collapsed } = get().settings!.regie;
    this.updateRegie({ collapsed: collapsed.includes(id) ? collapsed.filter(p => p !== id) : [...collapsed, id] });
  }

  /** Dépose un panneau dans une colonne, avant un autre ou tout en bas. */
  movePanel(id: PanelId, zone: "left" | "center" | "right", before: PanelId | null) {
    const regie = get().settings!.regie;
    const without = (list: PanelId[]) => list.filter(p => p !== id);
    const next = { left: without(regie.left), center: without(regie.center), right: without(regie.right) };
    const index = before ? next[zone].indexOf(before) : -1;
    next[zone].splice(index < 0 ? next[zone].length : index, 0, id);
    this.updateRegie(next);
  }

  resetRegie() {
    const { notes, actions } = get().settings!.regie;
    this.updateRegie({ ...DEFAULT_REGIE, notes, actions });
  }

  openRegie() {
    set({ regie: true, focused: get().publish?.streamId ?? get().focused });
  }

  setActions(actions: ActionId[]) {
    this.updateRegie({ actions });
  }

  saveScreens(screens: WaitScreen[]) {
    void this.updateSettings({ stream: { ...get().settings!.stream, screens } });
  }

  // ---------------------------------------------------------------- caméra et scènes

  /** Pendant un glissement, le salon suit sans être noyé. commit : fin du geste, on garde cette place pour la prochaine fois. */
  setCameraLayout(cameraLayout: CameraLayout, commit: boolean) {
    patchPublish({ cameraLayout, scene: null });
    const now = performance.now();
    if (commit || now - this.layoutSentAt >= LAYOUT_SEND_MS) {
      this.layoutSentAt = now;
      this.updateAnnounce({ cameraLayout });
    }
    if (commit) void this.updateSettings({ stream: { ...get().settings!.stream, cameraLayout } });
  }

  setBanner(banner: string) {
    patchPublish({ banner, scene: null });
    this.updateAnnounce({ banner });
  }


  async saveScene(name: string) {
    const publish = get().publish;
    if (!publish) return;
    const scene: Scene = { id: crypto.randomUUID(), name, hotkey: "", ...this.sceneState() };
    await this.updateSettings({ scenes: [...get().settings!.scenes, scene] });
    patchPublish({ scene: scene.id });
  }

  private sceneState() {
    const publish = get().publish!;
    return { source: this.currentSource && this.sceneSourceOf(this.currentSource), audio: [...this.mixChoices.values()], camera: !!publish.camera, cameraLayout: publish.cameraLayout, banner: publish.banner };
  }

  updateScene(id: string, patch: Partial<Scene>) {
    void this.updateSettings({ scenes: get().settings!.scenes.map(s => (s.id === id ? { ...s, ...patch } : s)) });
  }

  /** Reprend l'état du direct dans une scène existante. */
  captureScene(id: string) {
    if (!get().publish) return;
    this.updateScene(id, this.sceneState());
    patchPublish({ scene: id });
    toast("Scène mise à jour", "success");
  }

  deleteScene(id: string) {
    void this.updateSettings({ scenes: get().settings!.scenes.filter(s => s.id !== id) });
    if (get().publish?.scene === id) patchPublish({ scene: null });
  }

  /** Une fenêtre change d'identifiant quand on relance le jeu : son nom sert alors à la retrouver. */
  private async resolveScene(source: SceneSource): Promise<VideoSource | null> {
    if (source.kind === "obs") return this.obs.connected ? this.obsSource() : null;
    if (source.kind === "camera") return source;
    const sources = await api.listSources();
    const found = sources.find(s => s.id === source.id) ?? sources.find(s => s.kind === source.kind && s.name === source.name);
    return found ? ({ kind: source.kind, source: found } as VideoSource) : null;
  }

  async applyScene(id: string) {
    const scene = get().settings!.scenes.find(s => s.id === id);
    if (!scene || !this.publisher) return;
    const audio = scene.audio && (await this.currentChoices(scene.audio));
    let switched = false;
    if (scene.source) {
      const next = await this.resolveScene(scene.source);
      if (!next) return toast(`La source de « ${scene.name} » n'est plus disponible.`, "warning");
      const same = this.currentSource && JSON.stringify(this.sceneSourceOf(this.currentSource)) === JSON.stringify(this.sceneSourceOf(next));
      if (!same) {
        await this.switchSource(next, audio ?? (next.kind === "obs" ? [] : null));
        switched = true;
      }
    }
    if (audio && !switched) await this.restoreAudio(audio);
    const stream = get().settings!.stream;
    if (scene.camera && !this.cameraStream) await this.setCamera(stream.cameraId);
    else if (!scene.camera && this.cameraStream) await this.setCamera(null);
    patchPublish({ cameraLayout: scene.cameraLayout, banner: scene.banner, scene: id });
    this.updateAnnounce({ cameraLayout: scene.cameraLayout, banner: scene.banner });
  }

  /** Une application relancée a changé de numéro de processus : c'est son nom qui la retrouve. */
  private async currentChoices(choices: AudioChoice[]) {
    if (!choices.some(c => c.type === "app")) return choices;
    const apps = await api.audioApps().catch(() => []);
    return choices.flatMap<AudioChoice>(choice => {
      if (choice.type !== "app") return [choice];
      const app = apps.find(a => a.pid === choice.pid) ?? apps.find(a => a.name === choice.name);
      return app ? [{ ...choice, pid: app.pid }] : [];
    });
  }

  /** La table reprend les sons de la scène. Celui qui vient de la source, comme OBS, n'y est pour rien et reste en place. */
  private async restoreAudio(choices: AudioChoice[]) {
    const key = (list: AudioChoice[]) => JSON.stringify(list.map(c => (c.type === "app" ? c.name : c.type === "device" ? c.deviceId : c.type)).sort());
    if (key(choices) === key([...this.mixChoices.values()])) return;
    for (const id of [...this.mixChoices.keys()]) this.mixer?.remove(id);
    this.mixChoices.clear();
    for (const choice of choices) await this.addAudio(choice);
    this.afterMixChange();
  }

  private sceneSourceOf(source: VideoSource): SceneSource | null {
    if (source.kind === "screen" || source.kind === "window") return { kind: source.kind, id: source.source.id, name: source.source.name };
    if (source.kind === "camera") return { kind: "camera", deviceId: source.deviceId, label: source.label };
    return source.kind === "obs" ? { kind: "obs" } : null;
  }

  // ---------------------------------------------------------------- prendre la main

  private controlTargetOf(source: VideoSource): ControlTarget | null {
    if (source.kind === "window") return { hwnd: source.source.id.split(":")[1] };
    if (source.kind === "screen") return { displayId: source.source.displayId };
    return null;
  }

  private onHostControl(from: string, message: ControlToHost) {
    const publish = get().publish;
    if (!publish || !this.publisher) return;
    const hasHand = publish.controller === from;
    if (message.t === "input") {
      if (hasHand && Array.isArray(message.events)) api.controlInput(message.events);
    } else if (message.t === "alive") {
      if (hasHand) api.controlInput([]);
    } else if (message.t === "release") {
      if (hasHand) this.endControl();
      else if (publish.controlAsk === from) this.clearAsk();
    } else if (message.t === "ask") {
      this.onAsk(from);
    }
  }

  private onAsk(from: string) {
    const publish = get().publish!;
    const now = performance.now();
    const refused = !publish.allowControl || !publish.controlScope || publish.paused || !!memberOf(from)?.web || !!publish.controller || !!publish.controlAsk;
    if (refused || now - (this.askedAt.get(from) ?? -ASK_COOLDOWN_MS) < ASK_COOLDOWN_MS) return this.publisher!.sendControl(from, { t: "refused" });
    this.askedAt.set(from, now);
    patchPublish({ controlAsk: from });
    const name = memberOf(from)?.name ?? "Quelqu'un";
    this.log("hand", `${name} demande la main`);
    const hotkey = get().settings!.hotkeys.control;
    playSound("live", get().settings!.soundEffects);
    // En plein jeu, le diffuseur ne voit pas la fenêtre : l'overlay et la notification le préviennent. Un écran entier se décide dans l'application.
    api.overlaySend({ type: "control", text: publish.controlScope === "window" && hotkey ? `${name} demande la main · ${hotkey} pour accepter` : `${name} demande la main : réponds dans SpokaStream` });
    if (!document.hasFocus()) api.notify({ title: `${name} demande la main`, body: "Ouvre SpokaStream pour répondre.", roomId: get().room?.id });
  }

  private clearAsk() {
    patchPublish({ controlAsk: null });
    api.overlaySend({ type: "control", text: null });
  }

  async acceptControl() {
    const asker = get().publish?.controlAsk;
    const scope = get().publish?.controlScope;
    const target = this.controlTarget;
    if (!asker || !scope || !target || !this.publisher) return;
    this.clearAsk();
    if (!(await api.controlArm(target))) return toast("Le moteur n'a pas pu préparer la prise en main.", "error");
    patchPublish({ controller: asker, controlBlocked: false });
    this.updateAnnounce({ controller: asker });
    this.publisher.sendControl(asker, { t: "granted", scope });
    const name = memberOf(asker)?.name ?? "";
    const hotkey = get().settings!.hotkeys.control;
    api.overlaySend({ type: "control", text: `${name} a la main${hotkey ? ` · ${hotkey} pour la reprendre` : ""}` });
    this.pushTray();
  }

  refuseControl() {
    const asker = get().publish?.controlAsk;
    if (!asker) return;
    this.clearAsk();
    this.publisher?.sendControl(asker, { t: "refused" });
  }

  /** Reprendre la main : le moteur est désarmé d'abord, le spectateur n'est prévenu qu'ensuite. */
  endControl() {
    const controller = get().publish?.controller;
    if (!controller) return;
    api.controlDisarm();
    patchPublish({ controller: null, controlBlocked: false });
    this.updateAnnounce({ controller: null });
    this.publisher?.sendControl(controller, { t: "revoked" });
    api.overlaySend({ type: "control", text: null });
    this.pushTray();
  }

  private handSub() {
    return this.subs.get(get().hand?.streamId ?? "");
  }

  askControl(streamId: string) {
    this.subs.get(streamId)?.sendControl({ t: "ask" });
    set({ hand: { streamId, state: "asking", blocked: false } });
    clearTimeout(this.askTimer);
    this.askTimer = setTimeout(() => {
      if (get().hand?.state !== "asking") return;
      this.subs.get(streamId)?.sendControl({ t: "release" });
      set({ hand: null });
      toast("Pas de réponse pour l'instant.", "info");
    }, ASK_TIMEOUT_MS);
  }

  releaseControl() {
    this.handSub()?.sendControl({ t: "release" });
    set({ hand: null });
  }

  sendControlInput(events: ControlInput[]) {
    this.handSub()?.sendControl({ t: "input", events });
  }

  private onHandMessage(streamId: string, message: ControlToViewer) {
    const hand = get().hand;
    if (hand?.streamId !== streamId) return;
    if (message.t === "granted") {
      clearTimeout(this.askTimer);
      set({ hand: { ...hand, state: "granted" } });
    } else if (message.t === "blocked") {
      set({ hand: { ...hand, blocked: message.blocked } });
    } else {
      clearTimeout(this.askTimer);
      set({ hand: null });
      toast(message.t === "refused" ? "Demande refusée." : "Le diffuseur a repris la main.", "info");
    }
  }

  // ---------------------------------------------------------------- bulle caméra

  async setCamera(deviceId: string | null) {
    if (!this.publisher) return;
    const previous = this.cameraStream;
    let stream: MediaStream | null = null;
    if (deviceId !== null) {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { deviceId: deviceId ? { exact: deviceId } : undefined, width: { ideal: 640 }, height: { ideal: 360 }, frameRate: { ideal: 30 } } });
      } catch (e) {
        return toast(`Caméra : ${(e as Error).message}`, "error");
      }
      void this.updateSettings({ stream: { ...get().settings!.stream, cameraId: deviceId } });
    }
    this.cameraStream = stream;
    await this.publisher.setCamera(stream?.getVideoTracks()[0] ?? null);
    previous?.getTracks().forEach(t => t.stop());
    patchPublish({ camera: stream });
    this.updateAnnounce({ camera: !!stream });
  }

  private onViewersChanged(viewers: string[]) {
    const now = new Set(viewers);
    for (const id of now) if (!this.lastViewers.has(id)) this.log("watch", `${memberOf(id)?.name ?? "Quelqu'un"} regarde`);
    for (const id of this.lastViewers) if (!now.has(id)) this.log("watch", `${memberOf(id)?.name ?? "Quelqu'un"} ne regarde plus`);
    this.lastViewers = now;
    const names = viewers.map(id => memberOf(id)?.name).filter((n): n is string => !!n);
    api.overlaySend({ type: "viewers", count: viewers.length, names });
    this.pushTray();
  }

  // ---------------------------------------------------------------- voix

  async voiceJoin() {
    if (this.voice?.active) return;
    const settings = get().settings!;
    const voice = new Voice({
      selfId: () => get().userId,
      iceServers: () => get().iceServers,
      sendSignal: (to, data) => this.signal.send({ t: "rtc", to, session: VOICE_SESSION, data }),
      settings,
    });
    voice.onRemoteTrack = (userId, track) => this.playback.add(`voice:${userId}`, "voice", track, get().voiceVolumes[userId] ?? 1);
    voice.onPeerGone = userId => this.playback.remove(`voice:${userId}`);
    try {
      await voice.join();
    } catch (e) {
      toast(`Micro inaccessible : ${(e as Error).message}`, "error");
      return;
    }
    this.voice = voice;
    set({ voiceJoined: true });
    this.applyTransmit();
    this.signal.send({ t: "voice.set", voice: { muted: get().muted, deafened: get().deafened } });
    this.syncVoice();
    playSound("join", settings.soundEffects);
  }

  voiceLeave() {
    if (!this.voice) return;
    this.voice.leave();
    this.voice = null;
    set({ voiceJoined: false, speaking: {} });
    this.signal.send({ t: "voice.set", voice: null });
  }

  private syncVoice() {
    const room = get().room;
    if (!room || !this.voice?.active) return;
    this.voice.sync(room.members.filter(m => m.voice && m.id !== get().userId).map(m => m.id));
  }

  private applyTransmit() {
    const { muted, deafened, settings } = get();
    const allowed = !muted && !deafened && (settings?.voiceMode !== "ptt" || this.pttHeld);
    this.voice?.setTransmitting(allowed);
  }

  toggleMute() {
    const muted = !get().muted;
    set({ muted });
    this.afterVoiceFlags(muted);
  }

  toggleDeafen() {
    const deafened = !get().deafened;
    set({ deafened });
    this.playback.setDeafened(deafened);
    this.afterVoiceFlags(!deafened);
  }

  private afterVoiceFlags(silent: boolean) {
    this.applyTransmit();
    playSound(silent ? "mute" : "unmute", !!get().settings?.soundEffects);
    if (this.voice?.active) this.signal.send({ t: "voice.set", voice: { muted: get().muted, deafened: get().deafened } });
    this.pushTray();
  }

  setVoiceVolume(userId: string, volume: number) {
    set(s => ({ voiceVolumes: { ...s.voiceVolumes, [userId]: volume } }));
    this.playback.setVolume(`voice:${userId}`, volume);
  }

  private onHotkey(action: string) {
    if (action.startsWith("scene:")) return void this.applyScene(action.slice("scene:".length));
    if (action === "marker") return this.addMarker();
    if (action === "toggleMic") return this.toggleMute();
    if (action === "toggleDeafen") return this.toggleDeafen();
    if (action === "pauseStream") return void this.setPaused(!get().publish?.paused);
    if (action === "saveClip") return void this.saveClip();
    if (action === "control") return this.onControlHotkey();
    if (get().publish) return void this.stopLive();
    if (get().room) {
      api.showWindow();
      set({ goLiveOpen: true, view: "room" });
    }
  }

  /** Accepter au clavier n'existe que pour une fenêtre : donner un écran entier mérite de lire l'avertissement. */
  private onControlHotkey() {
    const publish = get().publish;
    if (publish?.controller) return this.endControl();
    if (!publish?.controlAsk) return;
    if (publish.controlScope === "window") void this.acceptControl();
    else api.showWindow();
  }

  // ---------------------------------------------------------------- suivi

  private async pollStats() {
    if (this.publisher) {
      const stats = await this.publisher.pollStats();
      this.healthHistory.push({ fps: stats?.fps ?? 0, kbps: stats?.kbps ?? 0 });
      if (this.healthHistory.length > HEALTH_POINTS) this.healthHistory.shift();
      // Chromium cache le nom de l'encodeur quand aucune capture à lui n'est ouverte : la mesure initiale le sait.
      if (stats && !stats.encoder) {
        const measured = get().publish?.bench.find(r => r.mime === `video/${stats.codec}`);
        if (measured) Object.assign(stats, { encoder: measured.implementation, hardware: measured.hardware });
      }
      patchPublish({ stats, viewers: this.publisher.viewerList });
    }
    for (const [id, sub] of this.subs) {
      const stats = await sub.stats();
      if (stats) patchSub(id, { stats });
    }
  }

  /** Le serveur ne voit passer aucune image : sans ces chiffres, un administrateur ne saurait pas comment va un direct. */
  private sendTelemetry() {
    const { publish, subs } = get();
    const pathOf = (path: { relay: boolean; protocol: string; rttMs: number | null } | null | undefined) => ({ relay: !!path?.relay, protocol: path?.protocol ?? "", rttMs: path?.rttMs ?? null });
    const sent = publish?.stats ?? null;
    const watch = Object.values(subs).flatMap(sub => (sub.stats ? [{ streamId: sub.streamId, fps: sub.stats.fps, kbps: sub.stats.kbps, height: sub.stats.height, lostPct: sub.stats.lostPct, jitterMs: sub.stats.jitterMs, freezes: sub.stats.freezes, ...pathOf(sub.stats.path) }] : []));
    if (!sent && !watch.length) return;
    this.signal.send({
      t: "telemetry",
      publish: publish && sent ? { streamId: publish.streamId, fps: sent.fps, kbps: sent.kbps, height: sent.height, codec: sent.codec, encoder: sent.encoder, hardware: sent.hardware, encMs: sent.encMs, limit: sent.limit, viewers: publish.viewers.flatMap(v => (v.stats ? [{ id: v.id, kbps: v.stats.kbps, retransmitPct: v.stats.retransmitPct, ...pathOf(v.stats.path) }] : [])) } : null,
      watch,
    });
  }

  private pollSpeaking() {
    const room = get().room;
    if (!room) return;
    const { userId, speaking } = get();
    const now = performance.now();
    let next: Record<string, boolean> | null = null;
    const check = (id: string, level: number, threshold: number) => {
      if (level > threshold) this.speakHold.set(id, now + 280);
      const active = (this.speakHold.get(id) ?? 0) > now;
      if (active !== !!speaking[id]) (next ??= { ...speaking })[id] = active;
    };
    if (this.voice?.active) {
      const transmitting = !get().muted && !get().deafened && (get().settings?.voiceMode !== "ptt" || this.pttHeld);
      check(userId, transmitting ? this.voice.level : 0, 0.012);
    }
    for (const member of room.members) {
      if (member.id !== userId && member.voice) check(member.id, this.playback.level(`voice:${member.id}`), 0.3);
    }
    if (next) set({ speaking: next });
  }

  private pushTray() {
    const { room, publish, muted, deafened } = get();
    api.setTray({ roomName: room?.name ?? null, live: !!publish, paused: !!publish?.paused, muted, deafened, viewers: room?.streams.find(s => s.id === publish?.streamId)?.viewers.length ?? 0, controller: publish?.controller ? (memberOf(publish.controller)?.name ?? "?") : null });
  }

  // ---------------------------------------------------------------- diagnostic

  async diagnostics() {
    const state = get();
    const lines = [await api.diagnostics(), `Connexion : ${state.connection} (${this.signal.rttMs} ms)`, `Relais TURN : ${state.iceServers.some(s => JSON.stringify(s.urls).includes("turn:")) ? "oui" : "non"}`];
    const best = rankResults(state.publish?.bench ?? []);
    for (const r of best) lines.push(`Encodeur ${r.label} : ${r.encMs ?? "?"} ms/img, ${r.fps} fps, ${r.width}x${r.height}, ${r.hardware ? "matériel" : "logiciel"} (${r.implementation || "?"}) ${r.ok ? "✔" : "✖"}`);
    if (state.publish) {
      const s = state.publish.stats;
      lines.push(`Capture : ${state.publish.gameCapture ? "de jeu" : state.publish.nativeCapture ? "native" : "Chromium"}`);
      lines.push(`Clips : ${this.clipBuffer ? `${Math.round(this.clipBuffer.bufferedSeconds)} s en mémoire` : "non"}`);
      lines.push(`Diffusion : ${state.publish.sourceName}, ${s ? `${s.width}x${s.height} ${s.fps} fps ${(s.kbps / 1000).toFixed(1)} Mb/s ${s.codec} ${s.encoder} limite=${s.limit}` : "pas de spectateur"}`);
      for (const v of state.publish.viewers) {
        lines.push(`  → ${memberOf(v.id)?.name ?? v.id} : ${v.state} ${v.stats ? `${(v.stats.kbps / 1000).toFixed(1)} Mb/s ${v.stats.path?.relay ? `relais ${v.stats.path.protocol}` : "direct"} ${v.stats.path?.rttMs ?? "?"} ms` : ""}`);
      }
      lines.push(`Son : ${state.publish.mix.map(m => `${m.label} ${Math.round(m.volume * 100)} %`).join(", ") || "aucun"}`);
    }
    for (const sub of Object.values(state.subs)) {
      const s = sub.stats;
      lines.push(`Réception de ${memberOf(sub.ownerId)?.name ?? "?"} : ${sub.state} ${s ? `${s.width}x${s.height} ${s.fps} fps ${(s.kbps / 1000).toFixed(1)} Mb/s ${s.codec} ${s.decoder} perdus=${s.lostPct} % gigue=${s.jitterMs} ms tampon=${s.bufferMs ?? "?"} ms gels=${s.freezes} ${s.path?.relay ? `relais ${s.path.protocol}` : "direct"} ${s.path?.rttMs ?? "?"} ms` : ""}`);
    }
    return lines.join("\n");
  }
}

export const core = new Core();
if (import.meta.env.DEV || api.testMode) Object.assign(window, { __core: core, __store: { useApp } });
