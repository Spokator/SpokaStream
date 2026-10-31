/** @jsxImportSource preact */
import { Camera, Captions, Gauge, Maximize, MessageSquare, Minimize, MousePointer2, Pause, PictureInPicture2, Play, Radio, RotateCcw, RotateCw, SkipForward, Square, Users, Volume2, VolumeX } from "lucide-preact";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { DEFAULT_CAMERA_LAYOUT } from "@shared/protocol.ts";
import { StrokeCanvas } from "../src/renderer/src/ui/strokes.ts";
import type { StrokeEvent } from "./client.ts";
import { audioOnly, camera, canShare, capture, frame, loadSubtitles, nameOf, newStrokeId, playerClock, react, REACTIONS, sendStroke, setTogetherVolume, streamShown, strokes, tapped, togetherPlay, togetherPosition, togetherSeek, togetherSkip, togetherSkipBy, togetherStop, video } from "./client.ts";
import { get, set, TOGETHER, useApp } from "./store.ts";

const HIDE_MS = 3500;
const MAX_ZOOM = 5;
const TAP_MS = 260;
const TAP_MOVE = 12;
const STROKE_MS = 40;

const pipSupported = () => document.pictureInPictureEnabled || "webkitSetPresentationMode" in video;

function togglePip() {
  const ios = video as HTMLVideoElement & { webkitSetPresentationMode?: (mode: string) => void };
  if (document.pictureInPictureElement) return void document.exitPictureInPicture();
  if (video.requestPictureInPicture) return void video.requestPictureInPicture().catch(() => {});
  ios.webkitSetPresentationMode?.("picture-in-picture");
}

/**
 * Le plein écran porte sur toute la page, jamais sur la vidéo : le lecteur natif du téléphone la met en pause en sortant,
 * et le chat doit rester à portée. Un iPhone n'a pas ce plein écran : la page occupe alors tout ce qu'elle peut.
 */
export async function toggleFullscreen() {
  const { fullscreen, immersive } = get();
  if (fullscreen) return void document.exitFullscreen();
  if (immersive) return set({ immersive: false, chatOpen: false });
  const root = document.documentElement;
  const entered = root.requestFullscreen ? await root.requestFullscreen({ navigationUI: "hide" }).then(() => true, () => false) : false;
  if (!entered) return set({ immersive: true });
  const orientation = screen.orientation as ScreenOrientation & { lock?: (type: string) => Promise<void> };
  await orientation.lock?.("landscape").catch(() => {});
}

function Uptime({ since }: { since: number }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const seconds = Math.max(0, Math.floor((now - since) / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = String(Math.floor((seconds % 3600) / 60)).padStart(hours ? 2 : 1, "0");
  return <>{`${hours ? `${hours}:` : ""}${minutes}:${String(seconds % 60).padStart(2, "0")}`}</>;
}

const mmss = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;

function TogetherBar() {
  const together = useApp(s => s.room?.together ?? null);
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => {
      setPosition(togetherPosition());
      setDuration(playerClock().duration);
    }, 500);
    return () => clearInterval(timer);
  }, []);
  if (!together) return null;
  const allowed = canShare();
  return (
    <div class="together-bar">
      <div class="together-title">
        <b>{together.title}</b>
        <small>
          Ajoutée par {together.byName}
          {together.queue.length > 0 && ` · ${together.queue.length} à suivre`}
        </small>
      </div>
      {allowed && (
        <div class="together-actions">
          <button type="button" class="round" aria-label={together.playing ? "Mettre en pause pour le salon" : "Reprendre pour le salon"} onClick={() => togetherPlay(!together.playing)}>
            {together.playing ? <Pause size={18} /> : <Play size={18} />}
          </button>
          <button type="button" class="round" aria-label="Reculer de 10 secondes" onClick={() => togetherSkipBy(-10)}>
            <RotateCcw size={17} />
          </button>
          <button type="button" class="round" aria-label="Avancer de 10 secondes" onClick={() => togetherSkipBy(10)}>
            <RotateCw size={17} />
          </button>
          <input type="range" aria-label="Position dans la vidéo" min={0} max={Math.max(1, Math.floor(duration))} value={Math.floor(position)} onChange={e => togetherSeek(Number(e.currentTarget.value))} />
          <span class="together-time">
            {mmss(position)} / {mmss(duration)}
          </span>
          <button type="button" class="round" aria-label="Vidéo suivante" onClick={togetherSkip}>
            <SkipForward size={18} />
          </button>
          <button type="button" class="round" aria-label="Arrêter pour le salon" onClick={togetherStop}>
            <Square size={16} />
          </button>
        </div>
      )}
    </div>
  );
}

export function Player() {
  const shown = useApp(s => s.shown);
  const status = useApp(s => s.status);
  const needsTap = useApp(s => s.needsTap);
  const floats = useApp(s => s.floats);
  const stats = useApp(s => s.stats);
  const chatOpen = useApp(s => s.chatOpen);
  const full = useApp(s => s.fullscreen || s.immersive);
  const streams = useApp(s => s.room?.streams);
  const stream = streamShown();
  const [controls, setControls] = useState(true);
  const [muted, setMuted] = useState(false);
  const [level, setLevel] = useState(100);
  const partyFile = useApp(s => s.shown === TOGETHER && !!s.room?.together?.url);
  const subtitleFile = useRef<HTMLInputElement>(null);
  const [zoom, setZoom] = useState({ scale: 1, x: 0, y: 0 });
  const [box, setBox] = useState({ left: 0, top: 0, width: 0, height: 0 });
  const [laser, setLaser] = useState(false);
  const stage = useRef<HTMLDivElement>(null);
  const videoHost = useRef<HTMLDivElement>(null);
  const cameraHost = useRef<HTMLDivElement>(null);
  const frameHost = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const pointers = useRef(new Map<number, { x: number; y: number; startX: number; startY: number; at: number }>());
  const pinch = useRef<{ distance: number; scale: number } | null>(null);
  const pan = useRef<{ x: number; y: number } | null>(null);
  const lastTap = useRef(0);
  const stroke = useRef<{ id: string; buffer: number[]; sent: number } | null>(null);
  const isTogether = shown === TOGETHER;

  useLayoutEffect(() => {
    videoHost.current!.append(video);
    cameraHost.current!.append(camera);
    frameHost.current!.append(frame);
  }, []);

  useEffect(() => {
    const measure = () => {
      const element = stage.current;
      if (!element) return;
      const vw = video.videoWidth || 16;
      const vh = video.videoHeight || 9;
      const scale = Math.min(element.clientWidth / vw, element.clientHeight / vh);
      const width = vw * scale;
      const height = vh * scale;
      setBox({ left: (element.clientWidth - width) / 2, top: (element.clientHeight - height) / 2, width, height });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(stage.current!);
    video.addEventListener("resize", measure);
    return () => {
      observer.disconnect();
      video.removeEventListener("resize", measure);
    };
  }, []);

  useEffect(() => {
    const layer = new StrokeCanvas(canvas.current!);
    const listener = (event: StrokeEvent) => {
      if ("clear" in event) layer.clear();
      else layer.add(event.stroke.id, event.stroke.tool, event.stroke.color, event.stroke.points, event.stroke.end);
    };
    strokes.add(listener);
    return () => {
      strokes.delete(listener);
      layer.dispose();
    };
  }, []);

  const showControls = () => {
    setControls(true);
    clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => setControls(false), HIDE_MS);
  };

  // En mode pointeur, toucher l'image dessine : sans ce bandeau, plus aucun geste ne ramènerait les commandes pour en sortir.
  const leaveLaser = () => {
    setLaser(false);
    showControls();
  };

  useEffect(() => {
    showControls();
    return () => clearTimeout(hideTimer.current);
  }, [shown]);

  const clampZoom = (scale: number, x: number, y: number) => {
    const element = stage.current!;
    const next = Math.max(1, Math.min(MAX_ZOOM, scale));
    if (next === 1) return { scale: 1, x: 0, y: 0 };
    const limitX = (element.clientWidth * (next - 1)) / 2;
    const limitY = (element.clientHeight * (next - 1)) / 2;
    return { scale: next, x: Math.max(-limitX, Math.min(limitX, x)), y: Math.max(-limitY, Math.min(limitY, y)) };
  };

  const pointOnImage = (e: PointerEvent) => {
    const rect = canvas.current!.getBoundingClientRect();
    return [+((e.clientX - rect.left) / rect.width).toFixed(4), +((e.clientY - rect.top) / rect.height).toFixed(4)];
  };

  const flushStroke = (end: boolean) => {
    const state = stroke.current;
    if (!state || (!state.buffer.length && !end)) return;
    sendStroke(state.buffer, state.id, end, get().color);
    for (const listener of strokes) listener({ stroke: { id: state.id, tool: "laser", color: get().color, points: state.buffer, end } });
    state.buffer = [];
    state.sent = performance.now();
  };

  const onDown = (e: PointerEvent) => {
    if ((e.target as HTMLElement).closest("button, input, select, a")) return;
    stage.current!.setPointerCapture(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY, startX: e.clientX, startY: e.clientY, at: performance.now() });
    const list = [...pointers.current.values()];
    if (list.length === 2) {
      pinch.current = { distance: Math.hypot(list[0]!.x - list[1]!.x, list[0]!.y - list[1]!.y), scale: zoom.scale };
      stroke.current = null;
    } else if (laser && !isTogether) {
      stroke.current = { id: newStrokeId(), buffer: pointOnImage(e), sent: 0 };
      flushStroke(false);
    } else if (zoom.scale > 1) {
      pan.current = { x: zoom.x - e.clientX, y: zoom.y - e.clientY };
    }
  };

  const onMove = (e: PointerEvent) => {
    const pointer = pointers.current.get(e.pointerId);
    if (!pointer) return;
    pointer.x = e.clientX;
    pointer.y = e.clientY;
    const list = [...pointers.current.values()];
    if (pinch.current && list.length === 2) {
      const distance = Math.hypot(list[0]!.x - list[1]!.x, list[0]!.y - list[1]!.y);
      setZoom(z => clampZoom((pinch.current!.scale * distance) / pinch.current!.distance, z.x, z.y));
    } else if (stroke.current) {
      stroke.current.buffer.push(...pointOnImage(e));
      if (performance.now() - stroke.current.sent > STROKE_MS) flushStroke(false);
    } else if (pan.current) {
      setZoom(z => clampZoom(z.scale, pan.current!.x + e.clientX, pan.current!.y + e.clientY));
    }
  };

  const onUp = (e: PointerEvent) => {
    const pointer = pointers.current.get(e.pointerId);
    pointers.current.delete(e.pointerId);
    if (pointers.current.size < 2) pinch.current = null;
    pan.current = null;
    if (stroke.current) {
      flushStroke(true);
      stroke.current = null;
      return;
    }
    if (!pointer || performance.now() - pointer.at > TAP_MS || Math.hypot(e.clientX - pointer.startX, e.clientY - pointer.startY) > TAP_MOVE) return;
    const now = performance.now();
    if (now - lastTap.current < 300) {
      lastTap.current = 0;
      return setZoom(z => (z.scale > 1 ? { scale: 1, x: 0, y: 0 } : clampZoom(2.2, 0, 0)));
    }
    lastTap.current = now;
    if (needsTap) tapped();
    if (controls) {
      clearTimeout(hideTimer.current);
      setControls(false);
    } else {
      showControls();
    }
  };

  const layout = stream?.cameraLayout ?? DEFAULT_CAMERA_LAYOUT;
  const zoomed = zoom.scale > 1;

  return (
    <div class={`stage ${controls ? "shows-controls" : ""} ${isTogether ? "is-together" : ""} ${audioOnly() ? "is-audio" : ""} ${laser ? "is-laser" : ""}`} ref={stage} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}>
      <div class="canvas" style={zoomed ? { transform: `translate(${zoom.x}px, ${zoom.y}px) scale(${zoom.scale})` } : undefined}>
        <div class="video-host" ref={videoHost} />
        {/* Preact 11 n'ajoute plus px aux nombres : sans unité, ce calque n'aurait aucune taille. */}
        <div class="layers" style={{ left: `${box.left}px`, top: `${box.top}px`, width: `${box.width}px`, height: `${box.height}px` }}>
          <canvas ref={canvas} class="strokes" />
          <div ref={cameraHost} hidden={!stream?.camera || audioOnly()} class={`camera-host is-${layout.shape} ${layout.mirror ? "is-mirror" : ""}`} style={{ left: `${layout.x * 100}%`, top: `${layout.y * 100}%`, width: `${layout.width * 100}%` }} />
          {stream?.banner && !audioOnly() && <div id="banner">{stream.banner}</div>}
        </div>
      </div>
      <div class="frame-host" ref={frameHost} />
      {audioOnly() && !isTogether && <div class="audio-only">Son seul</div>}
      {status && <div class="status">{status}</div>}
      {needsTap && (
        <button type="button" class="tap-button" onClick={tapped}>
          {needsTap === "son" ? "Toucher pour activer le son" : "Toucher pour reprendre"}
        </button>
      )}
      <div class="floats" aria-hidden="true">
        {floats.map(f => (
          <span key={f.id} class="float" style={{ left: `${f.left}%` }}>
            {f.emoji}
          </span>
        ))}
      </div>

      {laser && (
        <div class="laser-bar">
          <MousePointer2 size={15} />
          <span>Glisse le doigt sur l'image</span>
          <button type="button" onClick={leaveLaser}>
            Terminer
          </button>
        </div>
      )}

      {!isTogether && (
        <div class="controls-top">
          {stream && (
            <>
              <span class="live-chip">
                {stream.paused ? (
                  "Pause"
                ) : (
                  <>
                    <Radio size={12} /> <Uptime since={stream.startedAt} />
                  </>
                )}
              </span>
              <span class="top-title">
                <b>{nameOf(stream.ownerId)}</b>
                {stream.title && <small>{stream.title}</small>}
              </span>
              <span class="chip">
                <Users size={12} /> {stream.viewers.length}
              </span>
              {stats?.height ? (
                <span class="chip is-stats">
                  {stats.height}p{stats.fps}
                  {stats.relay ? " · relais" : ""}
                </span>
              ) : null}
            </>
          )}
          {zoomed && (
            <button type="button" class="chip is-button" onClick={() => setZoom({ scale: 1, x: 0, y: 0 })}>
              Zoom {Math.round(zoom.scale * 100)} %
            </button>
          )}
        </div>
      )}

      {isTogether && <TogetherBar />}

      <div class="controls-bottom">
        <button
          type="button"
          class="round"
          aria-label={muted ? "Remettre le son" : "Couper le son"}
          onClick={() => {
            const next = !muted;
            video.muted = next;
            setMuted(next);
            setTogetherVolume(next ? 0 : level);
            showControls();
          }}
        >
          {muted ? <VolumeX size={19} /> : <Volume2 size={19} />}
        </button>
        <input
          class="volume"
          type="range"
          min={0}
          max={100}
          step={5}
          value={level}
          aria-label="Volume"
          onInput={e => {
            const value = Number(e.currentTarget.value);
            setLevel(value);
            video.volume = value / 100;
            setTogetherVolume(value);
          }}
        />
        <div class="reactions-inline">
          {REACTIONS.slice(0, 4).map(emoji => (
            <button key={emoji} type="button" aria-label={`Réagir ${emoji} sur l'image`} onClick={() => (react(emoji), showControls())}>
              {emoji}
            </button>
          ))}
        </div>
        <span class="spacer" />
        {partyFile && (
          <>
            <input ref={subtitleFile} type="file" accept=".srt,.vtt" hidden onChange={e => {
              const picked = e.currentTarget.files?.[0];
              if (picked) void loadSubtitles(picked);
              e.currentTarget.value = "";
            }} />
            <button type="button" class="round" aria-label="Mes sous-titres : un fichier .srt ou .vtt, pour toi seulement" onClick={() => subtitleFile.current?.click()}>
              <Captions size={18} />
            </button>
          </>
        )}
        {stream?.allowDraw && !isTogether && (
          <button type="button" class={`round ${laser ? "is-on" : ""}`} aria-label="Pointeur laser : montre quelque chose avec ton doigt" aria-pressed={laser} onClick={() => (laser ? leaveLaser() : setLaser(true))}>
            <MousePointer2 size={18} />
          </button>
        )}
        {!isTogether && (
          <button type="button" class="round" aria-label="Capture de l'image, à envoyer au chat" onClick={() => void capture()}>
            <Camera size={18} />
          </button>
        )}
        {pipSupported() && !isTogether && (
          <button type="button" class="round" aria-label="Petite fenêtre, pour faire autre chose en regardant" onClick={togglePip}>
            <PictureInPicture2 size={18} />
          </button>
        )}
        {!isTogether && (
          <button type="button" class="round" aria-label="Qualité" onClick={() => set({ sheet: "quality" })}>
            <Gauge size={18} />
          </button>
        )}
        <button type="button" class={`round show-chat ${chatOpen ? "is-on" : ""}`} aria-label={chatOpen ? "Masquer le chat" : "Afficher le chat"} onClick={() => set(s => ({ chatOpen: !s.chatOpen }))}>
          <MessageSquare size={18} />
        </button>
        <button type="button" class="round" aria-label={full ? "Quitter le plein écran" : "Plein écran"} onClick={() => void toggleFullscreen()}>
          {full ? <Minimize size={18} /> : <Maximize size={18} />}
        </button>
      </div>
      {!streams?.length && !isTogether && !status && <div class="status">Personne ne diffuse pour l'instant.</div>}
    </div>
  );
}
