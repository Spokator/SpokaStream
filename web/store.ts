import { useEffect, useReducer, useRef } from "preact/hooks";
import type { RemoteState, RoomState, RoomStatus } from "@shared/protocol.ts";
import type { ChatMessage } from "@shared/protocol.ts";

export const TOGETHER = "together";

export interface RecentRoom {
  id: string;
  code: string;
  name: string;
}

export type Tab = "chat" | "live" | "room" | "regie";
export type Sheet = null | "quality" | "profile" | "poll" | "together" | "share" | { message: ChatMessage };

export interface Float {
  id: number;
  emoji: string;
  left: number;
}

export interface ViewStats {
  height: number;
  fps: number;
  kbps: number;
  lostPct: number;
  relay: boolean;
}

export interface WebState {
  screen: "home" | "join" | "room";
  code: string;
  error: string;
  online: boolean;
  userId: string;
  /** Le compte : le même que le PC une fois ce téléphone rattaché. */
  accountId: string;
  admin: boolean;
  /** Vient d'être rattaché : le profil et les droits ont changé. */
  linked: boolean;
  /** Ce que diffuse un autre appareil du compte. */
  remote: RemoteState | null;
  /** Un message du serveur à montrer un moment. */
  notice: string;
  name: string;
  color: string;
  avatar: string | null;
  room: RoomState | null;
  statuses: Record<string, RoomStatus>;
  recents: RecentRoom[];
  shown: string | null;
  /** Le second stream, en petit par-dessus le premier. */
  mini: string | null;
  /** Notifications de ce téléphone : "off", "on", ou "blocked" quand le téléphone les refuse. */
  push: "unsupported" | "off" | "on" | "blocked";
  status: string;
  /** Le navigateur a coupé le son ou la lecture : il faut un geste de la personne. */
  needsTap: "" | "son" | "lecture";
  stats: ViewStats | null;
  /** Mo reçus depuis l'ouverture, pour qui regarde sur son forfait. */
  dataMb: number;
  quality: number;
  latency: "balanced" | "stable";
  tab: Tab;
  unread: number;
  chatOpen: boolean;
  sheet: Sheet;
  immersive: boolean;
  fullscreen: boolean;
  /** Installation possible, sur Android : le navigateur attend un geste. */
  canInstall: boolean;
  replyTo: ChatMessage | null;
  draftImage: string | null;
  typing: Record<string, number>;
  floats: Float[];
  voiceOn: boolean;
  micOn: boolean;
  deafened: boolean;
  /** Mode talkie : le micro ne s'ouvre que pendant qu'on appuie. */
  pushToTalk: boolean;
  talking: boolean;
  speaking: Record<string, boolean>;
  togetherVolume: number;
}

type Patch = Partial<WebState> | ((state: WebState) => Partial<WebState>);

const listeners = new Set<() => void>();
let state: WebState;

export const get = () => state;

export function init(initial: WebState) {
  state = initial;
}

export function set(patch: Patch) {
  state = { ...state, ...(typeof patch === "function" ? patch(state) : patch) };
  for (const listener of listeners) listener();
}

/** Ne redessine un composant que si la valeur qu'il lit a changé. */
export function useApp<T>(select: (state: WebState) => T): T {
  const [, redraw] = useReducer((n: number) => n + 1, 0);
  const value = select(state);
  const latest = useRef({ select, value });
  latest.current = { select, value };
  useEffect(() => {
    const check = () => {
      if (!Object.is(latest.current.select(state), latest.current.value)) redraw(0);
    };
    listeners.add(check);
    check();
    return () => void listeners.delete(check);
  }, []);
  return value;
}

export function stored(key: string) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function store(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Navigation privée : tout ne dure que le temps de la page.
  }
}
