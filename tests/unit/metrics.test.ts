import assert from "node:assert/strict";
import { createSocket } from "node:dgram";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { Accounts } from "../../server/accounts.ts";
import { Alerts, validWebhook } from "../../server/alerts.ts";
import { applyPendingRestore, Backups } from "../../server/backups.ts";
import { ConfigStore, maskWords, olderThan } from "../../server/config.ts";
import { Hub } from "../../server/hub.ts";
import { Journal, logsCsv } from "../../server/journal.ts";
import { defaultInterface, mergePoints, Metrics, parseCpu, parseDiskstats, parseKeyed, parseNetDev, parsePressure, parseSockstat, probeStun, thin } from "../../server/metrics.ts";
import { MemoryStore } from "../../server/store.ts";
import { Usage } from "../../server/usage.ts";
import { catalog, defaultLayout, keyView, normalize, pageKeys, setKey, SLOTS, swapKeys } from "../../web/deck.ts";
import { PROTOCOL_VERSION } from "../../src/shared/protocol.ts";
import type { RemoteState, ServerMessage } from "../../src/shared/protocol.ts";

const temp = () => mkdtempSync(path.join(tmpdir(), "spokastream-metrics-"));

test("les fichiers du noyau se lisent comme ils sont écrits", () => {
  assert.deepEqual(parseCpu("cpu  100 0 50 800 10 0 5 35 0 0\ncpu0 1 1 1 1"), { total: 1000, idle: 800, iowait: 10, steal: 35 });
  assert.equal(parseCpu(""), null);
  assert.deepEqual(parseKeyed("MemTotal:       11963440 kB\nMemAvailable:    3476024 kB\n"), { MemTotal: 11963440, MemAvailable: 3476024 });
  assert.equal(parsePressure("some avg10=1.25 avg60=0.06 avg300=0.02 total=1\nfull avg10=0.00 avg60=0 avg300=0 total=0"), 1.25);
  assert.equal(defaultInterface("Iface\tDestination\tGateway\nens3\t00000000\t01818198\nens3\t01818198\t00000000"), "ens3");
  const net = "Inter-|\n face |bytes\n    lo: 1 2 0 0 0 0 0 0 3 4 0 0 0 0 0 0\n  ens3: 1000 82 1 2 0 0 0 0 2000 96 3 4 0 0 0 0\n";
  assert.deepEqual(parseNetDev(net, "ens3"), { rx: 1000, rxErrors: 3, tx: 2000, txErrors: 7 });
  assert.equal(parseNetDev(net, "eth9"), null);
  const disk = parseDiskstats("   8       0 sda 100 5 2000 30 200 7 4000 60 0 90 120 0 0 0 0\n   8       1 sda1 1 1 1 1 1 1 1 1 0 1 1", "sda");
  assert.deepEqual(disk, { reads: 100, readSectors: 2000, readMs: 30, writes: 200, writeSectors: 4000, writeMs: 60, ioMs: 90 });
  assert.deepEqual(parseSockstat("sockets: used 1\nTCP: inuse 42 orphan 0 tw 7 alloc 50 mem 1\nUDP: inuse 9 mem 1\n"), { tcp: 42, timeWait: 7, udp: 9 });
});

/** Une petite machine imaginaire : deux lectures de ses fichiers, à 10 secondes d'écart. */
function fakeMachine() {
  let tick = 0;
  const files = (): Record<string, string> => ({
    "/proc/stat": tick ? "cpu  300 0 100 1400 100 0 0 100\n" : "cpu  100 0 50 800 50 0 0 0\n",
    "/proc/meminfo": "MemTotal: 1000 kB\nMemAvailable: 250 kB\nSwapTotal: 100 kB\nSwapFree: 90 kB\n",
    "/proc/loadavg": "0.50 0.40 0.30 1/2 3",
    "/proc/pressure/cpu": "some avg10=2.50 avg60=0 avg300=0 total=0\n",
    "/proc/net/route": "Iface Destination\nens3 00000000\n",
    "/proc/net/dev": tick ? "ens3: 12500000 0 0 0 0 0 0 0 25000000 0 0 0 0 0 0 0\n" : "ens3: 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0\n",
    "/proc/diskstats": tick ? "8 0 sda 10 0 2000 20 10 0 4000 80 0 500 0 0 0 0 0\n" : "8 0 sda 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0\n",
    "/sys/fs/cgroup/system.slice/coturn.service/cpu.stat": tick ? "usage_usec 2000000\n" : "usage_usec 1000000\n",
    "/sys/fs/cgroup/system.slice/coturn.service/memory.current": String(34 * 1_048_576),
    "/sys/fs/cgroup/system.slice/spokastream-server.service/cpu.stat": tick ? "usage_usec 100\nthrottled_usec 2000000\n" : "usage_usec 50\nthrottled_usec 0\n",
    "/sys/fs/cgroup/system.slice/spokastream-server.service/memory.current": String(64 * 1_048_576),
    "/sys/fs/cgroup/system.slice/spokastream-server.service/memory.max": String(256 * 1_048_576),
    "/sys/fs/cgroup/system.slice/spokastream-server.service/cpu.max": "50000 100000",
    "/sys/fs/cgroup/system.slice/spokastream-server.service/memory.events": "oom_kill 1\n",
    "/sys/fs/cgroup/system.slice/docker-abcdef123456.scope/cpu.stat": "usage_usec 0\n",
    "/sys/fs/cgroup/system.slice/docker-abcdef123456.scope/memory.current": String(512 * 1_048_576),
    "/sys/fs/cgroup/system.slice/docker-abcdef123456.scope/cgroup.procs": "77\n",
    "/proc/77/comm": "postgres\n",
  });
  return {
    read: (file: string) => files()[file] ?? null,
    list: (dir: string) => (dir === "/sys/block" ? ["loop0", "sda"] : dir.endsWith("system.slice") ? ["coturn.service", "spokastream-server.service", "docker-abcdef123456.scope", "init.scope"] : []),
    next: () => tick++,
  };
}

test("une mesure dit ce que consomme la machine et chaque service", () => {
  const machine = fakeMachine();
  let now = 1_000_000;
  const metrics = new Metrics({ source: () => ({ connections: 3 }), read: machine.read, list: machine.list, now: () => now, self: "spokastream-server" });
  metrics.sample();
  machine.next();
  now += 10_000;
  const point = metrics.sample();
  metrics.close();
  assert.equal(point.cpu, 25, "ni l'attente du disque ni ce que reprend l'hébergeur ne comptent comme occupé");
  assert.equal(point.iowait, 5);
  assert.equal(point.steal, 10);
  assert.equal(point.mem, 75);
  assert.equal(point.swap, 10);
  assert.equal(point.pressureCpu, 2.5);
  assert.equal(point.netRx, 10, "12,5 Mo en 10 s font 10 Mb/s");
  assert.equal(point.netTx, 20);
  assert.equal(point.diskRead, 0.1);
  assert.equal(point.diskAwait, 5);
  assert.equal(point.diskUtil, 5);
  assert.equal(point.connections, 3);
  assert.equal(point.turnCpu, 10, "coturn a pris une seconde de processeur sur dix");
  assert.equal(point.turnMb, 34);
  const { rows, limits } = metrics.services();
  assert.equal(rows[0]!.name, "postgres", "un conteneur porte le nom de son programme, et le plus gourmand passe en tête");
  assert.equal(rows[0]!.kind, "container");
  assert.deepEqual(limits, { memMaxMb: 256, cpuMaxPct: 50, oomKills: 1, throttledPct: 20 });
});

test("hors de Linux, une mesure absente reste absente : le panneau ne doit pas afficher zéro", () => {
  const metrics = new Metrics({ source: () => ({}), read: () => null, list: () => [] });
  metrics.sample();
  const point = metrics.sample();
  metrics.close();
  assert.equal(point.cpu, null);
  assert.equal(point.netRx, null);
  assert.equal(point.diskRead, null);
  assert.equal(typeof point.procMb, "number");
});

test("les courbes survivent à un redémarrage et se résument sans perdre les pics", () => {
  const dir = temp();
  const file = path.join(dir, "metrics.json");
  let now = 1_700_000_000_000;
  let connections = 2;
  const options = { source: () => ({ connections, cpu: null }), read: () => null, list: () => [], now: () => now, file };
  const first = new Metrics(options);
  for (let i = 0; i < 18; i++) {
    if (i === 3) connections = 9;
    if (i === 4) connections = 2;
    first.sample();
    now += 10_000;
  }
  first.save(true);
  first.close();
  const second = new Metrics(options);
  second.sample();
  second.close();
  const range = second.range("6h");
  assert.ok(range.at.length >= 2);
  assert.equal(Math.max(...(range.series.connections as number[])), 9, "le pic reste visible dans la minute résumée");
  assert.equal(mergePoints([{ at: 1, cpu: 10, connections: 1 }, { at: 2, cpu: 30, connections: 5 }, { at: 3, cpu: null, connections: 2 }], 1).cpu, 20, "une mesure manquante ne tire pas la moyenne vers zéro");
  assert.equal(thin(Array.from({ length: 1000 }, (_, i) => ({ at: i, cpu: 1 })), 100).length, 100);
  rmSync(dir, { recursive: true, force: true });
});

test("la sonde du relais attend une vraie réponse STUN", async () => {
  const server = createSocket("udp4");
  await new Promise<void>(resolve => server.bind(0, "127.0.0.1", resolve));
  const { port } = server.address();
  server.on("message", (message, from) => {
    const reply = Buffer.from(message);
    reply.writeUInt16BE(0x0101, 0);
    server.send(reply, from.port, from.address);
  });
  assert.equal(typeof (await probeStun("127.0.0.1", port)), "number");
  server.close();
  assert.equal(await probeStun("127.0.0.1", port, 150), null);
});

test("une alerte attend d'avoir tenu, prévient une fois, et dit quand c'est rétabli", () => {
  let now = 0;
  const sent: string[] = [];
  const rules: Record<string, { on: boolean; limit: number }> = {};
  const alerts = new Alerts({ rules: () => rules, notify: text => sent.push(text), now: () => now });
  const context = (cpu: number) => ({ point: { cpu }, services: { coturn: { state: "active" } }, certificateDays: 60, diskPct: 50, errors5min: 0, memMaxPct: 10, throttledPct: 0 });
  alerts.check(context(99));
  assert.equal(alerts.active.length, 0, "un pic n'est pas un incident");
  now = 4 * 60_000;
  alerts.check(context(10));
  now = 5 * 60_000;
  alerts.check(context(99));
  now = 9 * 60_000;
  alerts.check(context(99));
  assert.equal(alerts.active.length, 0, "le compte repart de zéro après un retour à la normale");
  now = 10 * 60_000;
  alerts.check(context(99));
  alerts.check(context(99));
  assert.equal(alerts.active.length, 1);
  assert.equal(sent.length, 1, "une seule notification tant que ça dure");
  now = 11 * 60_000;
  alerts.check(context(20));
  assert.equal(alerts.active.length, 0);
  assert.match(sent[1]!, /Rétabli/);
  rules.cpu = { on: true, limit: 50 };
  alerts.check(context(60));
  now += 5 * 60_000;
  alerts.check(context(60));
  assert.equal(alerts.active.length, 1, "la limite choisie dans le panneau prime");
  rules.cpu = { on: false, limit: 50 };
  alerts.check(context(60));
  assert.equal(alerts.active.length, 0, "une règle désactivée se tait");
});

test("un service arrêté et un certificat proche de la fin alertent", () => {
  let now = 0;
  const alerts = new Alerts({ rules: () => ({}), notify: () => {}, now: () => now });
  const context = { point: {}, services: { coturn: { state: "failed" }, nginx: { state: "inconnu" } }, certificateDays: 5, diskPct: 50, errors5min: 0, memMaxPct: null, throttledPct: 0 };
  alerts.check(context);
  now = 60_000;
  alerts.check(context);
  assert.deepEqual(alerts.active.map(a => a.rule).sort(), ["certificate", "coturn"], "un service qu'on ne sait pas lire n'est pas un service en panne");
});

test("seules de vraies adresses de webhook Discord passent", () => {
  assert.ok(validWebhook("https://discord.com/api/webhooks/123/abc"));
  for (const bad of ["http://discord.com/api/webhooks/1/a", "https://discord.com.evil.test/api/webhooks/1/a", "https://169.254.169.254/api/webhooks/1/a", "https://discord.com/other", "pas une adresse"]) assert.equal(validWebhook(bad), false, bad);
});

test("le filtre masque le mot, ses variantes, et rien d'autre", () => {
  assert.equal(maskWords("Quel CÔNNARD celui-là", ["connard"]), "Quel ••••••• celui-là");
  assert.equal(maskWords("classe passe", ["ass"]), "classe passe", "un mot dans un autre mot ne compte pas");
  assert.equal(maskWords("rien à voir", []), "rien à voir");
});

test("les versions se comparent comme des versions", () => {
  assert.equal(olderThan("1.5.0", "1.10.0"), true);
  assert.equal(olderThan("1.10.0", "1.5.0"), false);
  assert.equal(olderThan("1.6.0", "1.6"), false);
});

interface Client {
  sent: ServerMessage[];
  closed: number | null;
  conn: ReturnType<Hub["connect"]>;
  send(message: object): void;
  acks(): ServerMessage[];
}

function client(hub: Hub, ip = "10.0.0.1"): Client {
  const sent: ServerMessage[] = [];
  const self: Client = {
    sent,
    closed: null,
    conn: hub.connect({ ip, send: data => sent.push(JSON.parse(data) as ServerMessage), close: code => (self.closed = code) }),
    send: message => hub.handle(self.conn, JSON.stringify(message)),
    acks: () => sent.filter(m => m.t === "ack"),
  };
  return self;
}

const token = (n: number) => String(n).repeat(64).slice(0, 64);
const hello = (n: number, extra: object = {}) => ({ t: "hello", protocol: PROTOCOL_VERSION, token: token(n), client: "app", version: "1.6.0", profile: { name: `P${n}`, color: "#112233", avatar: null }, rid: 1, ...extra });

function hubWith(now: () => number = Date.now) {
  const config = new ConfigStore();
  const accounts = new Accounts();
  const usage = new Usage(undefined, now);
  const hub = new Hub({ store: new MemoryStore(), accounts, config, usage, iceServers: () => [], now });
  return { hub, config, accounts, usage };
}

const created = (c: Client) => c.acks().flatMap(m => (m.t === "ack" && (m.data as { code?: string } | undefined)?.code ? [(m.data as { code: string }).code] : []))[0]!;

test("le téléphone lié reçoit les salons du compte, et un code de liaison n'est pas un code de salon", () => {
  const { hub } = hubWith();
  const pc = client(hub);
  pc.send(hello(1));
  pc.send({ t: "room.create", name: "Soirée", rid: 2 });
  const phone = client(hub, "10.0.0.2");
  phone.send(hello(2, { client: "web", version: "site" }));
  assert.deepEqual(phone.sent.filter(m => m.t === "account.rooms").flatMap(m => (m.t === "account.rooms" ? m.rooms : [])), [], "seul, le téléphone n'a aucun salon");
  pc.send({ t: "account.link", rid: 3 });
  const { code } = (pc.acks().at(-1) as { data: { code: string } }).data;
  phone.send({ t: "account.claim", code, rid: 4 });
  const rooms = phone.sent.filter(m => m.t === "account.rooms").at(-1);
  assert.equal(rooms?.t === "account.rooms" && rooms.rooms[0]?.name, "Soirée");
  assert.ok(pc.sent.some(m => m.t === "account.linked"), "le PC qui montrait le QR code apprend que c'est fait");
  phone.send({ t: "account.claim", code, rid: 5 });
  assert.equal((phone.acks().at(-1) as { ok: boolean }).ok, false, "un code ne sert qu'une fois");
  pc.send({ t: "account.link", rid: 6 });
  const again = (pc.acks().at(-1) as { data: { code: string } }).data.code;
  phone.send({ t: "account.claim", code: again, rid: 7 });
  const answer = phone.acks().at(-1) as { ok: boolean; data: { already: boolean } };
  assert.deepEqual([answer.ok, answer.data.already], [true, true], "déjà lié : on le dit, ce n'est pas une erreur");
});

test("un PC au repos passe avant un PC en direct : le téléphone garde le direct sous les yeux", () => {
  const { hub } = hubWith();
  const a = client(hub);
  a.send(hello(1));
  a.send({ t: "account.link", rid: 2 });
  const b = client(hub);
  b.send(hello(3));
  b.send({ t: "account.claim", code: (a.acks().at(-1) as { data: { code: string } }).data.code, rid: 3 });
  a.send({ t: "remote.state", state: { idle: false, title: "En direct" } });
  b.send({ t: "remote.state", state: { idle: true, title: "" } });
  const phone = client(hub);
  phone.send(hello(4));
  a.send({ t: "account.link", rid: 4 });
  phone.send({ t: "account.claim", code: (a.acks().at(-1) as { data: { code: string } }).data.code, rid: 5 });
  const fresh = client(hub);
  fresh.send(hello(4));
  const states = fresh.sent.filter(m => m.t === "remote.state");
  assert.equal(states.length, 2);
  assert.equal(states.at(-1)?.t === "remote.state" && states.at(-1)?.t === "remote.state" ? (states.at(-1) as { state: { title: string } }).state.title : "", "En direct");
});

test("muet, délai entre messages et mots filtrés s'appliquent côté serveur", () => {
  let now = 1_000_000;
  const { hub, config, accounts } = hubWith(() => now);
  const owner = client(hub);
  owner.send(hello(1));
  owner.send({ t: "room.create", name: "Salon", rid: 2 });
  const code = created(owner);
  const guest = client(hub);
  guest.send(hello(2));
  guest.send({ t: "room.join", code, rid: 2 });
  const said = () => owner.sent.flatMap(m => (m.t === "chat" && m.message.kind === "user" ? [m.message.text] : []));
  config.update({ words: ["vilain"], slowSeconds: 5 });
  guest.send({ t: "chat.send", text: "Tu es vilain" });
  assert.deepEqual(said(), ["Tu es ••••••"]);
  assert.ok(hub.logs.some(l => l.topic === "modération"));
  guest.send({ t: "chat.send", text: "encore" });
  assert.equal(said().length, 1, "trop vite");
  owner.send({ t: "chat.send", text: "le propriétaire n'attend pas" });
  assert.equal(said().length, 2);
  now += 6000;
  const account = guest.conn.accountId!;
  hub.adminMute(account, now + 1000, "calme-toi", "spoka");
  guest.send({ t: "chat.send", text: "je parle quand même" });
  assert.equal(said().length, 2);
  assert.ok(guest.sent.some(m => m.t === "error" && m.error === "muted"));
  now += 2000;
  guest.send({ t: "chat.send", text: "c'est fini" });
  assert.equal(said().length, 3, "le silence se lève tout seul");
  assert.deepEqual(accounts.detail(account)?.sanctions?.map(s => s.kind), ["mute"]);
  assert.equal(accounts.detail(account)?.stats?.messages, 2);
});

test("un bannissement à durée limitée se lève tout seul, une adresse bloquée n'entre plus", () => {
  let now = 1000;
  const { hub, config } = hubWith(() => now);
  const someone = client(hub);
  someone.send(hello(5));
  hub.adminBan(someone.conn.accountId!, true, "spam", now + 1000, "spoka");
  assert.equal(someone.closed, 4003);
  const back = client(hub);
  back.send(hello(5));
  assert.equal((back.acks().at(-1) as { error: string }).error, "banned");
  now += 2000;
  const later = client(hub);
  later.send(hello(5));
  assert.equal((later.acks().at(-1) as { ok: boolean }).ok, true);
  config.update({ blockedIps: [{ ip: "6.6.6.6", reason: "", by: "spoka", at: now, until: 0 }] });
  const blocked = client(hub, "6.6.6.6");
  blocked.send(hello(6));
  assert.equal(blocked.closed, 4003);
  assert.equal(blocked.conn.userId, null);
});

test("serveur fermé : un inconnu n'entre pas, mais peut se lier avec un code", () => {
  const { hub, config, accounts } = hubWith();
  const owner = client(hub);
  owner.send(hello(1));
  owner.send({ t: "room.create", name: "Salon", rid: 2 });
  const code = created(owner);
  config.update({ closed: true });
  const stranger = client(hub, "10.0.0.9");
  stranger.send(hello(7, { client: "web", version: "site" }));
  stranger.send({ t: "room.join", code, rid: 2 });
  assert.equal((stranger.acks().at(-1) as { error: string }).error, "closed");
  assert.equal(accounts.isNew(stranger.conn.userId!), true, "un refusé n'est pas enregistré");
  owner.send({ t: "account.link", rid: 3 });
  stranger.send({ t: "account.claim", code: (owner.acks().at(-1) as { data: { code: string } }).data.code, rid: 3 });
  stranger.send({ t: "room.join", code, rid: 4 });
  assert.equal((stranger.acks().at(-1) as { ok: boolean }).ok, true, "une fois lié, il entre");
  owner.send({ t: "room.leave" });
  const known = client(hub);
  known.send(hello(1));
  known.send({ t: "room.join", code, rid: 2 });
  assert.equal((known.acks().at(-1) as { ok: boolean }).ok, true, "un appareil déjà connu n'est pas gêné");
});

test("une application trop ancienne doit se mettre à jour, le site n'est pas concerné", () => {
  const { hub, config } = hubWith();
  config.update({ minVersion: "1.6.0" });
  const old = client(hub);
  old.send(hello(1, { version: "1.5.0" }));
  assert.equal((old.acks().at(-1) as { error: string }).error, "version");
  const web = client(hub);
  web.send(hello(2, { client: "web", version: "site" }));
  assert.equal((web.acks().at(-1) as { ok: boolean }).ok, true);
});

test("les mesures d'un direct viennent des deux côtés, et n'ont pas de valeur folle", () => {
  let now = 1000;
  const { hub, usage } = hubWith(() => now);
  const streamer = client(hub);
  streamer.send(hello(1));
  streamer.send({ t: "room.create", name: "Salon", rid: 2 });
  const code = created(streamer);
  const viewer = client(hub);
  viewer.send(hello(2));
  viewer.send({ t: "room.join", code, rid: 2 });
  streamer.send({ t: "stream.start", id: "s1", stream: { title: "Jeu", kind: "screen", width: 1920, height: 1080, fps: 60 }, rid: 3 });
  viewer.send({ t: "stream.watch", id: "s1", on: true, rid: 3 });
  streamer.send({ t: "telemetry", publish: { streamId: "s1", fps: 60, kbps: 8000, height: 1080, codec: "H264", encoder: "x", hardware: true, encMs: 4, limit: "none", viewers: [{ id: viewer.conn.userId, kbps: 7900, relay: true, protocol: "udp", rttMs: 40, retransmitPct: 0.5 }] } });
  viewer.send({ t: "telemetry", watch: [{ streamId: "s1", fps: 59, kbps: 7800, height: 1080, lostPct: 1000, jitterMs: 4, freezes: 2, relay: true, protocol: "udp", rttMs: 42 }] });
  const [health] = hub.adminHealth();
  assert.equal(health!.publish?.fps, 60);
  assert.equal(health!.viewers[0]!.kbps, 7800, "ce que le spectateur reçoit prime sur ce que le diffuseur croit envoyer");
  assert.equal(health!.viewers[0]!.lostPct, 100, "un chiffre impossible est borné");
  const summary = hub.telemetrySummary();
  assert.deepEqual([summary.relayed, summary.direct, summary.relayKbps], [1, 0, 7800]);
  hub.tickUsage();
  hub.tickUsage();
  now += 25_000;
  assert.equal(hub.adminHealth()[0]!.viewers[0]!.kbps, 7800, "encore frais");
  now += 10_000;
  assert.equal(hub.adminHealth()[0]!.publish, null, "une mesure trop vieille n'est plus affichée comme actuelle");
  streamer.send({ t: "stream.stop" });
  const session = usage.sessions()[0]!;
  assert.deepEqual([session.name, session.peakViewers, session.kbps, session.relayShare], ["P1", 1, 8000, 100]);
  const day = usage.days(1)[0]!;
  assert.equal(day.streams, 1);
  assert.equal(day.streamMinutes, 2);
  assert.equal(day.watchMinutes, 2);
  assert.equal(day.relayMinutes, 2);
});

test("le journal et les retours survivent à un redémarrage", () => {
  const dir = temp();
  const first = new Hub({ store: new MemoryStore(), journal: new Journal(dir), iceServers: () => [] });
  first.log("warning", "admin", "spoka : essai");
  const row = first.logs[0]!;
  const again = new Journal(dir);
  writeFileSync(path.join(dir, "journal.jsonl"), `${JSON.stringify(row)}\nligne abîmée\n`);
  assert.deepEqual(again.load(), [row], "une ligne abîmée n'empêche pas de lire les autres");
  assert.match(logsCsv([row]), /Date;Niveau;Sujet;Texte\n".*";"warning";"admin";"spoka : essai"/);
  rmSync(dir, { recursive: true, force: true });
});

test("restaurer se fait au démarrage, et une sauvegarde n'écrase jamais les accès au panneau", () => {
  const dir = temp();
  writeFileSync(path.join(dir, "accounts.json"), '"avant"');
  writeFileSync(path.join(dir, "admin-auth.json"), "secret");
  const backups = new Backups(dir);
  const backup = backups.create("Essai", false);
  assert.equal(backup.files, 1);
  writeFileSync(path.join(dir, "accounts.json"), '"après"');
  assert.equal(applyPendingRestore(dir), null, "rien de demandé, rien ne bouge");
  assert.ok(backups.markRestore(backup.id));
  assert.equal(backups.markRestore("../../etc"), false);
  assert.equal(applyPendingRestore(dir), backup.id);
  assert.equal(readFileSync(path.join(dir, "accounts.json"), "utf8"), '"avant"');
  assert.deepEqual(Object.keys(backups.read(backup.id) ?? {}), ["accounts.json"], "les accès au panneau ne font pas partie d'une sauvegarde");
  rmSync(dir, { recursive: true, force: true });
});

const remote = (patch: Partial<RemoteState> = {}): RemoteState => ({ roomId: "r", roomName: "Salon", roomCode: "ABCD2345", title: "", source: "Écran", startedAt: 0, paused: false, screen: null, screens: ["Pause"], scene: "a", scenes: [{ id: "a", name: "Jeu" }], mix: [{ id: "m", label: "Micro", volume: 1, muted: true }], viewers: [{ id: "v", name: "Léa" }], stats: { height: 1080, fps: 60, kbps: 8200, codec: "H264", limit: null }, muted: false, deafened: false, camera: false, banner: "Pause", recording: true, file: null, controlAsk: null, controller: null, clips: 2, ...patch });

test("les touches de la régie montrent ce que le PC renvoie", () => {
  const view = (action: Parameters<typeof keyView>[0]["action"], state = remote()) => keyView({ action }, state, 90_000);
  assert.equal(view({ kind: "pause" }).label, "Pause");
  assert.equal(view({ kind: "pause" }, remote({ paused: true })).label, "Reprendre");
  assert.equal(view({ kind: "record" }).on, true);
  assert.equal(view({ kind: "time" }).value, "1:30");
  assert.equal(view({ kind: "bitrate" }).value, "8.2");
  assert.equal(view({ kind: "clip" }).value, "2", "le compteur vient du PC");
  assert.equal(view({ kind: "clip" }, remote({ clips: undefined })).waits, false, "un PC plus ancien ne confirme pas : la touche n'attend rien");
  assert.equal(view({ kind: "scene", id: "a", name: "?" }).on, true);
  assert.equal(view({ kind: "scene", id: "b", name: "Ancienne" }).disabled, true, "une scène supprimée sur le PC reste à sa place, grisée");
  assert.equal(view({ kind: "mute", id: "m", name: "?" }).label, "Micro");
  assert.equal(view({ kind: "banner", text: "Pause" }).on, true);
  assert.equal(view({ kind: "stop" }).hold, true, "arrêter un direct exige un appui long");
  assert.equal(view({ kind: "party" }).disabled, true);
  assert.equal(keyView({ action: { kind: "mic" }, label: "Ma voix" }, remote(), 0).label, "Ma voix");
});

test("une page garde 15 touches, et un stockage abîmé redonne la régie d'origine", () => {
  const layout = defaultLayout();
  for (const page of layout.pages) assert.equal(page.keys.length, SLOTS);
  const swapped = swapKeys(layout, 0, 0, 14);
  assert.equal(swapped.pages[0]!.keys[0]!.action.kind, "stop");
  assert.equal(swapped.pages[0]!.keys[14]!.action.kind, "pause");
  assert.equal(setKey(layout, 0, 3, null).pages[0]!.keys[3], null);
  assert.equal(normalize(null).pages.length, 3);
  assert.equal(normalize({ pages: "n'importe quoi" }).pages.length, 3);
  const repaired = normalize({ pages: [{ name: "Moi", keys: [null, 3, { action: {} }, { action: { kind: "mic" } }] }] });
  assert.deepEqual(repaired.pages[0]!.keys.slice(0, 4).map(k => k?.action.kind ?? null), [null, null, null, "mic"]);
  assert.equal(repaired.pages[0]!.keys.length, SLOTS);
  const scenes = pageKeys(layout.pages[1]!, remote());
  assert.deepEqual(scenes.slice(0, 3).map(k => k?.action.kind ?? null), ["scene", "screen", null]);
  assert.deepEqual(catalog(remote()).map(group => group.title), ["Direct", "Micro et caméra", "Mesures", "Scènes", "Écrans d'attente", "Sources de son", "Watch Party"]);
});
