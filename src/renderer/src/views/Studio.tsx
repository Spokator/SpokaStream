import { Circle, Copy, Eraser, FolderOpen, Monitor, Pause, Play, Plus, Scissors, Square, UserX, Video, VideoOff, Volume2, VolumeX, X } from "lucide-react";
import { useEffect, useState } from "react";
import type { AudioApp, Resolution } from "@shared/ipc.ts";
import { core } from "../engine/core.ts";
import type { AudioChoice } from "../engine/core.ts";
import { get, memberOf, set, toast, useApp } from "../state/store.ts";
import type { PublishView } from "../state/store.ts";
import { limitText, mbps, pathText, plural } from "../ui/format.ts";
import { Avatar, Button, Field, IconButton, Meter, Popover, Select, Slider, Toggle, Uptime } from "../ui/kit.tsx";
import { BITRATES, FPS_OPTIONS, RESOLUTIONS } from "./GoLive.tsx";

function Metric({ label, value, tone }: { label: string; value: string; tone?: "warn" | "bad" }) {
  return (
    <div className={`metric ${tone ? `is-${tone}` : ""}`}>
      <span>{label}</span>
      <b>{value}</b>
    </div>
  );
}

type Health = { tone: "good" | "warn" | "bad"; text: string };

/** Ce qu'un diffuseur veut savoir d'un coup d'œil : est-ce que ça passe bien chez les autres ? */
function healthOf(publish: PublishView): Health | null {
  const { stats, target, viewers } = publish;
  if (!stats) return null;
  const retransmit = Math.max(0, ...viewers.map(v => v.stats?.retransmitPct ?? 0));
  const budget = 1000 / target.fps;
  if (stats.fps < target.fps * 0.7 || retransmit > 5 || (stats.encMs ?? 0) > budget) return { tone: "bad", text: stats.limit === "cpu" ? "Ton PC n'arrive pas à suivre" : "Ta connexion décroche" };
  if (stats.limit !== "none" || retransmit > 2) return { tone: "warn", text: limitText(stats.limit) || "Quelques pertes réseau" };
  return { tone: "good", text: "Tout passe bien" };
}

function TitleInput({ title }: { title: string }) {
  const [value, setValue] = useState(title);
  useEffect(() => setValue(title), [title]);
  const commit = () => value.trim() !== title && core.updateStreamInfo({ title: value.trim() });
  return <input className="input" value={value} maxLength={80} placeholder="Titre du stream" aria-label="Titre du stream" onChange={e => setValue(e.target.value)} onBlur={commit} onKeyDown={e => e.key === "Enter" && e.currentTarget.blur()} />;
}

function CameraField({ on }: { on: boolean }) {
  const saved = useApp(s => s.settings!.stream.cameraId);
  const [cameras, setCameras] = useState<MediaDeviceInfo[]>([]);
  useEffect(() => {
    void navigator.mediaDevices.enumerateDevices().then(list => setCameras(list.filter(d => d.kind === "videoinput")));
  }, []);
  if (!cameras.length) return null;
  const options = cameras.map(c => ({ value: c.deviceId, label: c.label || "Caméra" }));
  const current = options.find(o => o.value === saved)?.value ?? options[0]!.value;
  return (
    <div className="studio-camera">
      <Button icon={on ? <VideoOff size={15} /> : <Video size={15} />} onClick={() => void core.setCamera(on ? null : current)}>
        {on ? "Couper la caméra" : "Ajouter ma caméra"}
      </Button>
      {options.length > 1 && <Select label="Caméra" value={current} options={options} onChange={deviceId => void core.setCamera(on ? deviceId : null).then(() => core.updateSettings({ stream: { ...get().settings!.stream, cameraId: deviceId } }))} />}
    </div>
  );
}

function AddAudioMenu({ close }: { close: () => void }) {
  const [apps, setApps] = useState<AudioApp[]>([]);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  useEffect(() => {
    void window.spoka.audioApps().then(setApps).catch(() => {});
    void navigator.mediaDevices.enumerateDevices().then(list => setDevices(list.filter(d => d.kind === "audioinput" && d.deviceId !== "default" && d.deviceId !== "communications")));
  }, []);
  const add = (choice: AudioChoice) => {
    void core.addAudio(choice);
    close();
  };
  return (
    <div className="menu">
      <div className="menu-title">Tout le son</div>
      <button type="button" className="menu-item" onClick={() => add({ type: "system" })}>
        <span>Tout le PC</span>
        <small>Sauf SpokaStream, donc sans écho</small>
      </button>
      {apps.length > 0 && <div className="menu-title">Applications</div>}
      {apps.map(a => (
        <button key={a.pid} type="button" className="menu-item" onClick={() => add({ type: "app", pid: a.pid, name: a.name, icon: a.icon })}>
          <span>
            {a.icon && <img src={a.icon} alt="" />}
            {a.name}
          </span>
        </button>
      ))}
      {devices.length > 0 && <div className="menu-title">Entrées</div>}
      {devices.map(d => (
        <button key={d.deviceId} type="button" className="menu-item" onClick={() => add({ type: "device", deviceId: d.deviceId, label: d.label })}>
          <span>{d.label}</span>
        </button>
      ))}
    </div>
  );
}

export function Studio() {
  const publish = useApp(s => s.publish)!;
  const stream = useApp(s => s.room?.streams.find(x => x.id === s.publish?.streamId));
  const recording = useApp(s => (s.recording?.streamId === s.publish?.streamId ? s.recording : null));
  const lastRecording = useApp(s => s.lastRecording);
  const roomMax = useApp(s => s.room?.settings.maxKbps ?? 0);
  const clipSaving = useApp(s => s.clipSaving);
  const clipSeconds = useApp(s => s.settings!.stream.clipSeconds);
  const { stats, target } = publish;
  const encodeBudget = 1000 / target.fps;
  const overloaded = !!stats?.encMs && stats.encMs > encodeBudget * 0.8;
  const health = healthOf(publish);

  return (
    <div className="studio">
      <section className="studio-section">
        <TitleInput title={publish.title} />
        <div className="studio-state">
          {stream && (
            <span className="studio-uptime">
              En direct depuis <Uptime since={stream.startedAt} />
            </span>
          )}
          {health && <span className={`health-pill is-${health.tone}`}>{health.text}</span>}
        </div>
        <div className="metrics">
          <Metric label="Image" value={stats ? `${stats.height}p · ${stats.fps} i/s` : "–"} />
          <Metric label="Débit" value={stats ? `${mbps(stats.kbps)} Mb/s` : "–"} />
          <Metric label="Encodeur" value={stats ? `${stats.codec} ${stats.hardware ? "GPU" : "CPU"}` : "–"} tone={stats && !stats.hardware ? "warn" : undefined} />
          <Metric label="Temps par image" value={stats?.encMs != null ? `${stats.encMs} ms` : "–"} tone={overloaded ? "bad" : undefined} />
        </div>
        {!stats && <p className="muted-text">Les mesures apparaissent dès qu'une personne regarde. Personne ne regarde, rien n'est encodé.</p>}
        {stats && limitText(stats.limit) && <p className="warn-text">{limitText(stats.limit)}</p>}
      </section>

      <section className="studio-section">
        <h3>Source</h3>
        <div className="studio-source">
          <Monitor size={16} />
          <span>{publish.sourceName}</span>
          <Button onClick={() => set({ goLiveOpen: true })}>Changer</Button>
        </div>
        <div className="studio-buttons">
          <Button icon={publish.paused ? <Play size={15} /> : <Pause size={15} />} onClick={() => void core.setPaused(!publish.paused)}>
            {publish.paused ? "Reprendre" : "Pause"}
          </Button>
          <Button icon={recording ? <Square size={14} /> : <Circle size={15} />} className={recording ? "is-recording" : ""} onClick={() => void (recording ? core.stopRecording() : core.startRecording())}>
            {recording ? <Uptime since={recording.startedAt} /> : "Enregistrer"}
          </Button>
          <Button icon={<Scissors size={15} />} disabled={clipSaving || !clipSeconds} title={clipSeconds ? `Garde les ${clipSeconds} dernières secondes` : "Les clips sont coupés dans les paramètres"} onClick={() => void core.saveClip()}>
            {clipSaving ? "Clip…" : "Clip"}
          </Button>
          <Button icon={<Eraser size={15} />} onClick={() => core.clearDrawings(publish.streamId)}>
            Effacer
          </Button>
        </div>
        <CameraField on={!!publish.camera} />
      </section>

      <section className="studio-section">
        <div className="studio-head">
          <h3>Son du stream</h3>
          <Popover
            align="right"
            trigger={(open, toggle) => (
              <IconButton label="Ajouter une source de son" active={open} onClick={toggle}>
                <Plus size={17} />
              </IconButton>
            )}
          >
            {close => <AddAudioMenu close={close} />}
          </Popover>
        </div>
        {publish.mix.length === 0 && <p className="muted-text">Aucun son n'est envoyé. Ajoute une application ou tout le PC.</p>}
        {publish.mix.map(source => (
          <div key={source.id} className="mix-row">
            <div className="mix-head">
              {source.icon && <img src={source.icon} alt="" />}
              <span>{source.label}</span>
              <small>{Math.round(source.volume * 100)} %</small>
              <IconButton label={source.muted ? "Réactiver" : "Couper"} danger={source.muted} onClick={() => core.setMixMuted(source.id, !source.muted)}>
                {source.muted ? <VolumeX size={15} /> : <Volume2 size={15} />}
              </IconButton>
              <IconButton label="Retirer" onClick={() => core.removeMix(source.id)}>
                <X size={15} />
              </IconButton>
            </div>
            <Slider label={`Volume ${source.label}`} value={source.volume} min={0} max={2} step={0.05} onChange={v => core.setMixVolume(source.id, v)} />
            <Meter read={() => core.mixLevels()[source.id] ?? 0} />
          </div>
        ))}
      </section>

      <section className="studio-section">
        <h3>Qualité, appliquée en direct</h3>
        <Field label="Débit">
          <Select label="Débit" value={target.kbps} options={BITRATES} onChange={kbps => void core.updateEncoding({ kbps })} />
        </Field>
        {roomMax > 0 && roomMax < target.kbps && <p className="warn-text">Le salon limite le débit à {mbps(roomMax)} Mb/s.</p>}
        <Field label="Cadence">
          <Select label="Cadence" value={target.fps} options={FPS_OPTIONS} onChange={fps => void core.updateEncoding({ fps })} />
        </Field>
        <Field label="Définition">
          <Select<Resolution>
            label="Définition"
            value={target.maxHeight ? (String(target.maxHeight) as Resolution) : "source"}
            options={RESOLUTIONS}
            onChange={r => void core.updateEncoding({ maxHeight: r === "source" ? 0 : Number(r) })}
          />
        </Field>
        <Field label="Priorité">
          <Select
            label="Priorité"
            value={target.priority}
            options={[
              { value: "motion", label: "Fluidité" },
              { value: "detail", label: "Netteté" },
            ]}
            onChange={priority => void core.updateEncoding({ priority })}
          />
        </Field>
        <Field label="Dessin des spectateurs">
          <Toggle label="Dessin des spectateurs" checked={publish.allowDraw} onChange={allowDraw => core.updateStreamInfo({ allowDraw })} />
        </Field>
      </section>

      <section className="studio-section">
        <h3>{plural(stream?.viewers.length ?? 0, "spectateur")}</h3>
        {publish.viewers.length === 0 && <p className="muted-text">Partage le code du salon pour inviter tes amis.</p>}
        {publish.viewers.map(v => {
          const member = memberOf(v.id);
          return (
            <div key={v.id} className="viewer-row">
              <Avatar name={member?.name ?? "?"} color={member?.color} src={member?.avatar} size={28} />
              <div>
                <b>{member?.name ?? "?"}</b>
                <small>{v.stats ? `${v.stats.height}p${v.stats.fps} · ${mbps(v.stats.kbps)} Mb/s · ${pathText(v.stats.path)}` : v.state === "connected" ? "Connecté" : "Connexion…"}</small>
              </div>
              <IconButton label="Retirer de ce stream" onClick={() => core.kickViewer(v.id)}>
                <UserX size={15} />
              </IconButton>
            </div>
          );
        })}
      </section>

      <section className="studio-section">
        <div className="studio-buttons">
          <Button
            icon={<Copy size={15} />}
            onClick={() =>
              void core.diagnostics().then(report => {
                window.spoka.copyText(report);
                toast("Diagnostic copié", "success");
              })
            }
          >
            Copier le diagnostic
          </Button>
          {lastRecording && (
            <Button icon={<FolderOpen size={15} />} onClick={() => window.spoka.reveal(lastRecording)}>
              Voir l'enregistrement
            </Button>
          )}
        </div>
      </section>
    </div>
  );
}
