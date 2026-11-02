// Le moteur du lecteur web. Il réutilise la réception, le vocal et les clips de l'application.
// Diffuser reste réservé au logiciel : c'est lui seul qui peut capter le son d'une application.
import { DEFAULT_VIEWER_QUALITY, isHls, LIMITS, titleFromUrl, videoUrl, youtubeId } from "@shared/protocol.ts";
import type { ChatMessage, ErrorCode, IceServer, Profile, RemoteCommand, RemoteState, RoomState, RoomStatus, ServerMessage, Stroke, StreamInfo, Together, ViewerQuality } from "@shared/protocol.ts";
import { rememberRoom } from "@shared/rooms.ts";
import { CLIP_SESSION, ClipShare } from "../src/renderer/src/engine/clipShare.ts";
import { RequestError, Signal } from "../src/renderer/src/engine/signal.ts";
import { Subscription } from "../src/renderer/src/engine/subscription.ts";
import { VOICE_SESSION, Voice } from "../src/renderer/src/engine/voice.ts";
import { canPlay } from "../src/renderer/src/engine/videoProbe.ts";
import { frameForChat } from "../src/renderer/src/ui/image.ts";
import { get, init, set, store, stored, TOGETHER } from "./store.ts";
import type { RecentRoom, ViewStats } from "./store.ts";

const COLORS = ["#7c5cff", "#22d3ee", "#34d399", "#f59e0b", "#f472b6", "#fb7185", "#a78bfa", "#60a5fa"];
export const REACTIONS = ["🔥", "😂", "😮", "❤️", "👏", "🎉", "💀", "👀"];
const ERRORS: Partial<Record<ErrorCode, string>> = {
  room_not_found: "Ce salon n'existe pas. Vérifie le code.",
  room_full: "Ce salon est complet.",
  room_locked: "Ce salon est verrouillé par son propriétaire.",
  banned: "Tu as été banni de ce salon.",
  rate_limited: "Trop d'essais d'un coup, patiente un instant.",
  viewer_limit: "Ce stream a atteint sa limite de spectateurs.",
  stream_not_found: "Ce stream vient de se terminer.",
  maintenance: "Le serveur est en maintenance, réessaie dans un moment.",
  muted: "Tu ne peux plus écrire pour l'instant.",
  closed: "Ce serveur n'accepte plus de nouveaux appareils. Lie celui-ci à ton compte avec un code.",
  disabled: "L'administrateur a désactivé cette fonction.",
};

/** Du plus économe au plus beau. La qualité auto se promène sur cette échelle selon ce que le réseau supporte. */
export const QUALITIES: { label: string; hint: string; quality: ViewerQuality }[] = [
  { label: "Auto", hint: "S'adapte à ton réseau", quality: DEFAULT_VIEWER_QUALITY },
  { label: "1080p", hint: "12 Mb/s, environ 5 Go par heure", quality: { maxHeight: 1080, maxKbps: 12000, maxFps: 0, video: true } },
  { label: "720p", hint: "5 Mb/s, environ 2 Go par heure", quality: { maxHeight: 720, maxKbps: 5000, maxFps: 0, video: true } },
  { label: "480p", hint: "1,5 Mb/s, environ 700 Mo par heure", quality: { maxHeight: 480, maxKbps: 1500, maxFps: 30, video: true } },
  { label: "Son seul", hint: "L'image n'est plus envoyée, presque rien à télécharger", quality: { ...DEFAULT_VIEWER_QUALITY, video: false } },
];
const AUTO = 0;
const AUDIO_ONLY = 4;
const AUTO_STEPS = [3, 2, 1];
const STATS_MS = 2000;
const TELEMETRY_TICKS = 5;
const AUTO_UP_AFTER_MS = 30_000;
const SPEAKING_LEVEL = 0.03;

/** Un seul élément vidéo pour toute la séance : le geste qui lance le son reste valable quand l'écran se reconstruit. */
export const video = document.createElement("video");
export const camera = document.createElement("video");
for (const element of [video, camera]) {
  element.autoplay = true;
  element.playsInline = true;
  element.setAttribute("playsinline", "");
}
video.id = "video";
camera.id = "camera";
camera.muted = true;
export const miniVideo = document.createElement("video");
miniVideo.autoplay = true;
miniVideo.playsInline = true;
miniVideo.muted = true;
miniVideo.setAttribute("playsinline", "");
miniVideo.id = "mini-video";
export const frame = document.createElement("iframe");
frame.id = "together";
frame.title = "Vidéo de la Watch Party";
frame.allow = "autoplay; encrypted-media";

const signal = new Signal();
const socketUrl = `${location.origin.replace(/^http/, "ws")}/ws`;
let iceServers: IceServer[] = [];
let current: Subscription | null = null;
let miniSub: Subscription | null = null;
let chosen = false;
let voice: Voice | null = null;
let autoRung = 1;
let autoGoodSince = 0;
let lastFreezes = 0;
let statsTicks = 0;
let wakeLock: { release(): Promise<void> } | null = null;
let deckLock: { release(): Promise<void> } | null = null;
let installEvent: (Event & { prompt(): Promise<void> }) | null = null;
let nextFloat = 1;
let strokeCount = 0;
export type StrokeEvent = { stroke: Stroke } | { clear: true };
export const strokes = new Set<(event: StrokeEvent) => void>();

const clips = new ClipShare(() => iceServers, (to, session, data) => signal.send({ t: "rtc", to, session, data }));
const voiceAudio = new Map<string, { audio: HTMLAudioElement; analyser: AnalyserNode }>();
let voiceContext: AudioContext | null = null;

const memberOf = (id: string) => get().room?.members.find(m => m.id === id);
export const nameOf = (id: string) => memberOf(id)?.name ?? "?";
export const streamShown = () => get().room?.streams.find(s => s.id === get().shown) ?? null;
export const canShare = () => {
  const room = get().room;
  return !!room && (room.settings.whoCanStream === "everyone" || room.ownerId === get().accountId);
};

/** Le stream de ton propre PC : on peut le regarder, mais il ne s'ouvre jamais tout seul, il ferait écho à côté de lui. */
const isMine = (stream: StreamInfo) => get().room?.members.find(m => m.id === stream.ownerId)?.account === get().accountId;

const deviceName = () => (/iPhone/i.test(navigator.userAgent) ? "iPhone" : /iPad/i.test(navigator.userAgent) ? "iPad" : /Android/i.test(navigator.userAgent) ? "Téléphone Android" : "Navigateur");

function deviceToken() {
  const saved = stored("spoka-token");
  if (saved && /^[0-9a-f]{64}$/.test(saved)) return saved;
  const token = [...crypto.getRandomValues(new Uint8Array(32))].map(b => b.toString(16).padStart(2, "0")).join("");
  store("spoka-token", token);
  return token;
}

const readRecents = (): RecentRoom[] => {
  try {
    return JSON.parse(stored("spoka-rooms") ?? "[]") as RecentRoom[];
  } catch {
    return [];
  }
};

const profile = () => ({ name: get().name || "Invité", color: get().color, avatar: get().avatar });

// ---------------------------------------------------------------- démarrage

export function boot() {
  const code = location.pathname.match(/^\/w\/([A-Za-z0-9]{4,16})/)?.[1] ?? "";
  const color = stored("spoka-color") ?? COLORS[Math.floor(Math.random() * COLORS.length)]!;
  store("spoka-color", color);
  const name = stored("spoka-name") ?? "";
  init({
    screen: code ? "join" : "home",
    code,
    error: "",
    online: false,
    userId: "",
    accountId: "",
    admin: false,
    linked: false,
    remote: null,
    deckOpen: false,
    notice: "",
    name,
    color,
    avatar: stored("spoka-avatar"),
    room: null,
    statuses: {},
    recents: readRecents(),
    shown: null,
    mini: null,
    push: "unsupported",
    status: "",
    needsTap: "",
    stats: null,
    dataMb: 0,
    quality: AUTO,
    latency: "balanced",
    tab: "chat",
    unread: 0,
    chatOpen: false,
    sheet: null,
    immersive: false,
    fullscreen: false,
    canInstall: false,
    replyTo: null,
    draftImage: null,
    typing: {},
    floats: [],
    voiceOn: false,
    micOn: true,
    deafened: false,
    pushToTalk: false,
    talking: false,
    speaking: {},
    togetherVolume: 100,
  });
  signal.onMessage = onServer;
  signal.onState = state => {
    set({ online: state === "online" });
    if (state === "outdated") location.reload();
  };
  signal.onReady = onConnected;
  signal.start(socketUrl, deviceToken(), profile(), "web", "site", deviceName());
  autoRung = matchMedia("(pointer: coarse)").matches ? (slowNetwork() ? 0 : 1) : 2;

  addEventListener("popstate", () => {
    if (get().sheet) return set({ sheet: null });
    if (get().screen === "room" && !location.pathname.startsWith("/w/")) leaveRoom(false);
  });
  addEventListener("beforeinstallprompt", event => {
    event.preventDefault();
    installEvent = event as typeof installEvent;
    set({ canInstall: true });
  });
  document.addEventListener("fullscreenchange", () => {
    set({ fullscreen: !!document.fullscreenElement });
    resumeSoon();
  });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) return;
    resumeSoon();
    void keepAwake();
  });
  for (const type of ["pause", "webkitendfullscreen"]) video.addEventListener(type, resumeSoon);
  addEventListener("message", onPlayerMessage);
  setInterval(watchStats, STATS_MS);
  setInterval(expireTyping, 1000);
  setInterval(followSpeaking, 200);
  if ("serviceWorker" in navigator) void navigator.serviceWorker.register("/sw.js").then(checkPush).catch(() => {});
}

const pushReady = () => "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;

/** Le téléphone peut refuser plus tard, depuis ses réglages : ce qu'il dit fait foi, pas ce qu'on a retenu. */
async function checkPush() {
  if (!pushReady() || !(await fetch("/push/key").then(r => r.ok, () => false))) return;
  const registration = await navigator.serviceWorker.ready;
  const subscription = await registration.pushManager.getSubscription();
  set({ push: Notification.permission === "denied" ? "blocked" : subscription ? "on" : "off" });
  if (subscription) sendPush(subscription);
}

function sendPush(subscription: PushSubscription) {
  const { endpoint, keys } = subscription.toJSON();
  if (endpoint && keys?.p256dh && keys.auth) signal.send({ t: "push.subscribe", endpoint, p256dh: keys.p256dh, auth: keys.auth, rooms: get().recents.map(r => r.id) });
}

export async function togglePush() {
  const registration = await navigator.serviceWorker.ready;
  const subscription = await registration.pushManager.getSubscription();
  if (subscription) {
    signal.send({ t: "push.unsubscribe", endpoint: subscription.endpoint });
    await subscription.unsubscribe();
    return set({ push: "off" });
  }
  if ((await Notification.requestPermission()) !== "granted") return set({ push: "blocked" });
  const { key } = (await fetch("/push/key").then(r => r.json())) as { key: string };
  const raw = Uint8Array.from(atob(key.replace(/-/g, "+").replace(/_/g, "/")), c => c.charCodeAt(0));
  sendPush(await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: raw }));
  set({ push: "on" });
}

function slowNetwork() {
  const connection = (navigator as Navigator & { connection?: { saveData?: boolean; effectiveType?: string } }).connection;
  return !!connection?.saveData || /2g|3g/.test(connection?.effectiveType ?? "");
}

export async function install() {
  await installEvent?.prompt();
  installEvent = null;
  set({ canInstall: false });
}

function onRemote(state: RemoteState | null) {
  set(s => ({ remote: state, deckOpen: !!state && s.deckOpen }));
}

/** Les salons suivent la personne, pas le téléphone : le compte complète ce que cet appareil connaissait déjà. */
function onAccountRooms(rooms: RecentRoom[]) {
  const known = new Set(get().recents.map(r => r.id));
  const recents = [...get().recents, ...rooms.filter(r => !known.has(r.id))].slice(0, 24);
  store("spoka-rooms", JSON.stringify(recents));
  set({ recents });
  signal.send({ t: "room.subscribe", ids: recents.map(r => r.id) });
}

function applyAccountProfile(next: Profile) {
  // Un appareil seul reste maître de son profil : le serveur ne fait que le lui répéter.
  if (get().accountId === get().userId) return;
  set({ name: next.name, color: next.color, avatar: next.avatar });
  store("spoka-name", next.name);
  store("spoka-color", next.color);
  store("spoka-avatar", next.avatar ?? "");
}

function showNotice(text: string) {
  set({ notice: text });
  setTimeout(() => set(s => (s.notice === text ? { notice: "" } : {})), 12_000);
}

export const remoteCommand = (cmd: RemoteCommand, arg?: string | number | boolean) => {
  navigator.vibrate?.(12);
  signal.send({ t: "remote.cmd", cmd, arg });
};

/** Rattache ce téléphone au compte du PC qui a créé le code. */
export async function claimLink(code: string) {
  const answer = await signal.request<{ already?: boolean } | undefined>({ t: "account.claim", code });
  set({ linked: true });
  void checkPush().catch(() => {});
  return !answer?.already;
}

function onConnected() {
  const link = location.pathname.match(/^\/link\/([A-Za-z0-9]{4,16})/)?.[1];
  if (link) {
    history.replaceState(null, "", "/");
    void claimLink(link).then(
      () => showNotice("Ce téléphone est lié à ton compte."),
      () => showNotice("Ce lien n'est plus valable : crée-en un nouveau sur ton PC."),
    );
  }
  signal.send({ t: "room.subscribe", ids: get().recents.map(r => r.id) });
  void checkPush().catch(() => {});
  const room = get().room;
  if (room) void signal.request({ t: "room.join", id: room.id }).catch(() => {});
  else if (get().screen === "room") void enter(get().code);
}

/** Ce geste autorise le son : un navigateur refuse de lancer une vidéo sonore sans action de la personne. */
function unlockSound() {
  video.muted = false;
  video.srcObject = new MediaStream();
  void video.play().catch(() => {});
}

/** Un seul champ sur l'accueil : le code d'un salon, ou celui que montre le PC pour lier ce téléphone. */
export async function enterCode(code: string, name?: string) {
  const clean = code.replace(/[^A-Za-z0-9]/g, "").toUpperCase();
  if (!clean) return;
  try {
    const fresh = await claimLink(clean);
    set({ error: "" });
    return showNotice(fresh ? "Ce téléphone est lié à ton compte. Tes salons sont là." : "Ce téléphone était déjà lié à ton compte.");
  } catch {
    await enter(clean, name);
  }
}

export async function enter(code: string, name = get().name) {
  const clean = code.replace(/[^A-Za-z0-9]/g, "").toUpperCase();
  if (!clean) return;
  if (name !== get().name) saveProfile({ name });
  unlockSound();
  set({ code: clean, error: "", screen: "room" });
  if (location.pathname !== `/w/${clean}`) history.pushState(null, "", `/w/${clean}`);
  if (!get().online) return;
  try {
    await signal.request({ t: "room.join", code: clean });
  } catch (e) {
    history.replaceState(null, "", "/");
    set({ screen: "home", error: ERRORS[(e as RequestError).code] ?? "Impossible de rejoindre ce salon." });
  }
}

export function leaveRoom(notify = true) {
  if (notify) signal.send({ t: "room.leave" });
  closeMini();
  stopWatching();
  stopVoice();
  if (location.pathname !== "/") history.pushState(null, "", "/");
  set({ room: null, screen: "home", code: "", shown: null, unread: 0, immersive: false, chatOpen: false, status: "" });
  if (document.fullscreenElement) void document.exitFullscreen();
}

export function saveProfile(patch: { name?: string; color?: string; avatar?: string | null }) {
  set(patch);
  if (patch.name !== undefined) store("spoka-name", patch.name);
  if (patch.color) store("spoka-color", patch.color);
  if (patch.avatar !== undefined) store("spoka-avatar", patch.avatar ?? "");
  signal.send({ t: "profile.update", profile: profile() });
}

function remember(room: RoomState) {
  const recents = rememberRoom(get().recents, { id: room.id, code: room.code, name: room.name }, 24);
  store("spoka-rooms", JSON.stringify(recents));
  set({ recents });
  signal.send({ t: "room.subscribe", ids: recents.map(r => r.id) });
  void checkPush().catch(() => {});
}

/** Efface le compte sur le serveur, et le jeton de ce navigateur avec : la page repart de zéro. */
export async function deleteAccount() {
  await signal.request({ t: "account.delete" });
  for (const key of ["spoka-token", "spoka-rooms"]) localStorage.removeItem(key);
  location.href = "/";
}

export function forgetRoom(id: string) {
  const recents = get().recents.filter(r => r.id !== id);
  store("spoka-rooms", JSON.stringify(recents));
  set({ recents });
  signal.send({ t: "account.forget", id });
}

// ---------------------------------------------------------------- serveur

function patchRoom(patch: (room: RoomState) => Partial<RoomState>) {
  set(s => (s.room ? { room: { ...s.room, ...patch(s.room) } } : {}));
}

function onServer(m: ServerMessage) {
  switch (m.t) {
    case "welcome":
      iceServers = m.iceServers;
      return set({ userId: m.userId, accountId: m.accountId ?? m.userId, admin: !!m.admin });
    case "account.sync":
      return applyAccountProfile(m.profile);
    case "account.rooms":
      return onAccountRooms(m.rooms);
    case "remote.state":
      return onRemote(m.state);
    case "announce":
      return showNotice(m.text);
    case "room.state":
      return onRoomState(m.room);
    case "room.updated":
      return patchRoom(() => ({ name: m.name, settings: m.settings }));
    case "room.status":
      return onStatus(m.rooms);
    case "room.closed":
      set({ error: m.reason === "deleted" ? "Le salon a été supprimé." : m.reason === "banned" ? "Tu as été banni du salon." : m.reason === "replaced" ? "Ce salon vient d'être ouvert ailleurs sur cet appareil." : "Tu as été exclu du salon." });
      return leaveRoom(false);
    case "member.join":
      return patchRoom(r => ({ members: [...r.members.filter(x => x.id !== m.member.id), m.member] }));
    case "member.update":
      patchRoom(r => ({ members: r.members.map(x => (x.id === m.member.id ? m.member : x)) }));
      return syncVoice();
    case "member.leave":
      patchRoom(r => ({ members: r.members.filter(x => x.id !== m.userId) }));
      return syncVoice();
    case "chat":
      return onChat(m.message);
    case "chat.deleted":
      return patchRoom(r => ({ history: r.history.filter(x => x.id !== m.id) }));
    case "chat.reactions":
      return patchRoom(r => ({ history: r.history.map(x => (x.id === m.id ? { ...x, reactions: m.reactions } : x)) }));
    case "chat.pinned":
      return patchRoom(() => ({ pinned: m.message }));
    case "chat.typing":
      return set(s => ({ typing: { ...s.typing, [m.userId]: Date.now() + 4000 } }));
    case "poll":
      return patchRoom(() => ({ poll: m.poll }));
    case "together":
      return onTogether(m.together);
    case "reaction":
      if (m.streamId === get().shown) floatReaction(m.emoji);
      return;
    case "draw":
      if (m.streamId === get().shown) for (const listener of strokes) listener({ stroke: m.stroke });
      return;
    case "draw.clear":
      if (m.streamId === get().shown) for (const listener of strokes) listener({ clear: true });
      return;
    case "stream.add":
      patchRoom(r => ({ streams: [...r.streams.filter(s => s.id !== m.stream.id), m.stream] }));
      // Serveur redémarré : le stream revient avec le même identifiant, et la connexion vidéo n'a jamais cessé.
      if (m.stream.id === current?.streamId) return void signal.request({ t: "stream.watch", id: m.stream.id, on: true, resume: true, quality: requestedQuality() }).catch(() => {});
      return pickStream();
    case "stream.update":
      return patchRoom(r => ({ streams: r.streams.map(s => (s.id === m.id ? { ...s, ...m.patch } : s)) }));
    case "stream.thumb":
      return patchRoom(r => ({ streams: r.streams.map(s => (s.id === m.id ? { ...s, thumb: m.data } : s)) }));
    case "stream.remove":
      patchRoom(r => ({ streams: r.streams.filter(s => s.id !== m.id) }));
      if (get().mini === m.id) closeMini();
      if (get().shown === m.id) {
        stopWatching();
        chosen = false;
      }
      return pickStream();
    case "stream.kicked":
      stopWatching();
      return set({ status: "Le diffuseur t'a retiré de ce stream." });
    case "rtc":
      return onRtc(m.from, m.session, m.data);
    case "error":
      if (ERRORS[m.error]) set({ status: ERRORS[m.error]! });
      return;
    default:
      return;
  }
}

function onRtc(from: string, session: string, data: unknown) {
  const payload = data as { sdp?: RTCSessionDescriptionInit; candidate?: RTCIceCandidateInit };
  if (session.startsWith(CLIP_SESSION)) return void clips.onSignal(from, session, payload).catch(() => {});
  if (session === VOICE_SESSION) return void voice?.onSignal(from, payload).catch(() => {});
  if (session === miniSub?.streamId) return void miniSub.onSignal(payload).catch(() => closeMini());
  if (session === current?.streamId) void current.onSignal(payload).catch(() => set({ status: "Connexion au stream impossible." }));
}

function onRoomState(room: RoomState) {
  const back = !!get().room;
  set({ room, screen: "room", code: room.code, error: "" });
  remember(room);
  onTogether(room.together);
  if (back && voice?.active) sendVoiceState();
  if (back && current && room.streams.some(s => s.id === current!.streamId)) void signal.request({ t: "stream.watch", id: current.streamId, on: true, resume: true, quality: requestedQuality() }).catch(() => {});
  pickStream();
  syncVoice();
}

function onStatus(rooms: RoomStatus[]) {
  const statuses = { ...get().statuses };
  for (const status of rooms) statuses[status.id] = status;
  set({ statuses });
  for (const status of rooms) {
    if (status.exists) continue;
    const recents = get().recents.filter(r => r.id !== status.id);
    store("spoka-rooms", JSON.stringify(recents));
    set({ recents });
  }
}

function onChat(message: ChatMessage) {
  patchRoom(r => ({ history: [...r.history, message].slice(-300) }));
  set(s => {
    const typing = { ...s.typing };
    delete typing[message.authorId];
    const reading = s.tab === "chat" && !document.hidden;
    return { typing, unread: reading || message.kind !== "user" || message.authorId === s.userId ? s.unread : s.unread + 1 };
  });
  if (message.kind === "user" && message.authorId !== get().userId && new RegExp(`@(${get().name}|tous)\\b`, "i").test(message.text)) navigator.vibrate?.(60);
}

function expireTyping() {
  const now = Date.now();
  const { typing } = get();
  const keys = Object.keys(typing);
  const alive = keys.filter(k => typing[k]! > now);
  if (alive.length !== keys.length) set({ typing: Object.fromEntries(alive.map(k => [k, typing[k]!])) });
}

// ---------------------------------------------------------------- regarder

function requestedQuality(): ViewerQuality {
  const { quality } = get();
  return quality === AUTO ? QUALITIES[AUTO_STEPS[autoRung]!]!.quality : QUALITIES[quality]!.quality;
}

function pickStream() {
  const { shown, room } = get();
  if (shown === TOGETHER || (shown && room?.streams.some(s => s.id === shown))) return;
  const first = room?.streams.find(s => s.ownerId !== get().userId && !isMine(s));
  if (first) return show(first.id);
  if (room?.together) return show(TOGETHER);
  if (get().remote && !get().remote!.idle) return set({ status: "Ton PC diffuse : tu pilotes tout depuis l'onglet Régie." });
  set({ status: room ? "Personne ne diffuse pour l'instant. Reste ici : le stream s'affichera tout seul." : "" });
}

export function show(id: string) {
  if (get().shown === id) return;
  stopWatching();
  set({ shown: id, status: "" });
  if (id === TOGETHER) syncPlayer();
  else void watch(id);
}

export function choose(id: string) {
  chosen = true;
  set({ tab: "chat" });
  if (get().mini === id) closeMini();
  show(id);
}

/** Ce qu'on peut regarder ici, dans l'ordre de l'onglet En direct. */
export function liveChoices() {
  const { room, userId } = get();
  const list = (room?.streams ?? []).filter(s => s.ownerId !== userId).map(s => s.id);
  return room?.together ? [...list, TOGETHER] : list;
}

/** Glisser sur l'image passe au stream voisin, comme entre deux vidéos sur un réseau social. */
export function swipeStream(step: number) {
  const list = liveChoices();
  if (list.length < 2) return;
  const index = list.indexOf(get().shown ?? "");
  const next = list[(index + step + list.length) % list.length]!;
  navigator.vibrate?.(12);
  choose(next);
}

/** Un second stream en petit, muet : une petite image suffit, la définition reste basse pour ne pas vider le forfait. */
export async function openMini(id: string) {
  closeMini();
  const stream = get().room?.streams.find(s => s.id === id);
  if (!stream) return;
  const quality = QUALITIES[AUTO_STEPS[0]!]!.quality;
  const sub = new Subscription(id, stream.ownerId, "balanced", () => iceServers, data => signal.send({ t: "rtc", to: stream.ownerId, session: id, data }));
  miniSub = sub;
  set({ mini: id, tab: "chat" });
  sub.onTrack = () => {
    if (miniSub !== sub) return;
    if (miniVideo.srcObject !== sub.media) miniVideo.srcObject = sub.media;
    void miniVideo.play().catch(() => {});
  };
  sub.onLost = () => {
    if (miniSub === sub) void signal.request({ t: "stream.watch", id, on: true, quality }).catch(() => {});
  };
  await signal.request({ t: "stream.watch", id, on: true, quality }).catch(() => closeMini());
}

export function closeMini() {
  if (miniSub) {
    signal.send({ t: "stream.watch", id: miniSub.streamId, on: false });
    miniSub.close();
  }
  miniSub = null;
  miniVideo.srcObject = null;
  set({ mini: null });
}

/** Le petit passe en grand, et le grand en petit. */
export function swapMini() {
  const { mini, shown } = get();
  if (!mini) return;
  const previous = shown && shown !== TOGETHER ? shown : null;
  closeMini();
  chosen = true;
  show(mini);
  if (previous) void openMini(previous);
}

async function watch(id: string) {
  const stream = get().room?.streams.find(s => s.id === id);
  if (!stream) return;
  set({ status: "Connexion au stream…", stats: null });
  const sub = new Subscription(id, stream.ownerId, get().latency === "stable" ? "stable" : "balanced", () => iceServers, data => signal.send({ t: "rtc", to: stream.ownerId, session: id, data }));
  current = sub;
  lastFreezes = 0;
  autoGoodSince = Date.now();
  sub.onState = state => set({ status: state === "connected" ? "" : state === "connecting" ? "Connexion au stream…" : "Connexion instable…" });
  sub.onTrack = () => {
    if (current !== sub) return;
    if (video.srcObject !== sub.media) video.srcObject = sub.media;
    camera.srcObject = sub.camera;
    resume();
    void keepAwake();
    describeMedia(stream);
  };
  sub.onLost = () => {
    if (current === sub) void signal.request({ t: "stream.watch", id, on: true, quality: requestedQuality() }).catch(() => {});
  };
  try {
    await signal.request({ t: "stream.watch", id, on: true, quality: requestedQuality() });
  } catch (e) {
    if (current !== sub) return;
    stopWatching();
    set({ status: ERRORS[(e as RequestError).code] ?? "Ce stream n'est pas disponible." });
  }
}

function stopWatching() {
  if (current) {
    signal.send({ t: "stream.watch", id: current.streamId, on: false });
    current.close();
  }
  current = null;
  video.srcObject = null;
  camera.srcObject = null;
  set({ shown: null, stats: null, needsTap: "" });
  void wakeLock?.release().catch(() => {});
  wakeLock = null;
}

/**
 * Un téléphone met la vidéo en pause en sortant du plein écran, ou quand la page revient au premier plan.
 * Ce lecteur est un direct, sans bouton lecture : la reprise est automatique, et à portée de doigt si le navigateur la refuse.
 */
export function resume() {
  if (!video.srcObject) return;
  void video.play().then(
    () => set(s => (s.needsTap === "lecture" ? { needsTap: "" } : {})),
    (e: DOMException) => {
      if (e.name !== "NotAllowedError") return;
      if (video.muted) return set({ needsTap: "lecture" });
      // Le son est refusé : mieux vaut une image muette et un bouton qu'une image noire.
      video.muted = true;
      set({ needsTap: "son" });
      void video.play().catch(() => set({ needsTap: "lecture" }));
    },
  );
}

const resumeSoon = () => setTimeout(() => video.paused && resume(), 150);

export function tapped() {
  video.muted = false;
  set({ needsTap: "" });
  resume();
  if (get().shown === TOGETHER) sendPlayer({ cmd: "volume", volume: get().togetherVolume });
}

/** Une réaction envoyée sur le stream du PC, depuis la régie. */
export function reactTo(streamId: string | undefined, emoji: string) {
  const target = streamId ?? get().room?.streams.find(isMine)?.id;
  if (!target) return;
  signal.send({ t: "reaction", streamId: target, emoji });
  navigator.vibrate?.(15);
}

/** L'écran reste allumé tant que la régie est ouverte. Le téléphone reprend ce verrou dès que la page repasse devant. */
export async function deckAwake(on: boolean) {
  if (!on) {
    await deckLock?.release().catch(() => {});
    deckLock = null;
    return;
  }
  if (deckLock || document.hidden) return;
  deckLock = (await (navigator as Navigator & { wakeLock?: { request(type: "screen"): Promise<{ release(): Promise<void> }> } }).wakeLock?.request("screen").catch(() => null)) ?? null;
  deckLock && (deckLock as unknown as EventTarget).addEventListener?.("release", () => (deckLock = null));
}

/** L'écran ne s'éteint pas pendant qu'on regarde. */
async function keepAwake() {
  if (wakeLock || !current || document.hidden) return;
  wakeLock = (await (navigator as Navigator & { wakeLock?: { request(type: "screen"): Promise<{ release(): Promise<void> }> } }).wakeLock?.request("screen").catch(() => null)) ?? null;
}

/** Ce qui s'affiche sur l'écran verrouillé et dans la zone de notification du téléphone. */
function describeMedia(stream: StreamInfo) {
  if (!("mediaSession" in navigator)) return;
  navigator.mediaSession.metadata = new MediaMetadata({ title: stream.title || `${nameOf(stream.ownerId)} en direct`, artist: nameOf(stream.ownerId), album: get().room?.name ?? "SpokaStream", artwork: [{ src: "/icon-512.png", sizes: "512x512", type: "image/png" }] });
  navigator.mediaSession.setActionHandler("play", resume);
  navigator.mediaSession.setActionHandler("pause", () => undefined);
}

async function watchStats() {
  const sub = current;
  if (!sub) return;
  const read = await sub.stats();
  if (!read) return;
  const stats: ViewStats = { height: read.height, fps: read.fps, kbps: read.kbps, lostPct: read.lostPct, relay: !!read.path?.relay };
  set(s => ({ stats, dataMb: s.dataMb + ((read.kbps + read.audioKbps) * STATS_MS) / 8_000_000 }));
  if (++statsTicks % TELEMETRY_TICKS === 0) signal.send({ t: "telemetry", watch: [{ streamId: sub.streamId, fps: read.fps, kbps: read.kbps, height: read.height, lostPct: read.lostPct, jitterMs: read.jitterMs, freezes: read.freezes, relay: !!read.path?.relay, protocol: read.path?.protocol ?? "", rttMs: read.path?.rttMs ?? null }] });
  if (get().quality === AUTO) adaptQuality(read.lostPct, read.freezes);
}

/** Descend vite quand ça saccade, remonte lentement quand c'est stable : mieux vaut 480p fluide que 1080p figé. */
function adaptQuality(lostPct: number, freezes: number) {
  const froze = freezes > lastFreezes;
  lastFreezes = freezes;
  const now = Date.now();
  if (lostPct > 4 || froze) {
    autoGoodSince = now;
    if (autoRung > 0) stepAuto(autoRung - 1);
  } else if (now - autoGoodSince > AUTO_UP_AFTER_MS) {
    autoGoodSince = now;
    if (autoRung < AUTO_STEPS.length - 1 && !slowNetwork()) stepAuto(autoRung + 1);
  }
}

function stepAuto(rung: number) {
  autoRung = rung;
  if (current) signal.send({ t: "stream.quality", id: current.streamId, quality: requestedQuality() });
}

export function setQuality(index: number) {
  set({ quality: index });
  if (current) signal.send({ t: "stream.quality", id: current.streamId, quality: requestedQuality() });
}

export const audioOnly = () => get().quality === AUDIO_ONLY;

export function setLatency(latency: "balanced" | "stable") {
  set({ latency });
  current?.setLatency(latency);
}

export function floatReaction(emoji: string) {
  const id = nextFloat++;
  set(s => ({ floats: [...s.floats.slice(-16), { id, emoji, left: 8 + Math.random() * 30 }] }));
  setTimeout(() => set(s => ({ floats: s.floats.filter(f => f.id !== id) })), 3000);
}

export function react(emoji: string) {
  const { shown } = get();
  if (!shown) return;
  signal.send({ t: "reaction", streamId: shown, emoji });
  navigator.vibrate?.(15);
}

export function sendStroke(points: number[], id: string, end: boolean, color: string) {
  const { shown } = get();
  if (shown) signal.send({ t: "draw", streamId: shown, stroke: { id, tool: "laser", color, points, end } });
}

export const newStrokeId = () => `${get().userId.slice(0, 6)}-w${++strokeCount}`;

/** Une capture du stream, posée dans le message en cours : à envoyer au salon, ou à garder. */
export async function capture() {
  const image = await frameForChat(video);
  if (!image) return;
  set({ draftImage: image, tab: "chat", chatOpen: true });
}

// ---------------------------------------------------------------- regarder ensemble

function onTogether(next: Together | null) {
  const before = get().room?.together;
  patchRoom(() => ({ together: next }));
  togetherAt = performance.now();
  if (next && !before && !chosen) show(TOGETHER);
  if (!next && get().shown === TOGETHER) {
    set({ shown: null });
    playerVideo = "";
    frame.removeAttribute("src");
    playerReady = false;
    pickStream();
  }
  if (get().shown === TOGETHER) syncPlayer();
}

let togetherAt = 0;
let playerReady = false;
let playerVideo = "";
let lastSeek = 0;
let playerTime = 0;
let playerDuration = 0;

export function togetherPosition() {
  const together = get().room?.together;
  if (!together) return 0;
  return together.playing ? together.position + (performance.now() - togetherAt) / 1000 : together.position;
}

const sendPlayer = (message: Record<string, unknown>) => frame.contentWindow?.postMessage({ ...message, spoka: true }, location.origin);

function syncPlayer() {
  const together = get().room?.together;
  if (!together) return;
  if (!frame.getAttribute("src")) frame.src = "/player";
  if (!playerReady) return;
  if (playerVideo !== together.videoId) {
    playerVideo = together.videoId;
    return sendPlayer({ cmd: "load", id: together.videoId, url: together.url, subtitles: together.subtitles, time: togetherPosition(), playing: together.playing });
  }
  sendPlayer({ cmd: together.playing ? "play" : "pause" });
  sendPlayer({ cmd: "seek", time: togetherPosition() });
}

function onPlayerMessage(event: MessageEvent) {
  const message = event.data as { spoka?: boolean; type?: string; time?: number; duration?: number; state?: number; code?: number };
  if (event.origin !== location.origin || event.source !== frame.contentWindow || !message?.spoka) return;
  if (message.type === "ready") {
    playerReady = true;
    sendPlayer({ cmd: "volume", volume: get().togetherVolume });
    return syncPlayer();
  }
  if (message.type === "muted") return set({ needsTap: "son" });
  if (message.type === "error") return set({ status: "Cette vidéo ne peut pas être lue sur ce téléphone." });
  if (message.type === "state" && message.state === 0) {
    const id = get().room?.together?.videoId;
    if (id) signal.send({ t: "together.next", videoId: id });
  }
  if (message.type !== "time") return;
  playerTime = message.time ?? 0;
  playerDuration = message.duration ?? 0;
  if (get().room?.together && Math.abs(playerTime - togetherPosition()) > 1.5 && performance.now() - lastSeek > 3000) {
    lastSeek = performance.now();
    sendPlayer({ cmd: "seek", time: togetherPosition() });
  }
}

export const playerClock = () => ({ time: playerTime, duration: playerDuration });
export const togetherPlay = (playing: boolean) => signal.send({ t: "together.control", playing, position: togetherPosition() });
export const togetherSeek = (position: number) => signal.send({ t: "together.control", playing: get().room?.together?.playing ?? true, position });
export const togetherSkip = () => {
  const id = get().room?.together?.videoId;
  if (id) signal.send({ t: "together.next", videoId: id });
};
export const togetherStop = () => signal.send({ t: "together.stop" });
export const togetherSkipBy = (seconds: number) => togetherSeek(Math.max(0, togetherPosition() + seconds));
export const togetherRemove = (index: number, videoId: string) => signal.send({ t: "together.remove", index, videoId });

/** Le son de la Watch Party : elle joue dans son propre lecteur, pas dans celui des streams. */
export function setTogetherVolume(volume: number) {
  set({ togetherVolume: volume });
  sendPlayer({ cmd: "volume", volume });
}

/** Tes sous-titres, pour toi seul : un fichier .srt ou .vtt du téléphone. */
export async function loadSubtitles(file: File) {
  sendPlayer({ cmd: "subtitles", text: await file.text() });
}

/** Rend un message d'erreur, ou null si la vidéo part. */
export async function togetherAdd(link: string, subtitles = "") {
  const videoId = youtubeId(link);
  if (!videoId) {
    const url = videoUrl(/^[a-z]+:\/\//i.test(link.trim()) ? link : `https://${link.trim()}`);
    if (!url) return "Ce lien n'est pas valable.";
    if (location.protocol === "https:" && url.startsWith("http:")) return "Ce lien n'est pas sécurisé (http) : un navigateur refuse de le lire ici.";
    if (!isHls(url) && !(await canPlay(url))) return "Ce n'est pas une vidéo qu'un navigateur sait lire. Depuis l'application sur PC, on peut diffuser la page.";
    signal.send({ t: "together.add", url, title: titleFromUrl(url), ...(subtitles.trim() ? { subtitles: subtitles.trim() } : {}) });
    return null;
  }
  const info = await fetch(`/oembed?id=${videoId}`).then(r => (r.ok ? (r.json() as Promise<{ title?: string }>) : null), () => null);
  if (!info?.title) return "Cette vidéo n'existe pas, ou YouTube interdit de la regarder hors de son site.";
  signal.send({ t: "together.add", videoId, title: info.title });
  return null;
}

// ---------------------------------------------------------------- vocal

const sendVoiceState = () => signal.send({ t: "voice.set", voice: { muted: !get().micOn, deafened: get().deafened } });

const applyTransmit = () => voice?.setTransmitting(get().micOn && !get().deafened && (!get().pushToTalk || get().talking));

function syncVoice() {
  const room = get().room;
  if (!room || !voice?.active) return;
  voice.sync(room.members.filter(m => m.voice && m.id !== get().userId).map(m => m.id));
}

export async function joinVoice() {
  const next = new Voice({
    selfId: () => get().userId,
    iceServers: () => iceServers,
    sendSignal: (to, data) => signal.send({ t: "rtc", to, session: VOICE_SESSION, data }),
    settings: { micId: "default", noiseSuppression: true, echoCancellation: true, autoGain: true, voiceKbps: 48 },
  });
  next.onRemoteTrack = (id, track) => addVoice(id, track);
  next.onPeerGone = id => dropVoice(id);
  try {
    await next.join();
  } catch {
    return set({ status: "Le navigateur n'a pas donné accès au micro." });
  }
  voice = next;
  set({ voiceOn: true });
  applyTransmit();
  sendVoiceState();
  syncVoice();
}

function addVoice(id: string, track: MediaStreamTrack) {
  dropVoice(id);
  voiceContext ??= new AudioContext();
  void voiceContext.resume();
  const stream = new MediaStream([track]);
  const audio = new Audio();
  audio.autoplay = true;
  audio.dataset.voice = id;
  audio.srcObject = stream;
  audio.muted = get().deafened;
  void audio.play().catch(() => {});
  document.body.append(audio);
  const analyser = voiceContext.createAnalyser();
  analyser.fftSize = 512;
  voiceContext.createMediaStreamSource(stream).connect(analyser);
  voiceAudio.set(id, { audio, analyser });
}

function dropVoice(id: string) {
  const entry = voiceAudio.get(id);
  entry?.audio.remove();
  voiceAudio.delete(id);
}

function stopVoice() {
  voice?.leave();
  voice = null;
  for (const id of [...voiceAudio.keys()]) dropVoice(id);
  set({ voiceOn: false, speaking: {} });
}

export function leaveVoice() {
  stopVoice();
  signal.send({ t: "voice.set", voice: null });
}

export function toggleMic() {
  set(s => ({ micOn: !s.micOn }));
  applyTransmit();
  sendVoiceState();
}

export function toggleDeafen() {
  set(s => ({ deafened: !s.deafened }));
  for (const { audio } of voiceAudio.values()) audio.muted = get().deafened;
  applyTransmit();
  sendVoiceState();
}

export function setPushToTalk(on: boolean) {
  set({ pushToTalk: on, talking: false });
  applyTransmit();
}

export function setTalking(talking: boolean) {
  set({ talking });
  applyTransmit();
  if (talking) navigator.vibrate?.(20);
}

export const setVoiceVolume = (id: string, volume: number) => {
  const entry = voiceAudio.get(id);
  if (entry) entry.audio.volume = volume;
};

const buffer = new Float32Array(512);

function followSpeaking() {
  if (!voice?.active) return;
  const speaking: Record<string, boolean> = {};
  for (const [id, { analyser }] of voiceAudio) {
    analyser.getFloatTimeDomainData(buffer);
    let sum = 0;
    for (const x of buffer) sum += x * x;
    if (Math.sqrt(sum / buffer.length) > SPEAKING_LEVEL) speaking[id] = true;
  }
  const open = get().micOn && !get().deafened && (!get().pushToTalk || get().talking);
  if (open && voice.level > SPEAKING_LEVEL) speaking[get().userId] = true;
  if (JSON.stringify(speaking) !== JSON.stringify(get().speaking)) set({ speaking });
}

// ---------------------------------------------------------------- chat

export function sendChat(text: string) {
  const { replyTo, draftImage } = get();
  if (!text.trim() && !draftImage) return;
  signal.send({ t: "chat.send", text: text.slice(0, LIMITS.chat), replyTo: replyTo?.id ?? null, image: draftImage });
  set({ replyTo: null, draftImage: null });
}

export const sendTyping = () => signal.send({ t: "chat.typing" });
export const reactChat = (id: string, emoji: string) => signal.send({ t: "chat.react", id, emoji });
export const deleteChat = (id: string) => signal.send({ t: "chat.delete", id });
export const pollVote = (id: string, option: number) => signal.send({ t: "poll.vote", id, option });
export const pollCreate = (question: string, options: string[]) => signal.send({ t: "poll.create", question, options });
export const pollClose = (id: string) => signal.send({ t: "poll.close", id });
export const pollDismiss = (id: string) => signal.send({ t: "poll.dismiss", id });
export const fetchClip = (message: ChatMessage, onProgress: (share: number) => void) => clips.fetch(message.authorId, message.clip!.id, message.clip!.bytes, onProgress);

export const inviteLink = () => `${location.origin}/j/${get().code}`;

export async function shareInvite() {
  const url = inviteLink();
  const data = { title: "SpokaStream", text: `Rejoins-moi dans ${get().room?.name ?? "mon salon"}`, url };
  if (navigator.share && (await navigator.share(data).then(() => true, () => false))) return;
  await navigator.clipboard?.writeText(url).catch(() => {});
}
