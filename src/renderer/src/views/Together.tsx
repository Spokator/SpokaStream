import { ListVideo, Maximize, Pause, Play, Plus, SkipForward, Square, TvMinimalPlay, Volume2, VolumeX } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { core } from "../engine/core.ts";
import { get, set, useApp } from "../state/store.ts";
import { duration } from "../ui/format.ts";
import { Button, IconButton, isTyping, Modal, Popover, Slider } from "../ui/kit.tsx";
import { FloatingChat, toggleFullscreen, useFullscreen } from "./FloatingChat.tsx";

const DRIFT_SECONDS = 1.5;
const SEEK_PAUSE_MS = 3000;
const STATE = { ended: 0, playing: 1, paused: 2, buffering: 3 };

const ERRORS: Record<number, string> = {
  2: "Ce lien n'est pas valable.",
  5: "Cette vidéo ne peut pas être lue ici.",
  100: "Cette vidéo n'existe plus ou est privée.",
  101: "Son auteur interdit de la regarder hors de YouTube.",
  150: "Son auteur interdit de la regarder hors de YouTube.",
};

const savedVolume = () => {
  try {
    return Number(localStorage.getItem("volume:together") ?? 80);
  } catch {
    return 80;
  }
};

export function useCanShare() {
  return useApp(s => !!s.room && (s.room.settings.whoCanStream === "everyone" || s.room.ownerId === s.userId));
}

export function TogetherModal() {
  const together = useApp(s => s.room?.together);
  const queue = together?.queue ?? [];

  const [link, setLink] = useState("");
  const [busy, setBusy] = useState(false);
  const close = () => set({ dialog: null });
  const submit = async () => {
    if (!link.trim() || busy) return;
    setBusy(true);
    const ok = await core.togetherAdd(link);
    setBusy(false);
    if (ok) close();
  };

  return (
    <Modal
      title="Regarder ensemble"
      onClose={close}
      width={500}
      footer={
        <Button variant="primary" disabled={!link.trim() || busy} onClick={() => void submit()}>
          {busy ? "Vérification…" : together ? "Ajouter à la file" : "Lancer pour tout le salon"}
        </Button>
      }
    >
      <p className="muted-text">Chacun lit la vidéo chez lui, en pleine qualité, et tout le salon reste au même endroit. Personne n'a besoin de la diffuser.</p>
      <label className="stack">
        <span className="label">Lien YouTube</span>
        <input className="input" autoFocus value={link} placeholder="https://www.youtube.com/watch?v=…" spellCheck={false} onChange={e => setLink(e.target.value)} onKeyDown={e => e.key === "Enter" && void submit()} />
      </label>
      {queue.length > 0 && (
        <div className="stack">
          <span className="label">Ensuite</span>
          {queue.map((item, index) => (
            <div key={`${item.videoId}-${index}`} className="queue-row">
              <img src={`https://i.ytimg.com/vi/${item.videoId}/default.jpg`} alt="" />
              <span>
                <b>{item.title}</b>
                <small>Ajoutée par {item.byName}</small>
              </span>
            </div>
          ))}
        </div>
      )}
    </Modal>
  );
}

export function TogetherTile({ focused, primary, onFocus }: { focused: boolean; primary: boolean; onFocus: () => void }) {
  const together = useApp(s => s.room!.together!);
  const cinema = useApp(s => s.cinema);
  const togetherAt = useApp(s => s.togetherAt);
  const deafened = useApp(s => s.deafened);
  const canShare = useCanShare();
  const root = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  const lastSeek = useRef(0);
  const endedVideo = useRef("");
  const [ready, setReady] = useState(false);
  const [time, setTime] = useState(0);
  const [length, setLength] = useState(0);
  const [dragging, setDragging] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [volume, setVolume] = useState(savedVolume);
  const [muted, setMuted] = useState(false);
  const fullscreen = useFullscreen(root);

  const post = (message: Record<string, unknown>) => frame.current?.contentWindow?.postMessage({ spoka: true, ...message }, "*");

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const data = event.data as { spoka?: boolean; type?: string; time?: number; duration?: number; state?: number; code?: number } | null;
      if (event.source !== frame.current?.contentWindow || !data?.spoka) return;
      if (data.type === "ready") return setReady(true);
      if (data.type === "error") return setError(ERRORS[data.code ?? 0] ?? "YouTube n'a pas pu lire cette vidéo.");
      const current = get().room?.together;
      if (!current) return;
      if (data.state === STATE.ended && endedVideo.current !== current.videoId) {
        endedVideo.current = current.videoId;
        return core.togetherNext(current.videoId);
      }
      if (data.type !== "time") return;
      setTime(data.time ?? 0);
      setLength(data.duration ?? 0);
      if (data.state === STATE.buffering || data.state === STATE.ended) return;
      if (data.state === STATE.playing && !current.playing) post({ cmd: "pause" });
      if (data.state === STATE.paused && current.playing) post({ cmd: "play" });
      const expected = Math.min(core.togetherPosition(), data.duration || Infinity);
      const now = performance.now();
      if (Math.abs((data.time ?? 0) - expected) > DRIFT_SECONDS && now - lastSeek.current > SEEK_PAUSE_MS) {
        lastSeek.current = now;
        post({ cmd: "seek", time: expected });
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  useEffect(() => {
    if (!ready) return;
    setError(null);
    post({ cmd: "load", id: together.videoId, time: core.togetherPosition(), playing: together.playing });
  }, [ready, together.videoId]);

  // Un changement décidé par quelqu'un s'applique tout de suite, sans attendre le contrôle de dérive.
  useEffect(() => {
    if (!ready) return;
    post({ cmd: together.playing ? "play" : "pause" });
    post({ cmd: "seek", time: core.togetherPosition() });
    lastSeek.current = performance.now();
  }, [togetherAt]);

  useEffect(() => {
    if (ready) post({ cmd: "volume", volume: muted || deafened ? 0 : volume });
    try {
      localStorage.setItem("volume:together", String(volume));
    } catch {
      // Le volume reste valable pour cette séance.
    }
  }, [ready, volume, muted, deafened]);

  useEffect(() => {
    if (!primary) return;
    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e)) return;
      const key = e.key.toLowerCase();
      if (key === "m") setMuted(on => !on);
      else if (key === "f") toggleFullscreen(root.current);
      else if (key === "arrowup") setVolume(v => Math.min(100, v + 10));
      else if (key === "arrowdown") setVolume(v => Math.max(0, v - 10));
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [primary]);

  const shownTime = dragging ?? time;
  const percent = length ? (shownTime / length) * 100 : 0;

  return (
    <div className={`tile tile-together ${focused ? "is-focused" : ""}`} ref={root} onDoubleClick={() => toggleFullscreen(root.current)}>
      <iframe ref={frame} className="together-frame" src={core.playerUrl()} title="Lecteur YouTube" allow="autoplay; encrypted-media" referrerPolicy="strict-origin-when-cross-origin" tabIndex={-1} />
      {error && (
        <div className="tile-status together-error">
          <b>{error}</b>
          {canShare && <Button onClick={() => core.togetherNext(together.videoId)}>Passer</Button>}
        </div>
      )}
      {(fullscreen || (cinema && primary)) && <FloatingChat />}
      <div className="tile-top">
        <span className="live-pill is-together">Ensemble</span>
        <span className="tile-title">
          <b>{together.title}</b>
          <span>Lancée par {together.byName}</span>
        </span>
        <span className="tile-spacer" />
      </div>

      <div className="tile-bar together-bar">
        <input
          type="range"
          className="slider together-seek"
          aria-label="Position dans la vidéo"
          min={0}
          max={Math.max(1, length)}
          step={1}
          value={shownTime}
          disabled={!canShare}
          style={{ "--fill": `${percent}%` } as React.CSSProperties}
          onChange={e => setDragging(Number(e.target.value))}
          onPointerUp={() => {
            if (dragging !== null) core.togetherControl(together.playing, dragging);
            setDragging(null);
          }}
        />
        <div className="together-controls">
          <div className="tile-bar-group">
            <IconButton label={together.playing ? "Mettre en pause pour tout le salon" : "Reprendre pour tout le salon"} disabled={!canShare} onClick={() => core.togetherControl(!together.playing, core.togetherPosition())}>
              {together.playing ? <Pause size={18} /> : <Play size={18} />}
            </IconButton>
            <IconButton label={muted ? "Remettre le son" : "Couper le son"} onClick={() => setMuted(!muted)}>
              {muted ? <VolumeX size={18} /> : <Volume2 size={18} />}
            </IconButton>
            <Slider label="Volume de la vidéo" className="tile-volume" value={muted ? 0 : volume} min={0} max={100} onChange={v => (setMuted(false), setVolume(v))} />
            <span className="tile-percent together-time">
              {duration(shownTime * 1000)} / {duration(length * 1000)}
            </span>
          </div>
          <div className="tile-bar-group">
            <Popover
              up
              align="right"
              trigger={(open, toggle) => (
                <IconButton label="File d'attente" active={open} onClick={toggle}>
                  <ListVideo size={18} />
                </IconButton>
              )}
            >
              {close => (
                <div className="menu">
                  <div className="menu-title">Ensuite</div>
                  {together.queue.length === 0 && <div className="menu-empty">Rien dans la file pour l'instant.</div>}
                  {together.queue.map((item, index) => (
                    <div key={`${item.videoId}-${index}`} className="menu-item">
                      <span>{item.title}</span>
                      <small>Ajoutée par {item.byName}</small>
                    </div>
                  ))}
                  {canShare && (
                    <button
                      type="button"
                      className="menu-item"
                      onClick={() => {
                        close();
                        set({ dialog: "together" });
                      }}
                    >
                      <span>
                        <Plus size={15} /> Ajouter une vidéo
                      </span>
                    </button>
                  )}
                </div>
              )}
            </Popover>
            {canShare && (
              <>
                <IconButton label="Vidéo suivante" onClick={() => core.togetherNext(together.videoId)}>
                  <SkipForward size={18} />
                </IconButton>
                <IconButton label="Arrêter pour tout le salon" onClick={() => core.togetherStop()}>
                  <Square size={16} />
                </IconButton>
              </>
            )}
            {!focused && (
              <IconButton label="Mettre en grand" onClick={onFocus}>
                <TvMinimalPlay size={18} />
              </IconButton>
            )}
            <IconButton label="Plein écran" onClick={() => toggleFullscreen(root.current)}>
              <Maximize size={18} />
            </IconButton>
          </div>
        </div>
      </div>
    </div>
  );
}
