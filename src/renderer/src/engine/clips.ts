import { assembleClip, fragmentSpan, Mp4Splitter } from "./mp4.ts";
import type { Fragment } from "./mp4.ts";

// avc3 : la définition voyage avec les images. avc1 casse dès qu'une fenêtre change de taille.
const FORMAT = "video/mp4;codecs=avc3,mp4a.40.2";
const FRAGMENT_MS = 1000;
const MAX_CLIP_KBPS = 12_000;

/** Les dernières secondes, en mémoire, prêtes à devenir un fichier MP4 que Discord et tous les lecteurs acceptent. */
export class ClipBuffer {
  private recorder: MediaRecorder | null = null;
  private readonly splitter = new Mp4Splitter();
  private fragments: Fragment[] = [];
  private waiters: (() => void)[] = [];
  private readonly seconds: number;
  private queue: Promise<void> = Promise.resolve();
  lastSeconds = 0;

  constructor(seconds: number) {
    this.seconds = seconds;
  }

  static get supported() {
    return typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(FORMAT);
  }

  /** Sans encodeur matériel, un flux de plus en permanence ralentirait le stream ou le jeu. */
  static async hasHardwareEncoder() {
    // mediaCapabilities répond « pas efficace » même avec NVENC : seul WebCodecs interroge vraiment le matériel.
    const info = await VideoEncoder.isConfigSupported({ codec: "avc1.640028", width: 1920, height: 1080, bitrate: 8_000_000, framerate: 60, hardwareAcceleration: "prefer-hardware" }).catch(() => null);
    return info?.supported === true;
  }

  get bufferedSeconds() {
    return this.splitter.header ? fragmentSpan(this.splitter.header, this.fragments) : 0;
  }

  start(stream: MediaStream, kbps: number) {
    this.recorder = new MediaRecorder(stream, {
      mimeType: FORMAT,
      videoBitsPerSecond: Math.max(4000, Math.min(MAX_CLIP_KBPS, kbps)) * 1000,
      audioBitsPerSecond: 192_000,
      // Un fragment par image clé : c'est lui qui fixe la précision de la coupe.
      videoKeyFrameIntervalDuration: FRAGMENT_MS,
    } as MediaRecorderOptions);
    this.recorder.ondataavailable = event => {
      if (!event.data.size) return;
      this.queue = this.queue.then(async () => this.accept(new Uint8Array(await event.data.arrayBuffer())));
    };
    this.recorder.start(250);
  }

  private accept(chunk: Uint8Array) {
    const now = performance.now();
    const fresh = this.splitter.push(chunk, now);
    if (!fresh.length) return;
    this.fragments.push(...fresh);
    const oldest = now - (this.seconds + 2) * 1000;
    while (this.fragments.length > 1 && this.fragments[1]!.at < oldest) this.fragments.shift();
    for (const wake of this.waiters.splice(0)) wake();
  }

  /** Attend le fragment en cours : le clip doit contenir l'instant où on a appuyé. */
  async save(): Promise<Uint8Array | null> {
    await Promise.race([new Promise<void>(resolve => this.waiters.push(resolve)), new Promise(resolve => setTimeout(resolve, FRAGMENT_MS * 2))]);
    const header = this.splitter.header;
    if (!header || !this.fragments.length) return null;
    const newest = this.fragments[this.fragments.length - 1]!.at;
    const kept = this.fragments.filter(f => f.at >= newest - this.seconds * 1000);
    this.lastSeconds = fragmentSpan(header, kept) + FRAGMENT_MS / 1000;
    return assembleClip(header, kept);
  }

  stop() {
    const recorder = this.recorder;
    this.recorder = null;
    if (recorder && recorder.state !== "inactive") recorder.stop();
    for (const wake of this.waiters.splice(0)) wake();
  }
}
