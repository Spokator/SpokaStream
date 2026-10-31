/** @jsxImportSource preact */
import { Camera, CameraOff, Circle, Clapperboard, Eraser, Mic, MicOff, Pause, Play, Radio, Scissors, Square, Tag, UserMinus, Volume2, VolumeX } from "lucide-preact";
import { useEffect, useState } from "preact/hooks";
import type { ComponentChildren } from "preact";
import { enter, remoteCommand } from "./client.ts";
import { set, useApp } from "./store.ts";

const clock = (seconds: number) => {
  const hours = Math.floor(seconds / 3600);
  const minutes = String(Math.floor((seconds % 3600) / 60)).padStart(hours ? 2 : 1, "0");
  return `${hours ? `${hours}:` : ""}${minutes}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;
};

function Elapsed({ since }: { since: number }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return <>{clock(Math.max(0, (now - since) / 1000))}</>;
}

function Action({ label, on, danger, onClick, children }: { label: string; on?: boolean; danger?: boolean; onClick: () => void; children: ComponentChildren }) {
  return (
    <button type="button" class={`regie-action ${on ? "is-on" : ""} ${danger ? "is-danger" : ""}`} aria-pressed={on} onClick={onClick}>
      {children}
      <span>{label}</span>
    </button>
  );
}

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

/** Le téléphone pilote le PC : chaque geste part vers lui, et ce qui s'affiche ici est ce qu'il renvoie, jamais une supposition. */
export function RegiePane() {
  const remote = useApp(s => s.remote);
  const [armed, setArmed] = useState(false);
  if (!remote) return <p class="empty">Ton PC ne diffuse pas pour l'instant.</p>;
  const { stats, file } = remote;
  const warning = stats?.limit ?? "";
  return (
    <div class="pane-scroll regie">
      <div class={`regie-status ${remote.paused ? "is-paused" : ""}`}>
        <span class="live-chip">{remote.paused ? "Pause" : <Radio size={12} />}</span>
        <b>
          <Elapsed since={remote.startedAt} />
        </b>
        <span>{remote.viewers.length} spectateur{remote.viewers.length > 1 ? "s" : ""}</span>
        {stats && (
          <small>
            {stats.height}p{stats.fps} · {(stats.kbps / 1000).toFixed(1)} Mb/s · {stats.codec}
          </small>
        )}
      </div>
      {warning && <p class="regie-warning">{warning}</p>}
      {remote.controlAsk && (
        <div class="regie-ask">
          <span>{remote.controlAsk} demande la main</span>
          <button type="button" class="wide" onClick={() => remoteCommand("controlAccept")}>
            Accepter
          </button>
          <button type="button" class="wide" onClick={() => remoteCommand("controlRefuse")}>
            Refuser
          </button>
        </div>
      )}
      {remote.controller && (
        <button type="button" class="wide" onClick={() => remoteCommand("controlEnd")}>
          Reprendre la main à {remote.controller}
        </button>
      )}

      <div class="regie-actions">
        <Action label={remote.paused ? "Reprendre" : "Pause"} on={remote.paused} onClick={() => remoteCommand(remote.paused ? "resume" : "pause")}>
          {remote.paused ? <Play size={20} /> : <Pause size={20} />}
        </Action>
        <Action label={remote.muted ? "Micro coupé" : "Micro"} on={remote.muted} onClick={() => remoteCommand("mute")}>
          {remote.muted ? <MicOff size={20} /> : <Mic size={20} />}
        </Action>
        <Action label="Caméra" on={remote.camera} onClick={() => remoteCommand("camera")}>
          {remote.camera ? <Camera size={20} /> : <CameraOff size={20} />}
        </Action>
        <Action label={remote.recording ? "Enregistre" : "Enregistrer"} on={remote.recording} onClick={() => remoteCommand("record")}>
          <Circle size={20} />
        </Action>
        <Action label="Clip" onClick={() => remoteCommand("clip")}>
          <Scissors size={20} />
        </Action>
        <Action label="Marqueur" onClick={() => remoteCommand("marker")}>
          <Tag size={20} />
        </Action>
        <Action label="Effacer" onClick={() => remoteCommand("clear")}>
          <Eraser size={20} />
        </Action>
      </div>

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

      {remote.scenes.length > 0 && (
        <section class="regie-block">
          <h3>
            <Clapperboard size={14} /> Scènes
          </h3>
          <div class="regie-chips">
            {remote.scenes.map(scene => (
              <button key={scene.id} type="button" class={remote.scene === scene.id ? "is-on" : ""} onClick={() => remoteCommand("scene", scene.id)}>
                {scene.name}
              </button>
            ))}
          </div>
        </section>
      )}

      {remote.screens.length > 0 && (
        <section class="regie-block">
          <h3>Écrans d'attente</h3>
          <div class="regie-chips">
            {remote.screens.map((title, index) => (
              <button key={title} type="button" class={remote.screen === title ? "is-on" : ""} onClick={() => remoteCommand(remote.screen === title ? "resume" : "screen", index)}>
                {title}
              </button>
            ))}
          </div>
        </section>
      )}

      {remote.mix.length > 0 && (
        <section class="regie-block">
          <h3>Table de mixage</h3>
          {remote.mix.map(source => (
            <div key={source.id} class="regie-row">
              <button type="button" class={`round ${source.muted ? "is-off" : ""}`} aria-label={source.muted ? `Remettre ${source.label}` : `Couper ${source.label}`} onClick={() => remoteCommand("mixMute", `${source.id}|${source.muted ? "0" : "1"}`)}>
                {source.muted ? <VolumeX size={17} /> : <Volume2 size={17} />}
              </button>
              <span class="regie-label">{source.label}</span>
              <input type="range" aria-label={`Volume de ${source.label}`} min={0} max={1.5} step={0.05} value={source.volume} onChange={e => remoteCommand("mixVolume", `${source.id}|${e.currentTarget.value}`)} />
            </div>
          ))}
        </section>
      )}

      <section class="regie-block">
        <CommitField label="Titre du stream" value={remote.title} placeholder={remote.source} onCommit={title => remoteCommand("title", title)} />
        <CommitField label="Bandeau à l'image" value={remote.banner} placeholder="Aucun bandeau" onCommit={banner => remoteCommand("banner", banner)} />
      </section>

      {remote.viewers.length > 0 && (
        <section class="regie-block">
          <h3>Spectateurs</h3>
          {remote.viewers.map(viewer => (
            <div key={viewer.id} class="regie-row">
              <span class="regie-label">{viewer.name}</span>
              <button type="button" class="round" aria-label={`Retirer ${viewer.name} du stream`} onClick={() => remoteCommand("kick", viewer.id)}>
                <UserMinus size={16} />
              </button>
            </div>
          ))}
        </section>
      )}

      <button type="button" class={`wide regie-stop ${armed ? "is-armed" : ""}`} onClick={() => (armed ? (setArmed(false), remoteCommand("stop")) : setArmed(true))}>
        <Square size={16} /> {armed ? "Toucher encore pour arrêter le stream" : "Arrêter le stream"}
      </button>
    </div>
  );
}

/** Sur l'accueil du téléphone : le PC est en direct, la régie est à un toucher. */
export function RemoteCard() {
  const remote = useApp(s => s.remote);
  if (!remote) return null;
  return (
    <button
      type="button"
      class="remote-card"
      onClick={() => {
        set({ tab: "regie" });
        void enter(remote.roomCode);
      }}
    >
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
