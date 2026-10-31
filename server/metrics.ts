// Ce que consomme vraiment la machine et le serveur. Tout vient du noyau (/proc, cgroups) ou de Node lui-même : aucun agent à installer.
// Hors de Linux, ces fichiers n'existent pas : les valeurs restent nulles et le panneau le dit au lieu d'afficher zéro.
import { createSocket } from "node:dgram";
import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync, renameSync, writeFile, writeFileSync } from "node:fs";
import path from "node:path";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";

const CGROUP_ROOT = "/sys/fs/cgroup";
const RAW_POINTS = 360;
const MINUTE_POINTS = 1440;
const QUARTER_POINTS = 2880;
const MAX_ROWS = 300;
const STUN_TIMEOUT_MS = 3000;
const SAVE_MS = 5 * 60_000;

/** Un point de mesure. null : cette mesure n'existe pas ici, ou pas encore. */
export interface Point {
  at: number;
  [key: string]: number | null;
}

/** Sur une tranche de temps, un pic compte plus qu'une moyenne pour ces mesures. */
const PEAKS = new Set(["connections", "streams", "viewers", "members", "loopMax", "relayed", "direct"]);
const RANGES: Record<string, { tier: "raw" | "minute" | "quarter"; span: number }> = {
  "1h": { tier: "raw", span: 3600_000 },
  "6h": { tier: "minute", span: 6 * 3600_000 },
  "24h": { tier: "minute", span: 24 * 3600_000 },
  "7d": { tier: "quarter", span: 7 * 86_400_000 },
  "30d": { tier: "quarter", span: 30 * 86_400_000 },
};

export interface ProcCpu {
  total: number;
  idle: number;
  iowait: number;
  steal: number;
}

export function parseCpu(text: string): ProcCpu | null {
  const line = text.split("\n").find(l => /^cpu\s/.test(l));
  if (!line) return null;
  const [user = 0, nice = 0, system = 0, idle = 0, iowait = 0, irq = 0, softirq = 0, steal = 0] = line.trim().split(/\s+/).slice(1).map(Number);
  return { total: user + nice + system + idle + iowait + irq + softirq + steal, idle, iowait, steal };
}

export function parseKeyed(text: string) {
  const out: Record<string, number> = {};
  for (const line of text.split("\n")) {
    const match = line.match(/^(\S+?):?\s+(\d+)/);
    if (match) out[match[1]!] = Number(match[2]);
  }
  return out;
}

/** La pression dit si des tâches attendent vraiment : c'est plus parlant qu'un pourcentage d'occupation. */
export function parsePressure(text: string) {
  const match = text.match(/^some avg10=([\d.]+)/m);
  return match ? Number(match[1]) : null;
}

export function defaultInterface(route: string) {
  for (const line of route.split("\n").slice(1)) {
    const [name, destination] = line.trim().split(/\s+/);
    if (destination === "00000000") return name!;
  }
  return null;
}

export function parseNetDev(text: string, name: string) {
  for (const line of text.split("\n")) {
    const [iface, rest] = line.split(":");
    if (iface?.trim() !== name || !rest) continue;
    const v = rest.trim().split(/\s+/).map(Number);
    return { rx: v[0]!, rxErrors: (v[2] ?? 0) + (v[3] ?? 0), tx: v[8]!, txErrors: (v[10] ?? 0) + (v[11] ?? 0) };
  }
  return null;
}

export function parseDiskstats(text: string, device: string) {
  for (const line of text.split("\n")) {
    const v = line.trim().split(/\s+/);
    if (v[2] !== device) continue;
    return { reads: Number(v[3]), readSectors: Number(v[5]), readMs: Number(v[6]), writes: Number(v[7]), writeSectors: Number(v[9]), writeMs: Number(v[10]), ioMs: Number(v[12]) };
  }
  return null;
}

export function parseSockstat(text: string) {
  const tcp = text.match(/^TCP: inuse (\d+).*? tw (\d+)/m);
  const udp = text.match(/^UDP: inuse (\d+)/m);
  return { tcp: tcp ? Number(tcp[1]) : null, timeWait: tcp ? Number(tcp[2]) : null, udp: udp ? Number(udp[1]) : null };
}

/** Une ligne de moins : une tranche de temps résumée en un point. */
export function mergePoints(points: Point[], at: number) {
  const sum: Record<string, number> = {};
  const seen: Record<string, number> = {};
  const merged: Point = { at };
  for (const point of points) {
    for (const [key, value] of Object.entries(point)) {
      if (key === "at" || value === null) continue;
      if (PEAKS.has(key)) merged[key] = Math.max(merged[key] ?? 0, value);
      else {
        sum[key] = (sum[key] ?? 0) + value;
        seen[key] = (seen[key] ?? 0) + 1;
      }
    }
    for (const key of Object.keys(point)) if (key !== "at" && !(key in merged) && !(key in sum)) merged[key] = null;
  }
  for (const [key, total] of Object.entries(sum)) merged[key] = +(total / seen[key]!).toFixed(2);
  return merged;
}

export function thin(points: Point[], rows = MAX_ROWS) {
  if (points.length <= rows) return points;
  const size = points.length / rows;
  const out: Point[] = [];
  for (let i = 0; i < rows; i++) {
    const slice = points.slice(Math.floor(i * size), Math.floor((i + 1) * size));
    out.push(mergePoints(slice, slice.at(-1)!.at));
  }
  return out;
}

const round = (value: number, digits = 1) => +value.toFixed(digits);
const share = (part: number, whole: number) => (whole > 0 ? round((part / whole) * 100) : 0);

export interface ServiceUsage {
  id: string;
  name: string;
  kind: "service" | "container";
  cpuPct: number;
  memMb: number;
}

export interface MetricsOptions {
  /** Les chiffres du salon au moment de la mesure. */
  source: () => Record<string, number | null>;
  /** Pour lire ailleurs que sur la machine : les tests donnent leurs propres fichiers. */
  read?: (file: string) => string | null;
  list?: (dir: string) => string[];
  now?: () => number;
  file?: string;
  stunHost?: string;
  self?: string;
}

const readText = (file: string) => {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
};

const listDir = (dir: string) => {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
};

/** Une requête STUN minimale : le relais répond sans identifiants, ce qui prouve qu'il sert encore, pas seulement que le service tourne. */
export function probeStun(host: string, port = 3478, timeoutMs = STUN_TIMEOUT_MS) {
  return new Promise<number | null>(resolve => {
    const socket = createSocket("udp4");
    const id = randomBytes(12);
    const started = performance.now();
    const finish = (value: number | null) => {
      clearTimeout(timer);
      socket.close();
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    socket.on("error", () => finish(null));
    socket.on("message", message => {
      if (message.length >= 20 && message.readUInt16BE(0) === 0x0101 && message.subarray(8, 20).equals(id)) finish(round(performance.now() - started));
    });
    const header = Buffer.alloc(8);
    header.writeUInt16BE(0x0001, 0);
    header.writeUInt32BE(0x2112a442, 4);
    socket.send(Buffer.concat([header, id]), port, host);
  });
}

export class Metrics {
  /** Compteurs qui ne font que monter : la mesure en tire un débit. */
  readonly traffic = { wsIn: 0, wsOut: 0, msgIn: 0, msgOut: 0, http: 0, httpErrors: 0, httpMs: 0, rejected: 0, wsOpen: 0, wsClose: 0 };
  readonly messageTypes = new Map<string, { count: number; bytes: number }>();
  private readonly options: MetricsOptions;
  private readonly read: (file: string) => string | null;
  private readonly list: (dir: string) => string[];
  private readonly now: () => number;
  private readonly loop = monitorEventLoopDelay({ resolution: 20 });
  private raw: Point[] = [];
  private minutes: Point[] = [];
  private quarters: Point[] = [];
  private previous: { at: number; cpu: ProcCpu | null; net: ReturnType<typeof parseNetDev>; disk: ReturnType<typeof parseDiskstats>; proc: NodeJS.CpuUsage; traffic: Metrics["traffic"]; groups: Map<string, number>; throttled: number; elu: ReturnType<typeof performance.eventLoopUtilization> } | null = null;
  private serviceRows: ServiceUsage[] = [];
  private probes: { https: number | null; stun: number | null } = { https: null, stun: null };
  /** Une sonde qui a échoué, à distinguer d'une sonde qui n'a jamais tourné. */
  probeFailed: { https: boolean | null; stun: boolean | null } = { https: null, stun: null };
  private probeUrl = "";
  private lastSave = 0;
  private saving = false;
  private readonly containers = new Map<string, string>();
  /** Le dernier point complet, ce qu'affiche le panneau et ce que lisent les alertes. */
  latest: Point = { at: 0 };
  /** Mesures propres au service : limites posées par systemd, et combien de fois elles ont mordu. */
  limits: { memMaxMb: number | null; cpuMaxPct: number | null; oomKills: number; throttledPct: number } = { memMaxMb: null, cpuMaxPct: null, oomKills: 0, throttledPct: 0 };

  constructor(options: MetricsOptions) {
    this.options = options;
    this.read = options.read ?? readText;
    this.list = options.list ?? listDir;
    this.now = options.now ?? Date.now;
    this.loop.enable();
    this.load();
  }

  private load() {
    if (!this.options.file) return;
    const text = readText(this.options.file);
    if (!text) return;
    try {
      const saved = JSON.parse(text) as { keys: string[]; minutes: (number | null)[][]; quarters: (number | null)[][] };
      const inflate = (rows: (number | null)[][]) => rows.map(row => Object.fromEntries(saved.keys.map((key, i) => [key, row[i] ?? null])) as Point);
      this.minutes = inflate(saved.minutes);
      this.quarters = inflate(saved.quarters);
    } catch {
      // Un fichier abîmé ne doit pas empêcher le serveur de démarrer : la courbe repart de zéro.
    }
  }

  /** Écrit sans bloquer les salons : ce fichier pèse quelques centaines de ko. */
  save(sync = false) {
    const { file } = this.options;
    if (!file || (this.saving && !sync)) return;
    const keys = [...new Set([...this.minutes, ...this.quarters].flatMap(p => Object.keys(p)))];
    const flat = (rows: Point[]) => rows.map(row => keys.map(key => row[key] ?? null));
    const text = JSON.stringify({ keys, minutes: flat(this.minutes), quarters: flat(this.quarters) });
    const temporary = `${file}.tmp`;
    if (sync) {
      try {
        // À l'arrêt, une écriture de fond peut encore être en cours : celle-ci ne doit pas partager son fichier.
        writeFileSync(`${temporary}2`, text);
        renameSync(`${temporary}2`, file);
      } catch {
        // Une courbe perdue n'est pas une raison d'empêcher l'arrêt.
      }
      return;
    }
    this.saving = true;
    writeFile(temporary, text, error => {
      this.saving = false;
      if (error) return;
      try {
        renameSync(temporary, file);
      } catch {
        // Réessayé dans cinq minutes.
      }
    });
  }

  close() {
    this.loop.disable();
  }

  setProbeUrl(url: string) {
    this.probeUrl = url;
  }

  async probe() {
    const { stunHost } = this.options;
    if (stunHost) {
      this.probes.stun = await probeStun(stunHost);
      this.probeFailed.stun = this.probes.stun === null;
    }
    if (!this.probeUrl) return;
    const started = performance.now();
    const response = await fetch(this.probeUrl, { signal: AbortSignal.timeout(5000) }).catch(() => null);
    this.probes.https = response?.ok ? round(performance.now() - started) : null;
    this.probeFailed.https = this.probes.https === null;
  }

  private mainDisk() {
    const blocks = this.list("/sys/block").filter(name => !/^(loop|ram|sr|zram|dm-)/.test(name));
    return blocks[0] ?? null;
  }

  private containerName(id: string) {
    const known = this.containers.get(id);
    if (known) return known;
    const pid = this.read(path.posix.join(CGROUP_ROOT, "system.slice", id, "cgroup.procs"))?.split("\n")[0];
    const name = pid ? this.read(`/proc/${pid}/comm`)?.trim() : null;
    if (!name) return id.slice(7, 13);
    this.containers.set(id, name);
    return name;
  }

  /** Lit chaque service de la machine : on voit tout de suite qui prend la place, SpokaStream ou un voisin. */
  private readServices(seconds: number, before: Map<string, number>) {
    const groups = new Map<string, number>();
    const rows: ServiceUsage[] = [];
    for (const entry of this.list(path.posix.join(CGROUP_ROOT, "system.slice"))) {
      if (!/\.(service|scope)$/.test(entry)) continue;
      const dir = path.posix.join(CGROUP_ROOT, "system.slice", entry);
      const cpu = this.read(`${dir}/cpu.stat`);
      if (!cpu) continue;
      const usage = parseKeyed(cpu).usage_usec ?? 0;
      groups.set(entry, usage);
      const last = before.get(entry);
      const memory = Number(this.read(`${dir}/memory.current`) ?? 0);
      const container = entry.startsWith("docker-");
      rows.push({
        id: entry,
        name: container ? this.containerName(entry) : entry.replace(/\.(service|scope)$/, ""),
        kind: container ? "container" : "service",
        cpuPct: last !== undefined && seconds > 0 ? round((usage - last) / 1e4 / seconds) : 0,
        memMb: Math.round(memory / 1_048_576),
      });
    }
    this.serviceRows = rows.sort((a, b) => b.memMb - a.memMb);
    return groups;
  }

  private readLimits(seconds: number, before: number) {
    const { self } = this.options;
    if (!self) return { throttled: 0, value: 0 };
    const dir = path.posix.join(CGROUP_ROOT, "system.slice", `${self}.service`);
    const max = this.read(`${dir}/memory.max`)?.trim();
    const cpuMax = this.read(`${dir}/cpu.max`)?.trim().split(/\s+/);
    const cpu = parseKeyed(this.read(`${dir}/cpu.stat`) ?? "");
    const events = parseKeyed(this.read(`${dir}/memory.events`) ?? "");
    const throttled = cpu.throttled_usec ?? 0;
    const pct = seconds > 0 ? round((throttled - before) / 1e4 / seconds) : 0;
    this.limits = {
      memMaxMb: max && max !== "max" ? Math.round(Number(max) / 1_048_576) : null,
      cpuMaxPct: cpuMax?.[0] && cpuMax[0] !== "max" ? Math.round((Number(cpuMax[0]) / Number(cpuMax[1])) * 100) : null,
      oomKills: events.oom_kill ?? 0,
      throttledPct: Math.max(0, pct),
    };
    return { throttled, value: this.limits.throttledPct };
  }

  private service(id: string) {
    return this.serviceRows.find(row => row.id === `${id}.service`) ?? null;
  }

  /** Mesure tout, garde le point, et résume les anciens quand une minute ou un quart d'heure se termine. */
  sample() {
    const at = this.now();
    const before = this.previous;
    const seconds = before ? (at - before.at) / 1000 : 0;
    const rate = (key: keyof Metrics["traffic"]) => (before && seconds > 0 ? round((this.traffic[key] - before.traffic[key]) / seconds, 2) : 0);

    const cpu = parseCpu(this.read("/proc/stat") ?? "");
    const total = cpu && before?.cpu ? cpu.total - before.cpu.total : 0;
    const busy = cpu && before?.cpu && total > 0 ? share(total - (cpu.idle - before.cpu.idle) - (cpu.iowait - before.cpu.iowait) - (cpu.steal - before.cpu.steal), total) : null;
    const iowait = cpu && before?.cpu && total > 0 ? share(cpu.iowait - before.cpu.iowait, total) : null;
    const steal = cpu && before?.cpu && total > 0 ? share(cpu.steal - before.cpu.steal, total) : null;

    const memory = parseKeyed(this.read("/proc/meminfo") ?? "");
    const memPct = memory.MemTotal ? share(memory.MemTotal - (memory.MemAvailable ?? 0), memory.MemTotal) : null;
    const swapPct = memory.SwapTotal ? share(memory.SwapTotal - (memory.SwapFree ?? 0), memory.SwapTotal) : null;

    const iface = defaultInterface(this.read("/proc/net/route") ?? "");
    const netText = this.read("/proc/net/dev") ?? "";
    const net = iface ? parseNetDev(netText, iface) : null;
    const netMbps = (key: "rx" | "tx") => (net && before?.net && seconds > 0 ? round(((net[key] - before.net[key]) * 8) / 1e6 / seconds, 2) : null);

    const device = this.mainDisk();
    const disk = device ? parseDiskstats(this.read("/proc/diskstats") ?? "", device) : null;
    const previousDisk = before?.disk;
    const operations = disk && previousDisk ? disk.reads - previousDisk.reads + (disk.writes - previousDisk.writes) : 0;

    const procCpu = process.cpuUsage();
    const procPct = before && seconds > 0 ? round((procCpu.user - before.proc.user + (procCpu.system - before.proc.system)) / 1e4 / seconds) : null;
    const memoryUse = process.memoryUsage();
    const elu = performance.eventLoopUtilization();
    const loopUse = before ? performance.eventLoopUtilization(elu, before.elu).utilization : 0;
    const fds = this.list("/proc/self/fd").length;
    const socks = parseSockstat(this.read("/proc/net/sockstat") ?? "");

    const groups = this.readServices(seconds, before?.groups ?? new Map());
    const limit = this.readLimits(seconds, before?.throttled ?? 0);
    const turn = this.service("coturn");
    const nginx = this.service("nginx");

    const load = this.read("/proc/loadavg")?.split(" ")[0];
    const point: Point = {
      at,
      cpu: busy,
      iowait,
      steal,
      load: load ? Number(load) : null,
      mem: memPct,
      swap: swapPct,
      pressureCpu: parsePressure(this.read("/proc/pressure/cpu") ?? ""),
      pressureMem: parsePressure(this.read("/proc/pressure/memory") ?? ""),
      pressureIo: parsePressure(this.read("/proc/pressure/io") ?? ""),
      netRx: netMbps("rx"),
      netTx: netMbps("tx"),
      netErrors: net && before?.net ? net.rxErrors - before.net.rxErrors + (net.txErrors - before.net.txErrors) : null,
      diskRead: disk && previousDisk && seconds > 0 ? round(((disk.readSectors - previousDisk.readSectors) * 512) / 1e6 / seconds, 2) : null,
      diskWrite: disk && previousDisk && seconds > 0 ? round(((disk.writeSectors - previousDisk.writeSectors) * 512) / 1e6 / seconds, 2) : null,
      diskUtil: disk && previousDisk && seconds > 0 ? Math.min(100, round((disk.ioMs - previousDisk.ioMs) / 10 / seconds)) : null,
      diskAwait: disk && previousDisk ? (operations > 0 ? round((disk.readMs - previousDisk.readMs + (disk.writeMs - previousDisk.writeMs)) / operations) : 0) : null,
      tcp: socks.tcp,
      udp: socks.udp,
      procCpu: procPct,
      procMb: Math.round(memoryUse.rss / 1_048_576),
      heapMb: Math.round(memoryUse.heapUsed / 1_048_576),
      loopP50: round(this.loop.percentile(50) / 1e6),
      loopP99: round(this.loop.percentile(99) / 1e6),
      loopMax: round(this.loop.max / 1e6),
      loopUse: round(loopUse * 100),
      fds: fds || null,
      throttled: limit.value,
      turnCpu: turn?.cpuPct ?? null,
      turnMb: turn?.memMb ?? null,
      nginxCpu: nginx?.cpuPct ?? null,
      nginxMb: nginx?.memMb ?? null,
      wsIn: round((rate("wsIn") * 8) / 1000),
      wsOut: round((rate("wsOut") * 8) / 1000),
      msgIn: rate("msgIn"),
      msgOut: rate("msgOut"),
      httpRate: rate("http"),
      httpErrors: rate("httpErrors"),
      httpMs: before && this.traffic.http > before.traffic.http ? round((this.traffic.httpMs - before.traffic.httpMs) / (this.traffic.http - before.traffic.http)) : null,
      rejected: rate("rejected"),
      probeHttps: this.probes.https,
      probeStun: this.probes.stun,
      ...this.options.source(),
    };
    this.loop.reset();
    this.previous = { at, cpu, net, disk, proc: procCpu, traffic: { ...this.traffic }, groups, throttled: limit.throttled, elu };
    this.latest = point;
    this.keep(point);
    return point;
  }

  private keep(point: Point) {
    const previous = this.raw.at(-1);
    this.raw.push(point);
    if (this.raw.length > RAW_POINTS) this.raw.shift();
    if (previous && Math.floor(previous.at / 60_000) !== Math.floor(point.at / 60_000)) {
      const minute = Math.floor(previous.at / 60_000) * 60_000;
      this.minutes.push(mergePoints(this.raw.filter(p => p.at >= minute && p.at < minute + 60_000), minute));
      if (this.minutes.length > MINUTE_POINTS) this.minutes.shift();
    }
    if (previous && Math.floor(previous.at / 900_000) !== Math.floor(point.at / 900_000)) {
      const quarter = Math.floor(previous.at / 900_000) * 900_000;
      const slice = this.minutes.filter(p => p.at >= quarter && p.at < quarter + 900_000);
      if (slice.length) this.quarters.push(mergePoints(slice, quarter));
      if (this.quarters.length > QUARTER_POINTS) this.quarters.shift();
    }
    if (point.at - this.lastSave >= SAVE_MS) {
      this.lastSave = point.at;
      this.save();
    }
  }

  /** Une période, en colonnes : une courbe du panneau ne lit qu'une clé, et 300 points suffisent à une largeur d'écran. */
  range(name: string) {
    const range = RANGES[name] ?? RANGES["1h"]!;
    const source = range.tier === "raw" ? this.raw : range.tier === "minute" ? this.minutes : this.quarters;
    const since = this.now() - range.span;
    const points = thin(source.filter(p => p.at >= since));
    if (range.tier !== "raw" && this.latest.at) points.push(this.latest);
    const keys = [...new Set(points.flatMap(p => Object.keys(p)))].filter(k => k !== "at");
    return { at: points.map(p => p.at), series: Object.fromEntries(keys.map(key => [key, points.map(p => p[key] ?? null)])) };
  }

  services() {
    return { rows: this.serviceRows, limits: this.limits };
  }

  /** Quels messages coûtent le plus cher au serveur : c'est là qu'il faut regarder si la charge monte. */
  topMessages() {
    return [...this.messageTypes.entries()].map(([type, row]) => ({ type, ...row })).sort((a, b) => b.bytes - a.bytes).slice(0, 12);
  }
}
