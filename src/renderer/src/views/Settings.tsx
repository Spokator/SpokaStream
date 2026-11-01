import { AudioLines, Bell, Check, Copy, Download, ExternalLink, FolderOpen, Gauge, Info, Keyboard, Laptop, Layers, Mic, Palette, Radio, Server, Shield, ShieldCheck, Smartphone, Trash2, User } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { DEFAULT_HOTKEYS, DEFAULT_SERVER, isVirtualInput } from "@shared/ipc.ts";
import type { CodecChoice, HostStatus, HotkeyMap, LatencyMode, Settings, SoundboardInfo, VideoPriority, WallMode } from "@shared/ipc.ts";
import qrcode from "qrcode-generator";
import { core } from "../engine/core.ts";
import type { AccountDevice } from "../engine/core.ts";
import { cachedBench, measureEncoders, rankResults } from "../engine/encoders.ts";
import type { BenchResult } from "../engine/encoders.ts";
import { set, toast, useApp } from "../state/store.ts";
import type { SettingsSection } from "../state/store.ts";
import { Avatar, Button, Field, IconButton, Meter, Segmented, Select, Slider, Toggle } from "../ui/kit.tsx";
import { BITRATES, CODECS, FPS_OPTIONS, RESOLUTIONS } from "./GoLive.tsx";
import { ProfileEditor } from "./Onboarding.tsx";

const SECTIONS: { id: SettingsSection; label: string; icon: typeof User }[] = [
  { id: "account", label: "Compte", icon: Smartphone },
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

/** Un petit son dans la sortie choisie, pour vérifier que c'est la bonne. */
async function testOutput(deviceId: string) {
  const context = new AudioContext() as AudioContext & { setSinkId?: (id: string) => Promise<void> };
  if (deviceId !== "default") await context.setSinkId?.(deviceId).catch(() => {});
  const oscillator = context.createOscillator();
  const gain = context.createGain();
  oscillator.frequency.value = 660;
  gain.gain.value = 0.12;
  gain.gain.exponentialRampToValueAtTime(0.001, context.currentTime + 0.6);
  oscillator.connect(gain).connect(context.destination);
  oscillator.start();
  oscillator.stop(context.currentTime + 0.6);
  setTimeout(() => void context.close(), 800);
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

export function HotkeyInput({ value, onChange }: { value: string; onChange: (accelerator: string) => void }) {
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

const seenAt = (at: number) => new Date(at).toLocaleString("fr-FR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });

function LinkPanel({ onLinked }: { onLinked: () => void }) {
  const [link, setLink] = useState<{ code: string; expires: number } | null>(null);
  const url = link ? core.linkUrl(link.code) : "";
  const picture = useMemo(() => {
    if (!url) return "";
    const qr = qrcode(0, "M");
    qr.addData(url);
    qr.make();
    return qr.createDataURL(5, 8);
  }, [url]);

  const linkedAt = useApp(s => s.linkedAt);
  useEffect(() => {
    if (!linkedAt) return;
    setLink(null);
    onLinked();
  }, [linkedAt]);

  useEffect(() => {
    if (!link) return;
    const timer = setInterval(() => {
      if (Date.now() > link.expires) setLink(null);
    }, 3000);
    return () => clearInterval(timer);
  }, [link]);

  if (!link) {
    return (
      <Button variant="primary" icon={<Smartphone size={15} />} onClick={() => void core.linkDevice().then(setLink, () => toast("Impossible de créer le code.", "error"))}>
        Lier mon téléphone
      </Button>
    );
  }
  return (
    <div className="link-panel">
      <img src={picture} alt="QR code pour lier un téléphone" />
      <div>
        <b>Scanne avec ton téléphone</b>
        <span>Ou ouvre {url.replace(/^https?:\/\//, "").split("/")[0]} sur ton téléphone et entre ce code :</span>
        <code>{link.code}</code>
        <small>Valable 5 minutes, une seule fois. Ne le donne à personne : il ouvre ton compte.</small>
        <small>iPhone avec SpokaStream sur l'écran d'accueil : ouvre-le et entre le code. Le QR code ouvre Safari, que l'iPhone garde séparé.</small>
      </div>
    </div>
  );
}

function AccountSection({ s }: { s: Settings }) {
  const accountId = useApp(s => s.accountId);
  const admin = useApp(s => s.admin);
  const connection = useApp(s => s.connection);
  const [devices, setDevices] = useState<AccountDevice[]>([]);
  const [code, setCode] = useState("");
  const refresh = () => void core.listDevices().then(setDevices, () => {});
  useEffect(() => {
    if (connection === "online") refresh();
  }, [connection, accountId]);

  return (
    <>
      <h1>Compte</h1>
      <p className="muted-text">Lie ton téléphone à ce PC : tu es la même personne partout, et pendant que ce PC diffuse, ton téléphone devient ta régie.</p>
      <LinkPanel onLinked={refresh} />
      <Field label="Le téléphone peut lancer un direct" hint="Ton écran peut alors partir en direct sans que tu sois devant ce PC">
        <Toggle label="Le téléphone peut lancer un direct" checked={s.allowRemoteStart} onChange={allowRemoteStart => void core.updateSettings({ allowRemoteStart })} />
      </Field>
      <h2>Mes appareils</h2>
      {devices.map(device => (
        <div key={device.id} className="device-line">
          {device.client === "web" ? <Smartphone size={17} /> : <Laptop size={17} />}
          <span>
            <b>
              {device.label || (device.client === "web" ? "Navigateur" : "Application")}
              {device.self ? " (cet appareil)" : ""}
            </b>
            <small>{device.online ? "En ligne" : `Vu le ${seenAt(device.lastSeen)}`}</small>
          </span>
          {!device.primary && !device.self && (
            <IconButton label={`Détacher ${device.label || "cet appareil"}`} onClick={() => void core.revokeDevice(device.id).then(refresh)}>
              <Trash2 size={15} />
            </IconButton>
          )}
        </div>
      ))}
      <h2>Un autre PC</h2>
      <p className="muted-text">Sur ton PC principal, crée un code avec « Lier mon téléphone », puis entre-le ici. Ce PC prend alors son compte, son profil et ses salons.</p>
      <div className="row-gap">
        <input className="input" value={code} placeholder="Code à 8 caractères" aria-label="Code de liaison" spellCheck={false} onChange={e => setCode(e.target.value)} />
        <Button
          disabled={code.trim().length < 8}
          onClick={() =>
            void core.claimLink(code).then(
              () => (setCode(""), refresh(), toast("Ce PC est lié au compte", "success")),
              () => toast("Ce code n'est pas valable.", "error"),
            )
          }
        >
          Lier ce PC
        </Button>
      </div>
      <Field label="Identifiant du compte" hint={accountId}>
        <Button icon={<Copy size={15} />} onClick={() => window.spoka.copyText(accountId)}>
          Copier
        </Button>
      </Field>
      {admin && (
        <>
          <h2>Administration</h2>
          <Button icon={<ShieldCheck size={15} />} onClick={() => void core.openAdmin().catch(() => toast("Le panneau n'a pas pu s'ouvrir.", "error"))}>
            Ouvrir le panneau d'administration
          </Button>
        </>
      )}
    </>
  );
}

function ProfileSection({ s }: { s: Settings }) {
  const [profile, setProfile] = useState(s.profile);
  const changed = JSON.stringify({ ...profile, name: profile.name.trim() }) !== JSON.stringify(s.profile);
  return (
    <>
      <h1>Profil</h1>
      <p className="muted-text">Pas de compte : ton profil vit sur ce PC. Change-le quand tu veux, tes amis voient le nouveau tout de suite.</p>
      <ProfileEditor {...profile} onChange={setProfile} />
      <div className="profile-preview" aria-label="Aperçu">
        <Avatar name={profile.name || "?"} color={profile.color} src={profile.avatar} size={34} />
        <span>
          <b style={{ color: profile.color }}>{profile.name || "Ton pseudo"}</b>
          <span>C'est comme ça que tes amis te voient dans le chat.</span>
        </span>
      </div>
      <Button variant="primary" disabled={!profile.name.trim() || !changed} onClick={() => void core.updateProfile({ ...profile, name: profile.name.trim() }).then(() => toast("Profil enregistré", "success"))}>
        {changed ? "Enregistrer" : "Enregistré"}
      </Button>
    </>
  );
}

const ACCENTS = ["#7c5cff", "#4f8dff", "#22b8cf", "#2fbf8a", "#f59e0b", "#f4638d", "#ef4444"];

function AppearanceSection({ s }: { s: Settings }) {
  return (
    <>
      <h1>Apparence</h1>
      <Field label="Thème">
        <Segmented
          label="Thème"
          value={s.theme}
          options={[
            { value: "dark", label: "Sombre" },
            { value: "midnight", label: "Bleu nuit" },
            { value: "black", label: "Noir pur" },
          ]}
          onChange={theme => update({ theme })}
        />
      </Field>
      <Field label="Couleur d'accent">
        <div className="accent-list" role="radiogroup" aria-label="Couleur d'accent">
          {ACCENTS.map(accent => (
            <button key={accent} type="button" role="radio" aria-checked={s.accent === accent} aria-label={accent} style={{ background: accent }} onClick={() => update({ accent })}>
              {s.accent === accent && <Check size={15} />}
            </button>
          ))}
          <label className="accent-custom" title="Ta propre couleur" style={ACCENTS.includes(s.accent) ? undefined : { background: s.accent }}>
            <input type="color" aria-label="Choisir une autre couleur d'accent" value={s.accent} onChange={e => update({ accent: e.target.value })} />
          </label>
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
      <Field label="Texte du chat">
        <Segmented
          label="Texte du chat"
          value={s.chatSize}
          options={[
            { value: 12.5, label: "Petit" },
            { value: 13.5, label: "Normal" },
            { value: 15, label: "Grand" },
            { value: 17, label: "Très grand" },
          ]}
          onChange={chatSize => update({ chatSize })}
        />
      </Field>
      <Field label="Chat compact" hint="Moins d'espace entre les messages">
        <Toggle label="Chat compact" checked={s.chatCompact} onChange={chatCompact => update({ chatCompact })} />
      </Field>
      <Field label="Ambiance" hint="Les bandes autour de l'image prennent ses couleurs">
        <Toggle label="Ambiance" checked={s.ambient} onChange={ambient => update({ ambient })} />
      </Field>
      <Field label="Réduire les animations">
        <Toggle label="Réduire les animations" checked={s.reduceMotion} onChange={reduceMotion => update({ reduceMotion })} />
      </Field>
    </>
  );
}

/** SpokaSoundBoard envoie sa musique, ses sons et la voix transformée dans un micro virtuel : on le prend tel quel. */
function SoundboardCard({ s, mics }: { s: Settings; mics: { value: string; label: string }[] }) {
  const [info, setInfo] = useState<SoundboardInfo | null>(null);
  useEffect(() => {
    void window.spoka.soundboardInfo().then(setInfo);
  }, []);
  const cable = mics.find(m => m.value !== "default" && isVirtualInput(m.label));
  const usingCable = isVirtualInput(mics.find(m => m.value === s.micId)?.label ?? "");
  if (!info?.installed && !cable) return null;
  return (
    <div className="soundboard-card">
      <AudioLines size={20} />
      <div>
        <b>SpokaSoundBoard {info?.running ? "est ouvert" : info?.installed ? "est installé" : ""}</b>
        {usingCable ? (
          <span>Ton vocal passe par son micro virtuel. La réduction du bruit, l'écho et le niveau automatique sont coupés sur ce micro : ils prendraient la musique pour du bruit.</span>
        ) : cable ? (
          <span>Utilise son micro virtuel ici pour que le salon entende ta musique, tes sons et tes effets de voix.</span>
        ) : (
          <span>Aucun micro virtuel détecté. Lance l'assistant de configuration de SpokaSoundBoard : il installe VB-CABLE, puis il apparaît ici.</span>
        )}
      </div>
      {cable && !usingCable && <Button onClick={() => update({ micId: cable.value, voiceMode: "open", voiceKbps: 128 })}>Utiliser</Button>}
    </div>
  );
}

function VoiceSection({ s }: { s: Settings }) {
  const mics = useDevices("audioinput");
  const outputs = useDevices("audiooutput");
  return (
    <>
      <h1>Son et voix</h1>
      <SoundboardCard s={s} mics={mics} />
      <Field label="Micro">
        <Select label="Micro" value={s.micId} options={mics} onChange={micId => update({ micId })} />
      </Field>
      <MicTest deviceId={s.micId} />
      <Field label="Sortie" hint="Pour la voix et le son des streams">
        <Select label="Sortie" value={s.outputId} options={outputs} onChange={outputId => update({ outputId })} />
      </Field>
      <Button onClick={() => void testOutput(s.outputId)}>Tester la sortie</Button>
      <Field label="Volume des streams" hint={`${Math.round(s.streamVolume * 100)} %. Chaque stream garde son propre réglage en plus`}>
        <Slider label="Volume des streams" value={s.streamVolume} min={0} max={1.5} step={0.05} onChange={streamVolume => update({ streamVolume })} />
      </Field>
      <Field label="Volume des voix" hint={`${Math.round(s.voiceVolume * 100)} %`}>
        <Slider label="Volume des voix" value={s.voiceVolume} min={0} max={1.5} step={0.05} onChange={voiceVolume => update({ voiceVolume })} />
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
      <Field label="Codec par défaut" hint="Automatique choisit le meilleur que ton PC tient">
        <Select<CodecChoice> label="Codec" value={s.stream.codec} options={CODECS} onChange={codec => setStream({ codec })} />
      </Field>
      <Field label="Capture de jeu" hint="L'image est prise directement dans le jeu, comme Discord et OBS : ta souris reste visible dans les jeux OpenGL comme Project Zomboid. Choisis la fenêtre du jeu, pas l'écran. SpokaStream n'entre que dans les jeux OpenGL 64 bits, et jamais quand il détecte un anti-triche. Les autres jeux, comme LoL, gardent la capture normale, qui ne touche pas au jeu. Prend effet au prochain direct">
        <Toggle label="Capture de jeu" checked={s.stream.gameCapture} onChange={gameCapture => setStream({ gameCapture })} />
      </Field>
      <Field label="Priorité par défaut">
        <Segmented<VideoPriority>
          label="Priorité"
          value={s.stream.priority}
          options={[
            { value: "motion", label: "Fluidité" },
            { value: "detail", label: "Netteté" },
          ]}
          onChange={priority => setStream({ priority })}
        />
      </Field>
      <Field label="Qualité du son">
        <Select label="Qualité du son" value={s.stream.audioKbps} options={[128, 192, 256, 320, 510].map(value => ({ value, label: `${value} kb/s` }))} onChange={audioKbps => setStream({ audioKbps })} />
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
      <Field label="Prendre la main" hint="Un ami peut demander à jouer à ta place. Rien ne se passe sans ton accord">
        <Toggle label="Accepter les demandes de main" checked={s.stream.allowControl} onChange={allowControl => setStream({ allowControl })} />
      </Field>
      <Field label="Enregistrer chaque stream" hint="L'enregistrement démarre avec le direct">
        <Toggle label="Enregistrer chaque stream" checked={s.stream.autoRecord} onChange={autoRecord => setStream({ autoRecord })} />
      </Field>
      <Field label="Ouvrir la régie au lancement" hint="Sinon, elle reste à un clic dans la barre de direct">
        <Toggle label="Ouvrir la régie au lancement" checked={s.regie.auto} onChange={auto => update({ regie: { ...s.regie, auto } })} />
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
      <Field label="Qualité à l'ouverture" hint="Tu peux la changer sur chaque stream. Une connexion limitée préfère 720p">
        <Select
          label="Qualité à l'ouverture"
          value={s.watchQuality}
          options={[
            { value: 0, label: "Maximum" },
            { value: 1080, label: "1080p" },
            { value: 720, label: "720p" },
            { value: 480, label: "480p économe" },
          ]}
          onChange={watchQuality => update({ watchQuality })}
        />
      </Field>
      <Field label="Regarder automatiquement" hint="Ouvre un stream dès que tu arrives dans le salon">
        <Toggle label="Regarder automatiquement" checked={s.autoWatch} onChange={autoWatch => update({ autoWatch })} />
      </Field>
      <h2>Plusieurs streams à la fois</h2>
      <Field label="Disposition">
        <Select<WallMode>
          label="Disposition"
          value={s.wall.mode}
          options={[
            { value: "focus", label: "Un grand, bandeau en bas" },
            { value: "side", label: "Un grand, colonne à droite" },
            { value: "grid", label: "Grille" },
            { value: "pip", label: "Incrustation" },
            { value: "free", label: "Libre" },
          ]}
          onChange={mode => core.setWallMode(mode)}
        />
      </Field>
      <Field label="Ouvrir tous les streams du salon" hint="Sinon, seulement le premier">
        <Toggle label="Ouvrir tous les streams du salon" checked={s.wall.watchAll} onChange={watchAll => core.updateWall({ watchAll })} />
      </Field>
      <Field label="Le son suit l'image en grand" hint="Les autres streams restent muets">
        <Toggle label="Le son suit l'image en grand" checked={s.wall.audioFollows} onChange={audioFollows => core.updateWall({ audioFollows })} />
      </Field>
      <Field label="Adapter la qualité à la taille" hint="Une petite image reçoit une petite définition : le diffuseur et ta connexion respirent">
        <Toggle label="Adapter la qualité à la taille" checked={s.wall.fitQuality} onChange={fitQuality => core.updateWall({ fitQuality })} />
      </Field>
      <Field label="Voir mon retour quand je diffuse" hint="Le masquer économise un peu de carte graphique">
        <Toggle label="Voir mon retour quand je diffuse" checked={s.wall.showOwn} onChange={showOwn => core.updateWall({ showOwn })} />
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
      <Field label="Taille">
        <Segmented
          label="Taille de l'overlay"
          value={s.overlay.size}
          options={[
            { value: 0.85, label: "Petite" },
            { value: 1, label: "Normale" },
            { value: 1.25, label: "Grande" },
          ]}
          onChange={size => setOverlay({ size })}
        />
      </Field>
      <Field label="Opacité" hint={`${Math.round(s.overlay.opacity * 100)} %`}>
        <Slider label="Opacité de l'overlay" value={s.overlay.opacity} min={0.4} max={1} step={0.05} onChange={opacity => setOverlay({ opacity })} />
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
      <Button onClick={() => void core.testOverlay()}>Tester l'overlay</Button>
    </>
  );
}

const HOTKEY_LABELS: Record<keyof HotkeyMap, string> = {
  toggleMic: "Couper / réactiver le micro",
  toggleDeafen: "Couper / réactiver tout le son",
  toggleStream: "Lancer / arrêter le stream",
  pauseStream: "Mettre le stream en pause",
  saveClip: "Garder un clip des dernières secondes",
  control: "Accepter une demande de main, ou la reprendre",
  marker: "Poser un marqueur dans le direct",
};

function HotkeysSection({ s }: { s: Settings }) {
  return (
    <>
      <h1>Raccourcis</h1>
      <p className="muted-text">Ils fonctionnent partout, même en plein jeu. Dans l'application, appuie sur ? pour voir tous les autres.</p>
      {(Object.keys(HOTKEY_LABELS) as (keyof HotkeyMap)[]).map(action => {
        const twin = (Object.keys(HOTKEY_LABELS) as (keyof HotkeyMap)[]).find(other => other !== action && s.hotkeys[other] && s.hotkeys[other] === s.hotkeys[action]);
        return (
          <Field key={action} label={HOTKEY_LABELS[action]} hint={twin ? `Déjà pris par « ${HOTKEY_LABELS[twin]} » : un seul des deux marchera` : undefined}>
            <HotkeyInput value={s.hotkeys[action]} onChange={accelerator => update({ hotkeys: { ...s.hotkeys, [action]: accelerator } })} />
          </Field>
        );
      })}
      <Button onClick={() => update({ hotkeys: DEFAULT_HOTKEYS })}>Rétablir les raccourcis d'origine</Button>
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
      <Field label="Quand quelqu'un te mentionne" hint="@toi ou @tous">
        <Toggle label="Mentions" checked={s.notifyMentions} onChange={notifyMentions => update({ notifyMentions })} />
      </Field>
      <Field label="Tous les messages" hint="Quand la fenêtre n'est pas au premier plan">
        <Toggle label="Messages" checked={s.notifyMessages} onChange={notifyMessages => update({ notifyMessages })} />
      </Field>
      <Field label="Silence pendant que je diffuse" hint="Une notification de Windows finirait à l'image">
        <Toggle label="Silence pendant que je diffuse" checked={s.quietWhileLive} onChange={quietWhileLive => update({ quietWhileLive })} />
      </Field>
      <Button onClick={() => window.spoka.notify({ title: "SpokaStream", body: "Les notifications fonctionnent." })}>Tester une notification</Button>
      <Field label="Petits sons de l'interface">
        <Toggle label="Sons" checked={s.soundEffects} onChange={soundEffects => update({ soundEffects })} />
      </Field>
      {s.soundEffects && (
        <Field label="Volume des petits sons" hint={`${Math.round(s.sfxVolume * 100)} %`}>
          <Slider label="Volume des petits sons" value={s.sfxVolume} min={0.1} max={2} step={0.1} onChange={sfxVolume => update({ sfxVolume })} />
        </Field>
      )}
      <h2>Au démarrage</h2>
      {!window.spoka.store && (
        <>
          <Field label="Lancer avec Windows">
            <Toggle label="Lancer avec Windows" checked={s.startWithWindows} onChange={startWithWindows => update({ startWithWindows })} />
          </Field>
          <Field label="Démarrer dans la zone de notification">
            <Toggle label="Démarrer réduit" checked={s.startMinimized} onChange={startMinimized => update({ startMinimized })} />
          </Field>
        </>
      )}
      <Field label="La croix réduit dans la zone de notification" hint="Sinon, elle quitte l'application">
        <Toggle label="Réduire à la fermeture" checked={s.closeToTray} onChange={closeToTray => update({ closeToTray })} />
      </Field>
    </>
  );
}

/** On peut coller l'adresse du site telle quelle : http(s), sans /ws, ou le nom seul. */
function serverAddress(raw: string) {
  const text = raw.trim().replace(/\/+$/, "");
  const full = /^[a-z]+:\/\//i.test(text) ? text.replace(/^http/i, "ws") : `wss://${text}`;
  return /\/ws$/.test(full) ? full : `${full}/ws`;
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
          <Button
            disabled={url === s.serverUrl || !url.trim()}
            onClick={() => {
              const serverUrl = serverAddress(url);
              setUrl(serverUrl);
              update({ serverUrl });
            }}
          >
            Connecter
          </Button>
        </div>
      </label>
      <Field label="État">
        <span className="status-text">{connection === "online" ? `Connecté${hasRelay ? ", relais disponible" : ", sans relais"}` : connection === "connecting" ? "Connexion…" : "Hors ligne"}</span>
      </Field>
      {s.serverUrl !== DEFAULT_SERVER && (
        <Button
          onClick={() => {
            setUrl(DEFAULT_SERVER);
            update({ serverUrl: DEFAULT_SERVER });
          }}
        >
          Revenir au serveur SpokaStream
        </Button>
      )}
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

function FeedbackForm() {
  const [text, setText] = useState("");
  return (
    <div className="stack">
      <textarea className="input" rows={3} value={text} maxLength={3000} placeholder="Ce qui s'est passé. Le diagnostic de ce PC part avec le message." aria-label="Décrire le problème" onChange={e => setText(e.target.value)} />
      <Button
        disabled={!text.trim()}
        onClick={() =>
          void core.sendFeedback(text).then(() => {
            setText("");
            toast("Merci, c'est envoyé", "success");
          })
        }
      >
        Envoyer
      </Button>
    </div>
  );
}

function AboutSection() {
  const updateState = useApp(s => s.update);
  const settings = useApp(s => s.settings)!;
  const engine = useApp(s => s.audioEngine);
  const [confirmReset, setConfirmReset] = useState(false);
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
                ? window.spoka.store
                  ? "Mises à jour par le Microsoft Store"
                  : "Disponible dans la version installée"
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
        <Button icon={<ExternalLink size={15} />} onClick={() => window.spoka.openExternal("https://github.com/Spokator/SpokaStream/releases")}>
          Nouveautés
        </Button>
      </div>
      <h2>Signaler un problème</h2>
      <FeedbackForm />
      <Field label="Envoyer les erreurs de l'application" hint="Le message d'erreur et la version, pour pouvoir les corriger. Jamais le chat ni ce qui est diffusé">
        <Toggle label="Envoyer les erreurs de l'application" checked={settings.sendErrors} onChange={sendErrors => update({ sendErrors })} />
      </Field>
      <h2>Le moteur audio</h2>
      <p className="muted-text">SpokaAudio est le petit programme installé avec SpokaStream. C'est lui qui capte le son d'une seule application au lieu de tout le PC, et qui donne les images à haute cadence. Il démarre et s'arrête tout seul : il n'y a rien à lancer ni à régler. Il apparaît dans le Gestionnaire des tâches sous ce nom.</p>
      <Field label="État">
        <span className="status-text">{engine === "ready" ? "Prêt" : engine === "starting" ? "Démarrage…" : "Indisponible : les applications ne pourront pas être captées séparément"}</span>
      </Field>
      <h2>Données</h2>
      <p className="muted-text">Tes réglages, ton identité, tes clips et tes enregistrements restent sur ce PC. Le serveur garde ton profil, tes salons avec leur chat, quelques statistiques et tes dernières adresses IP.</p>
      <div className="row-gap">
        <Button icon={<Shield size={15} />} onClick={() => window.spoka.openExternal(`${settings.serverUrl.replace(/^ws/, "http").replace(/\/ws$/, "")}/confidentialite`)}>
          Politique de confidentialité
        </Button>
        <Button icon={<FolderOpen size={15} />} onClick={() => window.spoka.openDataFolder()}>
          Ouvrir le dossier des données
        </Button>
        {confirmReset ? (
          <>
            <Button variant="danger" onClick={() => void core.resetSettings().then(() => (setConfirmReset(false), toast("Réglages rétablis", "success")))}>
              Oui, tout rétablir
            </Button>
            <Button variant="ghost" onClick={() => setConfirmReset(false)}>
              Annuler
            </Button>
          </>
        ) : (
          <Button onClick={() => setConfirmReset(true)}>Rétablir les réglages d'origine</Button>
        )}
      </div>
      <p className="muted-text">Ton profil, tes salons, tes scènes et tes clés sont gardés.</p>
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
          {section === "account" && <AccountSection s={settings} />}
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
