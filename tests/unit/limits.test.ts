import assert from "node:assert/strict";
import { test } from "node:test";
import { cleanLimits } from "../../server/accounts.ts";
import { Hub } from "../../server/hub.ts";
import { MemoryStore } from "../../server/store.ts";
import type { AccountLimits, ClientMessage, ServerMessage } from "../../src/shared/protocol.ts";
import { NO_LIMITS, PROTOCOL_VERSION } from "../../src/shared/protocol.ts";

const stun = { urls: "stun:exemple" };
const turn = { urls: "turn:exemple", username: "u", credential: "c" };
const announce = { title: "", kind: "screen", width: 1920, height: 1080, fps: 60, allowDraw: false, allowControl: false, maxViewers: 0, sourceName: "Essai" };

function device(hub: Hub, token: string, name: string) {
  const received: ServerMessage[] = [];
  const conn = hub.connect({ ip: "203.0.113.7", send: d => received.push(JSON.parse(d)), close: () => {} });
  const send = (message: Record<string, unknown>) => hub.handle(conn, JSON.stringify(message as unknown as ClientMessage));
  send({ t: "hello", protocol: PROTOCOL_VERSION, token: token.repeat(64).slice(0, 64), profile: { name, color: "#7c5cff", avatar: null } });
  let rid = 1000;
  const request = (message: Record<string, unknown>) => {
    const id = ++rid;
    send({ ...message, rid: id });
    return received.find(m => m.t === "ack" && m.rid === id) as Extract<ServerMessage, { t: "ack" }>;
  };
  const last = <T extends ServerMessage["t"]>(t: T) => received.filter(m => m.t === t).at(-1) as Extract<ServerMessage, { t: T }> | undefined;
  return { received, request, send, last, accountId: last("welcome")!.accountId!, userId: last("welcome")!.userId };
}

const limited = (patch: Partial<AccountLimits>): AccountLimits => ({ ...NO_LIMITS, ...patch });
const newHub = (admins: string[] = []) => new Hub({ store: new MemoryStore(), iceServers: () => [stun, turn], admins });

test("les limites arrivent tout de suite sur l'appareil, et sans limite il n'y a rien à appliquer", () => {
  const hub = newHub();
  const pc = device(hub, "a", "Spoka");
  assert.equal(pc.last("account.limits")!.limits, null);
  assert.equal(hub.adminSetLimits(pc.accountId, limited({ maxKbps: 5000, maxFps: 30 }), "", "Admin"), true);
  assert.equal(pc.last("account.limits")!.limits!.maxKbps, 5000);
  hub.adminSetLimits(pc.accountId, null, "", "Admin");
  assert.equal(pc.last("account.limits")!.limits, null);
});

test("sans le droit de diffuser, le serveur refuse le direct et coupe celui en cours", () => {
  const hub = newHub();
  const pc = device(hub, "a", "Spoka");
  pc.request({ t: "room.create", name: "Salon" });
  assert.equal(pc.request({ t: "stream.start", id: "s1", stream: announce }).ok, true);
  hub.adminSetLimits(pc.accountId, limited({ canStream: false }), "", "Admin");
  assert.ok(pc.received.some(m => m.t === "stream.remove"), "le direct en cours s'arrête");
  assert.equal(pc.request({ t: "stream.start", id: "s2", stream: announce }).error, "disabled");
});

test("sans le relais, le compte ne reçoit plus d'identifiants, et les retrouve quand on le lève", () => {
  const hub = newHub();
  const pc = device(hub, "a", "Spoka");
  assert.equal(pc.last("welcome")!.iceServers.length, 2);
  hub.adminSetLimits(pc.accountId, limited({ canUseRelay: false }), "", "Admin");
  assert.deepEqual(pc.last("account.limits")!.iceServers, [stun]);
  assert.deepEqual(device(hub, "a", "Spoka").last("welcome")!.iceServers, [stun], "la reconnexion n'en redonne pas");
  hub.adminSetLimits(pc.accountId, null, "", "Admin");
  assert.equal(pc.last("account.limits")!.iceServers.length, 2);
});

test("salons et Watch Party se retirent aussi", () => {
  const hub = newHub();
  const pc = device(hub, "a", "Spoka");
  hub.adminSetLimits(pc.accountId, limited({ canCreateRooms: false }), "", "Admin");
  assert.equal(pc.request({ t: "room.create", name: "Salon" }).error, "disabled");
});

test("le nombre de spectateurs est tenu par le serveur", () => {
  const hub = newHub();
  const pc = device(hub, "a", "Spoka");
  const { code } = pc.request({ t: "room.create", name: "Salon" }).data as { code: string };
  pc.request({ t: "stream.start", id: "s1", stream: announce });
  hub.adminSetLimits(pc.accountId, limited({ maxViewers: 1 }), "", "Admin");
  const first = device(hub, "b", "Un");
  const second = device(hub, "c", "Deux");
  first.request({ t: "room.join", code });
  second.request({ t: "room.join", code });
  assert.equal(first.request({ t: "stream.watch", id: "s1", on: true }).ok, true);
  assert.equal(second.request({ t: "stream.watch", id: "s1", on: true }).error, "viewer_limit");
});

test("un débit qui reste au-dessus de la limite fait couper le direct, même si l'application ignore l'ordre", () => {
  const hub = newHub();
  const pc = device(hub, "a", "Spoka");
  pc.request({ t: "room.create", name: "Salon" });
  pc.request({ t: "stream.start", id: "s1", stream: announce });
  hub.adminSetLimits(pc.accountId, limited({ maxKbps: 5000 }), "", "Admin");
  const report = (kbps: number) => pc.send({ t: "telemetry", publish: { streamId: "s1", fps: 60, kbps, height: 1080, codec: "H265", encoder: "", hardware: true, encMs: 1, limit: "none", viewers: [{ id: "v", kbps, relay: false, protocol: "udp", rttMs: 10, lostPct: 0 }] }, watch: [] });
  report(20_000);
  report(20_000);
  assert.equal(pc.received.some(m => m.t === "stream.remove"), false, "un pic ne suffit pas");
  report(3000);
  report(20_000);
  report(20_000);
  assert.equal(pc.received.some(m => m.t === "stream.remove"), false, "repasser sous la limite remet le compteur à zéro");
  report(20_000);
  assert.ok(pc.received.some(m => m.t === "stream.remove"), "trois relevés de suite coupent");
});

test("une limite à durée limitée se lève toute seule", () => {
  let now = 1000;
  const hub = new Hub({ store: new MemoryStore(), iceServers: () => [], now: () => now } as never);
  const pc = device(hub, "a", "Spoka");
  hub.adminSetLimits(pc.accountId, limited({ canStream: false, until: 5000 }), "", "Admin");
  assert.equal(hub.limitsOf(pc.accountId)!.canStream, false);
  now = 6000;
  assert.equal(hub.limitsOf(pc.accountId), null);
});

test("un administrateur n'est jamais limité", () => {
  const first = newHub();
  const accountId = device(first, "a", "Admin").accountId;
  const hub = newHub([accountId]);
  assert.equal(device(hub, "a", "Admin").last("account.limits")!.limits, null);
  assert.equal(hub.adminSetLimits(accountId, limited({ canStream: false }), "", "Admin"), false);
});

test("les valeurs venues du panneau sont bornées et complétées", () => {
  const limits = cleanLimits({ maxKbps: -5, maxHeight: 99_999, maxFps: "30", canStream: false, inconnu: true }, 0);
  assert.deepEqual(limits, { ...NO_LIMITS, maxKbps: 0, maxHeight: 4320, maxFps: 30, canStream: false, until: 0 });
});
