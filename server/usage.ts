// Comment le service est utilisé, jour par jour. Un fichier léger, gardé 90 jours : il ne sert qu'au panneau.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

const DAYS_KEPT = 90;
const SESSIONS_KEPT = 300;
const SAVE_DELAY_MS = 30_000;

export interface DayUsage {
  day: string;
  streams: number;
  streamMinutes: number;
  watchMinutes: number;
  relayMinutes: number;
  directMinutes: number;
  partyMinutes: number;
  parties: number;
  messages: number;
  roomsCreated: number;
  newAccounts: number;
  activeAccounts: number;
  peakConnections: number;
  peakStreams: number;
  peakViewers: number;
  webConnections: number;
  appConnections: number;
  /** Le pic de connexions de chaque heure : on voit à quel moment les gens viennent. */
  hours: number[];
}

/** Une diffusion terminée, pour retrouver ce qui s'est passé hier soir. */
export interface StreamSession {
  id: string;
  startedAt: number;
  endedAt: number;
  accountId: string;
  name: string;
  room: string;
  title: string;
  kind: string;
  height: number;
  fps: number;
  peakViewers: number;
  kbps: number;
  relayShare: number;
  lossPct: number;
}

type Counter = Exclude<keyof DayUsage, "day" | "hours">;

interface UsageData {
  days: DayUsage[];
  active: { day: string; ids: string[] };
  sessions: StreamSession[];
}

const blankDay = (day: string): DayUsage => ({ day, streams: 0, streamMinutes: 0, watchMinutes: 0, relayMinutes: 0, directMinutes: 0, partyMinutes: 0, parties: 0, messages: 0, roomsCreated: 0, newAccounts: 0, activeAccounts: 0, peakConnections: 0, peakStreams: 0, peakViewers: 0, webConnections: 0, appConnections: 0, hours: new Array<number>(24).fill(0) });

export class Usage {
  private data: UsageData = { days: [], active: { day: "", ids: [] }, sessions: [] };
  private readonly active = new Set<string>();
  private readonly file?: string;
  private readonly now: () => number;
  private timer: NodeJS.Timeout | null = null;

  constructor(file?: string, now: () => number = Date.now) {
    this.file = file;
    this.now = now;
    if (!file) return;
    mkdirSync(path.dirname(file), { recursive: true });
    try {
      this.data = { ...this.data, ...(JSON.parse(readFileSync(file, "utf8")) as Partial<UsageData>) };
      for (const id of this.data.active.ids) this.active.add(id);
    } catch {
      // Premier démarrage.
    }
  }

  private today() {
    const key = new Date(this.now()).toISOString().slice(0, 10);
    let day = this.data.days.at(-1);
    if (day?.day !== key) {
      day = blankDay(key);
      this.data.days.push(day);
      this.data.days = this.data.days.slice(-DAYS_KEPT);
      this.active.clear();
    }
    return day;
  }

  private save() {
    if (!this.file || this.timer) return;
    this.timer = setTimeout(() => this.flush(), SAVE_DELAY_MS);
    this.timer.unref?.();
  }

  flush() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (!this.file) return;
    this.data.active = { day: this.data.days.at(-1)?.day ?? "", ids: [...this.active] };
    const temporary = `${this.file}.tmp`;
    writeFileSync(temporary, JSON.stringify(this.data), { mode: 0o600 });
    renameSync(temporary, this.file);
  }

  count(key: Counter, by = 1) {
    this.today()[key] += by;
    this.save();
  }

  peak(key: Counter, value: number) {
    const day = this.today();
    if (value > day[key]) day[key] = value;
    this.save();
  }

  /** Une personne compte une fois par jour, quel que soit son nombre d'appareils. */
  seen(accountId: string) {
    const day = this.today();
    this.active.add(accountId);
    day.activeAccounts = this.active.size;
    this.save();
  }

  connections(count: number) {
    const day = this.today();
    const hour = new Date(this.now()).getUTCHours();
    if (count > day.hours[hour]!) day.hours[hour] = count;
    if (count > day.peakConnections) day.peakConnections = count;
    this.save();
  }

  session(session: StreamSession) {
    this.data.sessions.unshift(session);
    this.data.sessions.length = Math.min(this.data.sessions.length, SESSIONS_KEPT);
    this.save();
  }

  sessions() {
    return this.data.sessions;
  }

  days(count: number) {
    this.today();
    return this.data.days.slice(-count);
  }
}
