import { Check, Copy } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { ObsInfo } from "@shared/ipc.ts";
import { core } from "../engine/core.ts";
import { useApp } from "../state/store.ts";

function CopyRow({ label, value, secret }: { label: string; value: string; secret?: boolean }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="obs-row">
      <span>{label}</span>
      <code>{secret ? "•".repeat(16) : value}</code>
      <button
        type="button"
        aria-label={`Copier : ${label}`}
        onClick={() => {
          window.spoka.copyText(value);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }}
      >
        {copied ? <Check size={14} /> : <Copy size={14} />}
      </button>
    </div>
  );
}

/** Tout ce qu'il faut pour brancher OBS : il garde ses scènes, ses filtres et son mix, SpokaStream reçoit le résultat. */
export function ObsPanel() {
  const [info, setInfo] = useState<ObsInfo | null>(null);
  const obs = useApp(s => s.obs);
  const preview = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    void window.spoka.obsInfo().then(setInfo);
  }, []);
  useEffect(() => {
    if (preview.current) preview.current.srcObject = core.obsPreview();
  }, [obs.connected]);

  if (obs.connected) {
    return (
      <div className="obs-panel">
        <video ref={preview} className="obs-preview" autoPlay playsInline muted />
        <p className="obs-state is-on">
          <i /> OBS est connecté{obs.height ? ` · ${obs.width}×${obs.height}` : ""}
        </p>
        <p className="muted-text">Tes scènes, tes filtres et ton son viennent d'OBS. Change de scène là-bas : tes spectateurs suivent en direct.</p>
      </div>
    );
  }
  if (!info?.url) return <p className="warn-text">L'entrée pour OBS n'a pas pu démarrer sur ce PC.</p>;
  return (
    <div className="obs-panel">
      <ol>
        <li>
          Dans OBS, ouvre <b>Paramètres</b> puis <b>Stream</b>, et choisis le service <b>WHIP</b>.
          <CopyRow label="Serveur" value={info.url} />
          <CopyRow label="Jeton Bearer" value={info.key} secret />
        </li>
        <li>
          Dans <b>Sortie</b>, mets un débit généreux, 20 000 kb/s par exemple : tout reste sur ce PC, et c'est SpokaStream qui règle la qualité envoyée à tes amis.
        </li>
        <li>
          Clique sur <b>Démarrer le streaming</b> dans OBS.
        </li>
      </ol>
      <p className="obs-state">
        <i /> En attente d'OBS…
      </p>
    </div>
  );
}
