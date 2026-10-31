/** @jsxImportSource preact */
import { Laptop, Pause, Play, Radio, Square, UserMinus } from "lucide-preact";
import type { RemoteState } from "@shared/protocol.ts";
import { useEffect, useState } from "preact/hooks";
import { enter, remoteCommand } from "./client.ts";
import { set, useApp } from "./store.ts";

const clock = (seconds: number) => {
  const hours = Math.floor(seconds / 3600);
  const minutes = String(Math.floor((seconds % 3600) / 60)).padStart(hours ? 2 : 1, "0");
  return `${hours ? `${hours}:` : ""}${minutes}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;
};

/** Un champ qui n'envoie qu'en quittant le champ : pas une mise à jour au PC à chaque lettre. */
function CommitField({ label, value, placeholder, onCommit }: { label: string; value: string; placeholder: string; onCommit: (value: string) => void }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  return (
    <label class="field">
      <span>{label}</span>
      <input value={draft} maxLength={120} placeholder={placeholder} aria-label={label} onInput={e => setDraft(e.currentTarget.value)} onBlur={() => draft !== value && onCommit(draft)} />
    </label>
  );
}

/** Ce qui ne tient pas sur une touche : les textes, le film en cours et la liste des spectateurs. */
export function DetailsPane({ remote }: { remote: RemoteState }) {
  const [armed, setArmed] = useState(false);
  const { file } = remote;
  return (
    <div class="pane-scroll regie">
      {file && (
        <section class="regie-block">
          <h3>Fichier diffusé</h3>
          <div class="regie-row">
            <button type="button" class="round" aria-label={file.playing ? "Mettre le fichier en pause" : "Reprendre le fichier"} onClick={() => remoteCommand("filePlay", !file.playing)}>
              {file.playing ? <Pause size={18} /> : <Play size={18} />}
            </button>
            <input type="range" aria-label="Position dans le fichier" min={0} max={Math.max(1, Math.floor(file.duration))} value={Math.floor(file.time)} onChange={e => remoteCommand("fileSeek", Number(e.currentTarget.value))} />
            <small>
              {clock(file.time)} / {clock(file.duration)}
            </small>
          </div>
        </section>
      )}

      <section class="regie-block">
        <CommitField label="Titre du stream" value={remote.title} placeholder={remote.source} onCommit={title => remoteCommand("title", title)} />
        <CommitField label="Bandeau à l'image" value={remote.banner} placeholder="Aucun bandeau" onCommit={banner => remoteCommand("banner", banner)} />
      </section>

      <section class="regie-block">
        <h3>Spectateurs</h3>
        {remote.viewers.length === 0 && <p class="regie-none">Personne pour l'instant.</p>}
        {remote.viewers.map(viewer => (
          <div key={viewer.id} class="regie-row">
            <span class="regie-label">{viewer.name}</span>
            <button type="button" class="round" aria-label={`Retirer ${viewer.name} du stream`} onClick={() => remoteCommand("kick", viewer.id)}>
              <UserMinus size={16} />
            </button>
          </div>
        ))}
      </section>

      <button type="button" class={`wide regie-stop ${armed ? "is-armed" : ""}`} onClick={() => (armed ? (setArmed(false), remoteCommand("stop")) : setArmed(true))}>
        <Square size={16} /> {armed ? "Toucher encore pour arrêter le stream" : "Arrêter le stream"}
      </button>
    </div>
  );
}

/** Sur l'accueil du téléphone : le PC est là, en direct ou non, et la régie est à un toucher. */
export function RemoteCard() {
  const remote = useApp(s => s.remote);
  if (!remote) return null;
  const open = () => {
    set({ deckOpen: true });
    if (!remote.idle && remote.roomCode) void enter(remote.roomCode);
  };
  if (remote.idle) {
    return (
      <button type="button" class="remote-card is-idle" onClick={open}>
        <Laptop size={20} />
        <span>
          <b>Ton PC est en ligne</b>
          <small>{remote.launch ? "Tu peux lancer le direct d'ici" : remote.roomName || "Il ne diffuse pas pour l'instant"}</small>
        </span>
        <em>{remote.launch ? "Lancer" : "Régie"}</em>
      </button>
    );
  }
  return (
    <button type="button" class="remote-card" onClick={open}>
      <Radio size={20} />
      <span>
        <b>Ton PC est en direct</b>
        <small>
          {remote.roomName} · {remote.viewers.length} spectateur{remote.viewers.length > 1 ? "s" : ""}
        </small>
      </span>
      <em>Ouvrir la régie</em>
    </button>
  );
}
