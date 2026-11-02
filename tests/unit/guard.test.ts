import assert from "node:assert/strict";
import { test } from "node:test";
import { GUARD, Guard } from "../../server/guard.ts";
import { Hub } from "../../server/hub.ts";
import { MemoryStore } from "../../server/store.ts";
import type { ClientMessage, ServerMessage } from "../../src/shared/protocol.ts";
import { PROTOCOL_VERSION } from "../../src/shared/protocol.ts";

const ip = "203.0.113.7";

test("une adresse ne peut pas ouvrir plus de connexions que prévu, et retrouve sa place en les fermant", () => {
  const guard = new Guard(0);
  let now = 0;
  for (let i = 0; i < GUARD.connectionsPerIp; i++) {
    now += 1000;
    assert.equal(guard.admit(ip, now), true);
  }
  now += 1000;
  assert.equal(guard.admit(ip, now), false, "la limite par adresse tient");
  assert.equal(guard.admit("203.0.113.8", now), true, "les autres adresses ne sont pas touchées");
  guard.release(ip);
  now += 1000;
  assert.equal(guard.admit(ip, now), true);
});

test("une rafale de reconnexions est freinée", () => {
  const guard = new Guard(0);
  let admitted = 0;
  for (let i = 0; i < GUARD.opensBurst + 10; i++) {
    if (guard.admit(ip, 0)) {
      admitted++;
      guard.release(ip);
    }
  }
  assert.equal(admitted, GUARD.opensBurst);
});

test("le serveur entier a un plafond, même venant d'adresses toutes différentes", () => {
  const guard = new Guard(0);
  for (let i = 0; i < GUARD.connections; i++) assert.equal(guard.admit(`10.${i >> 16}.${(i >> 8) & 255}.${i & 255}`, 0), true);
  assert.equal(guard.admit("203.0.113.9", 0), false);
});

test("les nouveaux comptes sont limités par adresse et pour tout le serveur", () => {
  const guard = new Guard(0);
  let allowed = 0;
  for (let i = 0; i < 40; i++) if (guard.allowAccount(ip, 0)) allowed++;
  assert.equal(allowed, GUARD.accountsBurstByIp);
  allowed = 0;
  for (let i = 0; i < 200; i++) if (guard.allowAccount(`10.0.0.${i}`, 0)) allowed++;
  assert.ok(allowed <= GUARD.accountsBurst, `${allowed} comptes d'un coup`);
  assert.equal(guard.allowAccount(ip, 180_000 * GUARD.accountsBurst), true, "le temps redonne des jetons");
});

test("la boucle locale passe, pour nginx mal configuré et pour les essais", () => {
  const guard = new Guard(0);
  for (let i = 0; i < GUARD.connectionsPerIp + 5; i++) assert.equal(guard.admit("127.0.0.1", 0), true);
  assert.equal(guard.allowAccount("127.0.0.1", 0), true);
});

test("un avertissement par sujet toutes les 10 minutes", () => {
  const guard = new Guard(0);
  assert.equal(guard.shouldWarn("comptes", 0), true);
  assert.equal(guard.shouldWarn("comptes", 1000), false);
  assert.equal(guard.shouldWarn("salons", 1000), true);
  assert.equal(guard.shouldWarn("comptes", 600_000), true);
});

function device(hub: Hub, token: string, name: string) {
  const received: ServerMessage[] = [];
  const conn = hub.connect({ ip, send: d => received.push(JSON.parse(d)), close: () => {} });
  const send = (message: Record<string, unknown>) => hub.handle(conn, JSON.stringify(message as unknown as ClientMessage));
  send({ t: "hello", protocol: PROTOCOL_VERSION, token: token.repeat(64).slice(0, 64), profile: { name, color: "#7c5cff", avatar: null } });
  let rid = 1000;
  const request = (message: Record<string, unknown>) => {
    const id = ++rid;
    send({ ...message, rid: id });
    return received.find(m => m.t === "ack" && m.rid === id) as Extract<ServerMessage, { t: "ack" }>;
  };
  const welcome = () => received.filter(m => m.t === "welcome").at(-1) as Extract<ServerMessage, { t: "welcome" }>;
  return { received, request, send, welcome };
}

test("au-delà de la limite, un nouveau venu reste invité : pas de compte écrit, pas de relais, pas de salon", () => {
  const turn = { urls: "turn:exemple", username: "u", credential: "c" };
  const stun = { urls: "stun:exemple" };
  const guard = new Guard();
  const hub = new Hub({ store: new MemoryStore(), iceServers: () => [stun, turn], guard });
  const seen: Extract<ServerMessage, { t: "welcome" }>[] = [];
  for (let i = 0; i <= GUARD.accountsBurstByIp; i++) seen.push(device(hub, i.toString(16), `Essai ${i}`).welcome());
  assert.equal(seen[0]!.iceServers.length, 2, "un vrai compte reçoit le relais");
  assert.deepEqual(seen.at(-1)!.iceServers, [stun], "le dernier n'a que STUN");
  const late = device(hub, "f", "Trop tard");
  assert.equal(late.request({ t: "room.create", name: "Salon" }).error, "closed");
});

test("les salons créés depuis une adresse sont limités", () => {
  const guard = new Guard();
  const hub = new Hub({ store: new MemoryStore(), iceServers: () => [], guard });
  const pc = device(hub, "a", "Spoka");
  let refused = 0;
  for (let i = 0; i < GUARD.roomsBurstByIp + 3; i++) if (pc.request({ t: "room.create", name: `Salon ${i}` }).error === "rate_limited") refused++;
  assert.ok(refused >= 3, `${refused} refus`);
});

test("supprimer son compte efface ses salons, ses messages ailleurs et ses appareils", () => {
  const store = new MemoryStore();
  const hub = new Hub({ store, iceServers: () => [] });
  const leaving = device(hub, "a", "Part");
  const friend = device(hub, "b", "Reste");
  const code = (friend.request({ t: "room.create", name: "Chez Reste" }).data as { code: string }).code;
  assert.equal(leaving.request({ t: "room.join", code }).ok, true);
  leaving.send({ t: "chat.send", text: "à effacer" });
  const sent = friend.received.filter(m => m.t === "chat" && m.message.kind === "user").at(-1) as Extract<ServerMessage, { t: "chat" }>;
  assert.ok(sent, "le message est arrivé");
  const mine = leaving.request({ t: "room.create", name: "Chez Part" }).ok;
  assert.equal(mine, true);
  const accountId = leaving.welcome().accountId!;
  assert.equal(leaving.request({ t: "account.delete" }).ok, true);
  assert.ok(friend.received.some(m => m.t === "chat.deleted" && m.id === sent.message.id), "le salon de l'ami perd le message");
  assert.equal(hub.accounts.detail(accountId), null, "le compte n'existe plus");
});

test("un compte administrateur ne se supprime pas par cette voie", () => {
  const hub = new Hub({ store: new MemoryStore(), iceServers: () => [] });
  const admin = device(hub, "a", "Admin");
  const owner = new Hub({ store: new MemoryStore(), iceServers: () => [], admins: [admin.welcome().accountId!] });
  assert.equal(device(owner, "a", "Admin").request({ t: "account.delete" }).error, "forbidden");
});
