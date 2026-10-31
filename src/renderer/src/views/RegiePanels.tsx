import { Activity, AudioLines, Bell, Camera, Circle, Clapperboard, Copy, Eraser, FolderOpen, Gamepad2, Gauge, Headphones, HeadphoneOff, Hand, Layers, Link2, ListChecks, MessageSquare, Mic, MicOff, Monitor, NotebookPen, Pause, Pencil, Play, Plus, Radio, Rewind, Scissors, Settings2, Square, Tag, Timer, UserX, Users, Video, VideoOff, Volume2, VolumeX, Vote, X, Zap } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import type { ActionId, AudioApp, PanelId, Resolution, WaitScreen } from "@shared/ipc.ts";
import { core } from "../engine/core.ts";
import type { AudioChoice } from "../engine/core.ts";
import { get, memberOf, set, toast, useApp } from "../state/store.ts";
import type { ActivityItem, PublishView } from "../state/store.ts";
import { clock, limitText, mbps, pathText, plural } from "../ui/format.ts";
import { Avatar, Button, Field, IconButton, Meter, Popover, Segmented, Select, Slider, Toggle, Uptime } from "../ui/kit.tsx";
import { FileTransport } from "./Stage.tsx";
import { Chat } from "./Chat.tsx";
import { BITRATES, FPS_OPTIONS, PRESETS, RESOLUTIONS } from "./GoLive.tsx";
import { Scenes, ScenesAdd } from "./Scenes.tsx";

// ---------------------------------------------------------------- santé

export interface Health {
  tone: "good" | "warn" | "bad" | "idle";
  text: string;
  advice?: string;
  fix?: { label: string; run: () => void };
}

const lowerBitrate = (kbps: number) => [...BITRATES].reverse().find(b => b.value < kbps * 0.75)?.value ?? null;

/** Ce qu'un diffuseur veut savoir d'un coup d'œil, et surtout quoi faire si ça ne va pas. */
export function healthOf(publish: PublishView): Health {
  const { stats, target, viewers } = publish;
  if (!stats) return { tone: "idle", text: "Personne ne regarde", advice: "Rien n'est encodé tant que personne ne regarde : ton PC ne fait aucun effort." };
  const retransmit = Math.max(0, ...viewers.map(v => v.stats?.retransmitPct ?? 0));
  const budget = 1000 / target.fps;
  const overloaded = stats.limit === "cpu" || (stats.encMs ?? 0) > budget;
  const fps30 = { label: "Passer à 30 i/s", run: () => void core.updateEncoding({ fps: 30 }) };
  const lower = lowerBitrate(target.kbps);
  const network = lower ? { label: `Passer à ${mbps(lower)} Mb/s`, run: () => void core.updateEncoding({ kbps: lower }) } : undefined;
  if (stats.fps < target.fps * 0.7 || retransmit > 5 || (stats.encMs ?? 0) > budget) {
    if (overloaded) return { tone: "bad", text: "Ton PC n'arrive pas à suivre", advice: "L'encodeur manque de temps pour chaque image. Baisse la cadence ou la définition.", fix: target.fps > 30 ? fps30 : undefined };
    return { tone: "bad", text: "Ta connexion décroche", advice: "Des images se perdent en route. Un débit plus bas donnera une image stable à tes spectateurs.", fix: network };
  }
  if (stats.limit !== "none" || retransmit > 2) return { tone: "warn", text: limitText(stats.limit) || "Quelques pertes réseau", advice: "Rien de grave pour l'instant. Si l'image saccade, baisse le débit.", fix: network };
  return { tone: "good", text: "Tout passe bien" };
}

function Metric({ label, value, tone }: { label: string; value: string; tone?: "warn" | "bad" }) {
  return (
    <div className={`metric ${tone ? `is-${tone}` : ""}`}>
      <span>{label}</span>
      <b>{value}</b>
    </div>
  );
}

/** Deux minutes de cadence et de débit : un creux se lit d'un regard, sans ouvrir de statistiques. */
function Graph({ values, label, unit }: { values: number[]; label: string; unit: string }) {
  const max = Math.max(1, ...values);
  const points = values.map((v, i) => `${(i / Math.max(1, values.length - 1)) * 100},${28 - (v / max) * 26}`).join(" ");
  return (
    <div className="health-graph">
      <span>
        {label}
        <b>
          {values.at(-1) ?? 0} {unit}
        </b>
      </span>
      <svg viewBox="0 0 100 30" preserveAspectRatio="none" role="img" aria-label={`Évolution : ${label}`}>
        <polyline points={points} vectorEffect="non-scaling-stroke" />
      </svg>
    </div>
  );
}

function HealthPanel() {
  const publish = useApp(s => s.publish)!;
  const { stats, target } = publish;
  const health = healthOf(publish);
  const history = core.healthHistory;
  const overloaded = !!stats?.encMs && stats.encMs > (1000 / target.fps) * 0.8;
  return (
    <>
      <div className={`health-state is-${health.tone}`}>
        <i />
        <b>{health.text}</b>
      </div>
      {health.advice && <p className="muted-text">{health.advice}</p>}
      {health.fix && (
        <Button icon={<Zap size={15} />} onClick={health.fix.run}>
          {health.fix.label}
        </Button>
      )}
      <div className="metrics">
        <Metric label="Image" value={stats ? `${stats.height}p · ${stats.fps} i/s` : "–"} />
        <Metric label="Débit" value={stats ? `${mbps(stats.kbps)} Mb/s` : "–"} />
        <Metric label="Encodeur" value={stats ? `${stats.codec} ${stats.hardware ? "GPU" : "CPU"}` : "–"} tone={stats && !stats.hardware ? "warn" : undefined} />
        <Metric label="Temps par image" value={stats?.encMs != null ? `${stats.encMs} ms` : "–"} tone={overloaded ? "bad" : undefined} />
      </div>
      {history.length > 1 && (
        <>
          <Graph values={history.map(h => h.fps)} label="Cadence" unit="i/s" />
          <Graph values={history.map(h => Math.round(h.kbps / 100) / 10)} label="Débit" unit="Mb/s" />
        </>
      )}
    </>
  );
}

// ---------------------------------------------------------------- actions rapides

interface QuickAction {
  label: string;
  icon: LucideIcon;
  on?: boolean;
  run: () => void;
}

function useQuickActions(): Record<ActionId, QuickAction> {
  const publish = useApp(s => s.publish)!;
  const recording = useApp(s => (s.recording?.streamId === s.publish?.streamId ? s.recording : null));
  const muted = useApp(s => s.muted);
  const deafened = useApp(s => s.deafened);
  const code = useApp(s => s.room?.code ?? "");
  const camera = useApp(s => s.settings!.stream.cameraId);
  return {
    pause: { label: publish.paused ? "Reprendre" : "Pause", icon: publish.paused ? Play : Pause, on: publish.paused, run: () => void core.setPaused(!publish.paused) },
    record: { label: recording ? "Arrêter l'enregistrement" : "Enregistrer", icon: recording ? Square : Circle, on: !!recording, run: () => void (recording ? core.stopRecording() : core.startRecording()) },
    clip: { label: "Clip", icon: Scissors, run: () => void core.saveClip() },
    replay: { label: "Revoir", icon: Rewind, run: () => void core.replay() },
    marker: { label: "Marqueur", icon: Tag, run: () => core.addMarker() },
    camera: { label: publish.camera ? "Couper la caméra" : "Caméra", icon: publish.camera ? VideoOff : Video, on: !!publish.camera, run: () => void core.setCamera(publish.camera ? null : camera) },
    mic: { label: muted ? "Micro coupé" : "Micro", icon: muted ? MicOff : Mic, on: muted, run: () => core.toggleMute() },
    deafen: { label: deafened ? "Sourdine active" : "Sourdine", icon: deafened ? HeadphoneOff : Headphones, on: deafened, run: () => core.toggleDeafen() },
    clearDraw: { label: "Effacer", icon: Eraser, run: () => core.clearDrawings(publish.streamId) },
    poll: { label: "Sondage", icon: Vote, run: () => set({ dialog: "poll" }) },
    invite: {
      label: "Inviter",
      icon: Link2,
      run: () => {
        window.spoka.copyText(core.inviteLink(code));
        toast("Lien d'invitation copié", "success");
      },
    },
  };
}

const ACTION_NAMES: Record<ActionId, string> = { pause: "Pause", record: "Enregistrer", clip: "Clip", replay: "Revoir", marker: "Marqueur", camera: "Caméra", mic: "Micro", deafen: "Sourdine", clearDraw: "Effacer les dessins", poll: "Sondage", invite: "Inviter" };

function ActionsPanel() {
  const actions = useQuickActions();
  const chosen = useApp(s => s.settings!.regie.actions);
  return (
    <div className="quick-actions">
      {chosen.map(id => {
        const action = actions[id];
        return (
          <button key={id} type="button" className={`quick-action ${action.on ? "is-on" : ""}`} onClick={action.run}>
            <action.icon size={18} />
            <span>{action.label}</span>
          </button>
        );
      })}
    </div>
  );
}

function ActionsChoice() {
  const chosen = useApp(s => s.settings!.regie.actions);
  return (
    <Popover
      align="right"
      trigger={(open, toggle) => (
        <IconButton label="Choisir les actions rapides" active={open} onClick={toggle}>
          <Settings2 size={15} />
        </IconButton>
      )}
    >
      {() => (
        <div className="menu">
          <div className="menu-title">Actions rapides</div>
          {(Object.keys(ACTION_NAMES) as ActionId[]).map(id => (
            <label key={id} className="menu-check">
              <input type="checkbox" checked={chosen.includes(id)} onChange={e => core.setActions(e.target.checked ? [...chosen, id] : chosen.filter(a => a !== id))} />
              {ACTION_NAMES[id]}
            </label>
          ))}
        </div>
      )}
    </Popover>
  );
}

// ---------------------------------------------------------------- infos

function CommitInput({ value, onCommit, label, placeholder, maxLength = 80 }: { value: string; onCommit: (next: string) => void; label: string; placeholder: string; maxLength?: number }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const commit = () => draft.trim() !== value && onCommit(draft.trim());
  return <input className="input" value={draft} maxLength={maxLength} placeholder={placeholder} aria-label={label} onChange={e => setDraft(e.target.value)} onBlur={commit} onKeyDown={e => e.key === "Enter" && e.currentTarget.blur()} />;
}

function InfoPanel() {
  const publish = useApp(s => s.publish)!;
  const code = useApp(s => s.room?.code ?? "");
  return (
    <>
      <CommitInput value={publish.title} onCommit={title => core.updateStreamInfo({ title })} label="Titre du stream" placeholder="Titre du stream" />
      <CommitInput value={publish.banner} onCommit={banner => core.setBanner(banner)} label="Bandeau sur l'image" placeholder="Bandeau sur l'image : pseudo, partie classée…" />
      <Button
        icon={<Link2 size={15} />}
        onClick={() => {
          window.spoka.copyText(core.inviteLink(code));
          toast("Lien d'invitation copié", "success");
        }}
      >
        Copier le lien d'invitation
      </Button>
    </>
  );
}

// ---------------------------------------------------------------- sources

function CameraField({ on }: { on: boolean }) {
  const saved = useApp(s => s.settings!.stream.cameraId);
  const layout = useApp(s => s.publish!.cameraLayout);
  const [cameras, setCameras] = useState<MediaDeviceInfo[]>([]);
  useEffect(() => {
    void navigator.mediaDevices.enumerateDevices().then(list => setCameras(list.filter(d => d.kind === "videoinput")));
  }, []);
  if (!cameras.length) return null;
  const options = cameras.map(c => ({ value: c.deviceId, label: c.label || "Caméra" }));
  const current = options.find(o => o.value === saved)?.value ?? options[0]!.value;
  return (
    <>
      <div className="studio-camera">
        <Button icon={on ? <VideoOff size={15} /> : <Video size={15} />} onClick={() => void core.setCamera(on ? null : current)}>
          {on ? "Couper la caméra" : "Ajouter ma caméra"}
        </Button>
        {options.length > 1 && <Select label="Caméra" value={current} options={options} onChange={deviceId => void core.setCamera(on ? deviceId : null).then(() => core.updateSettings({ stream: { ...get().settings!.stream, cameraId: deviceId } }))} />}
      </div>
      {on && (
        <>
          <p className="muted-text">Glisse la caméra sur l'aperçu pour la placer, et sa poignée pour l'agrandir.</p>
          <Segmented
            label="Forme de la caméra"
            value={layout.shape}
            options={[
              { value: "round", label: "Arrondie" },
              { value: "rect", label: "Carrée" },
              { value: "circle", label: "Ronde" },
            ]}
            onChange={shape => core.setCameraLayout({ ...layout, shape }, true)}
          />
          <Field label="Effet miroir">
            <Toggle label="Effet miroir" checked={layout.mirror} onChange={mirror => core.setCameraLayout({ ...layout, mirror }, true)} />
          </Field>
        </>
      )}
    </>
  );
}

function SourcesPanel() {
  const publish = useApp(s => s.publish)!;
  return (
    <>
      <div className="studio-source">
        <Monitor size={16} />
        <span>{publish.sourceName}</span>
        <Button onClick={() => set({ goLiveOpen: true })}>Changer</Button>
      </div>
      <FileTransport />
      <CameraField on={!!publish.camera} />
    </>
  );
}

// ---------------------------------------------------------------- écrans d'attente

function ScreenEditor({ screen, onChange }: { screen: WaitScreen; onChange: (next: WaitScreen) => void }) {
  return (
    <Popover
      align="right"
      trigger={(open, toggle) => (
        <IconButton label={`Modifier l'écran ${screen.title}`} active={open} onClick={toggle}>
          <Pencil size={14} />
        </IconButton>
      )}
    >
      {() => (
        <div className="menu menu-form">
          <CommitInput value={screen.title} onCommit={title => title && onChange({ ...screen, title })} label="Titre de l'écran" placeholder="Titre" maxLength={40} />
          <CommitInput value={screen.subtitle} onCommit={subtitle => onChange({ ...screen, subtitle })} label="Sous-titre de l'écran" placeholder="Sous-titre" maxLength={60} />
          <Select
            label="Compte à rebours"
            value={screen.minutes}
            options={[0, 1, 2, 5, 10, 15].map(value => ({ value, label: value ? `${value} min à décompter` : "Sans compte à rebours" }))}
            onChange={minutes => onChange({ ...screen, minutes })}
          />
          <label className="menu-check">
            <input type="checkbox" checked={screen.keepSound} onChange={e => onChange({ ...screen, keepSound: e.target.checked })} />
            Garder le son pendant cet écran
          </label>
        </div>
      )}
    </Popover>
  );
}

function ScreensPanel() {
  const screens = useApp(s => s.settings!.stream.screens);
  const active = useApp(s => s.publish!.screen);
  return (
    <>
      <p className="muted-text">Remplace ton image, le temps d'une attente. Ton écran n'est plus capturé pour les spectateurs.</p>
      {screens.map((screen, index) => (
        <div key={index} className={`wait-screen ${active === screen.title ? "is-on" : ""}`}>
          <button type="button" onClick={() => void (active === screen.title ? core.setPaused(false) : core.setPaused(true, screen))}>
            <Timer size={15} />
            {screen.title}
          </button>
          <ScreenEditor screen={screen} onChange={next => core.saveScreens(screens.map((s, i) => (i === index ? next : s)))} />
        </div>
      ))}
    </>
  );
}

// ---------------------------------------------------------------- table de mixage

function AddAudioMenu({ close }: { close: () => void }) {
  const [apps, setApps] = useState<AudioApp[]>([]);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const micId = useApp(s => s.settings!.micId);
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
      <button type="button" className="menu-item" onClick={() => add({ type: "device", deviceId: micId, label: "Mon micro" })}>
        <span>Mon micro</span>
        <small>Ta voix dans le stream, à côté du vocal</small>
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

function MixerAdd() {
  return (
    <Popover
      align="right"
      trigger={(open, toggle) => (
        <IconButton label="Ajouter une source de son" active={open} onClick={toggle}>
          <Plus size={16} />
        </IconButton>
      )}
    >
      {close => <AddAudioMenu close={close} />}
    </Popover>
  );
}

const OFFSETS = [0, 50, 100, 150, 200, 300, 500, 1000, 2000];

function MixerPanel() {
  const mix = useApp(s => s.publish!.mix);
  return (
    <>
      {mix.length === 0 && <p className="muted-text">Aucun son n'est envoyé. Ajoute une application ou tout le PC.</p>}
      {mix.map(source => (
        <div key={source.id} className="mix-row">
          <div className="mix-head">
            {source.icon && <img src={source.icon} alt="" />}
            <span>{source.label}</span>
            <small>{Math.round(source.volume * 100)} %</small>
            <IconButton label={source.muted ? "Réactiver" : "Couper"} danger={source.muted} onClick={() => core.setMixMuted(source.id, !source.muted)}>
              {source.muted ? <VolumeX size={15} /> : <Volume2 size={15} />}
            </IconButton>
            <Popover
              align="right"
              trigger={(open, toggle) => (
                <IconButton label={`Réglages de ${source.label}`} active={open} onClick={toggle}>
                  <Settings2 size={14} />
                </IconButton>
              )}
            >
              {() => (
                <div className="menu menu-form">
                  <label className="menu-check">
                    <input type="checkbox" checked={source.duck} onChange={e => core.setMixDuck(source.id, e.target.checked)} />
                    Baisser quand je parle
                  </label>
                  <Field label="Décalage du son" hint="Si le son arrive avant l'image">
                    <Select label="Décalage du son" value={source.offsetMs} options={OFFSETS.map(value => ({ value, label: value ? `${value} ms` : "Aucun" }))} onChange={ms => core.setMixOffset(source.id, ms)} />
                  </Field>
                </div>
              )}
            </Popover>
            <IconButton label="Retirer" onClick={() => core.removeMix(source.id)}>
              <X size={15} />
            </IconButton>
          </div>
          <Slider label={`Volume ${source.label}`} value={source.volume} min={0} max={2} step={0.05} onChange={v => core.setMixVolume(source.id, v)} />
          <Meter read={() => core.mixLevels()[source.id] ?? 0} />
        </div>
      ))}
      {mix.length > 1 && (
        <div className="mix-master">
          <span>Total envoyé</span>
          <Meter read={() => core.mixLevels().master ?? 0} />
        </div>
      )}
    </>
  );
}

// ---------------------------------------------------------------- qualité

function QualityPanel() {
  const target = useApp(s => s.publish!.target);
  const roomMax = useApp(s => s.room?.settings.maxKbps ?? 0);
  const autoRecord = useApp(s => s.settings!.stream.autoRecord);
  const resolution = (target.maxHeight ? String(target.maxHeight) : "source") as Resolution;
  const active = PRESETS.find(p => p.resolution === resolution && p.fps === target.fps && p.kbps === target.kbps && p.priority === target.priority)?.id;
  return (
    <>
      <div className="preset-grid">
        {PRESETS.map(p => (
          <button key={p.id} type="button" className={`preset ${active === p.id ? "is-on" : ""}`} onClick={() => void core.updateEncoding({ fps: p.fps, kbps: p.kbps, priority: p.priority, maxHeight: p.resolution === "source" ? 0 : Number(p.resolution) })}>
            <b>{p.label}</b>
            <small>{p.hint}</small>
          </button>
        ))}
      </div>
      <Field label="Débit">
        <Select label="Débit" value={target.kbps} options={BITRATES} onChange={kbps => void core.updateEncoding({ kbps })} />
      </Field>
      {roomMax > 0 && roomMax < target.kbps && <p className="warn-text">Le salon limite le débit à {mbps(roomMax)} Mb/s.</p>}
      <Field label="Cadence">
        <Select label="Cadence" value={target.fps} options={FPS_OPTIONS} onChange={fps => void core.updateEncoding({ fps })} />
      </Field>
      <Field label="Définition">
        <Select<Resolution> label="Définition" value={resolution} options={RESOLUTIONS} onChange={r => void core.updateEncoding({ maxHeight: r === "source" ? 0 : Number(r) })} />
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
      <Field label="Son du stream">
        <Select label="Son du stream" value={target.audioKbps} options={[128, 192, 256, 320, 510].map(value => ({ value, label: `${value} kb/s` }))} onChange={audioKbps => void core.updateEncoding({ audioKbps })} />
      </Field>
      <Field label="Enregistrer à chaque lancement">
        <Toggle label="Enregistrer à chaque lancement" checked={autoRecord} onChange={on => void core.updateSettings({ stream: { ...get().settings!.stream, autoRecord: on } })} />
      </Field>
    </>
  );
}

// ---------------------------------------------------------------- public

function AudiencePanel() {
  const publish = useApp(s => s.publish)!;
  const count = useApp(s => s.room?.streams.find(x => x.id === s.publish?.streamId)?.viewers.length ?? 0);
  const overlay = useApp(s => s.settings!.overlay);
  const hotkey = useApp(s => s.settings!.hotkeys.control);
  const lastRecording = useApp(s => s.lastRecording);
  const setOverlay = (patch: Partial<typeof overlay>) => {
    const next = { ...overlay, ...patch };
    void core.updateSettings({ overlay: next });
    window.spoka.overlaySend({ type: "settings", settings: next });
  };
  return (
    <>
      <p className="audience-count">{plural(count, "spectateur")}</p>
      {publish.viewers.length === 0 && <p className="muted-text">Partage le lien du salon pour inviter tes amis.</p>}
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
      <Field label="Spectateurs maximum">
        <Select label="Spectateurs maximum" value={publish.maxViewers} options={[0, 1, 2, 3, 4, 6, 8, 12].map(value => ({ value, label: value ? String(value) : "Sans limite" }))} onChange={maxViewers => core.updateStreamInfo({ maxViewers })} />
      </Field>
      <Field label="Dessin des spectateurs">
        <Toggle label="Dessin des spectateurs" checked={publish.allowDraw} onChange={allowDraw => core.updateStreamInfo({ allowDraw })} />
      </Field>
      {publish.controlScope && (
        <Field label="Demandes de main" hint={publish.controlScope === "window" ? "Un ami peut jouer dans cette fenêtre, seulement si tu acceptes" : "Tu partages un écran entier : pour un jeu, partage plutôt sa fenêtre"}>
          <Toggle label="Demandes de main" checked={publish.allowControl} onChange={allowControl => core.updateStreamInfo({ allowControl })} />
        </Field>
      )}
      {publish.controller && (
        <div className="studio-control">
          <Gamepad2 size={16} />
          <span>
            <b>{memberOf(publish.controller)?.name ?? "?"}</b> a la main
            {publish.controlBlocked ? <small>Ses gestes sont ignorés tant que tu es sur une autre fenêtre</small> : hotkey && <small className="is-plain">{hotkey} pour la reprendre</small>}
          </span>
          <Button variant="danger" onClick={() => core.endControl()}>
            Reprendre
          </Button>
        </div>
      )}
      <Field label="Chat sur ton écran">
        <Toggle label="Chat sur ton écran" checked={overlay.enabled && overlay.chat} onChange={chat => setOverlay({ chat, enabled: chat || overlay.reactions })} />
      </Field>
      <Field label="Réactions sur ton écran">
        <Toggle label="Réactions sur ton écran" checked={overlay.enabled && overlay.reactions} onChange={reactions => setOverlay({ reactions, enabled: reactions || overlay.chat })} />
      </Field>
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
    </>
  );
}

// ---------------------------------------------------------------- activité et notes

const ACTIVITY_ICONS: Record<ActivityItem["kind"], LucideIcon> = { people: Users, watch: Radio, reaction: Bell, clip: Scissors, poll: Vote, hand: Hand, marker: Tag };

function ActivityPanel() {
  const activity = useApp(s => s.activity);
  const hasMarkers = activity.some(a => a.kind === "marker");
  return (
    <>
      {activity.length === 0 && <p className="muted-text">Tout ce qui se passe pendant ton direct s'affichera ici.</p>}
      <div className="activity-list">
        {[...activity].reverse().map(item => {
          const Icon = ACTIVITY_ICONS[item.kind];
          return (
            <div key={item.id} className={`activity-item is-${item.kind}`}>
              <Icon size={13} />
              <span>{item.text}</span>
              <time>{clock(item.at)}</time>
            </div>
          );
        })}
      </div>
      {hasMarkers && (
        <Button icon={<Copy size={15} />} onClick={() => core.copyMarkers()}>
          Copier les marqueurs
        </Button>
      )}
    </>
  );
}

function NotesPanel() {
  const notes = useApp(s => s.settings!.regie.notes);
  const [draft, setDraft] = useState(notes);
  return <textarea className="input regie-notes" rows={5} value={draft} placeholder="Ce que tu veux garder sous les yeux. Personne d'autre ne le voit." aria-label="Bloc-notes" onChange={e => setDraft(e.target.value)} onBlur={() => draft !== notes && core.updateRegie({ notes: draft })} />;
}

export interface PanelDefinition {
  title: string;
  icon: LucideIcon;
  body: () => ReactNode;
  tools?: () => ReactNode;
}

export const PANELS: Record<PanelId, PanelDefinition> = {
  actions: { title: "Actions rapides", icon: Zap, body: () => <ActionsPanel />, tools: () => <ActionsChoice /> },
  health: { title: "Santé du stream", icon: Activity, body: () => <HealthPanel /> },
  info: { title: "Infos du stream", icon: Pencil, body: () => <InfoPanel /> },
  scenes: { title: "Scènes", icon: Layers, body: () => <Scenes />, tools: () => <ScenesAdd /> },
  sources: { title: "Source et caméra", icon: Camera, body: () => <SourcesPanel /> },
  screens: { title: "Écrans d'attente", icon: Clapperboard, body: () => <ScreensPanel /> },
  mixer: { title: "Table de mixage", icon: AudioLines, body: () => <MixerPanel />, tools: () => <MixerAdd /> },
  quality: { title: "Qualité", icon: Gauge, body: () => <QualityPanel /> },
  audience: { title: "Public", icon: Users, body: () => <AudiencePanel /> },
  activity: { title: "Activité", icon: ListChecks, body: () => <ActivityPanel /> },
  chat: { title: "Chat", icon: MessageSquare, body: () => <Chat /> },
  notes: { title: "Bloc-notes", icon: NotebookPen, body: () => <NotesPanel /> },
};

/** L'heure courante du direct, pour la barre de direct. */
export function LiveTimer() {
  const startedAt = useApp(s => s.room?.streams.find(x => x.id === s.publish?.streamId)?.startedAt);
  return startedAt ? <Uptime since={startedAt} /> : null;
}
