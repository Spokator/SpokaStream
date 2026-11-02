// Qui consomme quoi, compte par compte. Tout vient de ce que les applications déclarent toutes les 10 secondes : le serveur ne voit passer aucune vidéo.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

const POINT_MS = 5 * 60_000;
const SAVE_DELAY_MS = 60_000;
/** Répétés dans la politique de confidentialité : s'ils changent, elle change aussi. */
export const POINTS_KEPT_HOURS = 48;
export const DAYS_KEPT = 90;

/** En kilobits. relayUp et relayDown sont des parts de up et down. */
export interface Flow {
  up: number;
  down: number;
  relayUp: number;
  relayDown: number;
}

type Point = [at: number, up: number, down: number, relayUp: number, relayDown: number];

interface AccountBandwidth {
  points: Point[];
  days: Record<string, Flow>;
}

const blank = (): Flow => ({ up: 0, down: 0, relayUp: 0, relayDown: 0 });
const addTo = (total: Flow, flow: Flow) => {
  total.up += flow.up;
  total.down += flow.down;
  total.relayUp += flow.relayUp;
  total.relayDown += flow.relayDown;
};
const flowOf = ([, up, down, relayUp, relayDown]: Point): Flow => ({ up, down, relayUp, relayDown });
const dayOf = (at: number) => new Date(at).toISOString().slice(0, 10);
const asMbps = (kilobits: number, seconds: number) => +(kilobits / seconds / 1000).toFixed(2);

export class Bandwidth {
  private data: Record<string, AccountBandwidth> = {};
  private readonly file?: string;
  private readonly now: () => number;
  private timer: NodeJS.Timeout | null = null;

  constructor(file?: string, now: () => number = Date.now) {
    this.file = file;
    this.now = now;
    if (!file) return;
    mkdirSync(path.dirname(file), { recursive: true });
    try {
      this.data = JSON.parse(readFileSync(file, "utf8")) as Record<string, AccountBandwidth>;
      this.prune();
    } catch {
      // Premier démarrage.
    }
  }

  private save() {
    if (!this.file || this.timer) return;
    this.timer = setTimeout(() => this.flush(), SAVE_DELAY_MS);
    this.timer.unref?.();
  }

  flush() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.prune();
    if (!this.file) return;
    const temporary = `${this.file}.tmp`;
    writeFileSync(temporary, JSON.stringify(this.data), { mode: 0o600 });
    renameSync(temporary, this.file);
  }

  /** Une durée annoncée dans la politique de confidentialité doit tenir pour tout le monde, même un compte parti depuis longtemps. */
  prune() {
    const now = this.now();
    const pointsSince = now - POINTS_KEPT_HOURS * 3600_000;
    const daysSince = dayOf(now - DAYS_KEPT * 86_400_000);
    for (const [id, account] of Object.entries(this.data)) {
      account.points = account.points.filter(point => point[0] >= pointsSince);
      for (const day of Object.keys(account.days)) if (day < daysSince) delete account.days[day];
      if (!account.points.length && !Object.keys(account.days).length) delete this.data[id];
    }
  }

  add(accountId: string, flow: Flow) {
    if (!flow.up && !flow.down) return;
    const now = this.now();
    const account = (this.data[accountId] ??= { points: [], days: {} });
    const at = now - (now % POINT_MS);
    let point = account.points.at(-1);
    if (point?.[0] !== at) account.points.push((point = [at, 0, 0, 0, 0]));
    point[1] += Math.round(flow.up);
    point[2] += Math.round(flow.down);
    point[3] += Math.round(flow.relayUp);
    point[4] += Math.round(flow.relayDown);
    const today = (account.days[dayOf(now)] ??= blank());
    addTo(today, { up: Math.round(flow.up), down: Math.round(flow.down), relayUp: Math.round(flow.relayUp), relayDown: Math.round(flow.relayDown) });
    this.save();
  }

  forget(accountId: string) {
    if (!this.data[accountId]) return;
    delete this.data[accountId];
    this.save();
  }

  /** Un appareil rejoint un compte : ce qu'il a consommé le suit. */
  merge(from: string, to: string) {
    const old = this.data[from];
    if (!old || from === to) return;
    const target = (this.data[to] ??= { points: [], days: {} });
    const points = new Map(target.points.map(point => [point[0], [...point] as Point]));
    for (const point of old.points) {
      const known = points.get(point[0]);
      if (!known) points.set(point[0], [...point]);
      else for (const i of [1, 2, 3, 4] as const) known[i] += point[i];
    }
    target.points = [...points.values()].sort((a, b) => a[0] - b[0]);
    for (const [day, flow] of Object.entries(old.days)) addTo((target.days[day] ??= blank()), flow);
    delete this.data[from];
    this.save();
  }

  /** Sur 24 h on lit les points, plus longtemps les totaux du jour. La pointe n'existe que sur 24 h. */
  totals(days: number) {
    const now = this.now();
    const since = now - 24 * 3600_000;
    const daysSince = dayOf(now - (days - 1) * 86_400_000);
    return Object.entries(this.data).flatMap(([id, account]) => {
      const total = blank();
      let peak = 0;
      for (const point of account.points) {
        if (point[0] < since) continue;
        if (days === 1) addTo(total, flowOf(point));
        peak = Math.max(peak, point[1] + point[2]);
      }
      if (days > 1) for (const [day, flow] of Object.entries(account.days)) if (day >= daysSince) addTo(total, flow);
      return total.up || total.down ? [{ id, ...total, peakMbps: asMbps(peak, POINT_MS / 1000) }] : [];
    });
  }

  /**
   * 24 h en Mb/s moyens. Pour un compte, le relais compte ce qu'il envoie et ce qu'il reçoit. Pour le total, un flux relayé est
   * vu par ses deux bouts : seul le côté du diffuseur compte, sinon il serait compté deux fois.
   */
  timeline(accountId?: string) {
    const now = this.now();
    const current = now - (now % POINT_MS);
    const buckets = new Map<number, Flow>();
    for (let at = current - 24 * 3600_000 + POINT_MS; at <= current; at += POINT_MS) buckets.set(at, blank());
    for (const account of accountId ? [this.data[accountId]] : Object.values(this.data)) {
      for (const point of account?.points ?? []) {
        const bucket = buckets.get(point[0]);
        if (bucket) addTo(bucket, flowOf(point));
      }
    }
    const at = [...buckets.keys()];
    // Le dernier point n'est pas fini : divisé par 5 minutes pleines, il ferait croire à une chute.
    const seconds = (time: number) => (time === current ? Math.max(10, (now - current) / 1000) : POINT_MS / 1000);
    const series = (read: (flow: Flow) => number) => at.map(time => asMbps(read(buckets.get(time)!), seconds(time)));
    return { at, up: series(flow => flow.up), down: series(flow => flow.down), relay: series(flow => (accountId ? flow.relayUp + flow.relayDown : flow.relayUp)) };
  }

  /** Les derniers jours en kilobits, jours vides compris : un trou doit se voir. */
  daily(count: number, accountId?: string) {
    const now = this.now();
    const days = Array.from({ length: count }, (_, i) => dayOf(now - (count - 1 - i) * 86_400_000));
    return days.map(day => {
      const total = blank();
      for (const account of accountId ? [this.data[accountId]] : Object.values(this.data)) if (account?.days[day]) addTo(total, account.days[day]);
      return { day, up: total.up, down: total.down, relay: accountId ? total.relayUp + total.relayDown : total.relayUp };
    });
  }
}
