import { FolderOpen, Save, SendHorizontal } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { core } from "../engine/core.ts";
import { useApp } from "../state/store.ts";
import { Button, Modal } from "../ui/kit.tsx";

const duration = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;

/** Deux poignées sur une même piste : la coupe tombe sur une image clé, donc à la seconde près et sans réencoder. */
function Trim({ times, start, end, onChange }: { times: number[]; start: number; end: number; onChange: (start: number, end: number) => void }) {
  const last = times.length;
  const percent = (index: number) => `${(index / last) * 100}%`;
  return (
    <div className="clip-trim">
      <div className="clip-trim-track">
        <i style={{ left: percent(start), right: `calc(100% - ${percent(end)})` }} />
        <input type="range" aria-label="Début du clip" min={0} max={last} step={1} value={start} onChange={e => onChange(Math.min(Number(e.target.value), end - 1), end)} />
        <input type="range" aria-label="Fin du clip" min={0} max={last} step={1} value={end} onChange={e => onChange(start, Math.max(Number(e.target.value), start + 1))} />
      </div>
    </div>
  );
}

export function ClipPlayer() {
  const clip = useApp(s => s.clip);
  const room = useApp(s => !!s.room);
  const video = useRef<HTMLVideoElement>(null);
  const [range, setRange] = useState<[number, number]>([0, 0]);
  const [saved, setSaved] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const times = clip?.times ?? null;

  useEffect(() => {
    setRange([0, times?.length ?? 0]);
    setSaved(clip?.path ?? null);
    setSent(false);
  }, [clip?.url]);

  if (!clip) return null;

  const [start, end] = range;
  const startAt = times?.[start] ?? 0;
  const endAt = times ? (times[end] ?? clip.seconds) : clip.seconds;
  const whole = !times || (start === 0 && end === times.length);

  const onTrim = (nextStart: number, nextEnd: number) => {
    const moved = nextStart !== start ? nextStart : null;
    setRange([nextStart, nextEnd]);
    setSaved(null);
    setSent(false);
    const element = video.current;
    if (!element) return;
    // On montre l'endroit de la coupe qu'on est en train de déplacer.
    element.currentTime = moved !== null ? (times?.[moved] ?? 0) : Math.max(0, (times?.[nextEnd] ?? clip.seconds) - 1.5);
  };

  return (
    <Modal
      title={clip.title}
      onClose={() => core.closeClip()}
      width={800}
      footer={
        <>
          {saved ? (
            <Button icon={<FolderOpen size={15} />} onClick={() => window.spoka.reveal(saved)}>
              Voir le fichier
            </Button>
          ) : (
            <Button icon={<Save size={15} />} onClick={() => void core.keepClip(start, end).then(setSaved)}>
              Garder le fichier
            </Button>
          )}
          {times && room && (
            <Button
              variant="primary"
              icon={<SendHorizontal size={15} />}
              disabled={sent}
              onClick={() => {
                if (video.current) void core.shareClip(start, end, video.current).then(() => setSent(true));
              }}
            >
              {sent ? "Envoyé" : "Envoyer au salon"}
            </Button>
          )}
        </>
      }
    >
      <video
        ref={video}
        className="clip-video"
        src={clip.url}
        controls
        autoPlay
        playsInline
        onTimeUpdate={e => {
          // La lecture boucle sur la partie gardée : on entend exactement ce qui partira.
          const element = e.currentTarget;
          if (whole) return;
          if (element.currentTime < startAt || element.currentTime >= endAt) element.currentTime = startAt;
        }}
      />
      {times && times.length > 1 && (
        <>
          <Trim times={times} start={start} end={end} onChange={onTrim} />
          <p className="muted-text clip-range">
            De {duration(startAt)} à {duration(endAt)}, soit {Math.max(1, Math.round(endAt - startAt))} s
          </p>
        </>
      )}
    </Modal>
  );
}
