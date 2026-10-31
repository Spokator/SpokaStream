import { Activity, Camera, Circle, Clapperboard, Eye, EyeOff, Gamepad2, Gauge, Maximize, MousePointer2, Pencil, PictureInPicture2, Radio, Rewind, Scissors, Smile, Square, TvMinimalPlay, Users, Volume2, VolumeX } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { LatencyMode } from "@shared/ipc.ts";
import { DEFAULT_CAMERA_LAYOUT } from "@shared/protocol.ts";
import type { CameraLayout, DrawTool, Member, StreamInfo, ViewerQuality } from "@shared/protocol.ts";
import { core } from "../engine/core.ts";
import { get, set, TOGETHER, useApp } from "../state/store.ts";
import { limitText, mbps, pathText, plural } from "../ui/format.ts";
import { Avatar, Button, IconButton, isTyping, Popover, Slider, Uptime } from "../ui/kit.tsx";
import { StrokeCanvas } from "../ui/strokes.ts";
import { FloatingChat, toggleFullscreen, useFullscreen } from "./FloatingChat.tsx";
import { HandLayer } from "./Hand.tsx";
import { TogetherTile, useCanShare } from "./Together.tsx";

export const REACTIONS = ["🔥", "😂", "😮", "❤️", "👏", "💀", "🎉", "👀"];

const QUALITIES: { label: string; hint: string; quality: Omit<ViewerQuality, "video"> }[] = [
  { label: "Maximum", hint: "Ce que le diffuseur envoie", quality: { maxHeight: 0, maxKbps: 0, maxFps: 0 } },
  { label: "1080p", hint: "12 Mb/s max", quality: { maxHeight: 1080, maxKbps: 12000, maxFps: 0 } },
  { label: "720p", hint: "5 Mb/s max", quality: { maxHeight: 720, maxKbps: 5000, maxFps: 0 } },
  { label: "480p économe", hint: "1,5 Mb/s, 30 i/s", quality: { maxHeight: 480, maxKbps: 1500, maxFps: 30 } },
];

const LATENCIES: { value: LatencyMode; label: string; hint: string }[] = [
  { value: "ultra", label: "Ultra faible", hint: "Le plus réactif, peut saccader" },
  { value: "balanced", label: "Équilibrée", hint: "Le bon compromis" },
  { value: "stable", label: "Stable", hint: "Absorbe une connexion instable" },
];

const MAX_ZOOM = 6;
const AMBIENT_INTERVAL_MS = 200;

function useMember(id: string): Member | undefined {
  return useApp(s => s.room?.members.find(m => m.id === id));
}

function Video({ media, className, videoRef }: { media: MediaStream; className?: string; videoRef?: React.RefObject<HTMLVideoElement | null> }) {
  const own = useRef<HTMLVideoElement>(null);
  const ref = videoRef ?? own;
  useEffect(() => {
    const video = ref.current;
    if (!video || video.srcObject === media) return;
    video.srcObject = media;
    void video.play().catch(() => {});
  }, [media, ref]);
  return <video ref={ref} className={className} autoPlay playsInline muted />;
}

/** Les bandes autour de l'image prennent ses couleurs. Quelques images par seconde dans un minuscule canevas : ça ne coûte rien. */
function Ambient({ video }: { video: React.RefObject<HTMLVideoElement | null> }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const context = canvas.current?.getContext("2d", { willReadFrequently: false });
    if (!context) return;
    const timer = setInterval(() => {
      const element = video.current;
      if (element?.videoWidth) context.drawImage(element, 0, 0, 32, 18);
    }, AMBIENT_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [video]);
  return <canvas ref={canvas} className="tile-ambient" width={32} height={18} aria-hidden />;
}

interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

const cameraStyle = (layout: CameraLayout, box: Box) => ({ left: box.left + layout.x * box.width, top: box.top + layout.y * box.height, width: layout.width * box.width });
const cameraClass = (layout: CameraLayout) => `tile-cam is-${layout.shape} ${layout.mirror ? "is-mirror" : ""}`;

/** Bulle caméra du diffuseur, reçue à côté de l'image : chacun peut la masquer sans rien changer pour les autres. */
function CameraBubble({ media, layout, box }: { media: MediaStream; layout: CameraLayout; box: Box }) {
  const [hidden, setHidden] = useState(false);
  if (hidden) return null;
  return (
    <button type="button" className={cameraClass(layout)} style={cameraStyle(layout, box)} title="Masquer la caméra" onClick={() => setHidden(true)}>
      <Video media={media} />
    </button>
  );
}

/** Sur l'aperçu du diffuseur : glisser pour placer, la poignée pour agrandir. Les spectateurs suivent en direct. */
function CameraEditor({ media, layout, box }: { media: MediaStream; layout: CameraLayout; box: Box }) {
  const gesture = useRef<{ mode: "move" | "size"; x: number; y: number; from: CameraLayout } | null>(null);
  const place = (e: React.PointerEvent, commit: boolean) => {
    const state = gesture.current;
    if (!state || !box.width) return;
    const dx = (e.clientX - state.x) / box.width;
    const dy = (e.clientY - state.y) / box.height;
    const { from } = state;
    const width = state.mode === "size" ? Math.max(0.08, Math.min(0.9, from.width + dx, 1 - from.x)) : from.width;
    const height = ((width * box.width) / box.height) * (from.shape === "circle" ? 1 : 9 / 16);
    const x = state.mode === "move" ? Math.max(0, Math.min(1 - width, from.x + dx)) : from.x;
    const y = state.mode === "move" ? Math.max(0, Math.min(1 - height, from.y + dy)) : Math.min(from.y, 1 - height);
    core.setCameraLayout({ ...from, x, y, width }, commit);
  };
  const begin = (e: React.PointerEvent, mode: "move" | "size") => {
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    gesture.current = { mode, x: e.clientX, y: e.clientY, from: layout };
  };
  const finish = (e: React.PointerEvent) => {
    place(e, true);
    gesture.current = null;
  };
  return (
    <div className={`${cameraClass(layout)} is-editable`} style={cameraStyle(layout, box)} title="Glisse pour placer ta caméra" onPointerDown={e => begin(e, "move")} onPointerMove={e => place(e, false)} onPointerUp={finish}>
      <Video media={media} />
      <span className="tile-cam-handle" aria-label="Redimensionner la caméra" onPointerDown={e => begin(e, "size")} onPointerMove={e => place(e, false)} onPointerUp={finish} />
    </div>
  );
}

function Pill({ stream, paused }: { stream: StreamInfo; paused: boolean }) {
  return (
    <span className="live-pill">
      {paused ? (
        "Pause"
      ) : (
        <>
          En direct · <Uptime since={stream.startedAt} />
        </>
      )}
    </span>
  );
}

/** Zone réellement occupée par l'image dans la tuile : les dessins doivent tomber au même endroit chez tout le monde. */
function useContentBox(video: React.RefObject<HTMLVideoElement | null>) {
  const [box, setBox] = useState({ left: 0, top: 0, width: 0, height: 0 });
  useEffect(() => {
    const element = video.current;
    if (!element) return;
    const measure = () => {
      const vw = element.videoWidth || 16;
      const vh = element.videoHeight || 9;
      const scale = Math.min(element.clientWidth / vw, element.clientHeight / vh);
      const width = vw * scale;
      const height = vh * scale;
      setBox({ left: (element.clientWidth - width) / 2, top: (element.clientHeight - height) / 2, width, height });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    element.addEventListener("resize", measure);
    return () => {
      observer.disconnect();
      element.removeEventListener("resize", measure);
    };
  }, [video]);
  return box;
}

function DrawLayer({ streamId, box, tool, color }: { streamId: string; box: { left: number; top: number; width: number; height: number }; tool: DrawTool | null; color: string }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const layer = useRef<StrokeCanvas | null>(null);
  const drawing = useRef<{ id: string; buffer: number[]; last: number } | null>(null);

  useEffect(() => {
    const strokes = new StrokeCanvas(canvas.current!);
    layer.current = strokes;
    const off = core.onDrawEvent(event => {
      if (event.streamId !== streamId) return;
      if ("clear" in event) strokes.clear();
      else strokes.add(event.stroke.id, event.stroke.tool, event.stroke.color, event.stroke.points, event.stroke.end);
    });
    return () => {
      off();
      strokes.dispose();
    };
  }, [streamId]);

  const flush = (end: boolean) => {
    const state = drawing.current;
    if (!state || !tool || (!state.buffer.length && !end)) return;
    core.sendStroke(streamId, { id: state.id, tool, color, points: state.buffer, end });
    state.buffer = [];
    state.last = performance.now();
  };

  const point = (e: React.PointerEvent) => {
    const rect = e.currentTarget.getBoundingClientRect();
    return [+((e.clientX - rect.left) / rect.width).toFixed(4), +((e.clientY - rect.top) / rect.height).toFixed(4)];
  };

  return (
    <canvas
      ref={canvas}
      className={`draw-layer ${tool ? "is-active" : ""}`}
      style={box}
      onPointerDown={e => {
        if (!tool) return;
        e.currentTarget.setPointerCapture(e.pointerId);
        drawing.current = { id: core.newStrokeId(), buffer: point(e), last: 0 };
        flush(false);
      }}
      onPointerMove={e => {
        if (!drawing.current) return;
        drawing.current.buffer.push(...point(e));
        if (performance.now() - drawing.current.last > 33) flush(false);
      }}
      onPointerUp={() => {
        flush(true);
        drawing.current = null;
      }}
      onPointerCancel={() => {
        flush(true);
        drawing.current = null;
      }}
    />
  );
}

function FloatingReactions({ streamId }: { streamId: string }) {
  const [items, setItems] = useState<{ id: number; emoji: string; left: number; name: string }[]>([]);
  useEffect(() => {
    let next = 0;
    return core.onReactionEvent(event => {
      if (event.streamId !== streamId) return;
      const id = ++next;
      const name = get().room?.members.find(m => m.id === event.from)?.name ?? "";
      setItems(list => [...list.slice(-24), { id, emoji: event.emoji, left: 6 + Math.random() * 22, name }]);
      setTimeout(() => setItems(list => list.filter(i => i.id !== id)), 3000);
    });
  }, [streamId]);
  return (
    <div className="reactions" aria-hidden>
      {items.map(i => (
        <span key={i.id} className="reaction" style={{ left: `${i.left}%` }}>
          {i.emoji}
          <small>{i.name}</small>
        </span>
      ))}
    </div>
  );
}

function openPopout(media: MediaStream, title: string) {
  const child = window.open("", "spoka-popout");
  if (!child) return;
  child.document.title = title;
  const body = child.document.body;
  body.style.cssText = "margin:0;background:#000;overflow:hidden;-webkit-app-region:drag;height:100vh";
  body.replaceChildren();
  const video = child.document.createElement("video");
  video.style.cssText = "width:100%;height:100%;object-fit:contain;display:block";
  video.autoplay = true;
  video.muted = true;
  video.srcObject = media;
  const close = child.document.createElement("button");
  close.textContent = "✕";
  close.title = "Fermer";
  close.style.cssText = "position:fixed;top:6px;right:6px;width:26px;height:26px;border:0;border-radius:7px;background:rgba(0,0,0,.6);color:#fff;font-size:13px;cursor:pointer;-webkit-app-region:no-drag";
  close.onclick = () => child.close();
  body.append(video, close);
  void video.play();
}

function StatsOverlay({ streamId }: { streamId: string }) {
  const stats = useApp(s => s.subs[streamId]?.stats);
  if (!stats) return <div className="stats-card">Connexion…</div>;
  return (
    <div className="stats-card">
      <div>
        <span>Image</span>
        {stats.width}×{stats.height} · {stats.fps} i/s
      </div>
      <div>
        <span>Débit</span>
        {mbps(stats.kbps)} Mb/s · son {stats.audioKbps} kb/s
      </div>
      <div>
        <span>Codec</span>
        {stats.codec}
        {stats.decoder && (stats.hardware ? " matériel" : " logiciel")}
      </div>
      <div>
        <span>Réseau</span>
        {pathText(stats.path)}
      </div>
      <div>
        <span>Pertes</span>
        {stats.lostPct} % · gigue {stats.jitterMs} ms
      </div>
      <div>
        <span>Tampon</span>
        {stats.bufferMs ?? "?"} ms · {plural(stats.freezes, "gel")}
      </div>
    </div>
  );
}

function WatchTile({ stream, focused, primary, onFocus }: { stream: StreamInfo; focused: boolean; primary: boolean; onFocus: () => void }) {
  const sub = useApp(s => s.subs[stream.id]);
  const cinema = useApp(s => s.cinema);
  const ambient = useApp(s => s.settings!.ambient);
  const clipSaving = useApp(s => s.clipSaving);
  const owner = useMember(stream.ownerId);
  const latency = useApp(s => s.settings!.latency);
  const profileColor = useApp(s => s.settings!.profile.color);
  const recording = useApp(s => s.recording?.streamId === stream.id);
  const hand = useApp(s => (s.hand?.streamId === stream.id ? s.hand : null));
  const controllerName = useMember(stream.controller ?? "")?.name;
  const video = useRef<HTMLVideoElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const box = useContentBox(video);
  const [tool, setTool] = useState<DrawTool | null>(null);
  const [showStats, setShowStats] = useState(false);
  const [zoom, setZoom] = useState({ scale: 1, x: 0, y: 0 });
  const fullscreen = useFullscreen(root);
  const pan = useRef<{ x: number; y: number; originX: number; originY: number } | null>(null);

  /** Garde l'image dans le cadre : on ne peut pas la faire sortir en déplaçant le zoom. */
  const applyZoom = (scale: number, x: number, y: number) => {
    const bounds = root.current?.getBoundingClientRect();
    const next = Math.max(1, Math.min(MAX_ZOOM, scale));
    if (!bounds || next === 1) return setZoom({ scale: 1, x: 0, y: 0 });
    const limitX = (bounds.width * (next - 1)) / 2;
    const limitY = (bounds.height * (next - 1)) / 2;
    setZoom({ scale: next, x: Math.max(-limitX, Math.min(limitX, x)), y: Math.max(-limitY, Math.min(limitY, y)) });
  };

  const onWheel = (e: WheelEvent) => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    const bounds = root.current!.getBoundingClientRect();
    setZoom(current => {
      const scale = Math.max(1, Math.min(MAX_ZOOM, current.scale * (e.deltaY < 0 ? 1.2 : 1 / 1.2)));
      // Le point sous la souris reste sous la souris.
      const ratio = scale / current.scale;
      const pointerX = e.clientX - bounds.left - bounds.width / 2;
      const pointerY = e.clientY - bounds.top - bounds.height / 2;
      const limitX = (bounds.width * (scale - 1)) / 2;
      const limitY = (bounds.height * (scale - 1)) / 2;
      if (scale === 1) return { scale: 1, x: 0, y: 0 };
      return {
        scale,
        x: Math.max(-limitX, Math.min(limitX, pointerX - (pointerX - current.x) * ratio)),
        y: Math.max(-limitY, Math.min(limitY, pointerY - (pointerY - current.y) * ratio)),
      };
    });
  };
  const wheelHandler = useRef(onWheel);
  wheelHandler.current = onWheel;

  // React branche la molette en passif : sans écouteur à nous, impossible d'empêcher le défilement.
  useLayoutEffect(() => {
    const element = root.current;
    if (!element) return;
    const listener = (e: WheelEvent) => wheelHandler.current(e);
    element.addEventListener("wheel", listener, { passive: false });
    return () => element.removeEventListener("wheel", listener);
  }, [!sub]);

  useEffect(() => {
    if (!primary) return;
    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e) || get().hand?.state === "granted") return;
      const view = get().subs[stream.id];
      if (!view) return;
      const key = e.key.toLowerCase();
      if (key === "m") core.setSubMuted(stream.id, !view.muted);
      else if (key === "f") toggleFullscreen(root.current);
      else if (key === "i") setShowStats(on => !on);
      else if (key === "arrowup") core.setSubVolume(stream.id, Math.min(3, view.volume + 0.1));
      else if (key === "arrowdown") core.setSubVolume(stream.id, Math.max(0, view.volume - 0.1));
      else if (key === "+" || key === "=") setZoom(z => ({ ...z, scale: Math.min(MAX_ZOOM, z.scale * 1.25) }));
      else if (key === "-") applyZoom(zoom.scale / 1.25, zoom.x, zoom.y);
      else if (key === "0") setZoom({ scale: 1, x: 0, y: 0 });
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [primary, stream.id, zoom]);

  if (!sub) return null;

  const hasNoVideo = !sub.quality.video;
  const sendQuality = (quality: Omit<ViewerQuality, "video">) => core.setSubQuality(stream.id, { ...quality, video: sub.quality.video });
  const qualityIndex = QUALITIES.findIndex(q => q.quality.maxHeight === sub.quality.maxHeight);
  const statusText = sub.state === "connecting" ? "Connexion au stream…" : sub.state === "unstable" ? "Connexion instable…" : sub.state === "failed" ? "Reconnexion…" : null;

  return (
    <div
      className={`tile ${focused ? "is-focused" : ""} ${zoom.scale > 1 ? "is-zoomed" : ""} ${hand?.state === "granted" ? "is-hand" : ""}`}
      ref={root}
      onDoubleClick={() => toggleFullscreen(root.current)}
      onPointerDown={e => {
        if (zoom.scale === 1 || tool || (e.target as HTMLElement).closest("button, input, .tile-bar")) return;
        e.currentTarget.setPointerCapture(e.pointerId);
        pan.current = { x: e.clientX, y: e.clientY, originX: zoom.x, originY: zoom.y };
      }}
      onPointerMove={e => {
        if (pan.current) applyZoom(zoom.scale, pan.current.originX + e.clientX - pan.current.x, pan.current.originY + e.clientY - pan.current.y);
      }}
      onPointerUp={() => (pan.current = null)}
    >
      {ambient && (focused || fullscreen) && <Ambient video={video} />}
      <div className="tile-canvas" style={zoom.scale > 1 ? { transform: `translate(${zoom.x}px, ${zoom.y}px) scale(${zoom.scale})` } : undefined}>
        <Video media={sub.media} videoRef={video} className="tile-video" />
        <DrawLayer streamId={stream.id} box={box} tool={stream.allowDraw ? tool : null} color={profileColor} />
        {stream.camera && !hasNoVideo && <CameraBubble media={sub.camera} layout={stream.cameraLayout ?? DEFAULT_CAMERA_LAYOUT} box={box} />}
        {stream.banner && !hasNoVideo && <div className="tile-banner">{stream.banner}</div>}
      </div>
      {hasNoVideo && (
        <div className="tile-audio-only">
          <Avatar name={owner?.name ?? "?"} color={owner?.color} src={owner?.avatar} size={72} />
          <span>Son seul</span>
        </div>
      )}
      <FloatingReactions streamId={stream.id} />
      {statusText && <div className="tile-status">{statusText}</div>}
      {(fullscreen || (cinema && primary)) && <FloatingChat />}
      {hand?.state === "granted" && <HandLayer box={box} blocked={hand.blocked} ownerName={owner?.name ?? "Le diffuseur"} />}

      <div className="tile-top">
        <Pill stream={stream} paused={stream.paused} />
        <span className="tile-title">
          <b>{owner?.name ?? "?"}</b>
          {stream.title && <span>{stream.title}</span>}
        </span>
        <span className="tile-chip" title={stream.viewers.map(id => get().room?.members.find(m => m.id === id)?.name ?? "?").join(", ")}>
          <Users size={12} />
          {stream.viewers.length}
        </span>
        {zoom.scale > 1 && (
          <button type="button" className="tile-chip is-button" title="Enlever le zoom" onClick={() => setZoom({ scale: 1, x: 0, y: 0 })}>
            Zoom {Math.round(zoom.scale * 100)} %
          </button>
        )}
        {recording && (
          <span className="tile-chip is-rec">
            <Circle size={9} fill="currentColor" /> REC
          </span>
        )}
        {controllerName && hand?.state !== "granted" && (
          <span className="tile-chip">
            <Gamepad2 size={12} /> {controllerName} a la main
          </span>
        )}
        <span className="tile-spacer" />
        {sub.stats && (
          <span className="tile-chip">
            {sub.stats.height}p{sub.stats.fps} · {mbps(sub.stats.kbps)} Mb/s
          </span>
        )}
      </div>
      {showStats && <StatsOverlay streamId={stream.id} />}

      <div className="tile-bar">
        <div className="tile-bar-group">
          <IconButton label={sub.muted ? "Remettre le son" : "Couper le son"} onClick={() => core.setSubMuted(stream.id, !sub.muted)}>
            {sub.muted ? <VolumeX size={18} /> : <Volume2 size={18} />}
          </IconButton>
          <Slider label="Volume du stream" className="tile-volume" value={sub.muted ? 0 : sub.volume} min={0} max={3} step={0.05} onChange={v => core.setSubVolume(stream.id, v)} />
          <span className="tile-percent">{Math.round((sub.muted ? 0 : sub.volume) * 100)} %</span>
        </div>

        <div className="tile-bar-group tile-reactions">
          <Popover
            up
            trigger={(open, toggle) => (
              <IconButton label="Réagir" active={open} onClick={toggle}>
                <Smile size={18} />
              </IconButton>
            )}
          >
            {close => (
              <div className="reaction-grid">
                {REACTIONS.map(e => (
                  <button
                    key={e}
                    type="button"
                    onClick={event => {
                      core.react(stream.id, e);
                      if (!event.shiftKey) close();
                    }}
                  >
                    {e}
                  </button>
                ))}
              </div>
            )}
          </Popover>
          {stream.allowDraw && (
            <>
              <IconButton label="Pointeur laser : montre quelque chose à l'écran" active={tool === "laser"} onClick={() => setTool(tool === "laser" ? null : "laser")}>
                <MousePointer2 size={18} />
              </IconButton>
              <IconButton label="Dessiner sur le stream" active={tool === "pen"} onClick={() => setTool(tool === "pen" ? null : "pen")}>
                <Pencil size={18} />
              </IconButton>
            </>
          )}
        </div>

        <div className="tile-bar-group">
          {stream.allowControl && !stream.controller && !stream.paused && (
            <IconButton label={hand ? "Demande envoyée" : "Demander la main : jouer à sa place"} active={!!hand} disabled={!!hand} onClick={() => core.askControl(stream.id)}>
              <Gamepad2 size={18} />
            </IconButton>
          )}
          <Popover
            up
            align="right"
            trigger={(open, toggle) => (
              <IconButton label="Qualité et latence" active={open} onClick={toggle}>
                <Gauge size={18} />
              </IconButton>
            )}
          >
            {close => (
              <div className="menu">
                <div className="menu-title">Qualité pour moi</div>
                {QUALITIES.map((q, i) => (
                  <button
                    key={q.label}
                    type="button"
                    className={`menu-item ${i === qualityIndex ? "is-on" : ""}`}
                    onClick={() => {
                      sendQuality(q.quality);
                      close();
                    }}
                  >
                    <span>{q.label}</span>
                    <small>{q.hint}</small>
                  </button>
                ))}
                <button
                  type="button"
                  className={`menu-item ${hasNoVideo ? "is-on" : ""}`}
                  onClick={() => {
                    core.setSubQuality(stream.id, { ...sub.quality, video: hasNoVideo });
                    close();
                  }}
                >
                  <span>Son seul</span>
                  <small>Le diffuseur cesse d'envoyer l'image</small>
                </button>
                <div className="menu-title">Latence</div>
                {LATENCIES.map(l => (
                  <button
                    key={l.value}
                    type="button"
                    className={`menu-item ${l.value === latency ? "is-on" : ""}`}
                    onClick={() => {
                      core.setLatency(l.value);
                      close();
                    }}
                  >
                    <span>{l.label}</span>
                    <small>{l.hint}</small>
                  </button>
                ))}
              </div>
            )}
          </Popover>
          <IconButton label="Statistiques" active={showStats} onClick={() => setShowStats(!showStats)}>
            <Activity size={18} />
          </IconButton>
          <IconButton label="Capture d'écran" onClick={() => video.current && void core.screenshot(video.current, owner?.name ?? "stream")}>
            <Camera size={18} />
          </IconButton>
          <IconButton label="Revoir les dernières secondes" disabled={clipSaving} onClick={() => void core.replay()}>
            <Rewind size={18} />
          </IconButton>
          <IconButton label="Garder un clip des dernières secondes" disabled={clipSaving} onClick={() => void core.saveClip()}>
            <Scissors size={18} />
          </IconButton>
          <IconButton label={recording ? "Arrêter l'enregistrement" : "Enregistrer ce stream"} active={recording} onClick={() => void (recording ? core.stopRecording() : core.recordWatching(stream.id))}>
            {recording ? <Square size={16} /> : <Circle size={17} />}
          </IconButton>
          <IconButton label={cinema ? "Quitter le mode cinéma" : "Mode cinéma"} active={cinema} onClick={() => set({ cinema: !cinema })}>
            <Clapperboard size={18} />
          </IconButton>
          <IconButton label="Fenêtre flottante, toujours au-dessus" onClick={() => openPopout(sub.media, owner?.name ?? "Stream")}>
            <PictureInPicture2 size={18} />
          </IconButton>
          {!focused && (
            <IconButton label="Mettre en grand" onClick={onFocus}>
              <Eye size={18} />
            </IconButton>
          )}
          <IconButton label="Ne plus regarder" onClick={() => core.unwatch(stream.id)}>
            <EyeOff size={18} />
          </IconButton>
          <IconButton label="Plein écran" onClick={() => toggleFullscreen(root.current)}>
            <Maximize size={18} />
          </IconButton>
        </div>
      </div>
    </div>
  );
}

function OwnTile({ stream, focused, primary }: { stream: StreamInfo; focused: boolean; primary: boolean }) {
  const publish = useApp(s => s.publish);
  const cinema = useApp(s => s.cinema);
  const controllerName = useMember(publish?.controller ?? "")?.name;
  const video = useRef<HTMLVideoElement>(null);
  const box = useContentBox(video);
  if (!publish) return null;
  const stats = publish.stats;
  return (
    <div className={`tile tile-own ${focused ? "is-focused" : ""}`}>
      <Video media={publish.preview} videoRef={video} className="tile-video" />
      {publish.paused && <div className="tile-status">Stream en pause : les spectateurs ne voient plus ton écran</div>}
      <DrawLayer streamId={stream.id} box={box} tool={null} color="#ffffff" />
      <FloatingReactions streamId={stream.id} />
      {publish.camera && <CameraEditor media={publish.camera} layout={publish.cameraLayout} box={box} />}
      {publish.banner && <div className="tile-banner">{publish.banner}</div>}
      {cinema && primary && <FloatingChat />}
      <div className="tile-top">
        <Pill stream={stream} paused={publish.paused} />
        <span className="tile-title">
          <b>Ton stream</b>
          <span>{stream.title || publish.sourceName}</span>
        </span>
        <span className="tile-chip">
          <Users size={12} />
          {stream.viewers.length}
        </span>
        {controllerName && (
          <span className="tile-chip">
            <Gamepad2 size={12} /> {controllerName} a la main
          </span>
        )}
        <span className="tile-spacer" />
        {stats && (
          <span className="tile-chip">
            {stats.height}p{stats.fps} · {mbps(stats.kbps)} Mb/s · {stats.codec}
          </span>
        )}
      </div>
      {stats && limitText(stats.limit) && <div className="tile-warning">{limitText(stats.limit)}</div>}
    </div>
  );
}

function StreamCard({ stream, onWatch }: { stream: StreamInfo; onWatch: () => void }) {
  const owner = useMember(stream.ownerId);
  return (
    <button type="button" className="stream-card" onClick={onWatch}>
      {stream.thumb ? <img src={stream.thumb} alt="" /> : <div className="stream-card-empty" />}
      <span className="stream-card-shade" />
      <Pill stream={stream} paused={stream.paused} />
      <span className="stream-card-info">
        <Avatar name={owner?.name ?? "?"} color={owner?.color} src={owner?.avatar} size={26} />
        <span>
          <b>{owner?.name ?? "?"}</b>
          <small>
            {stream.title || stream.sourceName} · {plural(stream.viewers.length, "spectateur")}
          </small>
        </span>
      </span>
      <span className="stream-card-cta">Regarder</span>
    </button>
  );
}

function EmptyStage() {
  const canStream = useCanShare();
  const code = useApp(s => s.room!.code);
  return (
    <div className="stage-empty">
      <div className="stage-empty-icon">
        <Radio size={30} />
      </div>
      <h2>Personne ne diffuse pour l'instant</h2>
      <p>Partage ton écran, une fenêtre, une caméra ou un fichier vidéo, avec le son de l'application de ton choix.</p>
      {canStream && (
        <div className="stage-empty-actions">
          <Button variant="live" icon={<Radio size={18} />} onClick={() => set({ goLiveOpen: true })}>
            Lancer un stream
          </Button>
          <Button icon={<TvMinimalPlay size={17} />} onClick={() => set({ dialog: "together" })}>
            Regarder YouTube ensemble
          </Button>
        </div>
      )}
      <p className="stage-empty-code">
        Code du salon : <b>{code}</b>
      </p>
    </div>
  );
}

export function Stage({ layout }: { layout: "focus" | "grid" }) {
  const streams = useApp(s => s.room!.streams);
  const subs = useApp(s => s.subs);
  const userId = useApp(s => s.userId);
  const focusedId = useApp(s => s.focused);
  const publishId = useApp(s => s.publish?.streamId);
  const together = useApp(s => !!s.room!.together);

  if (!streams.length && !together) return <section className="stage"><EmptyStage /></section>;

  const isShown = (s: StreamInfo) => s.ownerId === userId || !!subs[s.id];
  const shown = streams.filter(s => isShown(s) && (s.ownerId !== userId || s.id === publishId));
  const others = streams.filter(s => !isShown(s));
  const main = shown.find(s => s.id === focusedId) ?? shown.find(s => s.ownerId !== userId) ?? shown[0];
  const focus = (id: string) => set({ focused: id });
  const togetherFirst = together && (focusedId === TOGETHER || !main);

  const tile = (stream: StreamInfo, focused: boolean, primary: boolean) =>
    stream.ownerId === userId ? <OwnTile key={stream.id} stream={stream} focused={focused} primary={primary} /> : <WatchTile key={stream.id} stream={stream} focused={focused} primary={primary} onFocus={() => focus(stream.id)} />;

  if (layout === "grid" || (!main && !together)) {
    return (
      <section className={`stage stage-grid n${Math.min(streams.length + Number(together), 6)}`}>
        {together && <TogetherTile focused={false} primary onFocus={() => focus(TOGETHER)} />}
        {shown.map((s, i) => tile(s, false, i === 0 && !together))}
        {others.map(s => (
          <StreamCard key={s.id} stream={s} onWatch={() => void core.watch(s.id)} />
        ))}
      </section>
    );
  }

  const rest = shown.filter(s => togetherFirst || s !== main);
  return (
    <section className="stage stage-focus">
      <div className="stage-main">{togetherFirst ? <TogetherTile focused primary onFocus={() => {}} /> : tile(main!, true, true)}</div>
      {rest.length + others.length + Number(together && !togetherFirst) > 0 && (
        <div className="stage-strip">
          {together && !togetherFirst && (
            <div className="strip-item">
              <TogetherTile focused={false} primary={false} onFocus={() => focus(TOGETHER)} />
            </div>
          )}
          {rest.map(s => (
            <div key={s.id} className="strip-item" onClick={() => focus(s.id)}>
              {tile(s, false, false)}
            </div>
          ))}
          {others.map(s => (
            <div key={s.id} className="strip-item">
              <StreamCard stream={s} onWatch={() => void core.watch(s.id)} />
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
