import { create } from "zustand";
import type { AudioEngineStatus, Settings, UpdateStatus } from "@shared/ipc.ts";
import type { ChatMessage, IceServer, Member, RoomState, RoomStatus, StreamInfo, ViewerQuality } from "@shared/protocol.ts";
import type { MixSource } from "../engine/audio/mixer.ts";
import type { BenchResult } from "../engine/encoders.ts";
import type { EncodingTarget, ViewerView } from "../engine/publisher.ts";
import type { ConnectionState } from "../engine/signal.ts";
import type { ReceiveStats, SendStats } from "../engine/stats.ts";
import type { SubscriptionState } from "../engine/subscription.ts";

export interface Toast {
  id: number;
  kind: "info" | "success" | "warning" | "error";
  text: string;
}

export interface SubView {
  streamId: string;
  ownerId: string;
  state: SubscriptionState;
  media: MediaStream;
  volume: number;
  muted: boolean;
  quality: ViewerQuality;
  stats: ReceiveStats | null;
  hasAudio: boolean;
}

export interface PublishView {
  streamId: string;
  preview: MediaStream;
  sourceName: string;
  kind: StreamInfo["kind"];
  nativeCapture: boolean;
  stats: SendStats | null;
  viewers: ViewerView[];
  mix: MixSource[];
  paused: boolean;
  target: EncodingTarget;
  bench: BenchResult[];
  title: string;
  allowDraw: boolean;
  maxViewers: number;
}

export type View = "home" | "room" | "settings";
export type PanelTab = "chat" | "members" | "studio";
export type SettingsSection = "profile" | "voice" | "stream" | "watch" | "overlay" | "hotkeys" | "notifications" | "server" | "about";

interface AppState {
  settings: Settings | null;
  settingsSection: SettingsSection;
  connection: ConnectionState;
  unreachable: boolean;
  userId: string;
  iceServers: IceServer[];
  serverName: string;
  view: View;
  panelTab: PanelTab;
  room: RoomState | null;
  statuses: Record<string, RoomStatus>;
  subs: Record<string, SubView>;
  focused: string | null;
  publish: PublishView | null;
  recording: { path: string; startedAt: number; streamId: string } | null;
  lastRecording: string | null;
  benching: string | null;
  voiceJoined: boolean;
  muted: boolean;
  deafened: boolean;
  speaking: Record<string, boolean>;
  voiceVolumes: Record<string, number>;
  audioEngine: AudioEngineStatus;
  update: UpdateStatus;
  toasts: Toast[];
  goLiveOpen: boolean;
  replyTo: ChatMessage | null;
  unread: number;
}

export const useApp = create<AppState>(() => ({
  settings: null,
  settingsSection: "profile",
  connection: "offline",
  unreachable: false,
  userId: "",
  iceServers: [],
  serverName: "",
  view: "home",
  panelTab: "chat",
  room: null,
  statuses: {},
  subs: {},
  focused: null,
  publish: null,
  recording: null,
  lastRecording: null,
  benching: null,
  voiceJoined: false,
  muted: false,
  deafened: false,
  speaking: {},
  voiceVolumes: {},
  audioEngine: "starting",
  update: { state: "idle" },
  toasts: [],
  goLiveOpen: false,
  replyTo: null,
  unread: 0,
}));

export const set = useApp.setState;
export const get = useApp.getState;

let nextToast = 1;
export function toast(text: string, kind: Toast["kind"] = "info", ms = 4500) {
  const id = nextToast++;
  set(s => ({ toasts: [...s.toasts.slice(-3), { id, kind, text }] }));
  setTimeout(() => set(s => ({ toasts: s.toasts.filter(t => t.id !== id) })), ms);
}

export function memberOf(userId: string): Member | undefined {
  return get().room?.members.find(m => m.id === userId);
}

export function patchRoom(patch: (room: RoomState) => Partial<RoomState>) {
  set(s => (s.room ? { room: { ...s.room, ...patch(s.room) } } : {}));
}

export function patchSub(streamId: string, patch: Partial<SubView>) {
  set(s => (s.subs[streamId] ? { subs: { ...s.subs, [streamId]: { ...s.subs[streamId]!, ...patch } } } : {}));
}

export function patchPublish(patch: Partial<PublishView>) {
  set(s => (s.publish ? { publish: { ...s.publish, ...patch } } : {}));
}
