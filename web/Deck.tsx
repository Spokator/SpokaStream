/** @jsxImportSource preact */
import { Activity, ArrowLeft, Camera, CameraOff, Check, Circle, Clapperboard, Eraser, Expand, Gauge, HeadphoneOff, Headphones, Hourglass, LayoutGrid, MessageSquare, Mic, MicOff, Pause, PenLine, Pencil, Play, Plus, Radio, RotateCcw, Scissors, SkipForward, SlidersVertical, Smile, Square, Tag, Timer, Trash2, Tv, Type, Users, Volume2, VolumeX, X } from "lucide-preact";
import type { RemoteState } from "@shared/protocol.ts";
import type { ComponentChildren } from "preact";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { deckAwake, enter, reactTo, remoteCommand, sendChat, togetherPlay, togetherSkip } from "./client.ts";
import { addPage, catalog, defaultLayout, KEY_COLORS, keyView, normalize, pageKeys, readLayout, removePage, renamePage, saveLayout, setKey, swapKeys } from "./deck.ts";
import type { DeckAction, DeckKey, DeckLayout, KeyView } from "./deck.ts";
import { DetailsPane } from "./Regie.tsx";
import { get, set, useApp } from "./store.ts";

const HOLD_MS = 1200;
const SWIPE_PX = 60;
const MOVE_PX = 14;
const WAIT_MS = 2500;
const CLIP_WAIT_MS = 8000;
const FADER_SEND_MS = 100;
const FADER_MAX = 1.5;
const ICONS: Record<string, typeof Pause> = {
  play: Play,
  pause: Pause,
  mic: Mic,
  "mic-off": MicOff,
  headphones: Headphones,
  "headphone-off": HeadphoneOff,
  camera: Camera,
  "camera-off": CameraOff,
  record: Circle,
  clip: Scissors,
  marker: Tag,
  clear: Eraser,
  draw: PenLine,
  stop: Square,
  time: Timer,
  viewers: Users,
  bitrate: Gauge,
  fps: Activity,
  health: Activity,
  scene: Clapperboard,
  screen: Hourglass,
  volume: Volume2,
  "volume-off": VolumeX,
  banner: Type,
  chat: MessageSquare,
  react: Smile,
  skip: SkipForward,
};

/** Fait partir l'action d'une touche. Une touche d'information ne passe pas par ici. */
function perform(action: DeckAction, remote: RemoteState) {
  switch (action.kind) {
    case "pause":
      return remoteCommand(remote.paused ? "resume" : "pause");
    case "mic":
      return remoteCommand("mute");
    case "deafen":
      return remoteCommand("deafen");
    case "camera":
      return remoteCommand("camera");
    case "record":
      return remoteCommand("record");
    case "clip":
      return remoteCommand("clip");
    case "marker":
      return remoteCommand("marker");
    case "clear":
      return remoteCommand("clear");
    case "draw":
      return remoteCommand("allowDraw", remote.allowDraw === false);
    case "stop":
      return remoteCommand("stop");
    case "scene":
      return remoteCommand("scene", action.id);
    case "screen":
      return remoteCommand(remote.screen === remote.screens[action.index] ? "resume" : "screen", action.index);
    case "mute": {
      const source = remote.mix.find(m => m.id === action.id);
      return remoteCommand("mixMute", `${action.id}|${source?.muted ? "0" : "1"}`);
    }
    case "banner":
      return remoteCommand("banner", remote.banner === action.text ? "" : action.text);
    case "chat":
      navigator.vibrate?.(12);
      return sendChat(action.text);
    case "react":
      return reactTo(remote.streamId, action.emoji);
    case "party":
      navigator.vibrate?.(12);
      return togetherPlay(!get().room?.together?.playing);
    case "skip":
      navigator.vibrate?.(12);
      return togetherSkip();
    default:
      return undefined;
  }
}

function Key({ view, color, pending, failed, onPress, editing, slot }: { view: KeyView; color?: string; pending: boolean; failed: boolean; onPress: () => void; editing: boolean; slot: number }) {
  const start = useRef<{ x: number; y: number } | null>(null);
  const holdTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const [holding, setHolding] = useState(false);
  const [pressed, setPressed] = useState(false);
  const Icon = ICONS[view.icon] ?? Circle;
  const stop = () => {
    clearTimeout(holdTimer.current);
    setHolding(false);
    setPressed(false);
  };
  useEffect(() => stop, []);
  const live = !view.info && !view.disabled && !editing;
  return (
    <button
      type="button"
      data-slot={slot}
      class={`key ${view.on ? "is-on" : ""} ${view.info ? "is-info" : ""} ${pending ? "is-pending" : ""} ${failed ? "is-failed" : ""} ${holding ? "is-holding" : ""} ${pressed ? "is-pressed" : ""} ${view.hold ? "is-danger" : ""}`}
      style={color ? { "--key-color": color } : undefined}
      aria-pressed={view.on}
      aria-label={view.hold ? `${view.label}, appui long` : view.value ? `${view.label} : ${view.value}` : view.label}
      disabled={view.disabled && !editing}
      onPointerDown={e => {
        if (!live) return;
        start.current = { x: e.clientX, y: e.clientY };
        setPressed(true);
        if (!view.hold) return;
        setHolding(true);
        holdTimer.current = setTimeout(() => {
          start.current = null;
          stop();
          navigator.vibrate?.(40);
          onPress();
        }, HOLD_MS);
      }}
      onPointerMove={e => {
        if (start.current && Math.hypot(e.clientX - start.current.x, e.clientY - start.current.y) > MOVE_PX) {
          start.current = null;
          stop();
        }
      }}
      onPointerUp={() => {
        const wasPressed = !!start.current;
        start.current = null;
        stop();
        if (wasPressed && !view.hold) onPress();
      }}
      onPointerCancel={() => {
        start.current = null;
        stop();
      }}
      onClick={e => {
        // Un clic sans pointeur vient du clavier ou d'un lecteur d'écran.
        if (e.detail === 0 && live) onPress();
      }}
    >
      {view.value ? <b class={`key-value ${view.icon === "react" ? "is-emoji" : ""}`}>{view.value}</b> : <Icon size={28} />}
      <span>{view.label}</span>
      {view.value && view.icon !== "react" && !view.info && <Icon class="key-corner" size={14} />}
    </button>
  );
}

function Grid({ layout, page, remote, now, editing, onEdit, onSwap, onPage }: { layout: DeckLayout; page: number; remote: RemoteState; now: number; editing: boolean; onEdit: (slot: number) => void; onSwap: (from: number, to: number) => void; onPage: (step: number) => void }) {
  const party = useApp(s => s.room?.together ?? null);
  const current = layout.pages[page]!;
  const keys = pageKeys(current, remote);
  const [pending, setPending] = useState<{ slot: number; before: string } | null>(null);
  const [failed, setFailed] = useState(-1);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const swipe = useRef<{ x: number; y: number; slot: number } | null>(null);
  const partyState = { on: !!party, playing: !!party?.playing };
  const fingerprint = (key: DeckKey) => {
    const { value, label, on, icon } = keyView(key, remote, 0, partyState);
    return JSON.stringify({ value, label, on, icon });
  };

  // La touche attend que le PC confirme : ce qu'elle montre change quand il a vraiment agi, pas quand on a touché l'écran.
  useEffect(() => {
    if (!pending) return;
    const key = keys[pending.slot];
    if (key && fingerprint(key) !== pending.before) {
      clearTimeout(timer.current);
      setPending(null);
    }
  }, [remote]);

  const press = (slot: number, key: DeckKey, view: KeyView) => {
    perform(key.action, remote);
    if (!view.waits) return;
    clearTimeout(timer.current);
    setFailed(-1);
    setPending({ slot, before: fingerprint(key) });
    timer.current = setTimeout(() => {
      setPending(null);
      setFailed(slot);
      navigator.vibrate?.([30, 40, 30]);
      setTimeout(() => setFailed(-1), 900);
    }, key.action.kind === "clip" ? CLIP_WAIT_MS : WAIT_MS);
  };
  useEffect(() => () => clearTimeout(timer.current), []);

  return (
    <div
      class={`deck-grid ${editing ? "is-editing" : ""}`}
      onPointerDown={e => {
        const target = (e.target as HTMLElement).closest<HTMLElement>("[data-slot]");
        swipe.current = { x: e.clientX, y: e.clientY, slot: Number(target?.dataset.slot ?? -1) };
      }}
      onPointerUp={e => {
        const start = swipe.current;
        swipe.current = null;
        if (!start) return;
        const dx = e.clientX - start.x;
        const moved = Math.hypot(dx, e.clientY - start.y);
        if (editing) {
          const over = document.elementFromPoint(e.clientX, e.clientY)?.closest<HTMLElement>("[data-slot]");
          const to = Number(over?.dataset.slot ?? -1);
          if (moved > MOVE_PX && to >= 0 && start.slot >= 0 && to !== start.slot) onSwap(start.slot, to);
          else if (moved <= MOVE_PX && start.slot >= 0) onEdit(start.slot);
          return;
        }
        if (Math.abs(dx) > SWIPE_PX && Math.abs(dx) > Math.abs(e.clientY - start.y)) onPage(dx < 0 ? 1 : -1);
      }}
    >
      {keys.map((key, slot) => {
        if (!key) {
          return editing ? (
            <button key={slot} type="button" data-slot={slot} class="key is-empty" aria-label={`Ajouter une touche, emplacement ${slot + 1}`}>
              <Plus size={22} />
            </button>
          ) : (
            <span key={slot} class="key is-blank" />
          );
        }
        const view = keyView(key, remote, now, partyState);
        return <Key key={`${page}-${slot}`} slot={slot} view={view} color={key.color} pending={pending?.slot === slot} failed={failed === slot} editing={editing} onPress={() => press(slot, key, view)} />;
      })}
    </div>
  );
}

/** Un curseur vertical, comme sur une vraie table : le doigt suit le geste, et le PC reçoit le niveau pendant qu'on glisse. */
function Fader({ source, remote }: { source: RemoteState["mix"][number]; remote: RemoteState }) {
  const track = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<number | null>(null);
  const lastSend = useRef(0);
  const release = useRef<ReturnType<typeof setTimeout>>(undefined);
  const value = drag ?? source.volume;
  const send = (next: number) => {
    const now = performance.now();
    if (now - lastSend.current < FADER_SEND_MS) return;
    lastSend.current = now;
    remoteCommand("mixVolume", `${source.id}|${next.toFixed(2)}`);
  };
  const follow = (clientY: number) => {
    const rect = track.current!.getBoundingClientRect();
    const next = Math.round((1 - Math.max(0, Math.min(1, (clientY - rect.top) / rect.height))) * FADER_MAX * 20) / 20;
    setDrag(next);
    clearTimeout(release.current);
    send(next);
    return next;
  };
  const finish = (next: number) => {
    lastSend.current = 0;
    send(next);
    // Le PC renvoie le niveau une seconde plus tard : le curseur ne doit pas revenir en arrière entre-temps.
    release.current = setTimeout(() => setDrag(null), 1200);
  };
  useEffect(() => () => clearTimeout(release.current), []);
  return (
    <div class={`fader ${source.muted ? "is-off" : ""}`}>
      <b>{Math.round(value * 100)} %</b>
      <div
        ref={track}
        class="fader-track"
        role="slider"
        tabIndex={0}
        aria-label={`Volume de ${source.label}`}
        aria-orientation="vertical"
        aria-valuemin={0}
        aria-valuemax={150}
        aria-valuenow={Math.round(value * 100)}
        onPointerDown={e => {
          e.currentTarget.setPointerCapture(e.pointerId);
          follow(e.clientY);
        }}
        onPointerMove={e => {
          if (e.currentTarget.hasPointerCapture(e.pointerId)) follow(e.clientY);
        }}
        onPointerUp={e => finish(follow(e.clientY))}
        onKeyDown={e => {
          if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
          e.preventDefault();
          const next = Math.max(0, Math.min(FADER_MAX, value + (e.key === "ArrowUp" ? 0.05 : -0.05)));
          setDrag(next);
          finish(next);
        }}
      >
        <i class="fader-unity" />
        <i class="fader-fill" style={{ height: `${(value / FADER_MAX) * 100}%` }} />
        <i class="fader-cap" style={{ bottom: `${(value / FADER_MAX) * 100}%` }} />
      </div>
      <button type="button" class={source.muted ? "is-on" : ""} aria-pressed={source.muted} aria-label={source.muted ? `Remettre ${source.label}` : `Couper ${source.label}`} onClick={() => perform({ kind: "mute", id: source.id, name: source.label }, remote)}>
        {source.muted ? <VolumeX size={20} /> : <Volume2 size={20} />}
      </button>
      <span>{source.label}</span>
    </div>
  );
}

function Faders({ remote }: { remote: RemoteState }) {
  if (!remote.mix.length) return <p class="deck-empty">Aucune source de son sur ce direct.</p>;
  return (
    <div class="faders">
      {remote.mix.map(source => (
        <Fader key={source.id} source={source} remote={remote} />
      ))}
    </div>
  );
}

function Picker({ remote, current, onChoose, onClose }: { remote: RemoteState; current: DeckKey | null; onChoose: (key: DeckKey | null) => void; onClose: () => void }) {
  const groups = useMemo(() => catalog(remote), [remote.scenes, remote.screens, remote.mix]);
  const [text, setText] = useState("");
  const [color, setColor] = useState(current?.color ?? "");
  const [label, setLabel] = useState(current?.label ?? "");
  const choose = (key: DeckKey) => onChoose({ ...key, ...(color ? { color } : {}), ...(label.trim() ? { label: label.trim().slice(0, 24) } : {}) });
  return (
    <div class="deck-picker" role="dialog" aria-label="Choisir une touche">
      <header>
        <h2>{current ? "Changer cette touche" : "Nouvelle touche"}</h2>
        <button type="button" class="round" aria-label="Fermer" onClick={onClose}>
          <X size={18} />
        </button>
      </header>
      <div class="deck-picker-body">
        {current && (
          <div class="picker-row">
            <input value={label} maxLength={24} placeholder="Nom affiché, facultatif" aria-label="Nom de la touche" onInput={e => setLabel(e.currentTarget.value)} />
            <button type="button" onClick={() => choose(current)}>
              <Check size={16} /> Garder
            </button>
            <button type="button" class="is-danger" onClick={() => onChoose(null)}>
              <Trash2 size={16} /> Retirer
            </button>
          </div>
        )}
        <div class="picker-colors" role="group" aria-label="Couleur de la touche">
          {KEY_COLORS.map(value => (
            <button key={value} type="button" class={color === value ? "is-on" : ""} style={{ background: value || "var(--surface-3)" }} aria-label={value ? `Couleur ${value}` : "Sans couleur"} aria-pressed={color === value} onClick={() => setColor(value)} />
          ))}
        </div>
        <div class="picker-row">
          <input value={text} maxLength={120} placeholder="Un message ou un bandeau" aria-label="Texte de la touche" onInput={e => setText(e.currentTarget.value)} />
          <button type="button" disabled={!text.trim()} onClick={() => choose({ action: { kind: "chat", text: text.trim() } })}>
            Message
          </button>
          <button type="button" disabled={!text.trim()} onClick={() => choose({ action: { kind: "banner", text: text.trim() } })}>
            Bandeau
          </button>
        </div>
        {groups.map(group => (
          <section key={group.title}>
            <h3>{group.title}</h3>
            <div class="picker-keys">
              {group.keys.map(key => {
                const view = keyView(key, remote, Date.now());
                const Icon = ICONS[view.icon] ?? Circle;
                return (
                  <button key={JSON.stringify(key.action)} type="button" onClick={() => choose(key)}>
                    <Icon size={18} /> {view.label}
                  </button>
                );
              })}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}

function Editor({ layout, page, onChange, onPage, onDone }: { layout: DeckLayout; page: number; onChange: (next: DeckLayout) => void; onPage: (page: number) => void; onDone: () => void }) {
  const current = layout.pages[page]!;
  return (
    <div class="deck-editor">
      {current.auto ? <span>Cette page suit tes scènes.</span> : <input value={current.name} maxLength={16} aria-label="Nom de la page" onInput={e => onChange(renamePage(layout, page, e.currentTarget.value))} />}
      <button
        type="button"
        onClick={() => {
          onChange(addPage(layout, `Page ${layout.pages.length + 1}`));
          onPage(Math.min(layout.pages.length, 7));
        }}
      >
        <Plus size={16} /> Page
      </button>
      {layout.pages.length > 1 && (
        <button
          type="button"
          onClick={() => {
            onChange(removePage(layout, page));
            onPage(Math.max(0, page - 1));
          }}
        >
          <Trash2 size={16} /> Page
        </button>
      )}
      <button type="button" onClick={() => (onChange(defaultLayout()), onPage(0))}>
        <RotateCcw size={16} /> Rétablir
      </button>
      <button type="button" class="primary" onClick={onDone}>
        Terminé
      </button>
    </div>
  );
}

/** La dernière chose qui s'est passée dans le salon : on la voit sans quitter les touches. */
function Ticker({ remote }: { remote: RemoteState }) {
  const last = useApp(s => s.room?.history.filter(m => m.kind === "user").at(-1) ?? null);
  const notice = useApp(s => s.notice);
  const [event, setEvent] = useState("");
  const viewers = useRef(remote.viewers.map(v => v.name));
  useEffect(() => {
    const names = remote.viewers.map(v => v.name);
    const joined = names.find(name => !viewers.current.includes(name));
    const left = viewers.current.find(name => !names.includes(name));
    viewers.current = names;
    if (!joined && !left) return;
    setEvent(joined ? `${joined} regarde ton stream` : `${left} est parti`);
    const timer = setTimeout(() => setEvent(""), 6000);
    return () => clearTimeout(timer);
  }, [remote.viewers.map(v => v.name).join()]);
  if (notice || event) return <p class="deck-ticker is-event">{notice || event}</p>;
  if (!last) return <p class="deck-ticker is-idle">Le chat s'affiche ici</p>;
  return (
    <p class="deck-ticker">
      <b style={{ color: last.authorColor }}>{last.authorName}</b> {last.image ? "a envoyé une image" : last.text}
    </p>
  );
}

function Bar({ remote, now, editing, onEdit }: { remote: RemoteState; now: number; editing: boolean; onEdit: () => void }) {
  const online = useApp(s => s.online);
  const thumb = useApp(s => s.room?.streams.find(stream => stream.id === remote.streamId)?.thumb ?? null);
  const elapsed = keyView({ action: { kind: "time" } }, remote, now).value;
  const canFullscreen = !!document.documentElement.requestFullscreen;
  return (
    <header class="deck-bar">
      <button type="button" class="round" aria-label="Quitter la régie" onClick={() => set({ deckOpen: false })}>
        <ArrowLeft size={19} />
      </button>
      {thumb && <img src={thumb} alt="" />}
      <span class={`live-chip ${remote.paused ? "is-paused" : ""}`}>{remote.paused ? "Pause" : <Radio size={12} />}</span>
      <b class="deck-clock">{elapsed}</b>
      <span class="deck-stat">
        <Users size={14} /> {remote.viewers.length}
      </span>
      {remote.stats && (
        <span class="deck-stat is-wide">
          {remote.stats.height}p{remote.stats.fps} · {(remote.stats.kbps / 1000).toFixed(1)} Mb/s
        </span>
      )}
      {!online && <span class="offline">Reconnexion…</span>}
      <span class="spacer" />
      <button type="button" class={`round ${editing ? "is-on" : ""}`} aria-label="Modifier les touches" aria-pressed={editing} onClick={onEdit}>
        <Pencil size={17} />
      </button>
      {canFullscreen && (
        <button type="button" class="round" aria-label="Plein écran" onClick={() => void toggleFullscreen()}>
          <Expand size={17} />
        </button>
      )}
    </header>
  );
}

async function toggleFullscreen() {
  if (document.fullscreenElement) return void document.exitFullscreen();
  await document.documentElement.requestFullscreen().catch(() => {});
}

function Ask({ remote }: { remote: RemoteState }) {
  const seen = useRef("");
  useEffect(() => {
    if (remote.controlAsk && remote.controlAsk !== seen.current) navigator.vibrate?.([60, 60, 60]);
    seen.current = remote.controlAsk ?? "";
  }, [remote.controlAsk]);
  if (remote.controlAsk) {
    return (
      <div class="deck-ask" role="alert">
        <span>{remote.controlAsk} demande la main</span>
        <button type="button" class="primary" onClick={() => remoteCommand("controlAccept")}>
          Accepter
        </button>
        <button type="button" onClick={() => remoteCommand("controlRefuse")}>
          Refuser
        </button>
      </div>
    );
  }
  if (remote.controller) {
    return (
      <div class="deck-ask">
        <span>{remote.controller} a la main</span>
        <button type="button" onClick={() => remoteCommand("controlEnd")}>
          Reprendre
        </button>
      </div>
    );
  }
  return remote.stats?.limit ? <p class="deck-warning">{remote.stats.limit}</p> : null;
}

/** Le PC est allumé mais ne diffuse pas : c'est d'ici qu'on lance le direct, si la personne l'a autorisé sur le PC. */
function Launch({ remote }: { remote: RemoteState }) {
  const { launch } = remote;
  const [room, setRoom] = useState(remote.roomId || launch?.rooms[0]?.id || "");
  const [sent, setSent] = useState(false);
  const go = (scene: string) => {
    setSent(true);
    remoteCommand("goLive", `${room}|${scene}`);
    setTimeout(() => setSent(false), 12_000);
  };
  return (
    <div class="deck is-idle">
      <header class="deck-bar">
        <button type="button" class="round" aria-label="Quitter la régie" onClick={() => set({ deckOpen: false })}>
          <ArrowLeft size={19} />
        </button>
        <b>Ton PC est en ligne</b>
      </header>
      <div class="deck-launch">
        {!launch ? (
          <>
            <LayoutGrid size={30} />
            <h2>La régie s'ouvre dès que ton PC diffuse</h2>
            <p>Pour lancer le direct depuis ce téléphone, active « Le téléphone peut lancer un direct » dans Paramètres, Compte, sur ton PC.</p>
          </>
        ) : !launch.rooms.length ? (
          <p>Crée d'abord un salon sur ton PC.</p>
        ) : (
          <>
            <h2>Lancer le direct</h2>
            <label>
              <span>Dans le salon</span>
              <select value={room} onChange={e => setRoom(e.currentTarget.value)}>
                {launch.rooms.map(option => (
                  <option key={option.id} value={option.id}>
                    {option.name}
                  </option>
                ))}
              </select>
            </label>
            {launch.last && (
              <button type="button" class="primary" disabled={sent || !room} onClick={() => go("")}>
                <Tv size={18} /> {sent ? "Lancement…" : `Diffuser ${launch.last}`}
              </button>
            )}
            {launch.scenes.map(scene => (
              <button key={scene.id} type="button" class="wide" disabled={sent || !room} onClick={() => go(scene.id)}>
                <Clapperboard size={18} /> {scene.name}
              </button>
            ))}
            {!launch.last && !launch.scenes.length && <p>Lance un premier direct depuis ton PC : ce téléphone saura ensuite reprendre la même source.</p>}
          </>
        )}
      </div>
    </div>
  );
}

function View({ id, view, onView, children }: { id: "keys" | "sound" | "more"; view: string; onView: (id: "keys" | "sound" | "more") => void; children: ComponentChildren }) {
  return (
    <button type="button" role="tab" aria-selected={view === id} class={view === id ? "is-on" : ""} onClick={() => onView(id)}>
      {children}
    </button>
  );
}

export function Deck() {
  const remote = useApp(s => s.remote);
  const room = useApp(s => s.room?.code ?? "");
  const [layout, setLayout] = useState(readLayout);
  const [page, setPage] = useState(0);
  const [view, setView] = useState<"keys" | "sound" | "more">("keys");
  const [editing, setEditing] = useState(false);
  const [picking, setPicking] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  // Une régie doit rester allumée : l'écran ne s'éteint pas tant qu'elle est ouverte.
  useEffect(() => {
    const wake = () => void deckAwake(true);
    wake();
    document.addEventListener("visibilitychange", wake);
    return () => {
      document.removeEventListener("visibilitychange", wake);
      void deckAwake(false);
    };
  }, []);

  // Le téléphone entre dans le salon du direct : il y lit le chat et y envoie ses réactions.
  useEffect(() => {
    if (remote && !remote.idle && remote.roomCode && remote.roomCode !== room) void enter(remote.roomCode);
  }, [remote?.roomCode, remote?.idle, room]);

  if (!remote) return null;
  if (remote.idle) return <Launch remote={remote} />;
  const update = (next: DeckLayout) => {
    const clean = normalize(next);
    setLayout(clean);
    saveLayout(clean);
  };
  const safePage = Math.min(page, layout.pages.length - 1);
  const go = (step: number) => {
    const next = safePage + step;
    if (next < 0 || next >= layout.pages.length) return;
    navigator.vibrate?.(8);
    setPage(next);
  };
  const auto = !!layout.pages[safePage]!.auto;
  const pickedKey = picking === null ? null : (layout.pages[safePage]!.keys[picking] ?? null);
  return (
    <div class="deck">
      <Bar remote={remote} now={now} editing={editing} onEdit={() => (setEditing(!editing), setView("keys"))} />
      <Ask remote={remote} />
      <div class="deck-main">
        <nav class="deck-views" role="tablist" aria-label="Vues de la régie">
          <View id="keys" view={view} onView={setView}>
            <LayoutGrid size={18} /> <span>Touches</span>
          </View>
          <View id="sound" view={view} onView={setView}>
            <SlidersVertical size={18} /> <span>Son</span>
          </View>
          <View id="more" view={view} onView={setView}>
            <Tv size={18} /> <span>Infos</span>
          </View>
        </nav>
        <div class="deck-body">
          {view === "keys" && (
            <>
              {editing && <Editor layout={layout} page={safePage} onChange={update} onPage={setPage} onDone={() => setEditing(false)} />}
              <Grid layout={layout} page={safePage} remote={remote} now={now} editing={editing && !auto} onEdit={setPicking} onSwap={(from, to) => update(swapKeys(layout, safePage, from, to))} onPage={go} />
              {layout.pages.length > 1 && (
                <div class="deck-pages" role="tablist" aria-label="Pages de touches">
                  {layout.pages.map((item, index) => (
                    <button key={index} type="button" role="tab" aria-selected={index === safePage} class={index === safePage ? "is-on" : ""} onClick={() => setPage(index)}>
                      {item.name}
                    </button>
                  ))}
                </div>
              )}
            </>
          )}
          {view === "sound" && <Faders remote={remote} />}
          {view === "more" && <DetailsPane remote={remote} />}
        </div>
      </div>
      <Ticker remote={remote} />
      {picking !== null && (
        <Picker
          remote={remote}
          current={pickedKey}
          onClose={() => setPicking(null)}
          onChoose={key => {
            update(setKey(layout, safePage, picking, key));
            setPicking(null);
          }}
        />
      )}
    </div>
  );
}
