// Les touches de la régie. Toute la logique est ici, sans affichage : ce qu'une touche fait, et ce qu'elle montre selon ce que le PC renvoie.
import type { RemoteState } from "@shared/protocol.ts";
import { store, stored } from "./store.ts";

/** Quinze touches par page, comme un Stream Deck : 5×3 en paysage, 3×5 en portrait. Tourner le téléphone ne déplace rien dans l'ordre de lecture. */
export const SLOTS = 15;
const STORAGE = "spoka-deck";
const MAX_PAGES = 8;

type SimpleKind = "pause" | "mic" | "deafen" | "camera" | "record" | "clip" | "marker" | "clear" | "draw" | "stop" | "time" | "viewers" | "bitrate" | "fps" | "health" | "party" | "skip";

export type DeckAction =
  | { kind: SimpleKind }
  | { kind: "scene"; id: string; name: string }
  | { kind: "screen"; index: number; name: string }
  | { kind: "mute"; id: string; name: string }
  | { kind: "banner"; text: string }
  | { kind: "chat"; text: string }
  | { kind: "react"; emoji: string };

export interface DeckKey {
  action: DeckAction;
  /** Le nom choisi par la personne, à la place de celui par défaut. */
  label?: string;
  color?: string;
}

export interface DeckPage {
  name: string;
  /** Une page automatique se remplit avec ce que le PC propose : elle ne se modifie pas à la main. */
  auto?: "scenes";
  keys: (DeckKey | null)[];
}

export interface DeckLayout {
  pages: DeckPage[];
}

export const KEY_COLORS = ["", "#ff4d5e", "#f5b041", "#34d399", "#22d3ee", "#7c5cff"];

const fill = (keys: (DeckKey | null)[]) => [...keys, ...new Array<null>(SLOTS).fill(null)].slice(0, SLOTS);
const key = (action: DeckAction): DeckKey => ({ action });

export function defaultLayout(): DeckLayout {
  return {
    pages: [
      {
        name: "Direct",
        keys: fill([key({ kind: "pause" }), key({ kind: "mic" }), key({ kind: "deafen" }), key({ kind: "camera" }), key({ kind: "record" }), key({ kind: "clip" }), key({ kind: "marker" }), key({ kind: "clear" }), key({ kind: "draw" }), key({ kind: "banner", text: "Pause dans 5 minutes" }), key({ kind: "time" }), key({ kind: "viewers" }), key({ kind: "bitrate" }), key({ kind: "health" }), key({ kind: "stop" })]),
      },
      { name: "Scènes", auto: "scenes", keys: fill([]) },
      {
        name: "Salon",
        keys: fill([key({ kind: "chat", text: "Je reviens dans 5 minutes" }), key({ kind: "chat", text: "Merci d'être là !" }), key({ kind: "chat", text: "On arrête bientôt" }), key({ kind: "party" }), key({ kind: "skip" }), ...["🔥", "😂", "😮", "❤️", "👏", "🎉", "💀", "👀"].map(emoji => key({ kind: "react", emoji }))]),
      },
    ],
  };
}

/** Ce qui vient du stockage du téléphone est relu avant usage : un fichier abîmé ne doit pas casser la régie en plein direct. */
export function normalize(value: unknown): DeckLayout {
  const pages = (value as DeckLayout | null)?.pages;
  if (!Array.isArray(pages) || !pages.length) return defaultLayout();
  return {
    pages: pages.slice(0, MAX_PAGES).map(page => ({
      name: String(page?.name ?? "Page").slice(0, 16),
      ...(page?.auto === "scenes" ? { auto: "scenes" as const } : {}),
      keys: fill(Array.isArray(page?.keys) ? page.keys.map(k => (k && typeof k === "object" && typeof k.action?.kind === "string" ? k : null)) : []),
    })),
  };
}

export function readLayout() {
  try {
    return normalize(JSON.parse(stored(STORAGE) ?? "null"));
  } catch {
    return defaultLayout();
  }
}

export const saveLayout = (layout: DeckLayout) => store(STORAGE, JSON.stringify(layout));

export function swapKeys(layout: DeckLayout, page: number, from: number, to: number): DeckLayout {
  return {
    pages: layout.pages.map((p, i) => {
      if (i !== page) return p;
      const keys = [...p.keys];
      [keys[from], keys[to]] = [keys[to] ?? null, keys[from] ?? null];
      return { ...p, keys };
    }),
  };
}

export const setKey = (layout: DeckLayout, page: number, slot: number, value: DeckKey | null): DeckLayout => ({ pages: layout.pages.map((p, i) => (i === page ? { ...p, keys: p.keys.map((k, s) => (s === slot ? value : k)) } : p)) });

export const addPage = (layout: DeckLayout, name: string): DeckLayout => (layout.pages.length >= MAX_PAGES ? layout : { pages: [...layout.pages, { name: name.slice(0, 16) || "Page", keys: fill([]) }] });

export const removePage = (layout: DeckLayout, page: number): DeckLayout => (layout.pages.length <= 1 ? layout : { pages: layout.pages.filter((_, i) => i !== page) });

export const renamePage = (layout: DeckLayout, page: number, name: string): DeckLayout => ({ pages: layout.pages.map((p, i) => (i === page ? { ...p, name: name.slice(0, 16) } : p)) });

/** Une page automatique : les scènes, puis les écrans d'attente, tels que le PC les propose à cet instant. */
export function pageKeys(page: DeckPage, remote: RemoteState): (DeckKey | null)[] {
  if (page.auto !== "scenes") return page.keys;
  return fill([...remote.scenes.map(scene => key({ kind: "scene", id: scene.id, name: scene.name })), ...remote.screens.map((name, index) => key({ kind: "screen", index, name }))]);
}

export interface KeyView {
  icon: string;
  label: string;
  /** Une mesure qui s'affiche à la place de l'icône. */
  value?: string;
  on: boolean;
  /** Une touche d'information : la toucher ne fait rien. */
  info?: boolean;
  /** Il faut appuyer longtemps : ce geste ne se rattrape pas. */
  hold?: boolean;
  /** Le PC doit répondre : la touche attend, et signale s'il se tait. */
  waits?: boolean;
  disabled?: boolean;
}

const clock = (seconds: number) => {
  const hours = Math.floor(seconds / 3600);
  const minutes = String(Math.floor((seconds % 3600) / 60)).padStart(hours ? 2 : 1, "0");
  return `${hours ? `${hours}:` : ""}${minutes}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;
};

/** Ce que montre une touche : c'est l'état renvoyé par le PC, jamais une supposition faite au moment du toucher. */
export function keyView(deckKey: DeckKey, remote: RemoteState, now: number, party: { on: boolean; playing: boolean } = { on: false, playing: false }): KeyView {
  const { action } = deckKey;
  const view = ((): KeyView => {
    switch (action.kind) {
      case "pause":
        return { icon: remote.paused ? "play" : "pause", label: remote.paused ? "Reprendre" : "Pause", on: remote.paused, waits: true };
      case "mic":
        return { icon: remote.muted ? "mic-off" : "mic", label: remote.muted ? "Micro coupé" : "Micro", on: remote.muted, waits: true };
      case "deafen":
        return { icon: remote.deafened ? "headphone-off" : "headphones", label: remote.deafened ? "Sourdine" : "Écoute", on: remote.deafened, waits: true };
      case "camera":
        return { icon: remote.camera ? "camera" : "camera-off", label: "Caméra", on: remote.camera, waits: true };
      case "record":
        return { icon: "record", label: remote.recording ? "Enregistre" : "Enregistrer", on: remote.recording, waits: true };
      case "clip":
        return { icon: "clip", label: "Clip", value: remote.clips ? String(remote.clips) : undefined, on: false, waits: remote.clips !== undefined };
      case "marker":
        return { icon: "marker", label: "Marqueur", value: remote.markers ? String(remote.markers) : undefined, on: false, waits: remote.markers !== undefined };
      case "clear":
        return { icon: "clear", label: "Effacer", on: false };
      case "draw":
        return { icon: "draw", label: remote.allowDraw === false ? "Dessin coupé" : "Dessin", on: remote.allowDraw === false, waits: true, disabled: remote.allowDraw === undefined };
      case "stop":
        return { icon: "stop", label: "Arrêter", on: false, hold: true };
      case "time":
        return { icon: "time", label: "En direct", value: clock(Math.max(0, (now - remote.startedAt) / 1000)), on: false, info: true };
      case "viewers":
        return { icon: "viewers", label: remote.viewers.length > 1 ? "Spectateurs" : "Spectateur", value: String(remote.viewers.length), on: false, info: true };
      case "bitrate":
        return { icon: "bitrate", label: "Mb/s", value: remote.stats ? (remote.stats.kbps / 1000).toFixed(1) : "—", on: false, info: true };
      case "fps":
        return { icon: "fps", label: remote.stats ? `${remote.stats.height}p` : "Images/s", value: remote.stats ? String(remote.stats.fps) : "—", on: false, info: true };
      case "health":
        return { icon: "health", label: remote.stats?.limit ?? (remote.stats ? "Tout va bien" : "Pas de mesure"), on: !!remote.stats?.limit, info: true };
      case "scene":
        return { icon: "scene", label: remote.scenes.find(s => s.id === action.id)?.name ?? action.name, on: remote.scene === action.id, waits: true, disabled: !remote.scenes.some(s => s.id === action.id) };
      case "screen": {
        const name = remote.screens[action.index] ?? action.name;
        return { icon: "screen", label: name, on: remote.screen === name, waits: true, disabled: !remote.screens[action.index] };
      }
      case "mute": {
        const source = remote.mix.find(m => m.id === action.id);
        return { icon: source?.muted ? "volume-off" : "volume", label: source?.label ?? action.name, on: !!source?.muted, waits: true, disabled: !source };
      }
      case "banner":
        return { icon: "banner", label: action.text, on: remote.banner === action.text, waits: true };
      case "chat":
        return { icon: "chat", label: action.text, on: false };
      case "react":
        return { icon: "react", label: "Réaction", value: action.emoji, on: false };
      case "party":
        return { icon: party.playing ? "pause" : "play", label: "Watch Party", on: party.playing, disabled: !party.on };
      case "skip":
        return { icon: "skip", label: "Vidéo suivante", on: false, disabled: !party.on };
    }
  })();
  return { ...view, label: deckKey.label || view.label };
}

export interface CatalogGroup {
  title: string;
  keys: DeckKey[];
}

/** Tout ce qu'on peut mettre sur une touche, avec ce que le PC propose en ce moment. */
export function catalog(remote: RemoteState): CatalogGroup[] {
  const plain = (kinds: SimpleKind[]) => kinds.map(kind => key({ kind }));
  return [
    { title: "Direct", keys: plain(["pause", "record", "clip", "marker", "clear", "draw", "stop"]) },
    { title: "Micro et caméra", keys: plain(["mic", "deafen", "camera"]) },
    { title: "Mesures", keys: plain(["time", "viewers", "bitrate", "fps", "health"]) },
    { title: "Scènes", keys: remote.scenes.map(scene => key({ kind: "scene", id: scene.id, name: scene.name })) },
    { title: "Écrans d'attente", keys: remote.screens.map((name, index) => key({ kind: "screen", index, name })) },
    { title: "Sources de son", keys: remote.mix.map(source => key({ kind: "mute", id: source.id, name: source.label })) },
    { title: "Watch Party", keys: plain(["party", "skip"]) },
  ].filter(group => group.keys.length);
}
