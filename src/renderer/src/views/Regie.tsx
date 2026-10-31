import { ChevronDown, ChevronRight, ExternalLink, GripVertical, LayoutDashboard, Mic, MicOff, Pause, Play, Rewind, RotateCcw, Scissors, SlidersHorizontal, Users, Video, VideoOff, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import type { PanelId } from "@shared/ipc.ts";
import { core } from "../engine/core.ts";
import { get, set, useApp } from "../state/store.ts";
import { mbps } from "../ui/format.ts";
import { Button, IconButton, Popover, Select } from "../ui/kit.tsx";
import { healthOf, LiveTimer, PANELS } from "./RegiePanels.tsx";

type Zone = "left" | "center" | "right";

const PANEL_DATA = "text/spoka-panel";
/** L'ordre du Studio, dans le panneau étroit à côté de la scène : ce dont on se sert le plus d'abord. */
const SIDE_ORDER: PanelId[] = ["actions", "health", "scenes", "sources", "mixer", "info", "screens", "quality", "audience", "activity", "notes"];

function Panel({ id, movable }: { id: PanelId; movable: boolean }) {
  const collapsed = useApp(s => s.settings!.regie.collapsed.includes(id));
  const definition = PANELS[id];
  const Chevron = collapsed ? ChevronRight : ChevronDown;
  return (
    <section className={`regie-panel is-${id} ${collapsed ? "is-collapsed" : ""}`} data-panel={id} aria-label={definition.title}>
      <header
        draggable={movable}
        onDragStart={e => {
          e.dataTransfer.setData(PANEL_DATA, id);
          e.dataTransfer.effectAllowed = "move";
        }}
      >
        {movable && <GripVertical size={14} className="regie-grip" aria-hidden />}
        <button type="button" className="regie-panel-title" aria-expanded={!collapsed} onClick={() => core.togglePanel(id)}>
          <Chevron size={14} />
          <definition.icon size={15} />
          {definition.title}
        </button>
        {!collapsed && definition.tools?.()}
      </header>
      {!collapsed && <div className="regie-panel-body">{definition.body()}</div>}
    </section>
  );
}

function Column({ zone, ids }: { zone: Zone; ids: PanelId[] }) {
  const [over, setOver] = useState(false);
  return (
    <div
      className={`regie-column is-${zone} ${over ? "is-over" : ""}`}
      data-zone={zone}
      onDragOver={e => {
        if (!e.dataTransfer.types.includes(PANEL_DATA)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={e => {
        setOver(false);
        const id = e.dataTransfer.getData(PANEL_DATA) as PanelId;
        if (!id) return;
        e.preventDefault();
        const before = (e.target as HTMLElement).closest<HTMLElement>("[data-panel]")?.dataset.panel as PanelId | undefined;
        if (before !== id) core.movePanel(id, zone, before ?? null);
      }}
    >
      {ids.map(id => (
        <Panel key={id} id={id} movable />
      ))}
    </div>
  );
}

function useVisible(ids: PanelId[]) {
  const hidden = useApp(s => s.settings!.regie.hidden);
  return ids.filter(id => !hidden.includes(id));
}

/** Le panneau Studio : les mêmes outils que la régie, repliés pour tenir dans une colonne, à côté de la scène. */
export function Studio() {
  const panels = useVisible(SIDE_ORDER);
  return (
    <div className="studio">
      {panels.map(id => (
        <Panel key={id} id={id} movable={false} />
      ))}
    </div>
  );
}

/** Le tableau de bord du direct : l'image au centre, et tout le reste autour, visible en même temps. */
export function RegieBoard({ stage }: { stage: ReactNode }) {
  const regie = useApp(s => s.settings!.regie);
  const left = useVisible(regie.left);
  const center = useVisible(regie.center);
  const right = useVisible(regie.right);
  return (
    <div className="regie-board">
      <Column zone="left" ids={left} />
      <div className="regie-center">
        {stage}
        <Column zone="center" ids={center} />
      </div>
      <Column zone="right" ids={right} />
    </div>
  );
}

function Customize() {
  const regie = useApp(s => s.settings!.regie);
  return (
    <Popover
      align="right"
      trigger={(open, toggle) => (
        <IconButton label="Personnaliser la régie" active={open} onClick={toggle}>
          <SlidersHorizontal size={16} />
        </IconButton>
      )}
    >
      {close => (
        <div className="menu">
          <div className="menu-title">Panneaux affichés</div>
          {(Object.keys(PANELS) as PanelId[]).map(id => (
            <label key={id} className="menu-check">
              <input type="checkbox" checked={!regie.hidden.includes(id)} onChange={e => core.updateRegie({ hidden: e.target.checked ? regie.hidden.filter(p => p !== id) : [...regie.hidden, id] })} />
              {PANELS[id].title}
            </label>
          ))}
          <div className="menu-title">Comportement</div>
          <label className="menu-check">
            <input type="checkbox" checked={regie.auto} onChange={e => core.updateRegie({ auto: e.target.checked })} />
            Ouvrir la régie au lancement
          </label>
          <label className="menu-check">
            <input
              type="checkbox"
              checked={regie.onTop}
              onChange={e => {
                core.updateRegie({ onTop: e.target.checked });
                window.spoka.regieOnTop(e.target.checked);
              }}
            />
            Fenêtre détachée toujours au-dessus
          </label>
          <button
            type="button"
            className="menu-item"
            onClick={() => {
              core.resetRegie();
              close();
            }}
          >
            <span>
              <RotateCcw size={14} /> Remettre la disposition d'origine
            </span>
          </button>
        </div>
      )}
    </Popover>
  );
}

/** Toujours sous les yeux pendant un direct, quel que soit l'onglet ouvert : l'état et les gestes qui comptent. */
export function LiveBar() {
  const publish = useApp(s => s.publish)!;
  const viewers = useApp(s => s.room?.streams.find(x => x.id === s.publish?.streamId)?.viewers.length ?? 0);
  const scenes = useApp(s => s.settings!.scenes);
  const regie = useApp(s => s.regie);
  const detached = useApp(s => s.regieWindow);
  const muted = useApp(s => s.muted);
  const clipSaving = useApp(s => s.clipSaving);
  const cameraId = useApp(s => s.settings!.stream.cameraId);
  const health = healthOf(publish);
  const { stats } = publish;

  return (
    <div className={`live-bar ${publish.paused ? "is-paused" : ""}`} role="region" aria-label="Barre de direct">
      <span className="live-bar-state">
        <i />
        {publish.screen ?? (publish.paused ? "En pause" : "En direct")} · <LiveTimer />
      </span>
      <span className="live-bar-chip" title="Spectateurs">
        <Users size={13} /> {viewers}
      </span>
      <button type="button" className={`health-pill is-${health.tone}`} title={health.advice ?? "Voir la santé du stream"} onClick={() => (get().regie ? undefined : set({ panelTab: "studio" }))}>
        {health.text}
      </button>
      {stats && (
        <span className="live-bar-stats">
          {stats.height}p{stats.fps} · {mbps(stats.kbps)} Mb/s
        </span>
      )}
      <span className="live-bar-spacer" />
      {scenes.length > 0 && <Select label="Scène en cours" value={publish.scene ?? ""} options={[{ value: "", label: "Scène…" }, ...scenes.map(s => ({ value: s.id, label: s.name }))]} onChange={id => id && void core.applyScene(id)} />}
      <IconButton label={publish.paused ? "Reprendre le stream" : "Mettre le stream en pause"} active={publish.paused} onClick={() => void core.setPaused(!publish.paused)}>
        {publish.paused ? <Play size={17} /> : <Pause size={17} />}
      </IconButton>
      <IconButton label={muted ? "Rallumer mon micro" : "Couper mon micro"} danger={muted} onClick={() => core.toggleMute()}>
        {muted ? <MicOff size={17} /> : <Mic size={17} />}
      </IconButton>
      <IconButton label={publish.camera ? "Éteindre ma caméra" : "Allumer ma caméra"} active={!!publish.camera} onClick={() => void core.setCamera(publish.camera ? null : cameraId)}>
        {publish.camera ? <Video size={17} /> : <VideoOff size={17} />}
      </IconButton>
      <IconButton label="Garder un clip" disabled={clipSaving} onClick={() => void core.saveClip()}>
        <Scissors size={17} />
      </IconButton>
      <IconButton label="Revoir ce qui vient de se passer" disabled={clipSaving} onClick={() => void core.replay()}>
        <Rewind size={17} />
      </IconButton>
      <span className="live-bar-divider" />
      {regie && <Customize />}
      <IconButton label={detached ? "Rattacher la régie" : "Détacher la régie dans sa fenêtre"} active={detached} onClick={() => set({ regieWindow: !detached })}>
        <ExternalLink size={16} />
      </IconButton>
      <Button variant={regie ? "default" : "primary"} icon={regie ? <X size={15} /> : <LayoutDashboard size={15} />} onClick={() => (regie ? set({ regie: false }) : core.openRegie())}>
        {regie ? "Fermer la régie" : "Régie"}
      </Button>
    </div>
  );
}

/**
 * La régie dans sa propre fenêtre, pour un second écran. C'est la même arborescence React rendue ailleurs : même état,
 * rien à synchroniser. La fenêtre est exclue des captures, un partage d'écran ne la montre pas.
 */
export function RegieWindow() {
  const [body, setBody] = useState<HTMLElement | null>(null);
  const opened = useRef<Window | null>(null);
  const regie = useApp(s => s.settings!.regie);
  const left = useVisible(regie.left);
  const center = useVisible(regie.center);
  const right = useVisible(regie.right);

  useEffect(() => {
    const child = window.open("", "spoka-regie");
    if (!child) return set({ regieWindow: false });
    opened.current = child;
    child.document.title = "Régie SpokaStream";
    for (const node of document.querySelectorAll<HTMLElement>('link[rel="stylesheet"], style')) {
      const copy = node.cloneNode(true) as HTMLElement;
      if (copy instanceof HTMLLinkElement) copy.href = (node as HTMLLinkElement).href;
      child.document.head.append(copy);
    }
    child.document.documentElement.style.setProperty("--accent", get().settings!.accent);
    child.document.body.className = "regie-window";
    setBody(child.document.body);
    const watcher = setInterval(() => child.closed && set({ regieWindow: false }), 500);
    return () => {
      clearInterval(watcher);
      child.close();
    };
  }, []);

  if (!body) return null;
  return createPortal(
    <div className="regie-board is-detached">
      <Column zone="left" ids={left} />
      <div className="regie-center">
        <Column zone="center" ids={center} />
      </div>
      <Column zone="right" ids={right} />
    </div>,
    body,
  );
}
