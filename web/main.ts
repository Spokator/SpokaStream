// Lecteur web : regarder et parler dans un salon depuis un navigateur, téléphone compris, sans rien installer.
// Il réutilise la réception, le vocal et les clips de l'application. Diffuser reste réservé au logiciel :
// c'est lui seul qui peut capter le son d'une application.
import { DEFAULT_CAMERA_LAYOUT, DEFAULT_VIEWER_QUALITY } from "@shared/protocol.ts";
import type { ChatMessage, ErrorCode, IceServer, Member, Poll, RoomState, ServerMessage, StreamInfo, Together, ViewerQuality } from "@shared/protocol.ts";
import { CLIP_SESSION, ClipShare } from "../src/renderer/src/engine/clipShare.ts";
import { RequestError, Signal } from "../src/renderer/src/engine/signal.ts";
import { Subscription } from "../src/renderer/src/engine/subscription.ts";
import { VOICE_SESSION, Voice } from "../src/renderer/src/engine/voice.ts";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text = "") {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

const COLORS = ["#7c5cff", "#22d3ee", "#34d399", "#f59e0b", "#f472b6", "#fb7185", "#a78bfa", "#60a5fa"];
const REACTIONS = ["🔥", "😂", "😮", "❤️", "👏", "🎉"];
const ERRORS: Partial<Record<ErrorCode, string>> = {
  room_not_found: "Ce salon n'existe plus. Demande un nouveau lien.",
  room_full: "Ce salon est complet.",
  room_locked: "Ce salon est verrouillé par son propriétaire.",
  banned: "Tu as été banni de ce salon.",
  rate_limited: "Trop d'essais d'un coup, patiente un instant.",
  viewer_limit: "Ce stream a atteint sa limite de spectateurs.",
  stream_not_found: "Ce stream vient de se terminer.",
};
const QUALITIES: { label: string; quality: ViewerQuality }[] = [
  { label: "Maximum", quality: DEFAULT_VIEWER_QUALITY },
  { label: "1080p", quality: { maxHeight: 1080, maxKbps: 12000, maxFps: 0, video: true } },
  { label: "720p", quality: { maxHeight: 720, maxKbps: 5000, maxFps: 0, video: true } },
  { label: "480p", quality: { maxHeight: 480, maxKbps: 1500, maxFps: 30, video: true } },
  { label: "Son seul", quality: { ...DEFAULT_VIEWER_QUALITY, video: false } },
];
const TOGETHER = "together";

const code = location.pathname.split("/").pop() ?? "";
const socketUrl = `${location.origin.replace(/^http/, "ws")}/ws`;
const onPhone = matchMedia("(pointer: coarse)").matches;

const signal = new Signal();
const video = $<HTMLVideoElement>("video");
const camera = $<HTMLVideoElement>("camera");
const frame = $<HTMLIFrameElement>("together");

let userId = "";
let iceServers: IceServer[] = [];
let room: RoomState | null = null;
let current: Subscription | null = null;
let shown: string | null = null;
let chosen = false;
let quality = QUALITIES[onPhone ? 2 : 0]!.quality;
let voice: Voice | null = null;
let muted = false;
let together: Together | null = null;
let togetherAt = 0;
let playerReady = false;
let playerVideo = "";
let lastSeek = 0;

const clips = new ClipShare(() => iceServers, (to, session, data) => signal.send({ t: "rtc", to, session, data }));

function stored(key: string) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function store(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Navigation privée : l'identité ne dure que le temps de la page.
  }
}

/** Pas de compte : comme dans l'application, un jeton aléatoire gardé sur l'appareil est l'identité. */
function deviceToken() {
  const saved = stored("spoka-token");
  if (saved && /^[0-9a-f]{64}$/.test(saved)) return saved;
  const token = [...crypto.getRandomValues(new Uint8Array(32))].map(b => b.toString(16).padStart(2, "0")).join("");
  store("spoka-token", token);
  return token;
}

const memberOf = (id: string): Member | undefined => room?.members.find(m => m.id === id);
const nameOf = (id: string) => memberOf(id)?.name ?? "?";

function setStatus(text: string) {
  const status = $("status");
  status.textContent = text;
  status.hidden = !text;
}

// ---------------------------------------------------------------- entrée

function join(name: string) {
  store("spoka-name", name);
  const color = stored("spoka-color") ?? COLORS[Math.floor(Math.random() * COLORS.length)]!;
  store("spoka-color", color);
  // Ce clic autorise le son : les navigateurs refusent de lancer une vidéo sonore sans geste de la personne.
  video.muted = false;
  void video.play().catch(() => {});
  signal.start(socketUrl, deviceToken(), { name, color, avatar: null }, "web");
}

signal.onReady = () => {
  signal
    .request({ t: "room.join", code })
    .catch((e: RequestError) => {
      signal.stop();
      $("join").hidden = false;
      $("app").hidden = true;
      $("join-error").textContent = ERRORS[e.code] ?? "Impossible de rejoindre ce salon.";
    });
};

signal.onState = state => {
  $("offline").hidden = state === "online" || !room;
  if (state === "outdated") location.reload();
};

signal.onMessage = onServer;

$<HTMLFormElement>("join-form").addEventListener("submit", e => {
  e.preventDefault();
  const name = $<HTMLInputElement>("join-name").value.trim();
  if (!name) return;
  $("join-error").textContent = "";
  join(name);
});

$<HTMLInputElement>("join-name").value = stored("spoka-name") ?? "";
$("join-code").textContent = code;

// ---------------------------------------------------------------- serveur

function onServer(m: ServerMessage) {
  switch (m.t) {
    case "welcome":
      userId = m.userId;
      iceServers = m.iceServers;
      return;
    case "room.state":
      return onRoomState(m.room);
    case "room.updated":
      if (room) room.name = m.name;
      return renderHead();
    case "room.closed":
      signal.stop();
      leaveAll();
      $("app").hidden = true;
      $("join").hidden = false;
      $("join-error").textContent = m.reason === "deleted" ? "Le salon a été supprimé." : m.reason === "banned" ? "Tu as été banni du salon." : m.reason === "replaced" ? "Ce salon vient d'être ouvert ailleurs sur cet appareil." : "Tu as été exclu du salon.";
      return;
    case "member.join":
      if (room) room.members = [...room.members.filter(x => x.id !== m.member.id), m.member];
      return renderHead();
    case "member.update":
      if (room) room.members = room.members.map(x => (x.id === m.member.id ? m.member : x));
      renderHead();
      return syncVoice();
    case "member.leave":
      if (room) room.members = room.members.filter(x => x.id !== m.userId);
      renderHead();
      return syncVoice();
    case "chat":
      room?.history.push(m.message);
      return addMessage(m.message);
    case "chat.deleted":
      document.querySelector(`[data-message="${CSS.escape(m.id)}"]`)?.remove();
      return;
    case "chat.pinned":
      if (room) room.pinned = m.message;
      return renderPinned();
    case "poll":
      if (room) room.poll = m.poll;
      return renderPoll(m.poll);
    case "together":
      return onTogether(m.together);
    case "reaction":
      if (m.streamId === shown) floatReaction(m.emoji);
      return;
    case "stream.add":
      if (room) room.streams = [...room.streams.filter(s => s.id !== m.stream.id), m.stream];
      renderStreams();
      return pickStream();
    case "stream.update": {
      const stream = room?.streams.find(s => s.id === m.id);
      if (stream) Object.assign(stream, m.patch);
      renderStreams();
      if (m.id === shown) renderLayers();
      return;
    }
    case "stream.thumb": {
      const stream = room?.streams.find(s => s.id === m.id);
      if (stream) stream.thumb = m.data;
      return renderStreams();
    }
    case "stream.remove":
      if (room) room.streams = room.streams.filter(s => s.id !== m.id);
      if (shown === m.id) {
        stopWatching();
        chosen = false;
      }
      renderStreams();
      return pickStream();
    case "stream.kicked":
      stopWatching();
      setStatus("Le diffuseur t'a retiré de ce stream.");
      return;
    case "rtc":
      return onRtc(m.from, m.session, m.data);
    case "error":
      if (ERRORS[m.error]) setStatus(ERRORS[m.error]!);
      return;
    default:
      return;
  }
}

function onRtc(from: string, session: string, data: unknown) {
  const signalData = data as { sdp?: RTCSessionDescriptionInit; candidate?: RTCIceCandidateInit };
  if (session.startsWith(CLIP_SESSION)) return void clips.onSignal(from, session, signalData).catch(() => {});
  if (session === VOICE_SESSION) return void voice?.onSignal(from, signalData).catch(() => {});
  if (session === current?.streamId) void current.onSignal(signalData).catch(() => setStatus("Connexion au stream impossible."));
}

function onRoomState(next: RoomState) {
  const back = !!room;
  room = next;
  $("join").hidden = true;
  $("app").hidden = false;
  renderHead();
  renderPinned();
  renderPoll(next.poll);
  $("chat-list").replaceChildren();
  for (const message of next.history) addMessage(message);
  onTogether(next.together);
  if (back && voice?.active) signal.send({ t: "voice.set", voice: { muted, deafened: false } });
  if (back && current && next.streams.some(s => s.id === current!.streamId)) void signal.request({ t: "stream.watch", id: current.streamId, on: true, resume: true, quality }).catch(() => {});
  renderStreams();
  pickStream();
  syncVoice();
}

// ---------------------------------------------------------------- regarder

function pickStream() {
  if (shown === TOGETHER || (shown && room?.streams.some(s => s.id === shown))) return;
  const first = room?.streams.find(s => s.ownerId !== userId);
  if (together && !first) return show(TOGETHER);
  if (first) return show(first.id);
  setStatus("Personne ne diffuse pour l'instant. Reste ici : le stream s'affichera tout seul.");
}

function show(id: string) {
  if (shown === id) return;
  stopWatching();
  shown = id;
  $("stage").classList.toggle("is-together", id === TOGETHER);
  if (id === TOGETHER) {
    setStatus("");
    syncPlayer();
  } else {
    void watch(id);
  }
  renderStreams();
}

async function watch(id: string) {
  const stream = room?.streams.find(s => s.id === id);
  if (!stream) return;
  setStatus("Connexion au stream…");
  const sub = new Subscription(id, stream.ownerId, "balanced", () => iceServers, data => signal.send({ t: "rtc", to: stream.ownerId, session: id, data }));
  current = sub;
  sub.onState = state => setStatus(state === "connected" ? "" : state === "connecting" ? "Connexion au stream…" : "Connexion instable…");
  sub.onTrack = () => {
    if (current !== sub) return;
    if (video.srcObject !== sub.media) video.srcObject = sub.media;
    // L'image et le son arrivent l'un après l'autre : un play interrompu n'est pas un refus du navigateur.
    void video.play().catch((e: DOMException) => {
      if (e.name !== "NotAllowedError") return;
      video.muted = true;
      void video.play().catch(() => {});
      $("unmute").hidden = false;
    });
  };
  sub.onLost = () => {
    if (current === sub) void signal.request({ t: "stream.watch", id, on: true, quality }).catch(() => {});
  };
  camera.srcObject = sub.camera;
  renderLayers();
  try {
    await signal.request({ t: "stream.watch", id, on: true, quality });
  } catch (e) {
    if (current === sub) {
      stopWatching();
      setStatus(ERRORS[(e as RequestError).code] ?? "Ce stream n'est pas disponible.");
    }
  }
}

function stopWatching() {
  if (current) {
    signal.send({ t: "stream.watch", id: current.streamId, on: false });
    current.close();
  }
  current = null;
  shown = null;
  video.srcObject = null;
  camera.srcObject = null;
  camera.hidden = true;
  $("banner").hidden = true;
  $("info").textContent = "";
}

/** La caméra et le bandeau tombent au même endroit que chez le diffuseur, quelle que soit la forme de l'écran. */
function renderLayers() {
  const stream = room?.streams.find(s => s.id === shown);
  camera.hidden = !stream?.camera;
  const banner = $("banner");
  banner.hidden = !stream?.banner;
  banner.textContent = stream?.banner ?? "";
  if (!stream?.camera) return;
  const layout = stream.cameraLayout ?? DEFAULT_CAMERA_LAYOUT;
  const scale = Math.min(video.clientWidth / (video.videoWidth || 16), video.clientHeight / (video.videoHeight || 9));
  const width = (video.videoWidth || 16) * scale;
  const height = (video.videoHeight || 9) * scale;
  camera.className = `is-${layout.shape} ${layout.mirror ? "is-mirror" : ""}`;
  camera.style.left = `${(video.clientWidth - width) / 2 + layout.x * width}px`;
  camera.style.top = `${(video.clientHeight - height) / 2 + layout.y * height}px`;
  camera.style.width = `${layout.width * width}px`;
}

video.addEventListener("resize", renderLayers);
addEventListener("resize", renderLayers);

function leaveAll() {
  stopWatching();
  voice?.leave();
  voice = null;
  room = null;
  renderVoice();
}

function renderHead() {
  if (!room) return;
  $("room-name").textContent = room.name;
  const online = room.members.filter(m => m.online);
  const count = $("room-count");
  count.textContent = `${online.length} ${online.length > 1 ? "personnes" : "personne"}`;
  count.title = online.map(m => m.name).join(", ");
}

function renderStreams() {
  const list = $("streams");
  const streams = room?.streams.filter(s => s.ownerId !== userId) ?? [];
  const entries: Node[] = streams.map(stream => streamButton(stream));
  if (together) {
    const button = el("button", `stream ${shown === TOGETHER ? "is-on" : ""}`);
    button.type = "button";
    const image = el("img");
    image.src = `https://i.ytimg.com/vi/${together.videoId}/mqdefault.jpg`;
    image.alt = "";
    const text = el("span");
    text.append(el("b", "", "YouTube ensemble"), el("small", "", together.title));
    button.append(image, text);
    button.onclick = () => show(TOGETHER);
    entries.push(button);
  }
  list.replaceChildren(...entries);
  list.hidden = entries.length < 2;
}

function streamButton(stream: StreamInfo) {
  const button = el("button", `stream ${shown === stream.id ? "is-on" : ""}`);
  button.type = "button";
  button.dataset.stream = stream.id;
  if (stream.thumb) {
    const image = el("img");
    image.src = stream.thumb;
    image.alt = "";
    button.append(image);
  }
  const text = el("span");
  text.append(el("b", "", nameOf(stream.ownerId)), el("small", "", stream.title || stream.sourceName));
  button.append(text);
  button.onclick = () => {
    chosen = true;
    show(stream.id);
  };
  return button;
}

function fillQualities() {
  const select = $<HTMLSelectElement>("quality");
  QUALITIES.forEach((q, index) => {
    const option = el("option", "", q.label);
    option.value = String(index);
    select.append(option);
  });
  select.value = String(QUALITIES.findIndex(q => q.quality === quality));
  select.onchange = () => {
    quality = QUALITIES[Number(select.value)]!.quality;
    if (current) signal.send({ t: "stream.quality", id: current.streamId, quality });
    $("stage").classList.toggle("is-audio", !quality.video);
  };
}

function fillReactions() {
  for (const emoji of REACTIONS) {
    const button = el("button", "", emoji);
    button.type = "button";
    button.setAttribute("aria-label", `Réagir ${emoji}`);
    button.onclick = () => shown && signal.send({ t: "reaction", streamId: shown, emoji });
    $("reactions").append(button);
  }
}

function floatReaction(emoji: string) {
  const item = el("span", "float", emoji);
  item.style.left = `${6 + Math.random() * 22}%`;
  $("floats").append(item);
  setTimeout(() => item.remove(), 3000);
}

$("unmute").onclick = () => {
  video.muted = false;
  void video.play().catch(() => {});
  $("unmute").hidden = true;
};

$<HTMLInputElement>("volume").oninput = e => {
  video.volume = Number((e.target as HTMLInputElement).value);
  video.muted = false;
};
$("volume").hidden = onPhone;

$("fullscreen").onclick = () => {
  const iosVideo = video as HTMLVideoElement & { webkitEnterFullscreen?: () => void };
  if (document.fullscreenElement) void document.exitFullscreen();
  else if ($("stage").requestFullscreen) void $("stage").requestFullscreen().catch(() => {});
  else iosVideo.webkitEnterFullscreen?.();
};

setInterval(async () => {
  const stats = await current?.stats();
  $("info").textContent = stats?.width ? `${stats.height}p${stats.fps} · ${(stats.kbps / 1000).toFixed(1)} Mb/s` : "";
}, 2000);

// ---------------------------------------------------------------- regarder ensemble

function togetherPosition() {
  if (!together) return 0;
  return together.playing ? together.position + (performance.now() - togetherAt) / 1000 : together.position;
}

function onTogether(next: Together | null) {
  const before = together;
  together = next;
  togetherAt = performance.now();
  if (next && !before && !chosen) show(TOGETHER);
  if (!next && shown === TOGETHER) {
    shown = null;
    playerVideo = "";
    $("stage").classList.remove("is-together");
    frame.removeAttribute("src");
    playerReady = false;
    pickStream();
  }
  if (shown === TOGETHER) syncPlayer();
  renderStreams();
}

const sendPlayer = (message: Record<string, unknown>) => frame.contentWindow?.postMessage({ ...message, spoka: true }, location.origin);

function syncPlayer() {
  if (!together) return;
  if (!frame.getAttribute("src")) frame.src = "/player";
  if (!playerReady) return;
  if (playerVideo !== together.videoId) {
    playerVideo = together.videoId;
    return sendPlayer({ cmd: "load", id: together.videoId, time: togetherPosition(), playing: together.playing });
  }
  sendPlayer({ cmd: together.playing ? "play" : "pause" });
  sendPlayer({ cmd: "seek", time: togetherPosition() });
}

addEventListener("message", event => {
  const message = event.data as { spoka?: boolean; type?: string; time?: number };
  if (event.origin !== location.origin || event.source !== frame.contentWindow || !message?.spoka) return;
  if (message.type === "ready") {
    playerReady = true;
    syncPlayer();
  } else if (message.type === "time" && together && Math.abs((message.time ?? 0) - togetherPosition()) > 1.5 && performance.now() - lastSeek > 3000) {
    lastSeek = performance.now();
    sendPlayer({ cmd: "seek", time: togetherPosition() });
  }
});

// ---------------------------------------------------------------- vocal

function renderVoice() {
  $("voice").textContent = voice ? "Quitter le vocal" : "Rejoindre le vocal";
  $("voice").classList.toggle("is-on", !!voice);
  $("mic").hidden = !voice;
  $("mic").textContent = muted ? "Micro coupé" : "Micro ouvert";
}

function syncVoice() {
  if (!room || !voice?.active) return;
  voice.sync(room.members.filter(m => m.voice && m.id !== userId).map(m => m.id));
}

$("voice").onclick = async () => {
  if (voice) {
    voice.leave();
    voice = null;
    signal.send({ t: "voice.set", voice: null });
    $("voices").replaceChildren();
    return renderVoice();
  }
  const next = new Voice({
    selfId: () => userId,
    iceServers: () => iceServers,
    sendSignal: (to, data) => signal.send({ t: "rtc", to, session: VOICE_SESSION, data }),
    settings: { micId: "default", noiseSuppression: true, echoCancellation: true, autoGain: true, voiceKbps: 48 },
  });
  next.onRemoteTrack = (id, track) => {
    document.querySelector(`[data-voice="${CSS.escape(id)}"]`)?.remove();
    const audio = el("audio");
    audio.dataset.voice = id;
    audio.autoplay = true;
    audio.srcObject = new MediaStream([track]);
    $("voices").append(audio);
  };
  next.onPeerGone = id => document.querySelector(`[data-voice="${CSS.escape(id)}"]`)?.remove();
  try {
    await next.join();
  } catch {
    return setStatus("Le navigateur n'a pas donné accès au micro.");
  }
  voice = next;
  voice.setTransmitting(!muted);
  signal.send({ t: "voice.set", voice: { muted, deafened: false } });
  syncVoice();
  renderVoice();
};

$("mic").onclick = () => {
  muted = !muted;
  voice?.setTransmitting(!muted);
  signal.send({ t: "voice.set", voice: { muted, deafened: false } });
  renderVoice();
};

// ---------------------------------------------------------------- chat

function textNode(text: string) {
  const line = el("div", "text");
  for (const part of text.split(/(https?:\/\/[^\s<]+)/g)) {
    if (!/^https?:\/\//.test(part)) {
      line.append(part);
      continue;
    }
    const link = el("a", "", part);
    link.href = part;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    line.append(link);
  }
  return line;
}

function clipNode(message: ChatMessage) {
  const clip = message.clip!;
  const button = el("button", "clip");
  button.type = "button";
  if (clip.thumb) {
    const image = el("img");
    image.src = clip.thumb;
    image.alt = "";
    button.append(image);
  }
  const label = el("span", "", `▶ ${clip.title} · ${clip.seconds} s · ${Math.max(1, Math.round(clip.bytes / 1e6))} Mo`);
  button.append(label);
  button.onclick = async () => {
    button.disabled = true;
    try {
      const bytes = await clips.fetch(message.authorId, clip.id, clip.bytes, share => (label.textContent = `Réception… ${Math.round(share * 100)} %`));
      openClip(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: "video/mp4" }), clip.title);
      label.textContent = `▶ ${clip.title} · ${clip.seconds} s`;
    } catch (e) {
      label.textContent = (e as Error).message;
    }
    button.disabled = false;
  };
  return button;
}

function openClip(blob: Blob, title: string) {
  const url = URL.createObjectURL(blob);
  const dialog = $("clip-view");
  const player = $<HTMLVideoElement>("clip-video");
  const save = $<HTMLAnchorElement>("clip-save");
  player.src = url;
  save.href = url;
  save.download = `${title.replace(/[^\p{L}\p{N} _-]/gu, "").trim() || "clip"}.mp4`;
  dialog.hidden = false;
  $("clip-close").onclick = () => {
    dialog.hidden = true;
    player.removeAttribute("src");
    player.load();
    URL.revokeObjectURL(url);
  };
}

function messageNode(message: ChatMessage) {
  if (message.kind === "system") return el("div", "system", message.text);
  const node = el("div", "message");
  node.dataset.message = message.id;
  const author = el("b", "", message.authorName);
  author.style.color = message.authorColor;
  node.append(author);
  if (message.clip) node.append(clipNode(message));
  else if (message.text) node.append(textNode(message.text));
  if (message.image) {
    const image = el("img", "picture");
    image.src = message.image;
    image.alt = "";
    node.append(image);
  }
  return node;
}

function addMessage(message: ChatMessage) {
  const list = $("chat-list");
  const follow = list.scrollHeight - list.scrollTop - list.clientHeight < 60;
  list.append(messageNode(message));
  while (list.children.length > 300) list.firstElementChild!.remove();
  if (follow) list.scrollTop = list.scrollHeight;
}

function renderPinned() {
  const pinned = room?.pinned;
  const bar = $("pinned");
  bar.hidden = !pinned;
  bar.textContent = pinned ? `📌 ${pinned.authorName} : ${pinned.text}` : "";
}

function renderPoll(poll: Poll | null) {
  const card = $("poll");
  card.hidden = !poll;
  card.replaceChildren();
  if (!poll) return;
  card.append(el("b", "", poll.question));
  const total = poll.options.reduce((n, o) => n + o.voters.length, 0);
  poll.options.forEach((option, index) => {
    const button = el("button", option.voters.includes(userId) ? "is-on" : "");
    button.type = "button";
    button.disabled = poll.closed;
    const share = total ? Math.round((option.voters.length / total) * 100) : 0;
    button.style.setProperty("--share", `${share}%`);
    button.append(el("span", "", option.text), el("em", "", `${share} %`));
    button.onclick = () => signal.send({ t: "poll.vote", id: poll.id, option: index });
    card.append(button);
  });
}

$<HTMLFormElement>("chat-form").addEventListener("submit", e => {
  e.preventDefault();
  const input = $<HTMLInputElement>("chat-input");
  const text = input.value.trim();
  if (!text) return;
  signal.send({ t: "chat.send", text });
  input.value = "";
});

$("chat-input").addEventListener("input", () => signal.send({ t: "chat.typing" }));

fillQualities();
fillReactions();
renderVoice();
