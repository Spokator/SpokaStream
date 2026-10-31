import assert from "node:assert/strict";
import { test } from "node:test";
import { Accounts } from "../../server/accounts.ts";
import { Hub } from "../../server/hub.ts";
import { startServer } from "../../server/index.ts";
import { MemoryStore } from "../../server/store.ts";
import { isVirtualInput } from "../../src/shared/ipc.ts";
import type { ClientMessage, ServerMessage } from "../../src/shared/protocol.ts";
import { PROTOCOL_VERSION } from "../../src/shared/protocol.ts";

const profile = { name: "Spoka", color: "#7c5cff", avatar: null };

class Device {
  received: ServerMessage[] = [];
  closed: number | null = null;
  private readonly conn: ReturnType<Hub["connect"]>;
  private readonly hub: Hub;
  private rid = 0;

  constructor(hub: Hub, token: string, name: string) {
    this.hub = hub;
    this.conn = hub.connect({ ip: "1.2.3.4", send: d => this.received.push(JSON.parse(d)), close: code => (this.closed = code) });
    this.send({ t: "hello", protocol: PROTOCOL_VERSION, token: token.repeat(64).slice(0, 64), profile: { ...profile, name } });
  }

  send(message: ClientMessage) {
    this.hub.handle(this.conn, JSON.stringify(message));
  }

  request(message: Record<string, unknown>) {
    const rid = ++this.rid + 1000;
    this.send({ ...message, rid } as unknown as ClientMessage);
    return this.received.find(m => m.t === "ack" && m.rid === rid) as Extract<ServerMessage, { t: "ack" }>;
  }

  last<T extends ServerMessage["t"]>(t: T) {
    return this.received.filter(m => m.t === t).at(-1) as Extract<ServerMessage, { t: T }> | undefined;
  }

  get userId() {
    return this.last("welcome")!.userId;
  }

  get accountId() {
    return this.last("welcome")!.accountId!;
  }
}

function linked(hub: Hub) {
  const pc = new Device(hub, "a", "Spoka");
  const phone = new Device(hub, "b", "Invité");
  const { code } = pc.request({ t: "account.link" }).data as { code: string };
  assert.equal(phone.request({ t: "account.claim", code }).ok, true);
  return { pc, phone };
}

const newHub = (admins: string[] = []) => new Hub({ store: new MemoryStore(), iceServers: () => [], admins });

test("un téléphone lié prend le compte et le profil du PC, en gardant son propre appareil", () => {
  const { pc, phone } = linked(newHub());
  assert.equal(phone.accountId, pc.accountId);
  assert.notEqual(phone.userId, pc.userId);
  assert.equal(phone.last("account.sync")!.profile.name, "Spoka");
});

test("un code ne sert qu'une fois, et un code inventé est refusé", () => {
  const hub = newHub();
  const pc = new Device(hub, "a", "Spoka");
  const { code } = pc.request({ t: "account.link" }).data as { code: string };
  assert.equal(new Device(hub, "b", "Un").request({ t: "account.claim", code }).ok, true);
  assert.equal(new Device(hub, "c", "Deux").request({ t: "account.claim", code }).ok, false);
  assert.equal(new Device(hub, "d", "Trois").request({ t: "account.claim", code: "AAAAAAAA" }).ok, false);
});

test("un code expiré ne vaut plus rien", () => {
  const accounts = new Accounts();
  const { code } = accounts.createLink("pc", 1000);
  assert.equal(accounts.claim(code, "phone", 1000 + 5 * 60_000 + 1), null);
});

test("le téléphone n'éjecte pas le PC du salon, et il a les droits du propriétaire", () => {
  const hub = newHub();
  const { pc, phone } = linked(hub);
  pc.request({ t: "room.create", name: "Soirée" });
  const code = pc.last("room.state")!.room.code;
  phone.request({ t: "room.join", code });
  assert.equal(pc.last("room.closed"), undefined, "le PC reste dans le salon");
  assert.equal(pc.last("member.join")!.member.account, pc.accountId);
  phone.send({ t: "room.update", name: "Renommé" });
  assert.equal(pc.last("room.updated")!.name, "Renommé");
});

test("ce qu'une personne ouvre ailleurs ne peut pas la bannir elle-même", () => {
  const hub = newHub();
  const { pc, phone } = linked(hub);
  pc.request({ t: "room.create", name: "Soirée" });
  phone.request({ t: "room.join", code: pc.last("room.state")!.room.code });
  pc.send({ t: "room.kick", userId: phone.userId, ban: true });
  assert.equal(phone.last("room.closed"), undefined);
});

test("la régie ne passe qu'entre appareils du même compte", () => {
  const hub = newHub();
  const { pc, phone } = linked(hub);
  const stranger = new Device(hub, "c", "Autre");
  const state = { roomId: "r", roomName: "S", roomCode: "C", title: "", source: "Écran", startedAt: 1, paused: false, screen: null, screens: [], scene: null, scenes: [], mix: [], viewers: [], stats: null, muted: false, deafened: false, camera: false, banner: "", recording: false, file: null, controlAsk: null, controller: null };
  pc.send({ t: "remote.state", state });
  assert.equal(phone.last("remote.state")!.state?.source, "Écran");
  assert.equal(stranger.last("remote.state"), undefined);
  phone.send({ t: "remote.cmd", cmd: "pause" });
  assert.equal(pc.last("remote.cmd")!.cmd, "pause");
  stranger.send({ t: "remote.cmd", cmd: "stop" });
  assert.equal(pc.received.filter(m => m.t === "remote.cmd").length, 1, "un inconnu ne pilote rien");
});

test("un téléphone qui arrive voit tout de suite que le PC diffuse, et l'apprend quand il part", () => {
  const hub = newHub();
  const { pc, phone } = linked(hub);
  pc.send({ t: "remote.state", state: { source: "Écran" } as never });
  const later = new Device(hub, "b", "Invité");
  assert.equal(later.last("remote.state")!.state?.source, "Écran");
  const before = phone.received.length;
  hub.disconnect((pc as unknown as { conn: never }).conn);
  assert.equal(phone.received.slice(before).some(m => m.t === "remote.state" && m.state === null), true);
});

test("détacher un appareil lui retire le compte tout de suite", () => {
  const hub = newHub();
  const { pc, phone } = linked(hub);
  assert.equal(pc.request({ t: "account.revoke", deviceId: phone.userId }).ok, true);
  assert.equal(phone.closed, 4001);
  assert.equal(hub.accounts.accountOf(phone.userId), phone.userId);
  assert.equal(pc.request({ t: "account.revoke", deviceId: pc.userId }).ok, false, "le PC principal ne se détache pas");
});

test("un compte banni du serveur ne se connecte plus", () => {
  const hub = newHub();
  const pc = new Device(hub, "a", "Spoka");
  assert.equal(hub.adminBan(pc.accountId, true), true);
  assert.equal(pc.closed, 4003);
  const again = new Device(hub, "a", "Spoka");
  assert.equal(again.last("welcome"), undefined);
});

test("en maintenance, seuls les propriétaires et les administrateurs entrent", () => {
  const hub = newHub();
  const owner = new Device(hub, "a", "Spoka");
  owner.request({ t: "room.create", name: "Soirée" });
  const code = owner.last("room.state")!.room.code;
  hub.maintenance = "Maintenance";
  assert.equal(new Device(hub, "c", "Autre").request({ t: "room.join", code }).error, "maintenance");
  assert.equal(new Device(hub, "d", "Autre").request({ t: "room.create", name: "Nouveau" }).error, "maintenance");
  assert.equal(owner.request({ t: "room.join", code }).ok, true);
});

test("les micros virtuels sont reconnus, pas les vraies entrées", () => {
  for (const label of ["CABLE Output (VB-Audio Virtual Cable)", "Line 1 (Virtual Audio Cable)", "VoiceMeeter Output (VB-Audio VoiceMeeter VAIO)"]) assert.equal(isVirtualInput(label), true, label);
  for (const label of ["Microphone (HyperX Cloud Alpha Wireless)", "Line In (High Definition Audio Device)", "Microphone sur casque"]) assert.equal(isVirtualInput(label), false, label);
});

// ---------------------------------------------------------------- panneau d'administration

async function panel() {
  const running = await startServer({ port: 0, host: "127.0.0.1", store: new MemoryStore(), admins: ["admin-compte"] });
  const base = `http://127.0.0.1:${running.port}`;
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) => fetch(`${base}/admin/api/${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  return { running, base, post, ticket: () => running.hub.onTicket!("admin-compte") };
}

test("le panneau refuse tout sans session", async () => {
  const { running, base, post } = await panel();
  try {
    for (const path of ["overview", "rooms", "users", "logs", "reports", "backup"]) assert.equal((await fetch(`${base}/admin/api/${path}`)).status, 401, path);
    assert.equal((await post("action", { action: "restart" })).status, 401);
    assert.equal((await post("login", { token: "f".repeat(64) })).status, 403, "un appareil quelconque n'entre pas");
    assert.equal((await post("login", { ticket: "faux" })).status, 403);
  } finally {
    await running.close();
  }
});

test("un billet ouvre une session, une seule fois", async () => {
  const { running, base, post, ticket } = await panel();
  try {
    const value = ticket();
    const login = await post("login", { ticket: value });
    assert.equal(login.status, 200);
    const cookie = login.headers.get("set-cookie")!;
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Strict/);
    assert.equal((await post("login", { ticket: value })).status, 403, "le billet a déjà servi");
    const overview = await fetch(`${base}/admin/api/overview`, { headers: { cookie: cookie.split(";")[0]! } });
    assert.equal(overview.status, 200);
    assert.equal(((await overview.json()) as { stats: { rooms: number } }).stats.rooms, 0);
  } finally {
    await running.close();
  }
});

test("une action venue d'un autre site est refusée", async () => {
  const { running, post, ticket } = await panel();
  try {
    const cookie = (await post("login", { ticket: ticket() })).headers.get("set-cookie")!.split(";")[0]!;
    assert.equal((await post("action", { action: "announce", text: "x" }, { cookie, origin: "https://evil.example" })).status, 403);
    assert.equal((await post("action", { action: "announce", text: "ok" }, { cookie })).status, 200);
  } finally {
    await running.close();
  }
});

test("le panneau ne se laisse pas essayer en boucle", async () => {
  const { running, post } = await panel();
  try {
    let last = 0;
    for (let i = 0; i < 16; i++) last = (await post("login", { ticket: "faux" })).status;
    assert.equal(last, 429);
  } finally {
    await running.close();
  }
});

test("un administrateur ne peut pas être banni par erreur", () => {
  const hub = newHub(["admin"]);
  assert.equal(hub.adminBan("admin", true), false);
});
