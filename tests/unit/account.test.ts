import assert from "node:assert/strict";
import { test } from "node:test";
import { Accounts } from "../../server/accounts.ts";
import { AdminAuth, totpCode } from "../../server/adminAuth.ts";
import { Hub } from "../../server/hub.ts";
import { clientIp, startServer } from "../../server/index.ts";
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

test("la politique de confidentialité est servie", async () => {
  const running = await startServer({ port: 0, host: "127.0.0.1", store: new MemoryStore() });
  const page = await fetch(`http://127.0.0.1:${running.port}/confidentialite`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Politique de confidentialité/);
  await running.close();
});

test("le dernier maillon de X-Forwarded-For est la seule adresse fiable", () => {
  const req = (header: string) => ({ headers: { "x-forwarded-for": header }, socket: { remoteAddress: "127.0.0.1" } }) as never;
  assert.equal(clientIp(req("1.1.1.1, 8.8.4.4"), { trustProxy: true }), "8.8.4.4", "le début de la liste est écrit par le client");
  assert.equal(clientIp(req("8.8.4.4"), { trustProxy: false }), "127.0.0.1", "sans proxy, l'en-tête ne vaut rien");
});

test("le code à 6 chiffres suit la RFC 6238", () => {
  // Vecteurs de la RFC, secret ASCII 12345678901234567890, tronqués à 6 chiffres.
  const secret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
  assert.equal(totpCode(secret, 1), "287082");
  assert.equal(totpCode(secret, 37037036), "081804");
  assert.equal(totpCode(secret, 37037037), "050471");
});

const PASSWORD = "un-long-mot-de-passe";

async function firstOwner() {
  const auth = new AdminAuth();
  const { user } = await auth.completeInvite(auth.ownerInvite(), "spoka", PASSWORD);
  return { auth, id: user!.id };
}

const status = async (auth: AdminAuth, ...args: [unknown, unknown, unknown, number?]) => (await auth.login(...args)).result;

test("un accès se crée une fois, avec un lien qui ne ressert pas", async () => {
  const auth = new AdminAuth();
  assert.equal(auth.state.configured, false);
  const code = auth.ownerInvite();
  assert.match((await auth.completeInvite(code, "spoka", "court")).problem!, /12 caractères/);
  assert.equal((await auth.completeInvite("faux", "spoka", PASSWORD)).problem, "Ce lien n'est plus valable.");
  assert.equal((await auth.completeInvite(code, "spoka", PASSWORD)).problem, null);
  assert.equal(auth.state.configured, true);
  assert.equal((await auth.completeInvite(code, "pirate", "un-autre-mot-de-passe")).problem, "Ce lien n'est plus valable.");
  assert.equal(await status(auth, "spoka", PASSWORD, ""), "ok");
  assert.equal(await status(auth, "SPOKA", PASSWORD, ""), "ok", "l'identifiant ne dépend pas de la casse");
  assert.equal(await status(auth, "spoka", "mauvais", ""), "bad");
  assert.equal(await status(auth, "autre", PASSWORD, ""), "bad");
});

test("un lien expiré ne crée rien", async () => {
  const auth = new AdminAuth();
  const code = auth.invite({ role: "owner" }, 1000);
  assert.equal((await auth.completeInvite(code, "spoka", PASSWORD, 1000 + 25 * 3600_000)).problem, "Ce lien n'est plus valable.");
});

test("avec le code à 6 chiffres, le mot de passe seul n'ouvre plus rien", async () => {
  const { auth, id } = await firstOwner();
  const now = Date.now();
  const counter = Math.floor(now / 30_000);
  const { secret } = auth.startTotp(id);
  assert.equal(auth.confirmTotp(id, "000000x", now), null, "un mauvais code n'active rien");
  const recovery = auth.confirmTotp(id, totpCode(secret, counter), now)!;
  assert.equal(recovery.length, 8);
  assert.equal(await status(auth, "spoka", PASSWORD, ""), "code");
  assert.equal(await status(auth, "spoka", "mauvais", ""), "bad", "un mauvais mot de passe ne révèle pas qu'un code est demandé");
  assert.equal(await status(auth, "spoka", PASSWORD, "123456", now), "bad");
  const fresh = totpCode(secret, counter + 1);
  assert.equal(await status(auth, "spoka", PASSWORD, fresh, now), "ok");
  assert.equal(await status(auth, "spoka", PASSWORD, fresh, now), "bad", "un code ne ressert pas");
  assert.equal(await status(auth, "spoka", PASSWORD, recovery[0]!, now), "ok");
  assert.equal(await status(auth, "spoka", PASSWORD, recovery[0]!, now), "bad", "un code de secours ne ressert pas");
  assert.equal(await auth.disableTotp(id, "mauvais"), false);
  assert.equal(await auth.disableTotp(id, PASSWORD), true);
  assert.equal(await status(auth, "spoka", PASSWORD, ""), "ok");
});

test("changer le mot de passe demande l'ancien", async () => {
  const { auth, id } = await firstOwner();
  assert.match((await auth.changePassword(id, "faux", "un-nouveau-mot-de-passe"))!, /faux/);
  assert.equal(await auth.changePassword(id, PASSWORD, "un-nouveau-mot-de-passe"), null);
  assert.equal(await status(auth, "spoka", PASSWORD, ""), "bad");
  assert.equal(await status(auth, "spoka", "un-nouveau-mot-de-passe", ""), "ok");
});

test("un lien de secours redonne l'accès du propriétaire, sans en créer un autre", async () => {
  const { auth, id } = await firstOwner();
  const { secret } = auth.startTotp(id);
  auth.confirmTotp(id, totpCode(secret, Math.floor(Date.now() / 30_000)));
  const { problem, user } = await auth.completeInvite(auth.ownerInvite(), "ignoré", "un-autre-long-mot-de-passe");
  assert.equal(problem, null);
  assert.equal(user!.username, "spoka");
  assert.equal(auth.list().length, 1);
  assert.equal(await status(auth, "spoka", "un-autre-long-mot-de-passe", ""), "ok", "le téléphone perdu ne bloque plus");
});

test("il reste toujours un propriétaire", async () => {
  const { auth, id } = await firstOwner();
  assert.match(auth.setRole(id, "moderator")!, /propriétaire/);
  assert.match(auth.setDisabled(id, true)!, /propriétaire/);
  assert.match(auth.remove(id)!, /propriétaire/);
  const { user } = await auth.completeInvite(auth.invite({ role: "owner" }), "second", PASSWORD);
  assert.equal(auth.setRole(id, "moderator"), null, "avec un second propriétaire, c'est possible");
  assert.match(auth.remove(user!.id)!, /propriétaire/);
});

test("un identifiant ne se prend pas deux fois, et un accès désactivé n'entre plus", async () => {
  const { auth } = await firstOwner();
  assert.match((await auth.completeInvite(auth.invite({ role: "moderator" }), "SPOKA", PASSWORD)).problem!, /déjà pris/);
  const { user } = await auth.completeInvite(auth.invite({ role: "moderator" }), "modo", PASSWORD);
  auth.setDisabled(user!.id, true);
  assert.equal(await status(auth, "modo", PASSWORD, ""), "bad");
});

test("gérer les comptes : renommer partout, supprimer, donner un salon", () => {
  const hub = newHub();
  const { pc, phone } = linked(hub);
  pc.request({ t: "room.create", name: "Soirée" });
  const roomId = pc.last("room.state")!.room.id;
  assert.equal(hub.adminProfile(pc.accountId, { name: "Nouveau nom" }), true);
  assert.equal(phone.last("account.sync")!.profile.name, "Nouveau nom", "le téléphone suit");
  assert.equal(pc.last("member.update")!.member.name, "Nouveau nom", "le salon suit");

  const friend = new Device(hub, "c", "Ami");
  friend.request({ t: "room.join", id: roomId });
  assert.equal(hub.adminTransferRoom(roomId, friend.accountId), true);
  assert.equal(friend.last("room.state")!.room.ownerId, friend.accountId);
  assert.equal(pc.last("room.state")!.room.ownerId, friend.accountId);

  assert.equal(hub.adminMessage(friend.accountId, "Bonjour"), true);
  assert.equal(friend.last("announce")!.text, "Bonjour");
  assert.equal(pc.last("announce"), undefined, "le message ne va qu'à cette personne");

  assert.equal(hub.adminDeleteAccount(friend.accountId, true), true);
  assert.equal(friend.closed, 4002);
  assert.equal(hub.adminRooms().length, 0, "son salon part avec lui");
  assert.equal(hub.accounts.list().some(a => a.id === friend.accountId), false);
});

test("le panneau refuse tout sans session", async () => {
  const { running, base, post } = await panel();
  try {
    for (const path of ["overview", "rooms", "users", "logs", "reports", "backup"]) assert.equal((await fetch(`${base}/admin/api/${path}`)).status, 401, path);
    assert.equal((await post("action", { action: "restart" })).status, 401);
    assert.equal((await post("login", { username: "spoka", password: "faux" })).status, 403);
    assert.equal((await post("login", { token: "f".repeat(64) })).status, 403, "un jeton d'appareil n'ouvre plus rien");
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

test("le panneau bloque une adresse après 5 échecs, même avec le bon mot de passe ensuite", async () => {
  const adminAuth = new AdminAuth();
  await adminAuth.completeInvite(adminAuth.ownerInvite(), "spoka", "un-long-mot-de-passe");
  const running = await startServer({ port: 0, host: "127.0.0.1", store: new MemoryStore(), adminAuth });
  const post = (body: unknown) => fetch(`http://127.0.0.1:${running.port}/admin/api/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  try {
    assert.equal((await post({ username: "spoka", password: "un-long-mot-de-passe" })).status, 200);
    for (let i = 0; i < 5; i++) assert.equal((await post({ username: "spoka", password: "faux" })).status, 403);
    assert.equal((await post({ username: "spoka", password: "un-long-mot-de-passe" })).status, 429);
  } finally {
    await running.close();
  }
});

async function roles() {
  const adminAuth = new AdminAuth();
  await adminAuth.completeInvite(adminAuth.ownerInvite(), "chef", PASSWORD);
  await adminAuth.completeInvite(adminAuth.invite({ role: "admin" }), "second", PASSWORD);
  await adminAuth.completeInvite(adminAuth.invite({ role: "moderator" }), "modo", PASSWORD);
  const running = await startServer({ port: 0, host: "127.0.0.1", store: new MemoryStore(), adminAuth });
  const base = `http://127.0.0.1:${running.port}/admin/api`;
  const session = async (username: string) => {
    const login = await fetch(`${base}/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username, password: PASSWORD }) });
    assert.equal(login.status, 200, username);
    const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
    return {
      post: (path: string, body: unknown) => fetch(`${base}/${path}`, { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify(body) }).then(r => r.status),
      get: (path: string) => fetch(`${base}/${path}`, { headers: { cookie } }).then(r => r.status),
    };
  };
  return { running, session, adminAuth };
}

test("les droits sont appliqués par le serveur, pas par l'interface", async () => {
  const { running, session } = await roles();
  try {
    const modo = await session("modo");
    assert.equal(await modo.post("action", { action: "announce", text: "x" }), 403);
    assert.equal(await modo.post("action", { action: "restart" }), 403);
    assert.equal(await modo.post("action", { action: "deleteRoom", roomId: "x" }), 403);
    assert.equal(await modo.post("action", { action: "deleteUser", accountId: "x" }), 403);
    assert.equal(await modo.get("backup"), 403);
    assert.equal(await modo.get("admins"), 403);
    assert.equal(await modo.post("admins/invite", { role: "owner" }), 403, "un modérateur ne se nomme pas propriétaire");
    assert.equal(await modo.post("action", { action: "stopStream", roomId: "x", ownerId: "y" }), 400, "son rôle le permet, l'action échoue juste faute de stream");
    const admin = await session("second");
    assert.equal(await admin.post("action", { action: "announce", text: "ok" }), 200);
    assert.equal(await admin.get("backup"), 403);
    assert.equal(await admin.post("admins/invite", { role: "owner" }), 403, "un administrateur ne touche pas aux accès");
    const owner = await session("chef");
    assert.equal(await owner.get("backup"), 200);
    assert.equal(await owner.get("admins"), 200);
    assert.equal(await owner.post("admins/invite", { role: "moderator" }), 200);
  } finally {
    await running.close();
  }
});

test("retirer un droit agit tout de suite, sans attendre une nouvelle connexion", async () => {
  const { running, session, adminAuth } = await roles();
  try {
    const admin = await session("second");
    const owner = await session("chef");
    const target = adminAuth.list().find(u => u.username === "second")!;
    assert.equal(await admin.post("action", { action: "announce", text: "ok" }), 200);
    assert.equal(await owner.post("admins/role", { id: target.id, role: "moderator" }), 200);
    assert.equal(await admin.post("action", { action: "announce", text: "non" }), 403);
    assert.equal(await owner.post("admins/disable", { id: target.id, disabled: true }), 200);
    assert.equal(await admin.get("overview"), 401, "sa session est coupée");
  } finally {
    await running.close();
  }
});

test("le propriétaire ne peut pas se couper lui-même", async () => {
  const { running, session, adminAuth } = await roles();
  try {
    const owner = await session("chef");
    const self = adminAuth.list().find(u => u.username === "chef")!;
    assert.equal(await owner.post("admins/disable", { id: self.id, disabled: true }), 400);
    assert.equal(await owner.post("admins/remove", { id: self.id }), 400);
  } finally {
    await running.close();
  }
});

test("un administrateur ne peut pas être banni par erreur", () => {
  const hub = newHub(["admin"]);
  assert.equal(hub.adminBan("admin", true), false);
});
