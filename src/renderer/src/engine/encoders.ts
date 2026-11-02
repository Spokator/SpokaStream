import type { CodecChoice } from "@shared/ipc.ts";
import { tuneVideoSdp } from "./sdp.ts";

export interface BenchResult {
  mime: string;
  label: string;
  fps: number;
  encMs: number | null;
  width: number;
  height: number;
  targetKbps: number;
  implementation: string;
  hardware: boolean;
  ok: boolean;
  error?: string;
}

const CACHE_VERSION = 2;
const CACHE_MS = 14 * 24 * 3600 * 1000;
const BENCH_MS = 2400;
const VIDEO_MIME = /^video\/(H264|H265|VP8|VP9|AV1)$/;

/**
 * À débit égal, de la meilleure image à la moins bonne. AV1 passerait devant, mais son encodage matériel a réinitialisé
 * le pilote NVIDIA en plein direct (voir ARCHITECTURE) : en automatique il passe après, et il reste au choix de la personne.
 */
const EFFICIENCY: Record<string, number> = { "video/H265": 0, "video/H264": 1, "video/AV1": 2, "video/VP9": 3, "video/VP8": 4 };

const cacheKey = (height: number, fps: number) => `bench:${CACHE_VERSION}:${height}p${fps}`;

const isHardware = (implementation: string, powerEfficient: boolean | undefined) =>
  powerEfficient === true || /external|hardware|mediafoundation|nvenc|qsv|amf|d3d/i.test(implementation);

/** Une mesure vaut pour toute une classe de définitions : inutile de la refaire à chaque taille de fenêtre. */
export const benchClass = (height: number) => [720, 1080, 1440, 2160].find(c => c >= height) ?? 2160;

export function h264Profile(fmtp: string | undefined) {
  return ({ "64": "High", "4d": "Main", "42": "Baseline" } as Record<string, string>)[fmtp?.match(/profile-level-id=([0-9a-f]{2})/i)?.[1]?.toLowerCase() ?? ""] ?? "";
}

export function rankResults(results: BenchResult[]) {
  const score = (r: BenchResult) => (r.ok ? 0 : 1000) + (r.hardware ? 0 : 100) + (EFFICIENCY[r.mime] ?? 9);
  return [...results].sort((a, b) => score(a) - score(b));
}

/** Le meilleur codec est le plus efficace qui tient la cadence, pas le plus rapide : l'image y gagne beaucoup à débit égal. */
export function preferredOrder(results: BenchResult[], choice: CodecChoice) {
  const ranked = rankResults(results).map(r => r.mime);
  const known = Object.keys(EFFICIENCY).filter(m => !ranked.includes(m));
  const order = [...ranked, ...known];
  if (choice === "auto") return order;
  return [choice, ...order.filter(m => m !== choice)];
}

export function codecPreferences(results: BenchResult[], choice: CodecChoice) {
  const capabilities = RTCRtpSender.getCapabilities("video")?.codecs ?? [];
  const order = preferredOrder(results, choice);
  const h264Order = (c: RTCRtpCodec) => ({ High: 0, Main: 1, Baseline: 2 } as Record<string, number>)[h264Profile(c.sdpFmtpLine)] ?? 3;
  const video = capabilities
    .filter(c => VIDEO_MIME.test(c.mimeType))
    .sort((a, b) => order.indexOf(a.mimeType) - order.indexOf(b.mimeType) || h264Order(a) - h264Order(b));
  return [...video, ...capabilities.filter(c => !VIDEO_MIME.test(c.mimeType))];
}

function candidates() {
  const caps = RTCRtpSender.getCapabilities("video")?.codecs ?? [];
  const h264 = caps.filter(c => c.mimeType === "video/H264" && /packetization-mode=1/.test(c.sdpFmtpLine ?? ""));
  const best = h264.find(c => h264Profile(c.sdpFmtpLine) === "High") ?? h264.find(c => h264Profile(c.sdpFmtpLine) === "Main") ?? h264[0];
  return [
    caps.find(c => c.mimeType === "video/AV1"),
    caps.find(c => c.mimeType === "video/H265"),
    best,
    caps.find(c => c.mimeType === "video/VP9" && /profile-id=0/.test(c.sdpFmtpLine ?? "")),
  ].filter((c): c is RTCRtpCodec => !!c);
}

async function benchOne(codec: RTCRtpCodec, track: MediaStreamTrack, fps: number, kbps: number): Promise<Partial<BenchResult>> {
  const a = new RTCPeerConnection();
  const b = new RTCPeerConnection();
  try {
    a.onicecandidate = e => e.candidate && void b.addIceCandidate(e.candidate).catch(() => {});
    b.onicecandidate = e => e.candidate && void a.addIceCandidate(e.candidate).catch(() => {});
    const sender = a.addTrack(track);
    const all = RTCRtpSender.getCapabilities("video")?.codecs ?? [];
    a.getTransceivers()[0]!.setCodecPreferences([codec, ...all.filter(c => !VIDEO_MIME.test(c.mimeType))]);
    const parameters = sender.getParameters();
    parameters.encodings = [{ maxBitrate: kbps * 1000, maxFramerate: fps }];
    await sender.setParameters(parameters);
    const offer = await a.createOffer();
    await a.setLocalDescription(offer);
    await b.setRemoteDescription(offer);
    const answer = await b.createAnswer();
    await b.setLocalDescription(answer);
    await a.setRemoteDescription({ type: "answer", sdp: tuneVideoSdp(answer.sdp!, kbps * 0.8) });
    await new Promise(r => setTimeout(r, BENCH_MS));
    let result: Partial<BenchResult> = {};
    (await a.getStats()).forEach((r: RTCOutboundRtpStreamStats & Record<string, never>) => {
      if (r.type !== "outbound-rtp" || r.kind !== "video") return;
      const implementation = String(r.encoderImplementation ?? "");
      result = {
        fps: Number(r.framesPerSecond ?? 0),
        encMs: r.framesEncoded ? +((Number(r.totalEncodeTime) / r.framesEncoded) * 1000).toFixed(1) : null,
        width: Number(r.frameWidth ?? 0),
        height: Number(r.frameHeight ?? 0),
        targetKbps: Math.round(Number(r.targetBitrate ?? 0) / 1000),
        implementation,
        hardware: isHardware(implementation, r.powerEfficientEncoder as unknown as boolean | undefined),
      };
    });
    return result;
  } catch (e) {
    return { error: (e as Error).message };
  } finally {
    a.close();
    b.close();
  }
}

export function cachedBench(height: number, fps: number): BenchResult[] | null {
  try {
    const cached = JSON.parse(localStorage.getItem(cacheKey(height, fps)) ?? "null") as { at: number; results: BenchResult[] } | null;
    if (cached && Date.now() - cached.at < CACHE_MS) return cached.results;
  } catch {
    // Cache illisible : on refait la mesure.
  }
  return null;
}

let running: Promise<BenchResult[]> | null = null;

/**
 * Mesure réelle des encodeurs : boucle locale de 2 s par codec, à la définition et la cadence visées.
 * Chromium ne dit si un encodeur est matériel que pendant une capture : on en garde donc une ouverte à côté.
 */
export function measureEncoders(sourceId: string | null, width: number, height: number, fps: number, kbps: number, onProgress?: (label: string) => void) {
  running ??= (async () => {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d")!;
    let frame = 0;
    const paint = setInterval(() => {
      for (let i = 0; i < 60; i++) {
        ctx.fillStyle = `hsl(${(frame * 7 + i * 23) % 360},70%,50%)`;
        ctx.fillRect((i * 97 + frame * 17) % width, (i * 53 + frame * 11) % height, width / 7, height / 6);
      }
      frame++;
    }, 1000 / fps);
    const stream = canvas.captureStream(fps);
    const track = stream.getVideoTracks()[0]!;
    track.contentHint = "motion";
    const unlock = sourceId
      ? await navigator.mediaDevices
          .getUserMedia({ audio: false, video: { mandatory: { chromeMediaSource: "desktop", chromeMediaSourceId: sourceId, maxWidth: 320, maxHeight: 180, maxFrameRate: 5 } } as MediaTrackConstraints })
          .catch(() => null)
      : null;
    const results: BenchResult[] = [];
    try {
      for (const codec of candidates()) {
        const label = codec.mimeType.replace("video/", "");
        onProgress?.(label);
        const r = await benchOne(codec, track, fps, Math.min(kbps, 50_000));
        // On juge le coût par image, pas la cadence atteinte : c'est souvent la scène de test qui plafonne, pas l'encodeur.
        const ok = !r.error && (r.fps ?? 0) >= fps * 0.6 && (r.width ?? 0) >= width * 0.9 && (r.encMs ?? 999) <= (1000 / fps) * 0.8;
        results.push({ mime: codec.mimeType, label, fps: 0, encMs: null, width: 0, height: 0, targetKbps: 0, implementation: "", hardware: false, ...r, ok });
      }
    } finally {
      clearInterval(paint);
      track.stop();
      unlock?.getTracks().forEach(t => t.stop());
    }
    if (results.some(r => r.fps > 0)) {
      try {
        localStorage.setItem(cacheKey(height, fps), JSON.stringify({ at: Date.now(), results }));
      } catch {
        // Stockage plein : la mesure reste valable pour cette fois.
      }
    }
    return results;
  })().finally(() => (running = null));
  return running;
}
