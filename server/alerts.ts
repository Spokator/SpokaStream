// Prévenir avant que quelqu'un ne s'en plaigne. Une règle ne déclenche qu'après avoir tenu un moment : un pic d'une seconde n'est pas un incident.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { AlertRule } from "./config.ts";

const HISTORY = 200;
const WEBHOOK_HOSTS = new Set(["discord.com", "discordapp.com", "ptb.discord.com", "canary.discord.com"]);

export interface AlertContext {
  point: Record<string, number | null>;
  services: Record<string, { state: string }>;
  certificateDays: number | null;
  diskPct: number | null;
  errors5min: number;
  memMaxPct: number | null;
  throttledPct: number;
}

export interface RuleDefinition {
  id: string;
  label: string;
  unit: string;
  limit: number;
  /** Combien de minutes la limite doit être dépassée avant d'alerter. */
  minutes: number;
  /** La valeur mesurée ; null si on ne sait pas la mesurer ici. */
  read: (c: AlertContext) => number | null;
  /** Par défaut, on alerte au-dessus de la limite. */
  below?: boolean;
}

const up = (name: string) => (c: AlertContext) => (c.services[name] && c.services[name]!.state !== "inconnu" ? (c.services[name]!.state === "active" ? 0 : 1) : null);

export const RULES: RuleDefinition[] = [
  { id: "coturn", label: "Le relais coturn est arrêté", unit: "", limit: 0, minutes: 1, read: up("coturn") },
  { id: "nginx", label: "nginx est arrêté", unit: "", limit: 0, minutes: 1, read: up("nginx") },
  { id: "stun", label: "Le relais ne répond plus", unit: "", limit: 0, minutes: 3, read: c => (c.point.stunFailed ?? null) },
  { id: "https", label: "Le site ne répond plus depuis l'extérieur", unit: "", limit: 0, minutes: 3, read: c => (c.point.httpsFailed ?? null) },
  { id: "cpu", label: "Processeur de la machine saturé", unit: "%", limit: 90, minutes: 5, read: c => c.point.cpu ?? null },
  { id: "steal", label: "L'hébergeur retire du processeur à la machine", unit: "%", limit: 15, minutes: 5, read: c => c.point.steal ?? null },
  { id: "memory", label: "Mémoire de la machine presque pleine", unit: "%", limit: 92, minutes: 3, read: c => c.point.mem ?? null },
  { id: "disk", label: "Disque presque plein", unit: "%", limit: 90, minutes: 1, read: c => c.diskPct },
  { id: "serviceMemory", label: "SpokaStream approche de sa limite de mémoire", unit: "%", limit: 85, minutes: 3, read: c => c.memMaxPct },
  { id: "throttled", label: "SpokaStream est bridé par sa limite de processeur", unit: "%", limit: 20, minutes: 3, read: c => c.throttledPct },
  { id: "loop", label: "Le serveur répond lentement", unit: "ms", limit: 200, minutes: 2, read: c => c.point.loopP99 ?? null },
  { id: "loss", label: "Pertes élevées sur les streams", unit: "%", limit: 5, minutes: 3, read: c => c.point.lossPct ?? null },
  { id: "errors", label: "Erreurs en série dans le journal", unit: "", limit: 10, minutes: 0, read: c => c.errors5min },
  { id: "certificate", label: "Le certificat HTTPS expire bientôt", unit: "jours", limit: 14, minutes: 0, read: c => c.certificateDays, below: true },
];

export interface AlertEvent {
  id: string;
  rule: string;
  label: string;
  value: number | null;
  limit: number;
  unit: string;
  startedAt: number;
  endedAt: number | null;
}

export const validWebhook = (url: string) => {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && WEBHOOK_HOSTS.has(parsed.hostname) && parsed.pathname.startsWith("/api/webhooks/");
  } catch {
    return false;
  }
};

export interface AlertOptions {
  rules: () => Record<string, AlertRule>;
  notify: (text: string) => void;
  file?: string;
  now?: () => number;
}

export class Alerts {
  private events: AlertEvent[] = [];
  private readonly breachedSince = new Map<string, number>();
  private readonly options: AlertOptions;
  private readonly now: () => number;

  constructor(options: AlertOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
    if (!options.file) return;
    mkdirSync(path.dirname(options.file), { recursive: true });
    try {
      this.events = JSON.parse(readFileSync(options.file, "utf8")) as AlertEvent[];
    } catch {
      // Premier démarrage.
    }
  }

  private save() {
    const { file } = this.options;
    if (!file) return;
    const temporary = `${file}.tmp`;
    writeFileSync(temporary, JSON.stringify(this.events));
    renameSync(temporary, file);
  }

  get active() {
    return this.events.filter(e => e.endedAt === null);
  }

  get history() {
    return this.events;
  }

  check(context: AlertContext) {
    const now = this.now();
    const overrides = this.options.rules();
    let changed = false;
    for (const rule of RULES) {
      const override = overrides[rule.id];
      const limit = override?.limit ?? rule.limit;
      const value = override?.on === false ? null : rule.read(context);
      const breached = value !== null && (rule.below ? value < limit : value > limit);
      const open = this.events.find(e => e.rule === rule.id && e.endedAt === null);
      if (breached) {
        if (!this.breachedSince.has(rule.id)) this.breachedSince.set(rule.id, now);
        if (open) open.value = value;
        else if (now - this.breachedSince.get(rule.id)! >= rule.minutes * 60_000) {
          const event: AlertEvent = { id: `${rule.id}-${now}`, rule: rule.id, label: rule.label, value, limit, unit: rule.unit, startedAt: now, endedAt: null };
          this.events.unshift(event);
          this.events.length = Math.min(this.events.length, HISTORY);
          changed = true;
          this.options.notify(`🔴 ${rule.label}${rule.unit ? ` : ${value} ${rule.unit} (limite ${limit})` : ""}`);
        }
        continue;
      }
      this.breachedSince.delete(rule.id);
      if (open) {
        open.endedAt = now;
        changed = true;
        this.options.notify(`🟢 Rétabli : ${rule.label}`);
      }
    }
    if (changed) this.save();
  }
}
