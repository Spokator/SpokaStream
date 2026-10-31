import assert from "node:assert/strict";
import { test } from "node:test";
import { iceServersFor } from "../../server/index.ts";
import { Hub } from "../../server/hub.ts";
import { MemoryStore } from "../../server/store.ts";
import type { ClientMessage, RoomState, ServerMessage, StreamAnnounce } from "../../src/shared/protocol.ts";
import { PROTOCOL_VERSION } from "../../src/shared/protocol.ts";

const ANNOUNCE: StreamAnnounce = {
  title: "Mon stream", kind: "screen", sourceName: "Écran 1", width: 1920, height: 1080, fps: 60,
  audio: "system", audioLabel: "Tout le PC", paused: false, allowDraw: true, maxViewers: 0,
};

class Client {
  received: ServerMessage[] = [];
  private readonly conn: ReturnType<Hub["connect"]>;
  private readonly hub: Hub;
  closed = false;
  constructor(hub: Hub, ip = "1.2.3.4") {
    this.hub = hub;
    this.conn = hub.connect({ ip, send: d => this.received.push(JSON.parse(d)), close: () => (this.closed = true) });
  }
  send(m: ClientMessage) {
    this.hub.handle(this.conn, JSON.stringify(m));
  }
  raw(s: string) {
    this.hub.handle(this.conn, s);
  }
  hello(name: string) {
    const token = (name.charCodeAt(0).toString(16) + name.charCodeAt(name.length - 1).toString(16) + name.length).padEnd(64, "a");
    this.send({ t: "hello", protocol: PROTOCOL_VERSION, token, profile: { name, color: "#112233", avatar: null } });
    return this.last("welcome").userId;
  }
  last<T extends ServerMessage["t"]>(t: T): Extract<ServerMessage, { t: T }> {
    const found = [...this.received].reverse().find(m => m.t === t);
    assert.ok(found, `message ${t} attendu, reçu : ${this.received.map(m => m.t).join(", ")}`);
    return found as Extract<ServerMessage, { t: T }>;
  }
  all<T extends ServerMessage["t"]>(t: T) {
    return this.received.filter(m => m.t === t) as Extract<ServerMessage, { t: T }>[];
  }
  ack(rid: number) {
    return this.all("ack").find(a => a.rid === rid);
  }
  drop() {
    this.hub.disconnect(this.conn);
  }
}

function setup() {
  const hub = new Hub({ store: new MemoryStore(), iceServers: () => [], graceMs: 10 });
  const a = new Client(hub);
  const b = new Client(hub, "5.6.7.8");
  const aId = a.hello("alice");
  const bId = b.hello("bob");
  a.send({ t: "room.create", name: "Les potes", rid: 1 });
  const room = a.last("room.state").room;
  b.send({ t: "room.join", code: room.code, rid: 2 });
  return { hub, a, b, aId, bId, room };
}

test("un salon se crée et se rejoint avec son code, quelle que soit la casse", () => {
  const { a, b, bId, room } = setup();
  assert.equal(a.ack(1)?.ok, true);
  assert.equal(b.ack(2)?.ok, true);
  assert.equal(b.last("room.state").room.members.length, 2);
  assert.equal(a.last("member.join").member.id, bId);

  const hub = new Hub({ store: new MemoryStore(), iceServers: () => [] });
  assert.equal(room.code.length, 8);
  const c = new Client(hub);
  c.hello("carole");
  c.send({ t: "room.join", code: "inexistant", rid: 3 });
  assert.equal(c.ack(3)?.error, "room_not_found");
});

test("rien n'est possible avant le hello", () => {
  const hub = new Hub({ store: new MemoryStore(), iceServers: () => [] });
  const c = new Client(hub);
  c.send({ t: "room.create", name: "x", rid: 1 });
  assert.equal(c.ack(1)?.error, "not_authenticated");
  c.raw("pas du json");
  assert.equal(c.last("error").error, "bad_request");
  c.send({ t: "hello", protocol: 999, token: "a".repeat(64), profile: { name: "x", color: "#000000", avatar: null }, rid: 2 });
  assert.equal(c.ack(2)?.error, "version");
  c.send({ t: "hello", protocol: PROTOCOL_VERSION, token: "court", profile: { name: "x", color: "#000000", avatar: null }, rid: 3 });
  assert.equal(c.ack(3)?.error, "bad_request");
});

test("le chat arrive à tout le monde et reste dans l'historique", () => {
  const { a, b } = setup();
  a.send({ t: "chat.send", text: "  salut  " });
  const message = b.last("chat").message;
  assert.equal(message.text, "salut");
  assert.equal(message.authorName, "alice");

  const hub2 = b.last("room.state").room.code;
  assert.ok(hub2);
  b.send({ t: "room.leave" });
  b.send({ t: "room.join", code: hub2, rid: 9 });
  assert.ok(b.last("room.state").room.history.some(m => m.text === "salut"));
});

test("seuls l'auteur et le propriétaire suppriment un message", () => {
  const { a, b } = setup();
  a.send({ t: "chat.send", text: "à garder" });
  const id = b.last("chat").message.id;
  b.send({ t: "chat.delete", id });
  assert.equal(b.last("error").error, "forbidden");
  a.send({ t: "chat.delete", id });
  assert.equal(b.last("chat.deleted").id, id);
});

test("une rafale de messages est freinée", () => {
  const { a } = setup();
  for (let i = 0; i < 40; i++) a.send({ t: "chat.send", text: `m${i}` });
  assert.equal(a.last("error").error, "rate_limited");
  assert.ok(a.all("chat").filter(m => m.message.kind === "user").length <= 13);
});

test("le diffuseur apprend qui veut regarder, et la signalisation passe de l'un à l'autre", () => {
  const { a, b, aId, bId } = setup();
  a.send({ t: "stream.start", id: "s1", stream: ANNOUNCE, rid: 5 });
  assert.equal(a.ack(5)?.ok, true);
  assert.equal(b.last("stream.add").stream.ownerId, aId);

  b.send({ t: "stream.watch", id: "s1", on: true, quality: { maxHeight: 720, maxKbps: 0, maxFps: 30, video: true }, rid: 6 });
  const viewer = a.last("stream.viewer");
  assert.deepEqual([viewer.userId, viewer.on, viewer.quality?.maxHeight], [bId, true, 720]);
  assert.deepEqual(b.last("stream.update").patch.viewers, [bId]);

  a.send({ t: "rtc", to: bId, session: "s1", data: { sdp: "offre" } });
  assert.deepEqual(b.last("rtc").data, { sdp: "offre" });

  b.send({ t: "stream.quality", id: "s1", quality: { maxHeight: 480, maxKbps: 2000, maxFps: 30, video: false } });
  assert.equal(a.last("stream.quality").quality.video, false);

  b.send({ t: "stream.watch", id: "s1", on: false });
  assert.equal(a.last("stream.viewer").on, false);
  a.send({ t: "stream.stop" });
  assert.equal(b.last("stream.remove").id, "s1");
});

test("demander à nouveau un flux déjà ouvert relance le diffuseur", () => {
  const { a, b } = setup();
  a.send({ t: "stream.start", id: "s1", stream: ANNOUNCE });
  b.send({ t: "stream.watch", id: "s1", on: true });
  const before = a.all("stream.viewer").length;
  b.send({ t: "stream.watch", id: "s1", on: true });
  assert.equal(a.all("stream.viewer").length, before + 1);
});

test("la limite de spectateurs est respectée", () => {
  const { hub, a, b, room } = setup();
  const c = new Client(hub, "9.9.9.9");
  c.hello("carole");
  c.send({ t: "room.join", code: room.code });
  a.send({ t: "stream.start", id: "s1", stream: { ...ANNOUNCE, maxViewers: 1 } });
  b.send({ t: "stream.watch", id: "s1", on: true, rid: 7 });
  c.send({ t: "stream.watch", id: "s1", on: true, rid: 8 });
  assert.equal(b.ack(7)?.ok, true);
  assert.equal(c.ack(8)?.error, "viewer_limit");
});

test("une coupure brève ne fait pas perdre sa place, et le stream continue", async () => {
  const { hub, a, b, aId } = setup();
  const code = a.last("room.state").room.code;
  a.send({ t: "stream.start", id: "s1", stream: ANNOUNCE });
  a.drop();
  assert.equal(b.last("member.update").member.online, false);

  const back = new Client(hub);
  assert.equal(back.hello("alice"), aId);
  back.send({ t: "room.join", code });
  const state: RoomState = back.last("room.state").room;
  assert.equal(state.streams[0]?.id, "s1");
  assert.equal(b.all("stream.remove").length, 0);

  back.send({ t: "stream.start", id: "s1", stream: ANNOUNCE, rid: 12 });
  assert.equal(back.ack(12)?.ok, true);
  await new Promise(r => setTimeout(r, 25));
  assert.equal(b.all("member.leave").length, 0);
});

test("sans retour avant la fin du délai, la personne et son stream disparaissent", async () => {
  const { a, b, aId } = setup();
  a.send({ t: "stream.start", id: "s1", stream: ANNOUNCE });
  a.drop();
  await new Promise(r => setTimeout(r, 25));
  assert.equal(b.last("member.leave").userId, aId);
  assert.equal(b.last("stream.remove").id, "s1");
});

test("la même personne sur une nouvelle connexion remplace l'ancienne", () => {
  const { hub, a, room } = setup();
  const again = new Client(hub);
  again.hello("alice");
  again.send({ t: "room.join", code: room.code });
  assert.equal(a.last("room.closed").reason, "replaced");
  assert.equal(again.last("room.state").room.members.length, 2);
});

test("le propriétaire exclut et bannit, un membre ne peut pas", () => {
  const { a, b, aId, bId, room } = setup();
  b.send({ t: "room.kick", userId: aId, ban: false });
  assert.equal(b.last("error").error, "forbidden");
  a.send({ t: "room.kick", userId: bId, ban: true });
  assert.equal(b.last("room.closed").reason, "banned");
  b.send({ t: "room.join", code: room.code, rid: 40 });
  assert.equal(b.ack(40)?.error, "banned");
});

test("un salon verrouillé refuse les nouveaux", () => {
  const { hub, a, room } = setup();
  a.send({ t: "room.update", settings: { locked: true } });
  const c = new Client(hub, "9.9.9.9");
  c.hello("carole");
  c.send({ t: "room.join", code: room.code, rid: 41 });
  assert.equal(c.ack(41)?.error, "room_locked");
});

test("seul le propriétaire peut diffuser si le salon le demande", () => {
  const { a, b } = setup();
  a.send({ t: "room.update", settings: { whoCanStream: "owner" } });
  b.send({ t: "stream.start", id: "s2", stream: ANNOUNCE, rid: 50 });
  assert.equal(b.ack(50)?.error, "forbidden");
});

test("le dessin est relayé aux autres, refusé si le diffuseur l'a coupé", () => {
  const { a, b } = setup();
  a.send({ t: "stream.start", id: "s1", stream: ANNOUNCE });
  const stroke = { id: "t1", tool: "laser" as const, color: "#ff0000", points: [0.1, 0.2], end: false };
  b.send({ t: "draw", streamId: "s1", stroke });
  assert.equal(a.last("draw").stroke.id, "t1");
  a.send({ t: "stream.update", patch: { allowDraw: false } });
  b.send({ t: "draw", streamId: "s1", stroke: { ...stroke, id: "t2" } });
  assert.equal(a.all("draw").length, 1);
});

test("les profils et images malveillants sont neutralisés", () => {
  const hub = new Hub({ store: new MemoryStore(), iceServers: () => [] });
  const c = new Client(hub);
  c.send({ t: "hello", protocol: PROTOCOL_VERSION, token: "b".repeat(64), profile: { name: "x".repeat(200), color: "red;background:url(x)", avatar: "javascript:alert(1)" } });
  c.send({ t: "room.create", name: "x" });
  const me = c.last("room.state").room.members[0]!;
  assert.equal(me.name.length, 32);
  assert.equal(me.color, "#7c5cff");
  assert.equal(me.avatar, null);
});

test("les salons survivent à un redémarrage du serveur", () => {
  const store = new MemoryStore();
  const hub = new Hub({ store, iceServers: () => [] });
  const c = new Client(hub);
  c.hello("alice");
  c.send({ t: "room.create", name: "Persistant" });
  const code = c.last("room.state").room.code;

  const restarted = new Hub({ store, iceServers: () => [] });
  const d = new Client(restarted);
  d.hello("bob");
  d.send({ t: "room.join", code, rid: 1 });
  assert.equal(d.ack(1)?.ok, true);
  assert.equal(d.last("room.state").room.name, "Persistant");
});

test("les abonnés sont prévenus quand un ami lance un stream, même hors du salon", () => {
  const { hub, a, room } = setup();
  const watcher = new Client(hub, "9.9.9.9");
  watcher.hello("carole");
  watcher.send({ t: "room.subscribe", ids: [room.id] });
  assert.equal(watcher.last("room.status").rooms[0]?.members, 2);
  a.send({ t: "stream.start", id: "s1", stream: ANNOUNCE });
  assert.equal(watcher.last("room.status").rooms[0]?.live[0]?.ownerName, "alice");
});

test("les identifiants TURN suivent le format de coturn", () => {
  const list = iceServersFor("u1", { turnHost: "turn.exemple.fr", turnSecret: "secret" });
  const turn = list[1]!;
  assert.match(String(turn.username), /^\d+:u1$/);
  assert.ok(turn.credential);
  assert.equal(iceServersFor("u1", {}).length, 1);
});
