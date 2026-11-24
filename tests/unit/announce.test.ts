import assert from "node:assert/strict";
import { test } from "node:test";
import { ANNOUNCE_DELAY_MS, LiveAnnouncer } from "../../server/announce.ts";
import { ConfigStore } from "../../server/config.ts";
import { Hub } from "../../server/hub.ts";
import { MemoryStore } from "../../server/store.ts";
import type { ServerMessage } from "../../src/shared/protocol.ts";
import { PROTOCOL_VERSION } from "../../src/shared/protocol.ts";

const WEBHOOK = "https://discord.com/api/webhooks/1/abc";
const stream = { title: "", kind: "screen", width: 1920, height: 1080, fps: 60, allowDraw: false, allowControl: false, maxViewers: 0, sourceName: "Essai" };

function rig() {
  let now = 1_000_000;
  const calls: { method: string; url: string; content: string; mentions: unknown }[] = [];
  const timers: (() => void)[] = [];
  const fakeFetch = (async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    calls.push({ method: init.method!, url, content: body.content, mentions: body.allowed_mentions });
    return new Response(JSON.stringify({ id: `m${calls.length}` }), { status: 200 });
  }) as typeof fetch;
  const config = new ConfigStore();
  config.update({ liveWebhook: WEBHOOK, publicHost: "stream.exemple.fr" });
  const announcer = new LiveAnnouncer({ webhook: () => config.value.liveWebhook, fetch: fakeFetch, now: () => now, schedule: run => timers.push(run) - 1, cancel: handle => (timers[handle as number] = () => {}) });
  const hub = new Hub({ store: new MemoryStore(), iceServers: () => [], config, announcer, now: () => now });
  now += 120_000;
  const received: ServerMessage[] = [];
  const conn = hub.connect({ ip: "203.0.113.7", send: d => received.push(JSON.parse(d)), close: () => {} });
  let rid = 0;
  const request = (message: Record<string, unknown>) => {
    const id = ++rid;
    hub.handle(conn, JSON.stringify({ ...message, rid: id }));
    return received.find(m => m.t === "ack" && m.rid === id) as Extract<ServerMessage, { t: "ack" }>;
  };
  hub.handle(conn, JSON.stringify({ t: "hello", protocol: PROTOCOL_VERSION, token: "a".repeat(64), profile: { name: "*Spoka*", color: "#7c5cff", avatar: null } }));
  const { code } = request({ t: "room.create", name: "Soirée" }).data as { code: string };
  const flush = () => new Promise(resolve => setTimeout(resolve, 0));
  const runTimers = async () => {
    timers.splice(0).forEach(run => run());
    await flush();
  };
  return { calls, received, request, code, config, runTimers, flush, advance: (ms: number) => (now += ms) };
}

test("le serveur dit à l'appli qu'il annonce les directs", () => {
  const { received } = rig();
  assert.equal((received.find(m => m.t === "welcome") as Extract<ServerMessage, { t: "welcome" }>).liveAnnounce, true);
});

test("un direct est annoncé après 30 s avec le lien, puis le message devient « a diffusé » à la fin", async () => {
  const { calls, request, code, runTimers, flush, advance } = rig();
  request({ t: "stream.start", id: "s1", stream: { ...stream, title: "Zomboid @everyone" }, discord: true });
  assert.equal(calls.length, 0, `rien avant ${ANNOUNCE_DELAY_MS / 1000} s`);
  await runTimers();
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.method, "POST");
  assert.match(calls[0]!.url, /\?wait=true$/);
  assert.match(calls[0]!.content, new RegExp(`https://stream\\.exemple\\.fr/j/${code}`));
  assert.match(calls[0]!.content, /\\\*Spoka\\\*/, "un pseudo ne met pas le message en forme");
  assert.deepEqual(calls[0]!.mentions, { parse: [] }, "@everyone dans un titre ne prévient personne");
  advance(25 * 60_000);
  request({ t: "stream.stop" });
  await flush();
  assert.equal(calls[1]!.method, "PATCH");
  assert.match(calls[1]!.url, /\/messages\/m1$/);
  assert.match(calls[1]!.content, /a diffusé 25 min/);
});

test("un essai de quelques secondes ne prévient personne", async () => {
  const { calls, request, runTimers } = rig();
  request({ t: "stream.start", id: "s1", stream, discord: true });
  request({ t: "stream.stop" });
  await runTimers();
  assert.equal(calls.length, 0);
});

test("relancer son direct peu après reprend le même message au lieu d'en poster un autre", async () => {
  const { calls, request, runTimers, flush, advance } = rig();
  request({ t: "stream.start", id: "s1", stream, discord: true });
  await runTimers();
  request({ t: "stream.stop" });
  await flush();
  advance(2 * 60_000);
  request({ t: "stream.start", id: "s2", stream, discord: true });
  await runTimers();
  assert.deepEqual(calls.map(call => call.method), ["POST", "PATCH", "PATCH"]);
  assert.match(calls[2]!.content, /est en direct/);
});

test("ni salon verrouillé, ni direct décoché, ni serveur sans webhook", async () => {
  const locked = rig();
  locked.request({ t: "room.update", settings: { locked: true } });
  locked.request({ t: "stream.start", id: "s1", stream, discord: true });
  await locked.runTimers();
  assert.equal(locked.calls.length, 0, "un salon verrouillé reste privé");
  const unchecked = rig();
  unchecked.request({ t: "stream.start", id: "s1", stream, discord: false });
  await unchecked.runTimers();
  assert.equal(unchecked.calls.length, 0);
  const off = rig();
  off.config.update({ liveWebhook: "" });
  off.request({ t: "stream.start", id: "s1", stream, discord: true });
  await off.runTimers();
  assert.equal(off.calls.length, 0);
});

test("un stream renvoyé après une coupure du serveur, ou par une ancienne version, n'est pas annoncé", async () => {
  const { calls, request, runTimers } = rig();
  request({ t: "stream.start", id: "s1", stream });
  await runTimers();
  assert.equal(calls.length, 0);
});
