import { AppWindow, Camera, Check, Clapperboard, FileVideo, Globe, Loader2, Monitor, Plus, Radio, RefreshCw, Volume2, VolumeX, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { isVirtualInput } from "@shared/ipc.ts";
import type { AudioApp, CaptureSource, CodecChoice, Resolution, VideoPriority } from "@shared/ipc.ts";
import { videoUrl } from "@shared/protocol.ts";
import type { VideoSource } from "../engine/capture.ts";
import { core } from "../engine/core.ts";
import type { AudioChoice } from "../engine/core.ts";
import { get, set, useApp } from "../state/store.ts";
import { mbps } from "../ui/format.ts";
import { Button, Field, Modal, Popover, Segmented, Select, Toggle } from "../ui/kit.tsx";
import { ObsPanel } from "./ObsPanel.tsx";

export const RESOLUTIONS: { value: Resolution; label: string }[] = [
  { value: "source", label: "Source (native)" },
  { value: "2160", label: "4K (2160p)" },
  { value: "1440", label: "1440p" },
  { value: "1080", label: "1080p" },
  { value: "720", label: "720p" },
];
export const FPS_OPTIONS = [
  { value: 30, label: "30 i/s" },
  { value: 60, label: "60 i/s" },
  { value: 120, label: "120 i/s" },
];
export const BITRATES = [2500, 5000, 8000, 12000, 20000, 30000, 40000, 60000, 80000, 120000].map(value => ({ value, label: `${mbps(value)} Mb/s` }));
export const CODECS: { value: CodecChoice; label: string }[] = [
  { value: "auto", label: "Automatique" },
  { value: "video/AV1", label: "AV1" },
  { value: "video/H265", label: "H265" },
  { value: "video/H264", label: "H264" },
  { value: "video/VP9", label: "VP9" },
];

interface Preset {
  id: string;
  label: string;
  hint: string;
  resolution: Resolution;
  fps: number;
  kbps: number;
  priority: VideoPriority;
}

export const PRESETS: Preset[] = [
  { id: "smooth", label: "Fluide", hint: "Jeux : 1080p, 60 i/s", resolution: "1080", fps: 60, kbps: 12000, priority: "motion" },
  { id: "sharp", label: "Net", hint: "Texte, code : native, 30 i/s", resolution: "source", fps: 30, kbps: 12000, priority: "detail" },
  { id: "cinema", label: "Film", hint: "Vidéo : 1080p, 30 i/s", resolution: "1080", fps: 30, kbps: 8000, priority: "motion" },
  { id: "max", label: "Maximum", hint: "Native, 60 i/s, 40 Mb/s", resolution: "source", fps: 60, kbps: 40000, priority: "motion" },
];

type Tab = "screen" | "window" | "camera" | "file" | "web" | "obs";

const TABS: { value: Tab; label: string; icon: typeof Monitor }[] = [
  { value: "screen", label: "Écrans", icon: Monitor },
  { value: "window", label: "Fenêtres", icon: AppWindow },
  { value: "camera", label: "Caméra", icon: Camera },
  { value: "file", label: "Fichier vidéo", icon: FileVideo },
  { value: "web", label: "Page web", icon: Globe },
  { value: "obs", label: "OBS", icon: Clapperboard },
];

const choiceKey = (c: AudioChoice) => (c.type === "system" ? "system" : c.type === "app" ? `app:${c.pid}` : `device:${c.deviceId}`);
const choiceLabel = (c: AudioChoice) => (c.type === "system" ? "Tout le PC" : c.type === "app" ? c.name : c.label);

function AudioPicker({ value, onChange, engineReady }: { value: AudioChoice[]; onChange: (next: AudioChoice[]) => void; engineReady: boolean }) {
  const [apps, setApps] = useState<AudioApp[]>([]);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);

  const refresh = () => {
    if (engineReady) void window.spoka.audioApps().then(setApps).catch(() => {});
    void navigator.mediaDevices.enumerateDevices().then(list => setDevices(list.filter(d => d.kind === "audioinput" && d.deviceId !== "default" && d.deviceId !== "communications")));
  };
  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, 2500);
    return () => clearInterval(timer);
  }, [engineReady]);

  const cable = devices.find(d => isVirtualInput(d.label));
  const isSoundboard = (a: AudioApp) => /SpokaSoundBoard/i.test(a.name);

  const toggle = (choice: AudioChoice) => {
    const key = choiceKey(choice);
    if (value.some(c => choiceKey(c) === key)) return onChange(value.filter(c => choiceKey(c) !== key));
    // « Tout le PC » contient déjà chaque application : les garder ensemble doublerait leur son.
    const compatible = value.filter(c => (choice.type === "system" ? c.type !== "app" : choice.type === "app" ? c.type !== "system" : true));
    onChange([...compatible, choice]);
  };

  return (
    <div className="audio-picker">
      <div className="audio-chips">
        {value.length === 0 && (
          <span className="audio-chip is-empty">
            <VolumeX size={14} /> Sans son
          </span>
        )}
        {value.map(c => (
          <span key={choiceKey(c)} className="audio-chip">
            {c.type === "app" && c.icon ? <img src={c.icon} alt="" /> : <Volume2 size={14} />}
            {choiceLabel(c)}
            <button type="button" aria-label={`Retirer ${choiceLabel(c)}`} onClick={() => toggle(c)}>
              <X size={12} />
            </button>
          </span>
        ))}
        <Popover
          trigger={(open, toggleMenu) => (
            <button type="button" className={`audio-add ${open ? "is-on" : ""}`} onClick={toggleMenu}>
              <Plus size={14} /> Son
            </button>
          )}
        >
          {close => (
            <div className="menu">
              <div className="menu-title">Tout le son</div>
              <button
                type="button"
                className={`menu-item ${value.some(c => c.type === "system") ? "is-on" : ""}`}
                onClick={() => {
                  toggle({ type: "system" });
                  close();
                }}
              >
                <span>Tout le PC</span>
                <small>Sauf SpokaStream, donc sans écho</small>
              </button>
              {cable && (
                <>
                  <div className="menu-title">Micro virtuel</div>
                  <button
                    type="button"
                    className={`menu-item ${value.some(c => c.type === "device" && c.deviceId === cable.deviceId) ? "is-on" : ""}`}
                    onClick={() => {
                      toggle({ type: "device", deviceId: cable.deviceId, label: "SpokaSoundBoard" });
                      close();
                    }}
                  >
                    <span>SpokaSoundBoard</span>
                    <small>Musique, sons et voix, déjà mixés. {cable.label}</small>
                  </button>
                </>
              )}
              {apps.length > 0 && <div className="menu-title">Applications qui font du son</div>}
              {apps.filter(a => !cable || !isSoundboard(a)).map(a => (
                <button
                  key={a.pid}
                  type="button"
                  className={`menu-item ${value.some(c => c.type === "app" && c.pid === a.pid) ? "is-on" : ""}`}
                  onClick={() => {
                    toggle({ type: "app", pid: a.pid, name: a.name, icon: a.icon });
                    close();
                  }}
                >
                  <span>
                    {a.icon && <img src={a.icon} alt="" />}
                    {a.name}
                    {a.peak > 0.001 && <i className="sound-dot" />}
                  </span>
                  {isSoundboard(a) ? <small>Il joue sur plusieurs sorties à la fois : le son peut arriver en double. Le micro virtuel évite ça.</small> : a.title && <small>{a.title}</small>}
                </button>
              ))}
              {devices.length > 0 && <div className="menu-title">Entrées (micro, carte d'acquisition)</div>}
              {devices.map(d => (
                <button
                  key={d.deviceId}
                  type="button"
                  className={`menu-item ${value.some(c => c.type === "device" && c.deviceId === d.deviceId) ? "is-on" : ""}`}
                  onClick={() => {
                    toggle({ type: "device", deviceId: d.deviceId, label: d.label });
                    close();
                  }}
                >
                  <span>{d.label || "Entrée audio"}</span>
                </button>
              ))}
            </div>
          )}
        </Popover>
      </div>
      {!engineReady && <p className="warn-text">Moteur audio indisponible : seules les entrées restent possibles.</p>}
    </div>
  );
}

export function GoLiveModal() {
  const settings = useApp(s => s.settings)!;
  const audioEngine = useApp(s => s.audioEngine);
  const benching = useApp(s => s.benching);
  const publish = useApp(s => s.publish);
  const switching = !!publish;
  const defaults = settings.stream;

  const obsConnected = useApp(s => s.obs.connected);
  const preset = useApp(s => s.goLivePreset);
  const [tab, setTab] = useState<Tab>(preset?.tab ?? (obsConnected ? "obs" : "screen"));
  const [webUrl, setWebUrl] = useState(preset?.url ?? "");
  const [sources, setSources] = useState<CaptureSource[]>([]);
  const [cameras, setCameras] = useState<MediaDeviceInfo[]>([]);
  const [selected, setSelected] = useState<VideoSource | null>(null);
  const gameCapture = useApp(s => s.settings!.stream.gameCapture);
  const [audio, setAudio] = useState<AudioChoice[]>([]);
  const [audioTouched, setAudioTouched] = useState(false);
  const [title, setTitle] = useState("");
  const [resolution, setResolution] = useState<Resolution>(defaults.resolution);
  const [fps, setFps] = useState(defaults.fps);
  const [kbps, setKbps] = useState(defaults.kbps);
  const [priority, setPriority] = useState<VideoPriority>(defaults.priority);
  const [codec, setCodec] = useState<CodecChoice>(defaults.codec);
  const [audioKbps, setAudioKbps] = useState(defaults.audioKbps);
  const [advanced, setAdvanced] = useState(false);
  const [starting, setStarting] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const engineReady = audioEngine === "ready";
  const close = () => set({ goLiveOpen: false, goLivePreset: null });

  useEffect(() => {
    let alive = true;
    const load = () =>
      window.spoka.listSources().then(list => {
        if (alive) setSources(list);
      });
    void load();
    const timer = setInterval(() => void load(), 3000);
    void navigator.mediaDevices.enumerateDevices().then(list => setCameras(list.filter(d => d.kind === "videoinput")));
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);

  /** Tant qu'on n'a rien touché, le son suit la source : la fenêtre choisie, ou tout le PC pour un écran. */
  const pick = (source: VideoSource) => {
    setSelected(source);
    if (audioTouched || !engineReady) return;
    if (source.kind === "window" && source.source.app) {
      setAudio([{ type: "app", pid: source.source.app.pid, name: source.source.app.name, icon: source.source.icon }]);
    } else if (source.kind === "screen") {
      setAudio([{ type: "system" }]);
    } else {
      setAudio([]);
    }
  };

  // OBS se branche depuis un autre logiciel : dès qu'il arrive, c'est forcément ce qu'on veut diffuser.
  useEffect(() => {
    if (tab === "obs" && obsConnected) pick(core.obsSource());
    else if (selected?.kind === "obs" && !obsConnected) setSelected(null);
  }, [tab, obsConnected]);

  useEffect(() => {
    const url = tab === "web" ? videoUrl(/^[a-z]+:\/\//i.test(webUrl.trim()) ? webUrl : `https://${webUrl.trim()}`) : null;
    if (url && webUrl.trim()) pick({ kind: "web", url });
    else if (selected?.kind === "web") setSelected(null);
  }, [tab, webUrl]);

  useEffect(() => {
    if (selected || !sources.length || tab !== "screen") return;
    const primary = sources.find(s => s.kind === "screen");
    if (primary) pick({ kind: "screen", source: primary });
  }, [sources]);

  const activePreset = PRESETS.find(p => p.resolution === resolution && p.fps === fps && p.kbps === kbps && p.priority === priority)?.id;
  const applyPreset = (p: Preset) => {
    setResolution(p.resolution);
    setFps(p.fps);
    setKbps(p.kbps);
    setPriority(p.priority);
  };

  const list = useMemo(() => sources.filter(s => s.kind === tab), [sources, tab]);
  const isSelected = (id: string) => (selected?.kind === "screen" || selected?.kind === "window") && selected.source.id === id;
  const viewers = useApp(s => Math.max(1, (s.room?.members.length ?? 2) - 1));

  const start = async () => {
    if (!selected) return;
    setStarting(true);
    void core.updateSettings({ stream: { ...get().settings!.stream, resolution, fps, kbps, priority, codec, audioKbps } });
    if (switching) {
      await core.switchSource(selected, audioTouched || selected.kind === "window" || selected.kind === "obs" ? audio : null);
      await core.updateEncoding({ kbps, fps, priority, codec, audioKbps, maxHeight: resolution === "source" ? 0 : Number(resolution) });
    } else {
      await core.goLive({ source: selected, audio, title: title.trim(), resolution, fps, kbps, codec, priority, audioKbps, allowDraw: defaults.allowDraw, maxViewers: defaults.maxViewers });
    }
    setStarting(false);
    close();
  };

  return (
    <Modal
      title={switching ? "Changer de source" : "Lancer un stream"}
      onClose={close}
      width={940}
      footer={
        <>
          <span className="golive-summary">
            {benching ? (
              <>
                <Loader2 size={14} className="spin" /> Mesure de tes encodeurs : {benching}
              </>
            ) : (
              <>≈ {mbps((kbps + audioKbps) * viewers)} Mb/s d'envoi avec {viewers} spectateur{viewers > 1 ? "s" : ""}</>
            )}
          </span>
          <Button onClick={close}>Annuler</Button>
          <Button variant="live" icon={switching ? <RefreshCw size={16} /> : <Radio size={17} />} disabled={!selected || starting} onClick={() => void start()}>
            {starting ? "Préparation…" : switching ? "Changer" : "Lancer le stream"}
          </Button>
        </>
      }
    >
      <div className="golive">
        <div className="golive-sources">
          <div className="golive-tabs" role="tablist">
            {TABS.map(t => (
              <button key={t.value} type="button" role="tab" aria-selected={tab === t.value} className={tab === t.value ? "is-on" : ""} onClick={() => setTab(t.value)}>
                <t.icon size={15} />
                {t.label}
              </button>
            ))}
          </div>

          {(tab === "screen" || tab === "window") && (
            <div className="source-grid">
              {list.map(source => (
                <button key={source.id} type="button" className={`source-card ${isSelected(source.id) ? "is-on" : ""}`} onClick={() => pick(source.kind === "screen" ? { kind: "screen", source } : { kind: "window", source })}>
                  {source.thumbnail ? <img className="source-thumb" src={source.thumbnail} alt="" /> : <span className="source-thumb is-empty">Aperçu indisponible</span>}
                  <span className="source-name">
                    {source.icon && <img src={source.icon} alt="" />}
                    <span>{source.name}</span>
                  </span>
                  {isSelected(source.id) && (
                    <i className="source-check">
                      <Check size={14} />
                    </i>
                  )}
                </button>
              ))}
              {list.length === 0 && <p className="muted-text">Recherche des sources…</p>}
            </div>
          )}

          {tab === "camera" && (
            <div className="device-list">
              {cameras.map(c => (
                <button
                  key={c.deviceId}
                  type="button"
                  className={`device-row ${selected?.kind === "camera" && selected.deviceId === c.deviceId ? "is-on" : ""}`}
                  onClick={() => pick({ kind: "camera", deviceId: c.deviceId, label: c.label || "Caméra" })}
                >
                  <Camera size={16} />
                  {c.label || "Caméra"}
                </button>
              ))}
              {cameras.length === 0 && <p className="muted-text">Aucune caméra ni carte d'acquisition détectée.</p>}
            </div>
          )}

          {tab === "obs" && <ObsPanel />}

          {tab === "web" && (
            <div className="file-pick">
              <Globe size={32} />
              <p>SpokaStream ouvre la page dans sa propre fenêtre et diffuse son image et son son, rien d'autre du PC. Tu y navigues normalement, et ton compte reste connecté d'une fois sur l'autre. Les vidéos protégées (Netflix, Disney+…) restent noires : c'est voulu par ces services.</p>
              <input className="input" autoFocus value={webUrl} placeholder="https://…" spellCheck={false} aria-label="Adresse de la page" onChange={e => setWebUrl(e.target.value)} />
            </div>
          )}

          {tab === "file" && (
            <div className="file-pick">
              <input
                ref={fileInput}
                type="file"
                accept="video/*,.mkv"
                hidden
                onChange={e => {
                  const file = e.target.files?.[0];
                  if (file) pick({ kind: "file", file });
                }}
              />
              <FileVideo size={32} />
              <p>{selected?.kind === "file" ? selected.file.name : "Diffuse un film ou une vidéo de ton PC, sans partager ton écran. Tu gardes la pause et la position, et le son du fichier part avec."}</p>
              <Button onClick={() => fileInput.current?.click()}>Choisir un fichier</Button>
            </div>
          )}
        </div>

        <div className="golive-side">
          {!switching && (
            <label className="stack">
              <span className="label">Titre (facultatif)</span>
              <input className="input" value={title} maxLength={80} placeholder="Ce que tu vas montrer" onChange={e => setTitle(e.target.value)} />
            </label>
          )}

          <div className="stack">
            <span className="label">Son du stream</span>
            <AudioPicker
              value={audio}
              engineReady={engineReady}
              onChange={next => {
                setAudioTouched(true);
                setAudio(next);
              }}
            />
          </div>

          <div className="stack">
            <span className="label">Qualité</span>
            <div className="preset-grid">
              {PRESETS.map(p => (
                <button key={p.id} type="button" className={`preset ${activePreset === p.id ? "is-on" : ""}`} onClick={() => applyPreset(p)}>
                  <b>{p.label}</b>
                  <small>{p.hint}</small>
                </button>
              ))}
            </div>
          </div>

          {selected?.kind === "window" && (
            <Field label="Capture de jeu" hint="Garde ta souris visible dans les jeux OpenGL comme Project Zomboid. Les autres jeux gardent la capture normale.">
              <Toggle label="Capture de jeu" checked={gameCapture} onChange={value => void core.updateSettings({ stream: { ...get().settings!.stream, gameCapture: value } })} />
            </Field>
          )}

          <button type="button" className="link" onClick={() => setAdvanced(!advanced)}>
            {advanced ? "Masquer les réglages" : "Personnaliser"}
          </button>
          {advanced && (
            <div className="golive-advanced">
              <Field label="Définition">
                <Select label="Définition" value={resolution} options={RESOLUTIONS} onChange={setResolution} />
              </Field>
              <Field label="Cadence">
                <Select label="Cadence" value={fps} options={FPS_OPTIONS} onChange={setFps} />
              </Field>
              <Field label="Débit">
                <Select label="Débit" value={kbps} options={BITRATES} onChange={setKbps} />
              </Field>
              <Field label="Codec">
                <Select label="Codec" value={codec} options={CODECS} onChange={setCodec} />
              </Field>
              <Field label="Priorité">
                <Segmented
                  label="Priorité"
                  value={priority}
                  options={[
                    { value: "motion", label: "Fluidité" },
                    { value: "detail", label: "Netteté" },
                  ]}
                  onChange={setPriority}
                />
              </Field>
              <Field label="Qualité du son">
                <Select
                  label="Qualité du son"
                  value={audioKbps}
                  options={[128, 192, 256, 320, 510].map(value => ({ value, label: `${value} kb/s` }))}
                  onChange={setAudioKbps}
                />
              </Field>
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}
