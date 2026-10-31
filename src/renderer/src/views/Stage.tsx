import { Activity, Camera, Circle, Eye, EyeOff, Gauge, Maximize, MousePointer2, Pencil, PictureInPicture2, Radio, Smile, Square, Users, Volume2, VolumeX } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { LatencyMode } from "@shared/ipc.ts";
import type { DrawTool, Member, StreamInfo, ViewerQuality } from "@shared/protocol.ts";
import { core } from "../engine/core.ts";
import { get, set, useApp } from "../state/store.ts";
import { limitText, mbps, pathText, plural } from "../ui/format.ts";
import { Avatar, Button, IconButton, Popover, Slider } from "../ui/kit.tsx";
import { StrokeCanvas } from "../ui/strokes.ts";

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

function WatchTile({ stream, focused, onFocus }: { stream: StreamInfo; focused: boolean; onFocus: () => void }) {
  const sub = useApp(s => s.subs[stream.id]);
  const owner = useMember(stream.ownerId);
  const latency = useApp(s => s.settings!.latency);
  const profileColor = useApp(s => s.settings!.profile.color);
  const recording = useApp(s => s.recording?.streamId === stream.id);
  const video = useRef<HTMLVideoElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const box = useContentBox(video);
  const [tool, setTool] = useState<DrawTool | null>(null);
  const [showStats, setShowStats] = useState(false);
  if (!sub) return null;

  const hasNoVideo = !sub.quality.video;
  const sendQuality = (quality: Omit<ViewerQuality, "video">) => core.setSubQuality(stream.id, { ...quality, video: sub.quality.video });
  const qualityIndex = QUALITIES.findIndex(q => q.quality.maxHeight === sub.quality.maxHeight);
  const statusText = sub.state === "connecting" ? "Connexion au stream…" : sub.state === "unstable" ? "Connexion instable…" : sub.state === "failed" ? "Reconnexion…" : null;

  return (
    <div className={`tile ${focused ? "is-focused" : ""}`} ref={root} onDoubleClick={() => void (document.fullscreenElement ? document.exitFullscreen() : root.current?.requestFullscreen())}>
      <Video media={sub.media} videoRef={video} className="tile-video" />
      {hasNoVideo && (
        <div className="tile-audio-only">
          <Avatar name={owner?.name ?? "?"} color={owner?.color} src={owner?.avatar} size={72} />
          <span>Son seul</span>
        </div>
      )}
      <DrawLayer streamId={stream.id} box={box} tool={stream.allowDraw ? tool : null} color={profileColor} />
      <FloatingReactions streamId={stream.id} />
      {statusText && <div className="tile-status">{statusText}</div>}

      <div className="tile-top">
        <span className="live-pill">{stream.paused ? "Pause" : "En direct"}</span>
        <span className="tile-title">
          <b>{owner?.name ?? "?"}</b>
          {stream.title && <span>{stream.title}</span>}
        </span>
        <span className="tile-chip">
          <Users size={12} />
          {stream.viewers.length}
        </span>
        {recording && (
          <span className="tile-chip is-rec">
            <Circle size={9} fill="currentColor" /> REC
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
          <IconButton label={recording ? "Arrêter l'enregistrement" : "Enregistrer ce stream"} active={recording} onClick={() => void (recording ? core.stopRecording() : core.recordWatching(stream.id))}>
            {recording ? <Square size={16} /> : <Circle size={17} />}
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
          <IconButton label="Plein écran" onClick={() => void (document.fullscreenElement ? document.exitFullscreen() : root.current?.requestFullscreen())}>
            <Maximize size={18} />
          </IconButton>
        </div>
      </div>
    </div>
  );
}

function OwnTile({ stream, focused }: { stream: StreamInfo; focused: boolean }) {
  const publish = useApp(s => s.publish);
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
      <div className="tile-top">
        <span className="live-pill">{publish.paused ? "Pause" : "En direct"}</span>
        <span className="tile-title">
          <b>Ton stream</b>
          <span>{publish.sourceName}</span>
        </span>
        <span className="tile-chip">
          <Users size={12} />
          {stream.viewers.length}
        </span>
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
      <span className="live-pill">En direct</span>
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
  const canStream = useApp(s => s.room!.settings.whoCanStream === "everyone" || s.room!.ownerId === s.userId);
  const code = useApp(s => s.room!.code);
  return (
    <div className="stage-empty">
      <div className="stage-empty-icon">
        <Radio size={30} />
      </div>
      <h2>Personne ne diffuse pour l'instant</h2>
      <p>Partage ton écran, une fenêtre, une caméra ou un fichier vidéo, avec le son de l'application de ton choix.</p>
      {canStream && (
        <Button variant="live" icon={<Radio size={18} />} onClick={() => set({ goLiveOpen: true })}>
          Lancer un stream
        </Button>
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

  if (!streams.length) return <section className="stage"><EmptyStage /></section>;

  const isShown = (s: StreamInfo) => s.ownerId === userId || !!subs[s.id];
  const shown = streams.filter(s => isShown(s) && (s.ownerId !== userId || s.id === publishId));
  const others = streams.filter(s => !isShown(s));
  const main = shown.find(s => s.id === focusedId) ?? shown.find(s => s.ownerId !== userId) ?? shown[0];
  const focus = (id: string) => set({ focused: id });

  const tile = (stream: StreamInfo, focused: boolean) =>
    stream.ownerId === userId ? <OwnTile key={stream.id} stream={stream} focused={focused} /> : <WatchTile key={stream.id} stream={stream} focused={focused} onFocus={() => focus(stream.id)} />;

  if (layout === "grid" || !main) {
    return (
      <section className={`stage stage-grid n${Math.min(streams.length, 6)}`}>
        {shown.map(s => tile(s, false))}
        {others.map(s => (
          <StreamCard key={s.id} stream={s} onWatch={() => void core.watch(s.id)} />
        ))}
      </section>
    );
  }

  const rest = shown.filter(s => s !== main);
  return (
    <section className="stage stage-focus">
      <div className="stage-main">{tile(main, true)}</div>
      {rest.length + others.length > 0 && (
        <div className="stage-strip">
          {rest.map(s => (
            <div key={s.id} className="strip-item" onClick={() => focus(s.id)}>
              {tile(s, false)}
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
