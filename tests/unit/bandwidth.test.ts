import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { Alerts, RULES } from "../../server/alerts.ts";
import { Bandwidth, DAYS_KEPT, POINTS_KEPT_HOURS } from "../../server/bandwidth.ts";
import { Hub } from "../../server/hub.ts";
import { privacyPage } from "../../server/privacy.ts";
import { MemoryStore } from "../../server/store.ts";
import type { ServerMessage } from "../../src/shared/protocol.ts";
import { PROTOCOL_VERSION } from "../../src/shared/protocol.ts";

const HOUR = 3600_000;
const START = Date.UTC(2026, 10, 2, 12);

function device(hub: Hub, token: string, name: string) {
  const received: ServerMessage[] = [];
  const conn = hub.connect({ ip: "203.0.113.7", send: d => received.push(JSON.parse(d)), close: () => {} });
  const send = (message: Record<string, unknown>) => hub.handle(conn, JSON.stringify(message));
  send({ t: "hello", protocol: PROTOCOL_VERSION, token: token.repeat(64).slice(0, 64), profile: { name, color: "#7c5cff", avatar: null } });
  return { send, accountId: conn.accountId! };
}

const publish = (viewers: { kbps: number; relay: boolean }[]) => ({ t: "telemetry", publish: { streamId: "s1", fps: 60, kbps: 0, height: 1080, codec: "H265", encoder: "", hardware: true, encMs: 1, limit: "none", viewers: viewers.map((viewer, i) => ({ id: `v${i}`, protocol: "udp", rttMs: 10, lostPct: 0, ...viewer })) }, watch: [] });
const watch = (kbps: number, relay: boolean) => ({ t: "telemetry", watch: [{ streamId: "s1", fps: 60, kbps, height: 1080, lostPct: 0, jitterMs: 1, freezes: 0, relay, protocol: "udp", rttMs: 10 }] });

test("chaque compte accumule ce qu'il envoie, ce qu'il reçoit et ce qui passe par le relais", () => {
  let now = START;
  const bandwidth = new Bandwidth(undefined, () => now);
  const hub = new Hub({ store: new MemoryStore(), iceServers: () => [], bandwidth, now: () => now });
  const pc = device(hub, "a", "Spoka");
  const viewer = device(hub, "b", "Pinoy");
  pc.send(publish([{ kbps: 8000, relay: true }, { kbps: 2000, relay: false }]));
  viewer.send(watch(8000, true));
  now += 10_000;
  pc.send(publish([{ kbps: 8000, relay: true }, { kbps: 2000, relay: false }]));
  viewer.send(watch(8000, true));
  const rows = hub.adminBandwidth(1);
  const spoka = rows.find(row => row.name === "Spoka")!;
  assert.equal(spoka.up, 200_000, "10 Mb/s pendant 20 s");
  assert.equal(spoka.relayUp, 160_000);
  assert.equal(spoka.live!.up, 10_000);
  const pinoy = rows.find(row => row.name === "Pinoy")!;
  assert.equal(pinoy.down, 160_000);
  assert.equal(pinoy.relayDown, 160_000);
  assert.equal(bandwidth.daily(1)[0]!.relay, 160_000, "le total ne compte un flux relayé qu'une fois");
  assert.equal(bandwidth.daily(1, pc.accountId)[0]!.relay, 160_000);
});

test("répéter ses relevés ne gonfle rien, et une longue absence ne compte pas", () => {
  let now = START;
  const bandwidth = new Bandwidth(undefined, () => now);
  const hub = new Hub({ store: new MemoryStore(), iceServers: () => [], bandwidth, now: () => now });
  const pc = device(hub, "a", "Spoka");
  pc.send(publish([{ kbps: 1000, relay: false }]));
  for (let i = 0; i < 50; i++) pc.send(publish([{ kbps: 1000, relay: false }]));
  assert.equal(bandwidth.totals(1)[0]!.up, 10_000, "seul le temps écoulé compte");
  now += 2 * HOUR;
  pc.send(publish([{ kbps: 1000, relay: false }]));
  assert.equal(bandwidth.totals(1)[0]!.up, 40_000, "30 s au plus entre deux relevés");
});

test("la courbe garde ses trous à zéro, et le point en cours n'a pas l'air d'une chute", () => {
  let now = START;
  const bandwidth = new Bandwidth(undefined, () => now);
  bandwidth.add("a", { up: 600_000, down: 0, relayUp: 0, relayDown: 0 });
  now += 60_000;
  const timeline = bandwidth.timeline("a");
  assert.equal(timeline.at.length, 288);
  assert.equal(timeline.up.at(-1), 10, "600 Mb en 60 s, pas sur 5 minutes pleines");
  assert.equal(timeline.up[100], 0);
});

test("les durées annoncées tiennent, même pour un compte parti depuis longtemps", () => {
  let now = START;
  const bandwidth = new Bandwidth(undefined, () => now);
  bandwidth.add("parti", { up: 1000, down: 0, relayUp: 0, relayDown: 0 });
  now += (POINTS_KEPT_HOURS + 1) * HOUR;
  bandwidth.flush();
  assert.equal(bandwidth.timeline("parti").up.some(Boolean), false);
  assert.equal(bandwidth.daily(30, "parti").reduce((total, day) => total + day.up, 0), 1000, "le total du jour reste");
  now += (DAYS_KEPT + 1) * 24 * HOUR;
  bandwidth.flush();
  assert.equal(bandwidth.totals(30).length, 0);
  assert.equal(bandwidth.daily(1, "parti")[0]!.up, 0);
});

test("un compte supprimé ne laisse rien, et l'historique se relit après un redémarrage", () => {
  const folder = mkdtempSync(path.join(tmpdir(), "spokastream-bandwidth-"));
  try {
    const file = path.join(folder, "bandwidth.json");
    const now = () => START;
    const bandwidth = new Bandwidth(file, now);
    const hub = new Hub({ store: new MemoryStore(), iceServers: () => [], bandwidth, now });
    const pc = device(hub, "a", "Spoka");
    bandwidth.add(pc.accountId, { up: 1000, down: 500, relayUp: 100, relayDown: 0 });
    bandwidth.add("reste", { up: 1000, down: 0, relayUp: 0, relayDown: 0 });
    bandwidth.flush();
    assert.equal(new Bandwidth(file, now).totals(1).length, 2);
    assert.equal(hub.adminDeleteAccount(pc.accountId, true), true);
    bandwidth.flush();
    assert.deepEqual(new Bandwidth(file, now).totals(1).map(row => row.id), ["reste"]);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test("un appareil qui rejoint un compte y apporte son historique", () => {
  const bandwidth = new Bandwidth(undefined, () => START);
  bandwidth.add("tel", { up: 1000, down: 0, relayUp: 0, relayDown: 0 });
  bandwidth.add("pc", { up: 500, down: 0, relayUp: 0, relayDown: 0 });
  bandwidth.merge("tel", "pc");
  assert.deepEqual(bandwidth.totals(1).map(row => [row.id, row.up]), [["pc", 1500]]);
});

test("l'alerte du relais tient 5 minutes et nomme le compte", () => {
  let now = START;
  const sent: string[] = [];
  const alerts = new Alerts({ rules: () => ({}), notify: text => sent.push(text), now: () => now });
  const context = (relayTopMbps: number) => ({ point: { netTx: 10 }, services: {}, certificateDays: 60, diskPct: 50, errors5min: 0, memMaxPct: 10, throttledPct: 0, relayMbps: relayTopMbps, relayTopMbps, relayTopName: "Spoka" });
  alerts.check(context(60));
  assert.equal(alerts.active.length, 0);
  now += 5 * 60_000;
  alerts.check(context(60));
  assert.deepEqual(alerts.active.map(alert => alert.rule), ["relayAccount"]);
  assert.match(sent[0]!, /Spoka/);
  assert.match(sent[0]!, /60 Mb\/s \(limite 50\)/);
  assert.ok(RULES.some(rule => rule.id === "network"), "la sortie réelle de la machine a aussi sa règle : elle ne dépend pas de ce que déclarent les applications");
});

test("la politique de confidentialité annonce les durées du code", () => {
  const page = privacyPage("");
  assert.ok(page.includes(`${POINTS_KEPT_HOURS} heures`));
  assert.ok(page.includes(`${DAYS_KEPT} jours`));
  assert.match(page, /bande passante/i);
});
