import assert from "node:assert/strict";
import { test } from "node:test";
import { ConfigStore } from "../../server/config.ts";
import { Hub } from "../../server/hub.ts";
import { MemoryStore } from "../../server/store.ts";
import type { ServerMessage } from "../../src/shared/protocol.ts";
import { PROTOCOL_VERSION, scrubPaths } from "../../src/shared/protocol.ts";

const turn = { urls: "turn:exemple", username: "u", credential: "c" };

function device(hub: Hub, token: string, name: string, client = "app") {
  const received: ServerMessage[] = [];
  const conn = hub.connect({ ip: `203.0.113.${token.charCodeAt(0)}`, send: d => received.push(JSON.parse(d)), close: () => {} });
  const send = (message: Record<string, unknown>) => hub.handle(conn, JSON.stringify(message));
  send({ t: "hello", protocol: PROTOCOL_VERSION, token: token.repeat(64).slice(0, 64), client, profile: { name, color: "#7c5cff", avatar: null } });
  let rid = 1000;
  const request = (message: Record<string, unknown>) => {
    const id = ++rid;
    send({ ...message, rid: id });
    return received.find(m => m.t === "ack" && m.rid === id) as Extract<ServerMessage, { t: "ack" }>;
  };
  const last = <T extends ServerMessage["t"]>(t: T) => received.filter(m => m.t === t).at(-1) as Extract<ServerMessage, { t: T }> | undefined;
  return { received, request, last, conn };
}

function setup(inviteOnly: boolean) {
  const config = new ConfigStore();
  const hub = new Hub({ store: new MemoryStore(), iceServers: () => [turn], config });
  // L'ami qui invite existe déjà : sur un serveur ouvert au départ, puis passé sur invitation.
  const friend = device(hub, "a", "Spoka");
  const { code } = friend.request({ t: "room.create", name: "Soirée" }).data as { code: string };
  config.update({ inviteOnly });
  return { hub, friend, code };
}

test("sur invitation, un inconnu sans code ne peut ni créer de salon ni utiliser le relais, et on lui dit quoi faire", () => {
  const { hub } = setup(true);
  const stranger = device(hub, "e", "Inconnu");
  assert.equal(stranger.last("welcome")!.iceServers.length, 0);
  assert.match(stranger.last("announce")!.text, /sur invitation/);
  assert.equal(stranger.request({ t: "room.create", name: "À moi" }).error, "closed", "un code que les applications installées connaissent déjà");
  assert.equal(hub.adminUsers().length, 1, "rien n'est écrit pour lui");
});

test("le code d'un ami vaut invitation : le compte est créé sans reconnexion, et tout s'ouvre", () => {
  const { hub, code } = setup(true);
  const newcomer = device(hub, "b", "Nouveau");
  assert.equal(newcomer.request({ t: "room.join", code: "ZZZZZZZZ" }).error, "room_not_found");
  assert.equal(hub.adminUsers().length, 1, "un mauvais code ne crée rien");
  assert.equal(newcomer.request({ t: "room.join", code }).ok, true);
  const welcome = newcomer.last("welcome")!;
  assert.ok(welcome.accountId && welcome.iceServers.length === 1, "identité et relais arrivent avec le nouveau welcome");
  assert.equal(hub.adminUsers().length, 2);
  assert.equal(newcomer.request({ t: "room.create", name: "À moi" }).ok, true);
  assert.equal(device(hub, "b", "Nouveau").last("announce"), undefined, "à la reconnexion, c'est un compte comme un autre");
});

test("un spectateur du site arrive par le lien du salon et devient un compte", () => {
  const { hub, code } = setup(true);
  const phone = device(hub, "d", "Téléphone", "web");
  assert.equal(phone.last("announce"), undefined, "le site arrive déjà avec son code : pas d'annonce inutile");
  assert.equal(phone.request({ t: "room.join", code }).ok, true);
  assert.ok(phone.last("welcome")!.accountId);
});

test("les comptes existants ne voient aucune différence, et sans le réglage rien ne change", () => {
  const { hub, friend } = setup(true);
  assert.equal(device(hub, "a", "Spoka").request({ t: "room.create", name: "Encore" }).ok, true);
  assert.equal(friend.last("announce"), undefined);
  const open = setup(false);
  assert.equal(device(open.hub, "f", "Ouvert").request({ t: "room.create", name: "Libre" }).ok, true);
});

test("un serveur fermé reste fermé, même avec un code", () => {
  const { hub, code } = setup(true);
  hub.config.closed = true;
  assert.equal(device(hub, "c", "Fermé").request({ t: "room.join", code }).error, "closed");
});

test("le nom de session Windows ne finit pas dans un rapport d'erreur", () => {
  const stack = "at Stage (file:///C:/Users/arthu/AppData/Local/Programs/SpokaStream/resources/app.asar/x.js:1:2)\nC:\\Users\\Pierre Dupont\\AppData | c:\\\\users\\\\léa\\\\x";
  const clean = scrubPaths(stack);
  assert.ok(!/arthu|Pierre|léa/.test(clean), clean);
  assert.match(clean, /C:\/Users\/…\/AppData/);
  const { hub } = setup(false);
  const pc = device(hub, "9", "Rapport");
  hub.handle(pc.conn, JSON.stringify({ t: "report", kind: "error", text: "1.6.3 : C:\\Users\\arthu\\x", details: stack }));
  assert.ok(!JSON.stringify(hub.reports[0]).includes("arthu"));
});
