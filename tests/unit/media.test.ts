import assert from "node:assert/strict";
import { assembleClip, fragmentSpan, fragmentTimes, Mp4Splitter } from "../../src/renderer/src/engine/mp4.ts";
import { revealCandidates } from "../../src/renderer/src/engine/candidates.ts";
import { test } from "node:test";
import { DriftBuffer } from "../../src/renderer/src/engine/audio/driftBuffer.ts";
import { preferredOrder, rankResults } from "../../src/renderer/src/engine/encoders.ts";
import type { BenchResult } from "../../src/renderer/src/engine/encoders.ts";
import { NEGOTIATED_CEILING_KBPS, tuneOpusSdp, tuneVideoSdp } from "../../src/renderer/src/engine/sdp.ts";

const SDP = [
  "v=0", "o=- 1 2 IN IP4 127.0.0.1", "s=-", "t=0 0",
  "m=audio 9 UDP/TLS/RTP/SAVPF 111", "c=IN IP4 0.0.0.0", "a=rtpmap:111 opus/48000/2", "a=fmtp:111 minptime=10;useinbandfec=1",
  "m=video 9 UDP/TLS/RTP/SAVPF 96 97 98", "c=IN IP4 0.0.0.0", "a=rtpmap:96 H265/90000", "a=rtpmap:97 rtx/90000", "a=fmtp:97 apt=96",
  "a=rtpmap:98 AV1/90000", "a=fmtp:98 level-idx=5;profile=0;tier=0", "",
].join("\r\n");

test("le plafond vidéo est posé sur chaque codec, sans toucher à rtx ni au son", () => {
  const out = tuneVideoSdp(SDP, 6000);
  assert.match(out, /a=fmtp:98 level-idx=5;profile=0;tier=0;x-google-start-bitrate=6000;x-google-min-bitrate=800;x-google-max-bitrate=300000/);
  assert.match(out, /a=fmtp:96 x-google-start-bitrate=6000/);
  assert.match(out, /a=fmtp:97 apt=96\r\n/);
  assert.equal((out.match(/b=AS:/g) ?? []).length, 1);
  assert.match(out, new RegExp(`b=TIAS:${(NEGOTIATED_CEILING_KBPS + 1000) * 1000}`));
  assert.ok(out.endsWith("\r\n"));
  assert.match(out, /a=fmtp:111 minptime=10;useinbandfec=1\r\n/);
});

test("annoter deux fois ne double pas les bornes de débit", () => {
  const twice = tuneVideoSdp(tuneVideoSdp(SDP, 6000), 6000);
  assert.equal((twice.match(/b=AS:/g) ?? []).length, 1);
});

test("le son passe en stéréo haute qualité, les réglages existants sont gardés", () => {
  const out = tuneOpusSdp(SDP, { stereo: true, kbps: 320, dtx: false });
  const line = out.split("\r\n").find(l => l.startsWith("a=fmtp:111"))!;
  for (const part of ["minptime=10", "useinbandfec=1", "stereo=1", "sprop-stereo=1", "maxaveragebitrate=320000", "usedtx=0", "cbr=0"]) assert.ok(line.includes(part), part);
  assert.equal(line.match(/useinbandfec/g)?.length, 1);
});

test("un SDP sans Opus reste intact", () => {
  assert.equal(tuneOpusSdp("v=0\r\n", { stereo: true, kbps: 320, dtx: false }), "v=0\r\n");
});

const r = (mime: string, ok: boolean, hardware: boolean): BenchResult => ({ mime, label: mime, fps: 60, encMs: 5, width: 1920, height: 1080, targetKbps: 1, implementation: "", hardware, ok });

test("auto prend le codec le plus efficace qui tient la cadence, pas le plus rapide", () => {
  const order = preferredOrder([r("video/H264", true, true), r("video/H265", true, true), r("video/AV1", true, true)], "auto");
  assert.equal(order[0], "video/AV1");
});

test("un codec qui décroche passe derrière, comme AV1 en 4K60", () => {
  const order = preferredOrder([r("video/H264", true, true), r("video/H265", true, true), r("video/AV1", false, true)], "auto");
  assert.deepEqual(order.slice(0, 3), ["video/H265", "video/H264", "video/AV1"]);
});

test("un encodeur matériel passe devant un logiciel plus efficace : il ne prend rien au jeu", () => {
  assert.equal(rankResults([r("video/VP9", true, false), r("video/H264", true, true)])[0]?.mime, "video/H264");
});

test("un choix manuel passe devant, le reste sert de repli pour un spectateur qui ne le décode pas", () => {
  const order = preferredOrder([r("video/H264", true, true), r("video/AV1", true, true)], "video/H264");
  assert.equal(order[0], "video/H264");
  assert.equal(order[1], "video/AV1");
});

const QUANTUM = 128;

function blocks(buffer: DriftBuffer, count: number) {
  const left = new Float32Array(QUANTUM);
  const right = new Float32Array(QUANTUM);
  for (let i = 0; i < count; i++) buffer.pull([left, right]);
  return { left, right };
}

test("le tampon reste silencieux tant qu'il n'a pas de réserve, puis rend le son", () => {
  const buffer = new DriftBuffer(48000, 1920);
  const out = [new Float32Array(QUANTUM), new Float32Array(QUANTUM)];
  buffer.push(new Float32Array(960).fill(0.5));
  assert.equal(buffer.pull(out), false);
  buffer.push(new Float32Array(4000).fill(0.5));
  assert.equal(buffer.pull(out), true);
  assert.ok(Math.abs(out[0]![10]! - 0.5) < 1e-6);
});

test("droite et gauche ne se mélangent pas", () => {
  const buffer = new DriftBuffer(48000, 480);
  const samples = new Float32Array(2000);
  for (let i = 0; i < samples.length; i += 2) {
    samples[i] = 0.25;
    samples[i + 1] = -0.75;
  }
  buffer.push(samples);
  const { left, right } = blocks(buffer, 1);
  assert.ok(Math.abs(left[50]! - 0.25) < 1e-6);
  assert.ok(Math.abs(right[50]! + 0.75) < 1e-6);
});

test("une carte son 0,2 % trop rapide ne fait pas monter la latence", () => {
  const target = 1920;
  const buffer = new DriftBuffer(48000, target);
  const packet = new Float32Array(480 * 2);
  const sourceRate = 48096;
  let produced = 0;
  let consumed = 0;
  for (let second = 0; second < 240; second++) {
    for (let i = 0; i < 375; i++) {
      consumed += QUANTUM;
      while (produced * 48000 < consumed * sourceRate) {
        buffer.push(packet);
        produced += 480;
      }
      blocks(buffer, 1);
    }
  }
  assert.ok(buffer.available < target * 1.8, `réserve finale ${buffer.available}`);
  assert.ok(buffer.isPrimed);
});

test("une carte son 0,2 % trop lente ne provoque pas de coupures", () => {
  const target = 1920;
  const buffer = new DriftBuffer(48000, target);
  const packet = new Float32Array(480 * 2);
  const sourceRate = 47904;
  let produced = 0;
  let consumed = 0;
  let cuts = 0;
  for (let second = 0; second < 240; second++) {
    for (let i = 0; i < 375; i++) {
      consumed += QUANTUM;
      while (produced * 48000 < consumed * sourceRate) {
        buffer.push(packet);
        produced += 480;
      }
      const wasPrimed = buffer.isPrimed;
      blocks(buffer, 1);
      if (wasPrimed && !buffer.isPrimed) cuts++;
    }
  }
  assert.equal(cuts, 0);
});

test("après une grosse surcharge, le retard est rattrapé d'un coup", () => {
  const target = 1920;
  const buffer = new DriftBuffer(48000, target);
  buffer.push(new Float32Array(20_000 * 2));
  assert.equal(buffer.available, target);
});

test("quand le son s'arrête, le tampon se tait proprement puis repart", () => {
  const buffer = new DriftBuffer(48000, 480);
  buffer.push(new Float32Array(960).fill(0.5));
  const out = [new Float32Array(QUANTUM), new Float32Array(QUANTUM)];
  for (let i = 0; i < 8; i++) buffer.pull(out);
  assert.equal(out[0]![QUANTUM - 1], 0);
  assert.equal(buffer.isPrimed, false);
  buffer.push(new Float32Array(960).fill(0.5));
  assert.equal(buffer.isPrimed, true);
});

// Un MP4 fragmenté réduit au strict nécessaire : la piste 1 compte à 48 kHz, la piste 2 à 30 kHz.
function box(type: string, ...parts: Uint8Array[]) {
  const size = 8 + parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(size);
  new DataView(out.buffer).setUint32(0, size);
  out.set(new TextEncoder().encode(type), 4);
  let offset = 8;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}
const u32 = (...values: number[]) => {
  const out = new Uint8Array(values.length * 4);
  values.forEach((v, i) => new DataView(out.buffer).setUint32(i * 4, v));
  return out;
};
const u64 = (value: number) => {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, BigInt(value));
  return out;
};
function trak(id: number, scale: number) {
  return box("trak", box("tkhd", u32(0, 0, 0, id)), box("mdia", box("mdhd", u32(0, 0, 0, scale))));
}
function moof(sequence: number, audio: number, video: number) {
  const traf = (track: number, time: number) => box("traf", box("tfhd", u32(0, track)), box("tfdt", u32(0x01000000), u64(time)));
  return box("moof", box("mfhd", u32(0, sequence)), traf(1, audio), traf(2, video));
}
const concat = (...parts: Uint8Array[]) => Uint8Array.from(parts.flatMap(p => [...p]));
const HEADER = concat(box("ftyp", u32(1)), box("moov", trak(1, 48_000), trak(2, 30_000)));
const fragment = (index: number) => concat(moof(index + 1, index * 48_000, index * 30_000), box("mdat", u32(index)));

test("le flux MP4 se découpe en fragments, quelle que soit la taille des morceaux", () => {
  const stream = concat(HEADER, fragment(0), fragment(1), fragment(2));
  for (const size of [1, 7, 64, stream.length]) {
    const splitter = new Mp4Splitter();
    const fragments = [];
    for (let i = 0; i < stream.length; i += size) fragments.push(...splitter.push(stream.subarray(i, i + size), i));
    assert.deepEqual(splitter.header, HEADER, `morceaux de ${size} octets`);
    assert.equal(fragments.length, 3);
    assert.deepEqual(fragments[1]!.bytes, fragment(1));
  }
});

test("un clip repart de zéro en gardant l'image et le son alignés", () => {
  const splitter = new Mp4Splitter();
  const all = splitter.push(concat(HEADER, fragment(10), fragment(11), fragment(12)), 0);
  assert.equal(fragmentSpan(HEADER, all), 2);
  const clip = assembleClip(HEADER, all.slice(1));
  const again = new Mp4Splitter();
  const kept = again.push(clip, 0);
  assert.deepEqual(again.header, HEADER);
  assert.equal(kept.length, 2);
  const view = new DataView(kept[1]!.bytes.buffer, kept[1]!.bytes.byteOffset);
  // mfhd : numéro de séquence ; puis pour chaque piste, le temps de début.
  assert.equal(view.getUint32(20), 2);
  const tfdtOf = (track: number) => Number(view.getBigUint64(24 + 8 + 16 + 12 + (track - 1) * 44));
  assert.equal(tfdtOf(1), 48_000);
  assert.equal(tfdtOf(2), 30_000);
});

test("on sait où couper un clip, et une partie du milieu repart de zéro", () => {
  const splitter = new Mp4Splitter();
  const fragments = [0, 1, 2, 3].flatMap(index => splitter.push(fragment(index), index));
  splitter.push(HEADER, 0);
  assert.deepEqual(fragmentTimes(HEADER, fragments), [0, 1, 2, 3]);
  const middle = assembleClip(HEADER, fragments.slice(1, 3));
  const again = new Mp4Splitter();
  const parts = again.push(middle, 0);
  assert.equal(parts.length, 2);
  assert.deepEqual(fragmentTimes(HEADER, parts), [0, 1]);
});

test("une piste sans temps valable ne décale pas tout le clip", () => {
  // Le début du clip tombe à 22 s d'enregistrement, et une piste y porte encore un temps de 0 : c'est ainsi qu'un clip de 30 s a annoncé 52 s.
  const at = (second: number, audio = second * 48_000) => concat(moof(second + 1, audio, second * 30_000), box("mdat", u32(second)));
  const splitter = new Mp4Splitter();
  const fragments = splitter.push(concat(HEADER, at(22, 0), at(23), at(24)), 0);
  assert.equal(fragmentSpan(HEADER, fragments), 2);
  assert.deepEqual(fragmentTimes(HEADER, fragments), [0, 1, 2]);
  const again = new Mp4Splitter();
  const parts = again.push(assembleClip(HEADER, fragments), 0);
  const video = (bytes: Uint8Array) => Number(new DataView(bytes.buffer, bytes.byteOffset).getBigUint64(24 + 8 + 16 + 12 + 44));
  assert.deepEqual(parts.map(part => video(part.bytes)), [0, 30_000, 60_000], "l'image repart de zéro");
  assert.deepEqual(fragmentTimes(HEADER, parts), [0, 1, 2]);
});

test("un vrai décalage entre l'image et le son reste dans le clip", () => {
  const splitter = new Mp4Splitter();
  const fragments = splitter.push(concat(HEADER, concat(moof(1, 10_000 * 48, 10_500 * 30), box("mdat", u32(0)))), 0);
  const [part] = new Mp4Splitter().push(assembleClip(HEADER, fragments), 0);
  const view = new DataView(part!.bytes.buffer, part!.bytes.byteOffset);
  assert.equal(Number(view.getBigUint64(24 + 8 + 16 + 12)), 0, "le son part de zéro");
  assert.equal(Number(view.getBigUint64(24 + 8 + 16 + 12 + 44)), 15_000, "l'image garde ses 500 ms de retard");
});

test("la réponse à OBS remplace les noms masqués par les adresses de ce PC", () => {
  const sdp = "a=mid:0\r\na=candidate:1 1 udp 2122260223 4f2a-11.local 54000 typ host generation 0\r\na=end-of-candidates\r\n";
  const answer = revealCandidates(sdp, ["192.168.1.20", "10.0.0.4"]);
  assert.ok(!answer.includes(".local"));
  assert.match(answer, /udp 2122260223 192\.168\.1\.20 54000 typ host/);
  assert.match(answer, /udp 2122260223 10\.0\.0\.4 54000 typ host/);
  assert.match(answer, /a=end-of-candidates/);
});
