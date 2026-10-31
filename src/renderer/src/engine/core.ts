import type { HotkeyMap, Resolution, Settings } from "@shared/ipc.ts";
import { DEFAULT_VIEWER_QUALITY } from "@shared/protocol.ts";
import type { AudioKind, ChatMessage, ErrorCode, Profile, RoomSettings, RoomState, RoomStatus, ServerMessage, Stroke, StreamAnnounce, StreamInfo, ViewerQuality } from "@shared/protocol.ts";
import { get, memberOf, patchPublish, patchRoom, patchSub, set, toast, useApp } from "../state/store.ts";
import { StreamMixer } from "./audio/mixer.ts";
import { Playback } from "./audio/playback.ts";
import { captureThumbnail, createPauseCard, openSource } from "./capture.ts";
import type { OpenedSource, VideoSource } from "./capture.ts";
import { benchClass, cachedBench, measureEncoders, rankResults } from "./encoders.ts";
import type { BenchResult } from "./encoders.ts";
import { Publisher } from "./publisher.ts";
import type { EncodingTarget } from "./publisher.ts";
import { Recorder, saveVideoFrame } from "./recorder.ts";
import { playSound } from "./sfx.ts";
import { RequestError, Signal } from "./signal.ts";
import { Subscription } from "./subscription.ts";
import { VOICE_SESSION, Voice } from "./voice.ts";

const api = window.spoka;

export type AudioChoice =
  | { type: "system" }
  | { type: "app"; pid: number; name: string; icon: string | null }
  | { type: "device"; deviceId: string; label: string };

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
};

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
  private previewTimer: ReturnType<typeof setInterval> | undefined;
  private recorder: Recorder | null = null;
  private sourceMixId: string | null = null;
  private announce: StreamAnnounce | null = null;
  private timers: ReturnType<typeof setInterval>[] = [];
  private pttHeld = false;
  private lastLive = new Map<string, Set<string>>();
  private readonly drawListeners = new Set<DrawListener>();
  private readonly reactionListeners = new Set<ReactionListener>();
  private readonly speakHold = new Map<string, number>();
  private strokeCount = 0;

  async boot() {
    // S'abonner avant de lire : un changement arrivé entre les deux serait perdu, et l'interface resterait fausse.
    api.onSettings(next => set({ settings: next }));
    api.onAudioStatus(status => set({ audioEngine: status }));
    api.onUpdateStatus(update => set({ update }));
    const settings = await api.getSettings();
    set({ settings, audioEngine: await api.audioStatus(), update: await api.updateStatus() });
    this.playback.setOutput(settings.outputId);

    api.onDeepLink(code => void this.joinRoom(code));
    api.onNotificationClick(roomId => void this.openRoom(roomId));
    api.onHotkey(action => this.onHotkey(action));
    api.onTrayAction(action => {
      if (action === "toggleMic") this.toggleMute();
      else if (action === "toggleDeafen") this.toggleDeafen();
      else if (action === "stopStream") void this.stopLive();
      else if (action === "pauseStream") void this.setPaused(!get().publish?.paused);
      else this.leaveRoom();
    });
    api.onKey((key, down) => {
      if (key !== get().settings?.pttKey) return;
      this.pttHeld = down;
      this.applyTransmit();
    });

    this.signal.onState = connection => set({ connection, unreachable: connection === "connecting" && this.signal.failedAttempts >= 3 });
    this.signal.onMessage = message => this.onServer(message);
    this.signal.onReady = () => this.onConnected();

    this.timers.push(setInterval(() => void this.pollStats(), 1000));
    this.timers.push(setInterval(() => this.pollSpeaking(), 120));

    if (settings.onboarded) this.connect();
    this.applyPttWatch();
    this.pushTray();
  }

  connect() {
    const s = get().settings!;
    this.signal.start(s.serverUrl, s.token, s.profile);
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
        return set({ userId: m.userId, iceServers: m.iceServers, serverName: m.serverName });
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
        playSound("join", !!get().settings?.soundEffects && !!get().voiceJoined);
        patchRoom(r => ({ members: [...r.members.filter(x => x.id !== m.member.id), m.member] }));
        return;
      case "member.update":
        patchRoom(r => ({ members: r.members.map(x => (x.id === m.member.id ? m.member : x)) }));
        return this.syncVoice();
      case "member.leave":
        patchRoom(r => ({ members: r.members.filter(x => x.id !== m.userId) }));
        return this.syncVoice();
      case "chat":
        return this.onChat(m.message);
      case "chat.deleted":
        return patchRoom(r => ({ history: r.history.filter(x => x.id !== m.id) }));
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
    if (session === VOICE_SESSION) return void this.voice?.onSignal(from, signal).catch(e => console.error("voix :", e));
    if (session === this.publisher?.sessionId) return void this.publisher.onSignal(from, signal).catch(e => console.error("stream :", e));
    void this.subs.get(session)?.onSignal(signal).catch(e => console.error("réception :", e));
  }

  private onRoomState(room: RoomState) {
    set({ room, view: get().view === "settings" ? "settings" : "room" });
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
    const recentRooms = [{ id, name, code, at: Date.now() }, ...settings.recentRooms.filter(r => r.id !== id)].slice(0, 30);
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
      if (seen && s.notifyLive && (status.id !== get().room?.id || !document.hasFocus())) {
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
    if (message.kind !== "user" || message.authorId === get().userId) return;
    const s = get().settings!;
    if (get().panelTab !== "chat" || !s.chatPanelOpen) set(state => ({ unread: state.unread + 1 }));
    playSound("message", s.soundEffects && !document.hasFocus());
    if (s.notifyMessages && !document.hasFocus()) api.notify({ title: message.authorName, body: message.text.slice(0, 140), roomId: get().room?.id });
    if (this.publisher) api.overlaySend({ type: "chat", name: message.authorName, color: message.authorColor, text: message.text.slice(0, 200) });
  }

  private onReaction(streamId: string | null, emoji: string, from: string) {
    for (const listener of this.reactionListeners) listener({ streamId, emoji, from });
    if (streamId === get().publish?.streamId) api.overlaySend({ type: "reaction", emoji, name: memberOf(from)?.name ?? "" });
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
      void this.signal.request({ t: "stream.watch", id: stream.id, on: true, resume: true, quality: get().subs[stream.id]?.quality }).catch(() => {});
      return;
    }
    this.maybeAutoWatch();
  }

  private maybeAutoWatch() {
    if (!get().settings?.autoWatch || this.subs.size) return;
    const first = get().room?.streams.find(s => s.ownerId !== get().userId);
    if (first) void this.watch(first.id);
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
    if (id) void this.updateSettings({ recentRooms: get().settings!.recentRooms.filter(r => r.id !== id) });
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

  sendChat(text: string) {
    this.signal.send({ t: "chat.send", text, replyTo: get().replyTo?.id ?? null });
    set({ replyTo: null });
  }

  deleteChat(id: string) {
    this.signal.send({ t: "chat.delete", id });
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
    const quality: ViewerQuality = { ...DEFAULT_VIEWER_QUALITY };
    const volume = savedVolume(stream.ownerId);
    set(s => ({
      subs: { ...s.subs, [streamId]: { streamId, ownerId: stream.ownerId, state: "connecting", media: sub.media, volume, muted: false, quality, stats: null, hasAudio: false } },
      focused: s.focused ?? streamId,
    }));
    sub.onState = state => patchSub(streamId, { state });
    sub.onTrack = track => {
      if (track.kind !== "audio") return;
      const view = get().subs[streamId];
      this.playback.add(streamId, "stream", track, view?.volume ?? 1, view?.muted ?? false);
      patchSub(streamId, { hasAudio: true });
    };
    sub.onLost = () => {
      if (this.subs.has(streamId)) void this.signal.request({ t: "stream.watch", id: streamId, on: true, quality: get().subs[streamId]?.quality }).catch(() => {});
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
    sub.close();
    this.subs.delete(streamId);
    this.playback.remove(streamId);
    set(s => {
      const subs = { ...s.subs };
      delete subs[streamId];
      return { subs, focused: s.focused === streamId ? (Object.keys(subs)[0] ?? null) : s.focused };
    });
  }

  setSubVolume(streamId: string, volume: number) {
    this.playback.setVolume(streamId, volume);
    patchSub(streamId, { volume, muted: false });
    this.playback.setMuted(streamId, false);
    const ownerId = get().subs[streamId]?.ownerId;
    try {
      if (ownerId) localStorage.setItem(`volume:${ownerId}`, String(volume));
    } catch {
      // Le volume reste valable pour cette séance.
    }
  }

  setSubMuted(streamId: string, muted: boolean) {
    this.playback.setMuted(streamId, muted);
    patchSub(streamId, { muted });
  }

  setSubQuality(streamId: string, quality: ViewerQuality) {
    patchSub(streamId, { quality });
    this.signal.send({ t: "stream.quality", id: streamId, quality });
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
      toast("Capture enregistrée", "success");
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
      if (choice.type === "system") await mixer.addCapture("exclude", api.selfPid, "Tout le PC", null);
      else if (choice.type === "app") await mixer.addCapture("include", choice.pid, choice.name, choice.icon);
      else await mixer.addDevice(choice.deviceId, choice.label);
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

  async goLive(config: GoLiveConfig) {
    if (this.publisher) return;
    const streamId = `${get().userId.slice(0, 8)}-${Date.now().toString(36)}`;
    let opened: OpenedSource;
    try {
      opened = await openSource(config.source, config.fps, resolutionHeight(config.resolution));
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
    const preview = new MediaStream([opened.track]);
    set({
      publish: {
        streamId,
        preview,
        sourceName: opened.name,
        kind: opened.kind,
        nativeCapture: opened.native,
        stats: null,
        viewers: [],
        mix: [],
        paused: false,
        target,
        bench,
        title: config.title,
        allowDraw: config.allowDraw,
        maxViewers: config.maxViewers,
      },
      panelTab: "studio",
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
    this.openOverlay(config.source);
    playSound("live", get().settings!.soundEffects);
    this.pushTray();
    return true;
  }

  private openOverlay(source: VideoSource) {
    const overlay = get().settings!.overlay;
    if (!overlay.enabled || (source.kind !== "screen" && source.kind !== "window")) return api.overlayClose();
    void api.overlayOpen({ displayId: source.kind === "screen" ? source.source.displayId : undefined, hwnd: source.kind === "window" ? source.source.id.split(":")[1] : undefined, settings: overlay });
  }

  private watchSource(opened: OpenedSource) {
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
      next = await openSource(source, fps, maxHeight);
    } catch (e) {
      return this.reportError(e);
    }
    const previous = this.opened;
    next.track.contentHint = priority === "detail" ? "detail" : "motion";
    this.opened = next;
    this.sourceGone = false;
    this.watchSource(next);
    if (!get().publish!.paused) await this.publisher.replaceVideo(next.track, next.height);
    previous.stop();
    const preview = new MediaStream([next.track]);
    if (this.previewElement) this.previewElement.srcObject = preview;
    patchPublish({ preview, sourceName: next.name, kind: next.kind, nativeCapture: next.native });
    this.updateAnnounce({ kind: next.kind, sourceName: next.name, width: next.width, height: next.height });
    if (audio) {
      this.mixer?.clear();
      for (const choice of audio) await this.addAudio(choice);
    } else if (this.sourceMixId) {
      this.mixer?.remove(this.sourceMixId);
    }
    this.sourceMixId = next.audio ? (this.mixer?.addMediaStream(next.audio, next.name) ?? null) : null;
    this.afterMixChange();
    this.openOverlay(source);
    toast("Source changée", "success");
  }

  async setPaused(paused: boolean) {
    const publish = get().publish;
    if (!publish || !this.publisher || publish.paused === paused) return;
    if (paused) {
      this.pauseCard = createPauseCard();
      await this.publisher.replaceVideo(this.pauseCard.track, 720);
    } else {
      if (!this.opened || this.sourceGone) return toast("La source n'existe plus : choisis-en une autre pour reprendre.", "warning");
      await this.publisher.replaceVideo(this.opened.track, this.opened.height);
      this.pauseCard?.stop();
      this.pauseCard = null;
    }
    this.mixer?.setSilenced(paused);
    patchPublish({ paused });
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

  updateStreamInfo(patch: { title?: string; allowDraw?: boolean; maxViewers?: number }) {
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

  private onViewersChanged(viewers: string[]) {
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

  private onHotkey(action: keyof HotkeyMap) {
    if (action === "toggleMic") return this.toggleMute();
    if (action === "toggleDeafen") return this.toggleDeafen();
    if (action === "pauseStream") return void this.setPaused(!get().publish?.paused);
    if (get().publish) return void this.stopLive();
    if (get().room) {
      api.showWindow();
      set({ goLiveOpen: true, view: "room" });
    }
  }

  // ---------------------------------------------------------------- suivi

  private async pollStats() {
    if (this.publisher) {
      const stats = await this.publisher.pollStats();
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
    api.setTray({ roomName: room?.name ?? null, live: !!publish, paused: !!publish?.paused, muted, deafened, viewers: room?.streams.find(s => s.id === publish?.streamId)?.viewers.length ?? 0 });
  }

  // ---------------------------------------------------------------- diagnostic

  async diagnostics() {
    const state = get();
    const lines = [await api.diagnostics(), `Connexion : ${state.connection} (${this.signal.rttMs} ms)`, `Relais TURN : ${state.iceServers.some(s => JSON.stringify(s.urls).includes("turn:")) ? "oui" : "non"}`];
    const best = rankResults(state.publish?.bench ?? []);
    for (const r of best) lines.push(`Encodeur ${r.label} : ${r.encMs ?? "?"} ms/img, ${r.fps} fps, ${r.width}x${r.height}, ${r.hardware ? "matériel" : "logiciel"} (${r.implementation || "?"}) ${r.ok ? "✔" : "✖"}`);
    if (state.publish) {
      const s = state.publish.stats;
      lines.push(`Capture : ${state.publish.nativeCapture ? "native" : "Chromium"}`);
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
