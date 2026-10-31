import assert from "node:assert/strict";
import { createDecipheriv, createECDH, hkdfSync, randomBytes } from "node:crypto";
import { test } from "node:test";
import { encryptPush, PushService } from "../../server/push.ts";
import { isHls, titleFromUrl, videoUrl, youtubeId } from "../../src/shared/protocol.ts";

test("une adresse de vidéo : http ou https, jamais autre chose", () => {
  assert.equal(videoUrl("https://exemple.fr/film.mp4"), "https://exemple.fr/film.mp4");
  assert.equal(videoUrl("  http://exemple.fr/a b.webm "), "http://exemple.fr/a%20b.webm");
  assert.equal(videoUrl("javascript:alert(1)"), null);
  assert.equal(videoUrl("file:///C:/film.mp4"), null);
  assert.equal(videoUrl("https://moi:secret@exemple.fr/film.mp4"), null);
  assert.equal(videoUrl(`https://exemple.fr/${"a".repeat(3000)}`), null);
  assert.equal(videoUrl(12), null);
});

test("HLS et titres", () => {
  assert.equal(isHls("https://x.fr/live/index.m3u8?token=1"), true);
  assert.equal(isHls("https://x.fr/film.mp4"), false);
  assert.equal(titleFromUrl("https://x.fr/films/Le.Grand_Film.2024.mp4"), "Le Grand Film 2024");
  assert.equal(titleFromUrl("https://x.fr/"), "x.fr");
});

test("un lien YouTube reste reconnu avant tout le reste", () => {
  assert.equal(youtubeId("https://youtu.be/aqz-KE-bpKQ?t=3"), "aqz-KE-bpKQ");
  assert.equal(youtubeId("https://exemple.fr/film.mp4"), null);
});

/** Le déchiffrement côté téléphone, écrit à part : si les deux côtés se comprennent, le format est le bon. */
function decrypt(body: Buffer, receiver: ReturnType<typeof createECDH>, auth: Buffer) {
  const salt = body.subarray(0, 16);
  const length = body[20]!;
  const sender = body.subarray(21, 21 + length);
  const sealed = body.subarray(21 + length);
  const shared = receiver.computeSecret(sender);
  const info = Buffer.concat([Buffer.from("WebPush: info\0"), receiver.getPublicKey(), sender]);
  const ikm = Buffer.from(hkdfSync("sha256", shared, auth, info, 32));
  const key = Buffer.from(hkdfSync("sha256", ikm, salt, "Content-Encoding: aes128gcm\0", 16));
  const nonce = Buffer.from(hkdfSync("sha256", ikm, salt, "Content-Encoding: nonce\0", 12));
  const decipher = createDecipheriv("aes-128-gcm", key, nonce);
  decipher.setAuthTag(sealed.subarray(-16));
  const plain = Buffer.concat([decipher.update(sealed.subarray(0, -16)), decipher.final()]);
  assert.equal(plain.at(-1), 2, "marque de fin du dernier bloc");
  return plain.subarray(0, -1).toString();
}

test("une notification ne se lit qu'avec les clés du téléphone", () => {
  const phone = createECDH("prime256v1");
  phone.generateKeys();
  const auth = randomBytes(16);
  const body = encryptPush(Buffer.from("Pinoy est en direct"), phone.getPublicKey().toString("base64url"), auth.toString("base64url"));
  assert.equal(decrypt(body, phone, auth), "Pinoy est en direct");
  assert.throws(() => decrypt(body, phone, randomBytes(16)));
});

test("le serveur ne pousse que vers les services de push des navigateurs", () => {
  const service = new PushService();
  const record = { p256dh: "a", auth: "b", userId: "u", rooms: ["r"] };
  assert.equal(service.subscribe({ ...record, endpoint: "https://fcm.googleapis.com/fcm/send/abc" }), true);
  assert.equal(service.subscribe({ ...record, endpoint: "https://web.push.apple.com/abc" }), true);
  assert.equal(service.subscribe({ ...record, endpoint: "https://169.254.169.254/latest" }), false);
  assert.equal(service.subscribe({ ...record, endpoint: "https://evil.example/googleapis.com" }), false);
  assert.equal(service.subscribe({ ...record, endpoint: "pas une adresse" }), false);
});

test("un téléphone abonné est prévenu une fois, pas ceux déjà dans le salon", async () => {
  const phone = createECDH("prime256v1");
  phone.generateKeys();
  const auth = randomBytes(16);
  const received: { url: string; headers: Record<string, string>; body: Buffer }[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    received.push({ url, headers: init.headers as Record<string, string>, body: init.body as Buffer });
    return new Response(null, { status: 201 });
  }) as typeof fetch;
  try {
    const service = new PushService({ allowHost: () => true });
    const keys = { p256dh: phone.getPublicKey().toString("base64url"), auth: auth.toString("base64url"), rooms: ["salon"] };
    service.subscribe({ ...keys, endpoint: "https://push.test/absent", userId: "absent" });
    service.subscribe({ ...keys, endpoint: "https://push.test/present", userId: "present" });
    const message = { title: "Pinoy est en direct", body: "Soirée", url: "/w/ABCD", tag: "salon" };
    assert.equal(await service.notify("salon", new Set(["present"]), "live:pinoy", message, 1000), 1);
    assert.equal(received[0]!.url, "https://push.test/absent");
    assert.match(received[0]!.headers.authorization!, /^vapid t=.+, k=/);
    assert.deepEqual(JSON.parse(decrypt(received[0]!.body, phone, auth)), message);
    assert.equal(await service.notify("salon", new Set(), "live:pinoy", message, 2000), 0, "le même événement ne repart pas tout de suite");
    assert.equal(await service.notify("autre", new Set(), "live:pinoy", message, 2000), 0);
  } finally {
    globalThis.fetch = realFetch;
  }
});
