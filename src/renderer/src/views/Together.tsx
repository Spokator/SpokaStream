import { Captions, FileVideo, Globe, ListVideo, Maximize, Pause, Play, Plus, RotateCcw, RotateCw, SkipForward, Smile, Square, TvMinimalPlay, Volume2, VolumeX, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { VideoInfo } from "@shared/ipc.ts";
import { core } from "../engine/core.ts";
import type { TogetherItem } from "@shared/protocol.ts";
import { get, set, soloOf, TOGETHER, useApp } from "../state/store.ts";
import { duration } from "../ui/format.ts";
import { Button, IconButton, isTyping, Modal, Popover, Slider } from "../ui/kit.tsx";
import { FloatingChat, toggleFullscreen, useFullscreen } from "./FloatingChat.tsx";
import { FloatingReactions, REACTIONS } from "./Stage.tsx";

const DRIFT_SECONDS = 1.5;
const SEEK_PAUSE_MS = 3000;
const STATE = { ended: 0, playing: 1, paused: 2, buffering: 3 };

const ERRORS: Record<number, string> = {
  2: "Ce lien n'est pas valable.",
  5: "Cette vidéo ne peut pas être lue ici.",
  100: "Cette vidéo n'existe plus ou est privée.",
  101: "Son auteur interdit de la regarder hors de YouTube.",
  150: "Son auteur interdit de la regarder hors de YouTube.",
  1002: "Le site qui héberge cette vidéo ne répond plus.",
  1003: "Cette vidéo est abîmée ou mal encodée.",
  1004: "Ce format ne se lit pas ici, ou le site refuse la lecture.",
};

const SKIP_SECONDS = 10;

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

const mayShare = () => {
  const { room, userId } = get();
  return !!room && (room.settings.whoCanStream === "everyone" || room.ownerId === userId);
};

export function TogetherModal() {
  const together = useApp(s => s.room?.together);
  const canShare = useCanShare();
  const queue = together?.queue ?? [];

  const [link, setLink] = useState("");
  const [subtitles, setSubtitles] = useState("");
  const [withSubtitles, setWithSubtitles] = useState(false);
  const [busy, setBusy] = useState(false);
  const [page, setPage] = useState<VideoInfo | null>(null);
  const close = () => set({ dialog: null });
  const goLive = (tab: "file" | "web", url?: string) => set({ dialog: null, goLiveOpen: true, goLivePreset: { tab, url } });
  const submit = async () => {
    if (!link.trim() || busy) return;
    setBusy(true);
    setPage(null);
    const result = await core.togetherAdd(link, subtitles);
    setBusy(false);
    if (result === true) close();
    else if (result) setPage(result);
  };

  return (
    <Modal
      title="Watch Party"
      onClose={close}
      width={540}
      footer={
        <Button variant="primary" disabled={!link.trim() || busy} onClick={() => void submit()}>
          {busy ? "Vérification…" : together ? "Ajouter à la file" : "Lancer pour tout le salon"}
        </Button>
      }
    >
      <p className="muted-text">Colle un lien YouTube, ou l'adresse d'une vidéo sur le web : .mp4, .webm, flux .m3u8. Chacun la lit chez lui, en pleine qualité, et tout le salon reste au même endroit. Personne n'a besoin de la diffuser.</p>
      <label className="stack">
        <span className="label">Lien de la vidéo</span>
        <input
          className="input"
          autoFocus
          value={link}
          placeholder="https://…"
          spellCheck={false}
          onChange={e => {
            setLink(e.target.value);
            setPage(null);
          }}
          onKeyDown={e => e.key === "Enter" && void submit()}
        />
      </label>
      {withSubtitles ? (
        <label className="stack">
          <span className="label">Sous-titres pour tout le salon (.vtt ou .srt)</span>
          <input className="input" value={subtitles} placeholder="https://…/sous-titres.vtt" spellCheck={false} onChange={e => setSubtitles(e.target.value)} />
        </label>
      ) : (
        <button type="button" className="link" onClick={() => setWithSubtitles(true)}>
          Ajouter des sous-titres
        </button>
      )}
      {page && (
        <div className="party-page">
          <Globe size={20} />
          <div>
            <b>Ce site ne laisse pas lire sa vidéo ailleurs</b>
            <span>{page.title}. Tu peux ouvrir la page dans SpokaStream et la diffuser, image et son : tes amis la regardent en direct, même sans compte sur ce site.</span>
          </div>
          <Button disabled={!canShare} onClick={() => goLive("web", page.url)}>
            Diffuser cette page
          </Button>
        </div>
      )}
      <button type="button" className="party-file" onClick={() => goLive("file")}>
        <FileVideo size={18} />
        <span>
          <b>Un film sur ton PC ?</b>
          <small>Diffuse le fichier : tu gardes la pause et la position, avec le son du film.</small>
        </span>
      </button>
      {queue.length > 0 && (
        <div className="stack">
          <span className="label">Ensuite</span>
          {queue.map((item, index) => (
            <QueueRow key={`${item.videoId}-${index}`} item={item} index={index} />
          ))}
        </div>
      )}
    </Modal>
  );
}

function QueueRow({ item, index }: { item: TogetherItem; index: number }) {
  const canShare = useCanShare();
  return (
    <div className="queue-row">
      {item.url ? (
        <i className="queue-thumb">
          <FileVideo size={15} />
        </i>
      ) : (
        <img src={`https://i.ytimg.com/vi/${item.videoId}/default.jpg`} alt="" />
      )}
      <span>
        <b>{item.title}</b>
        <small>Ajoutée par {item.byName}</small>
      </span>
      {canShare && (
        <IconButton label="Retirer de la file" onClick={() => core.togetherRemove(index, item.videoId)}>
          <X size={15} />
        </IconButton>
      )}
    </div>
  );
}

export function TogetherTile({ focused, primary, onFocus }: { focused: boolean; primary: boolean; onFocus: () => void }) {
  const together = useApp(s => s.room!.together!);
  const cinema = useApp(s => s.cinema);
  const togetherAt = useApp(s => s.togetherAt);
  const deafened = useApp(s => s.deafened);
  const silenced = useApp(s => {
    const solo = soloOf(s);
    return solo !== null && solo !== TOGETHER;
  });
  const canShare = useCanShare();
  const root = useRef<HTMLDivElement>(null);
  const subtitleFile = useRef<HTMLInputElement>(null);
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
      if (data.type === "error") return setError(ERRORS[data.code ?? 0] ?? "Cette vidéo n'a pas pu être lue.");
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
    post({ cmd: "load", id: together.videoId, url: together.url, subtitles: together.subtitles, time: core.togetherPosition(), playing: together.playing });
  }, [ready, together.videoId]);

  // Un changement décidé par quelqu'un s'applique tout de suite, sans attendre le contrôle de dérive.
  useEffect(() => {
    if (!ready) return;
    post({ cmd: together.playing ? "play" : "pause" });
    post({ cmd: "seek", time: core.togetherPosition() });
    lastSeek.current = performance.now();
  }, [togetherAt]);

  useEffect(() => {
    if (ready) post({ cmd: "volume", volume: muted || deafened || silenced ? 0 : volume });
    try {
      localStorage.setItem("volume:together", String(volume));
    } catch {
      // Le volume reste valable pour cette séance.
    }
  }, [ready, volume, muted, deafened, silenced]);

  const togglePlay = () => {
    const current = get().room?.together;
    if (current && mayShare()) core.togetherControl(!current.playing, core.togetherPosition());
  };
  const skip = (seconds: number) => {
    const current = get().room?.together;
    if (current && mayShare()) core.togetherControl(current.playing, Math.max(0, core.togetherPosition() + seconds));
  };
  const loadSubtitles = async (file: File | undefined) => {
    if (file) post({ cmd: "subtitles", text: await file.text() });
  };

  useEffect(() => {
    if (!primary) return;
    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e)) return;
      const key = e.key.toLowerCase();
      if (key === "m") setMuted(on => !on);
      else if (key === "f") toggleFullscreen(root.current);
      else if (key === " " || key === "k") togglePlay();
      else if (key === "arrowleft") skip(-SKIP_SECONDS);
      else if (key === "arrowright") skip(SKIP_SECONDS);
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
      <iframe ref={frame} className="together-frame" src={core.playerUrl()} title="Lecteur de la Watch Party" allow="autoplay; encrypted-media" referrerPolicy="strict-origin-when-cross-origin" tabIndex={-1} />
      {error && (
        <div className="tile-status together-error">
          <b>{error}</b>
          {canShare && <Button onClick={() => core.togetherNext(together.videoId)}>Passer</Button>}
        </div>
      )}
      {(fullscreen || (cinema && primary)) && <FloatingChat />}
      <FloatingReactions streamId={TOGETHER} />
      <div className="tile-top">
        <span className="live-pill is-together">Watch Party</span>
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
            <IconButton label={together.playing ? "Mettre en pause pour tout le salon" : "Reprendre pour tout le salon"} disabled={!canShare} onClick={togglePlay}>
              {together.playing ? <Pause size={18} /> : <Play size={18} />}
            </IconButton>
            {canShare && (
              <>
                <IconButton label="Reculer de 10 secondes" onClick={() => skip(-SKIP_SECONDS)}>
                  <RotateCcw size={17} />
                </IconButton>
                <IconButton label="Avancer de 10 secondes" onClick={() => skip(SKIP_SECONDS)}>
                  <RotateCw size={17} />
                </IconButton>
              </>
            )}
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
                <IconButton label="Réagir" active={open} onClick={toggle}>
                  <Smile size={18} />
                </IconButton>
              )}
            >
              {close => (
                <div className="reaction-grid">
                  {REACTIONS.map(emoji => (
                    <button
                      key={emoji}
                      type="button"
                      onClick={event => {
                        core.react(TOGETHER, emoji);
                        if (!event.shiftKey) close();
                      }}
                    >
                      {emoji}
                    </button>
                  ))}
                </div>
              )}
            </Popover>
            {together.url && (
              <>
                <input ref={subtitleFile} type="file" accept=".srt,.vtt" hidden onChange={e => (void loadSubtitles(e.target.files?.[0]), (e.target.value = ""))} />
                <IconButton label="Mes sous-titres : choisis un fichier .srt ou .vtt, pour toi seulement" onClick={() => subtitleFile.current?.click()}>
                  <Captions size={18} />
                </IconButton>
              </>
            )}
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
                    <QueueRow key={`${item.videoId}-${index}`} item={item} index={index} />
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
