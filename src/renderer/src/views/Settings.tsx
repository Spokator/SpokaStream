import { Bell, Check, Copy, Download, FolderOpen, Gauge, Info, Keyboard, Layers, Mic, Palette, Radio, Server, User } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { HostStatus, HotkeyMap, LatencyMode, Settings } from "@shared/ipc.ts";
import { core } from "../engine/core.ts";
import { cachedBench, measureEncoders, rankResults } from "../engine/encoders.ts";
import type { BenchResult } from "../engine/encoders.ts";
import { set, toast, useApp } from "../state/store.ts";
import type { SettingsSection } from "../state/store.ts";
import { Button, Field, Meter, Segmented, Select, Toggle } from "../ui/kit.tsx";
import { BITRATES, FPS_OPTIONS, RESOLUTIONS } from "./GoLive.tsx";
import { ProfileEditor } from "./Onboarding.tsx";

const SECTIONS: { id: SettingsSection; label: string; icon: typeof User }[] = [
  { id: "profile", label: "Profil", icon: User },
  { id: "appearance", label: "Apparence", icon: Palette },
  { id: "voice", label: "Son et voix", icon: Mic },
  { id: "stream", label: "Diffusion", icon: Radio },
  { id: "watch", label: "Regarder", icon: Gauge },
  { id: "overlay", label: "Overlay en jeu", icon: Layers },
  { id: "hotkeys", label: "Raccourcis", icon: Keyboard },
  { id: "notifications", label: "Notifications", icon: Bell },
  { id: "server", label: "Serveur", icon: Server },
  { id: "about", label: "À propos", icon: Info },
];

const update = (patch: Partial<Settings>) => void core.updateSettings(patch);

function useDevices(kind: MediaDeviceKind) {
  const [devices, setDevices] = useState<{ value: string; label: string }[]>([{ value: "default", label: "Par défaut" }]);
  useEffect(() => {
    const load = () =>
      navigator.mediaDevices.enumerateDevices().then(list =>
        setDevices([
          { value: "default", label: "Par défaut" },
          ...list.filter(d => d.kind === kind && d.deviceId !== "default" && d.deviceId !== "communications").map(d => ({ value: d.deviceId, label: d.label || "Périphérique" })),
        ]),
      );
    void load();
    navigator.mediaDevices.addEventListener("devicechange", load);
    return () => navigator.mediaDevices.removeEventListener("devicechange", load);
  }, [kind]);
  return devices;
}

/** Pour savoir si le micro marche sans rejoindre de vocal. */
function MicTest({ deviceId }: { deviceId: string }) {
  const [running, setRunning] = useState(false);
  const analyser = useRef<AnalyserNode | null>(null);
  const buffer = useRef(new Float32Array(1024));

  useEffect(() => {
    if (!running) return;
    let stream: MediaStream | null = null;
    let context: AudioContext | null = null;
    let cancelled = false;
    void navigator.mediaDevices
      .getUserMedia({ audio: deviceId === "default" ? true : { deviceId: { exact: deviceId } } })
      .then(s => {
        if (cancelled) return s.getTracks().forEach(t => t.stop());
        stream = s;
        context = new AudioContext();
        analyser.current = context.createAnalyser();
        analyser.current.fftSize = 1024;
        context.createMediaStreamSource(s).connect(analyser.current);
      })
      .catch(e => {
        toast(`Micro inaccessible : ${e.message}`, "error");
        setRunning(false);
      });
    return () => {
      cancelled = true;
      analyser.current = null;
      stream?.getTracks().forEach(t => t.stop());
      void context?.close();
    };
  }, [running, deviceId]);

  const read = () => {
    if (!analyser.current) return 0;
    analyser.current.getFloatTimeDomainData(buffer.current);
    let sum = 0;
    for (const x of buffer.current) sum += x * x;
    return Math.max(0, Math.min(1, (20 * Math.log10(Math.sqrt(sum / 1024) + 1e-6) + 60) / 60));
  };

  return (
    <div className="mic-test">
      <Button onClick={() => setRunning(!running)}>{running ? "Arrêter le test" : "Tester le micro"}</Button>
      {running && <Meter read={read} />}
    </div>
  );
}

function KeyCapture({ value, onChange }: { value: string; onChange: (code: number, name: string) => void }) {
  const [listening, setListening] = useState(false);
  useEffect(() => {
    if (!listening) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      onChange(e.keyCode, e.key.length === 1 ? e.key.toUpperCase() : e.code);
      setListening(false);
    };
    const onMouse = (e: MouseEvent) => {
      if (e.button < 3) return;
      e.preventDefault();
      onChange(e.button === 3 ? 0x05 : 0x06, e.button === 3 ? "Souris 4" : "Souris 5");
      setListening(false);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onMouse);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onMouse);
    };
  }, [listening, onChange]);
  return (
    <button type="button" className={`key-capture ${listening ? "is-on" : ""}`} onClick={() => setListening(true)}>
      {listening ? "Appuie sur une touche…" : value}
    </button>
  );
}

const MODIFIERS = new Set(["Control", "Shift", "Alt", "Meta"]);

function acceleratorOf(e: KeyboardEvent) {
  if (MODIFIERS.has(e.key)) return null;
  const parts = [e.ctrlKey && "Ctrl", e.altKey && "Alt", e.shiftKey && "Shift"].filter(Boolean) as string[];
  const key = /^Key[A-Z]$/.test(e.code) ? e.code.slice(3) : /^Digit\d$/.test(e.code) ? e.code.slice(5) : /^F\d+$/.test(e.code) ? e.code : e.key.length === 1 ? e.key.toUpperCase() : null;
  if (!key || (!parts.length && !/^F\d+$/.test(key))) return null;
  return [...parts, key].join("+");
}

function HotkeyInput({ value, onChange }: { value: string; onChange: (accelerator: string) => void }) {
  const [listening, setListening] = useState(false);
  useEffect(() => {
    if (!listening) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      if (e.key === "Escape") return setListening(false);
      if (e.key === "Backspace") {
        onChange("");
        return setListening(false);
      }
      const accelerator = acceleratorOf(e);
      if (accelerator) {
        onChange(accelerator);
        setListening(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [listening, onChange]);
  return (
    <button type="button" className={`key-capture ${listening ? "is-on" : ""}`} onClick={() => setListening(true)}>
      {listening ? "Combinaison… (Retour arrière pour retirer)" : value || "Aucun"}
    </button>
  );
}

function ProfileSection({ s }: { s: Settings }) {
  const [profile, setProfile] = useState(s.profile);
  return (
    <>
      <h1>Profil</h1>
      <ProfileEditor {...profile} onChange={setProfile} />
      <Button variant="primary" disabled={!profile.name.trim()} onClick={() => void core.updateProfile({ ...profile, name: profile.name.trim() }).then(() => toast("Profil enregistré", "success"))}>
        Enregistrer
      </Button>
    </>
  );
}

const ACCENTS = ["#7c5cff", "#4f8dff", "#22b8cf", "#2fbf8a", "#f59e0b", "#f4638d", "#ef4444"];

function AppearanceSection({ s }: { s: Settings }) {
  return (
    <>
      <h1>Apparence</h1>
      <Field label="Couleur d'accent">
        <div className="accent-list" role="radiogroup" aria-label="Couleur d'accent">
          {ACCENTS.map(accent => (
            <button key={accent} type="button" role="radio" aria-checked={s.accent === accent} aria-label={accent} style={{ background: accent }} onClick={() => update({ accent })}>
              {s.accent === accent && <Check size={15} />}
            </button>
          ))}
        </div>
      </Field>
      <Field label="Taille de l'interface">
        <Segmented
          label="Taille de l'interface"
          value={s.uiScale}
          options={[
            { value: 0.9, label: "Petite" },
            { value: 1, label: "Normale" },
            { value: 1.1, label: "Grande" },
            { value: 1.25, label: "Très grande" },
          ]}
          onChange={uiScale => update({ uiScale })}
        />
      </Field>
      <Field label="Ambiance" hint="Les bandes autour de l'image prennent ses couleurs">
        <Toggle label="Ambiance" checked={s.ambient} onChange={ambient => update({ ambient })} />
      </Field>
    </>
  );
}

function VoiceSection({ s }: { s: Settings }) {
  const mics = useDevices("audioinput");
  const outputs = useDevices("audiooutput");
  return (
    <>
      <h1>Son et voix</h1>
      <Field label="Micro">
        <Select label="Micro" value={s.micId} options={mics} onChange={micId => update({ micId })} />
      </Field>
      <MicTest deviceId={s.micId} />
      <Field label="Sortie" hint="Pour la voix et le son des streams">
        <Select label="Sortie" value={s.outputId} options={outputs} onChange={outputId => update({ outputId })} />
      </Field>
      <Field label="Mode du micro">
        <Segmented
          label="Mode du micro"
          value={s.voiceMode}
          options={[
            { value: "open", label: "Toujours actif" },
            { value: "ptt", label: "Appuyer pour parler" },
          ]}
          onChange={voiceMode => update({ voiceMode })}
        />
      </Field>
      {s.voiceMode === "ptt" && (
        <Field label="Touche pour parler" hint="Fonctionne aussi quand un jeu a le focus">
          <KeyCapture value={s.pttKeyName} onChange={(pttKey, pttKeyName) => update({ pttKey, pttKeyName })} />
        </Field>
      )}
      <Field label="Réduction du bruit">
        <Toggle label="Réduction du bruit" checked={s.noiseSuppression} onChange={noiseSuppression => update({ noiseSuppression })} />
      </Field>
      <Field label="Annulation de l'écho" hint="Inutile avec un casque">
        <Toggle label="Annulation de l'écho" checked={s.echoCancellation} onChange={echoCancellation => update({ echoCancellation })} />
      </Field>
      <Field label="Réglage automatique du niveau">
        <Toggle label="Réglage automatique" checked={s.autoGain} onChange={autoGain => update({ autoGain })} />
      </Field>
      <Field label="Qualité de la voix">
        <Select label="Qualité de la voix" value={s.voiceKbps} options={[32, 64, 96, 128].map(value => ({ value, label: `${value} kb/s` }))} onChange={voiceKbps => update({ voiceKbps })} />
      </Field>
    </>
  );
}

function BenchPanel() {
  const stream = useApp(s => s.settings!.stream);
  const [results, setResults] = useState<BenchResult[] | null>(() => cachedBench(1080, 60));
  const [running, setRunning] = useState<string | null>(null);

  const run = async () => {
    const sources = await window.spoka.listSources();
    setRunning("préparation");
    const measured = await measureEncoders(sources.find(s => s.kind === "screen")?.id ?? null, 1920, 1080, 60, stream.kbps, setRunning);
    setRunning(null);
    setResults(measured);
  };

  return (
    <div className="bench">
      <Field label="Encodeurs de ce PC" hint="Mesure réelle en 1080p, 60 i/s">
        <Button disabled={!!running} onClick={() => void run()}>
          {running ? `Mesure : ${running}` : results ? "Mesurer à nouveau" : "Mesurer"}
        </Button>
      </Field>
      {results && (
        <table className="bench-table">
          <tbody>
            {rankResults(results).map((r, i) => (
              <tr key={r.mime} className={i === 0 && r.ok ? "is-best" : ""}>
                <td>{r.label}</td>
                <td>{r.hardware ? "Carte graphique" : "Processeur"}</td>
                <td>{r.encMs ?? "?"} ms</td>
                <td>{r.fps} i/s</td>
                <td>{r.ok ? (i === 0 ? "Choisi" : "Tient") : "Décroche"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function StreamSection({ s }: { s: Settings }) {
  const setStream = (patch: Partial<Settings["stream"]>) => update({ stream: { ...s.stream, ...patch } });
  return (
    <>
      <h1>Diffusion</h1>
      <BenchPanel />
      <Field label="Définition par défaut">
        <Select label="Définition" value={s.stream.resolution} options={RESOLUTIONS} onChange={resolution => setStream({ resolution })} />
      </Field>
      <Field label="Cadence par défaut">
        <Select label="Cadence" value={s.stream.fps} options={FPS_OPTIONS} onChange={fps => setStream({ fps })} />
      </Field>
      <Field label="Débit par défaut" hint="Par spectateur : chacun a son propre flux">
        <Select label="Débit" value={s.stream.kbps} options={BITRATES} onChange={kbps => setStream({ kbps })} />
      </Field>
      <Field label="Limite de spectateurs" hint="Protège ta connexion montante">
        <Select
          label="Limite de spectateurs"
          value={s.stream.maxViewers}
          options={[
            { value: 0, label: "Aucune" },
            ...[2, 3, 4, 6, 8].map(value => ({ value, label: String(value) })),
          ]}
          onChange={maxViewers => setStream({ maxViewers })}
        />
      </Field>
      <Field label="Égaliser le volume du stream" hint="Remonte un son trop faible, sans jamais saturer">
        <Toggle label="Égaliser le volume" checked={s.stream.normalizeAudio} onChange={normalizeAudio => setStream({ normalizeAudio })} />
      </Field>
      <Field label="Dessin des spectateurs" hint="Ils peuvent pointer et dessiner sur ton stream">
        <Toggle label="Dessin des spectateurs" checked={s.stream.allowDraw} onChange={allowDraw => setStream({ allowDraw })} />
      </Field>
      <Field label="Clips" hint="Garde les dernières secondes en mémoire : une touche, et c'est un fichier MP4. Encode un flux de plus pendant que tu diffuses ou regardes">
        <Select
          label="Clips"
          value={s.stream.clipSeconds}
          options={[
            { value: 0, label: "Coupés" },
            { value: 15, label: "15 secondes" },
            { value: 30, label: "30 secondes" },
            { value: 60, label: "1 minute" },
          ]}
          onChange={clipSeconds => setStream({ clipSeconds })}
        />
      </Field>
      <Field label="Dossier des enregistrements" hint={s.recordingsDir}>
        <Button
          icon={<FolderOpen size={15} />}
          onClick={() =>
            void window.spoka.pickFolder().then(recordingsDir => {
              if (recordingsDir) update({ recordingsDir });
            })
          }
        >
          Changer
        </Button>
      </Field>
    </>
  );
}

function WatchSection({ s }: { s: Settings }) {
  return (
    <>
      <h1>Regarder</h1>
      <Field label="Latence" hint="Plus elle est basse, plus c'est réactif, moins ça encaisse une connexion instable">
        <Segmented<LatencyMode>
          label="Latence"
          value={s.latency}
          options={[
            { value: "ultra", label: "Ultra faible" },
            { value: "balanced", label: "Équilibrée" },
            { value: "stable", label: "Stable" },
          ]}
          onChange={latency => core.setLatency(latency)}
        />
      </Field>
      <Field label="Regarder automatiquement" hint="Ouvre le premier stream du salon dès que tu arrives">
        <Toggle label="Regarder automatiquement" checked={s.autoWatch} onChange={autoWatch => update({ autoWatch })} />
      </Field>
    </>
  );
}

function OverlaySection({ s }: { s: Settings }) {
  const setOverlay = (patch: Partial<Settings["overlay"]>) => update({ overlay: { ...s.overlay, ...patch } });
  return (
    <>
      <h1>Overlay en jeu</h1>
      <p className="muted-text">Quand tu diffuses, le chat, les réactions et les dessins de tes amis s'affichent par-dessus ton jeu. Tes spectateurs ne le voient pas en double. Les jeux doivent être en plein écran fenêtré.</p>
      <Field label="Activer l'overlay">
        <Toggle label="Activer l'overlay" checked={s.overlay.enabled} onChange={enabled => setOverlay({ enabled })} />
      </Field>
      <Field label="Réactions">
        <Toggle label="Réactions" checked={s.overlay.reactions} onChange={reactions => setOverlay({ reactions })} />
      </Field>
      <Field label="Messages du chat">
        <Toggle label="Messages du chat" checked={s.overlay.chat} onChange={chat => setOverlay({ chat })} />
      </Field>
      <Field label="Nombre de spectateurs">
        <Toggle label="Nombre de spectateurs" checked={s.overlay.viewers} onChange={viewers => setOverlay({ viewers })} />
      </Field>
      <Field label="Position">
        <Select
          label="Position"
          value={s.overlay.corner}
          options={[
            { value: "top-right", label: "En haut à droite" },
            { value: "top-left", label: "En haut à gauche" },
            { value: "bottom-right", label: "En bas à droite" },
            { value: "bottom-left", label: "En bas à gauche" },
          ]}
          onChange={corner => setOverlay({ corner })}
        />
      </Field>
    </>
  );
}

const HOTKEY_LABELS: Record<keyof HotkeyMap, string> = {
  toggleMic: "Couper / réactiver le micro",
  toggleDeafen: "Couper / réactiver tout le son",
  toggleStream: "Lancer / arrêter le stream",
  pauseStream: "Mettre le stream en pause",
  saveClip: "Garder un clip des dernières secondes",
};

function HotkeysSection({ s }: { s: Settings }) {
  return (
    <>
      <h1>Raccourcis</h1>
      <p className="muted-text">Ils fonctionnent partout, même en plein jeu. Dans l'application, appuie sur ? pour voir tous les autres.</p>
      {(Object.keys(HOTKEY_LABELS) as (keyof HotkeyMap)[]).map(action => (
        <Field key={action} label={HOTKEY_LABELS[action]}>
          <HotkeyInput value={s.hotkeys[action]} onChange={accelerator => update({ hotkeys: { ...s.hotkeys, [action]: accelerator } })} />
        </Field>
      ))}
    </>
  );
}

function NotificationsSection({ s }: { s: Settings }) {
  return (
    <>
      <h1>Notifications</h1>
      <Field label="Quand un ami lance un stream" hint="Même si SpokaStream est dans la zone de notification">
        <Toggle label="Streams" checked={s.notifyLive} onChange={notifyLive => update({ notifyLive })} />
      </Field>
      <Field label="Nouveaux messages" hint="Quand la fenêtre n'est pas au premier plan">
        <Toggle label="Messages" checked={s.notifyMessages} onChange={notifyMessages => update({ notifyMessages })} />
      </Field>
      <Field label="Petits sons de l'interface">
        <Toggle label="Sons" checked={s.soundEffects} onChange={soundEffects => update({ soundEffects })} />
      </Field>
      <h2>Au démarrage</h2>
      <Field label="Lancer avec Windows">
        <Toggle label="Lancer avec Windows" checked={s.startWithWindows} onChange={startWithWindows => update({ startWithWindows })} />
      </Field>
      <Field label="Démarrer dans la zone de notification">
        <Toggle label="Démarrer réduit" checked={s.startMinimized} onChange={startMinimized => update({ startMinimized })} />
      </Field>
      <Field label="La croix réduit dans la zone de notification" hint="Sinon, elle quitte l'application">
        <Toggle label="Réduire à la fermeture" checked={s.closeToTray} onChange={closeToTray => update({ closeToTray })} />
      </Field>
    </>
  );
}

function ServerSection({ s }: { s: Settings }) {
  const connection = useApp(state => state.connection);
  const iceServers = useApp(state => state.iceServers);
  const [url, setUrl] = useState(s.serverUrl);
  const [host, setHost] = useState<HostStatus | null>(null);
  const [port, setPort] = useState(8787);
  useEffect(() => void window.spoka.hostStatus().then(setHost), []);
  const hasRelay = JSON.stringify(iceServers).includes("turn:");

  const startHost = async () => {
    const status = await window.spoka.hostStart(port);
    setHost(status);
    if (status.error) return toast(status.error, "error");
    const local = `ws://127.0.0.1:${status.port}/ws`;
    setUrl(local);
    update({ serverUrl: local });
  };

  return (
    <>
      <h1>Serveur</h1>
      <p className="muted-text">Le serveur présente les participants les uns aux autres et transporte le chat. La vidéo et le son passent directement de PC à PC.</p>
      <label className="stack">
        <span className="label">Adresse du serveur</span>
        <div className="row-gap">
          <input className="input" value={url} spellCheck={false} onChange={e => setUrl(e.target.value)} />
          <Button disabled={url === s.serverUrl || !url.trim()} onClick={() => update({ serverUrl: url.trim() })}>
            Connecter
          </Button>
        </div>
      </label>
      <Field label="État">
        <span className="status-text">{connection === "online" ? `Connecté${hasRelay ? ", relais disponible" : ", sans relais"}` : connection === "connecting" ? "Connexion…" : "Hors ligne"}</span>
      </Field>
      <h2>Héberger sur ce PC</h2>
      <p className="muted-text">Pour jouer en réseau local sans aucun serveur. Tes amis sur le même réseau entrent l'adresse affichée ici.</p>
      {host?.running ? (
        <>
          {host.addresses.map(a => (
            <Field key={a} label={`ws://${a}:${host.port}/ws`}>
              <Button icon={<Copy size={15} />} onClick={() => window.spoka.copyText(`ws://${a}:${host.port}/ws`)}>
                Copier
              </Button>
            </Field>
          ))}
          <Button onClick={() => void window.spoka.hostStop().then(setHost)}>Arrêter l'hébergement</Button>
        </>
      ) : (
        <div className="row-gap">
          <input className="input input-port" type="number" min={1024} max={65535} value={port} aria-label="Port" onChange={e => setPort(Number(e.target.value))} />
          <Button onClick={() => void startHost()}>Héberger sur ce PC</Button>
        </div>
      )}
    </>
  );
}

function AboutSection() {
  const updateState = useApp(s => s.update);
  const status =
    updateState.state === "ready"
      ? `Version ${updateState.version} prête`
      : updateState.state === "downloading"
        ? `Téléchargement de ${updateState.version} : ${updateState.percent} %`
        : updateState.state === "checking"
          ? "Recherche…"
          : updateState.state === "none"
            ? "Tu as la dernière version"
            : updateState.state === "error"
              ? "Vérification impossible"
              : updateState.state === "unsupported"
                ? "Disponible dans la version installée"
                : "";
  return (
    <>
      <h1>À propos</h1>
      <Field label="SpokaStream" hint={`Version ${window.spoka.version}`}>
        <span className="status-text">{status}</span>
      </Field>
      <div className="row-gap">
        {updateState.state === "ready" ? (
          <Button variant="primary" icon={<Download size={15} />} onClick={() => window.spoka.updateInstall()}>
            Installer et redémarrer
          </Button>
        ) : (
          <Button onClick={() => window.spoka.updateCheck()}>Rechercher une mise à jour</Button>
        )}
        <Button
          icon={<Copy size={15} />}
          onClick={() =>
            void core.diagnostics().then(report => {
              window.spoka.copyText(report);
              toast("Diagnostic copié : colle-le où tu veux", "success");
            })
          }
        >
          Copier le diagnostic
        </Button>
      </div>
    </>
  );
}

export function SettingsView() {
  const settings = useApp(s => s.settings)!;
  const section = useApp(s => s.settingsSection);
  return (
    <div className="settings">
      <nav className="settings-nav" aria-label="Paramètres">
        {SECTIONS.map(item => (
          <button key={item.id} type="button" className={section === item.id ? "is-on" : ""} onClick={() => set({ settingsSection: item.id })}>
            <item.icon size={16} />
            {item.label}
          </button>
        ))}
      </nav>
      <div className="settings-body">
        <div className="settings-inner">
          {section === "profile" && <ProfileSection s={settings} />}
          {section === "appearance" && <AppearanceSection s={settings} />}
          {section === "voice" && <VoiceSection s={settings} />}
          {section === "stream" && <StreamSection s={settings} />}
          {section === "watch" && <WatchSection s={settings} />}
          {section === "overlay" && <OverlaySection s={settings} />}
          {section === "hotkeys" && <HotkeysSection s={settings} />}
          {section === "notifications" && <NotificationsSection s={settings} />}
          {section === "server" && <ServerSection s={settings} />}
          {section === "about" && <AboutSection />}
        </div>
      </div>
    </div>
  );
}
