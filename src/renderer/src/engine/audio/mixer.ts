import workletUrl from "./capture.worklet.ts?worker&url";

export type MixSourceKind = "capture" | "device" | "media";

export interface MixSource {
  id: string;
  kind: MixSourceKind;
  label: string;
  icon: string | null;
  volume: number;
  muted: boolean;
  /** Retard ajouté, pour recaler un son en avance sur l'image. */
  offsetMs: number;
  /** Ce son baisse tout seul quand tu parles. */
  duck: boolean;
}

interface LiveSource extends MixSource {
  gain: GainNode;
  delay: DelayNode;
  ducker: GainNode;
  analyser: AnalyserNode;
  dispose(): void;
}

const MAX_OFFSET_SECONDS = 2;
const DUCK_GAIN = 0.25;
const DUCK_INTERVAL_MS = 50;
const DUCK_HOLD_MS = 500;
const TALK_LEVEL = 0.02;

const ports = new Map<number, MessagePort>();
const waiters = new Map<number, (port: MessagePort) => void>();

window.addEventListener("message", event => {
  const data = event.data as { type?: string; captureId?: number } | null;
  if (data?.type !== "spoka-audio-port" || data.captureId === undefined || !event.ports[0]) return;
  const waiter = waiters.get(data.captureId);
  if (waiter) {
    waiters.delete(data.captureId);
    waiter(event.ports[0]);
  } else ports.set(data.captureId, event.ports[0]);
});

function portFor(captureId: number) {
  const port = ports.get(captureId);
  if (port) {
    ports.delete(captureId);
    return Promise.resolve(port);
  }
  return new Promise<MessagePort>(resolve => waiters.set(captureId, resolve));
}

export const levelOf = (analyser: AnalyserNode, buffer: Float32Array<ArrayBuffer>) => {
  analyser.getFloatTimeDomainData(buffer);
  let sum = 0;
  for (const x of buffer) sum += x * x;
  const db = 20 * Math.log10(Math.sqrt(sum / buffer.length) + 1e-6);
  return Math.max(0, Math.min(1, (db + 60) / 60));
};

function rmsOf(analyser: AnalyserNode, buffer: Float32Array<ArrayBuffer>) {
  analyser.getFloatTimeDomainData(buffer);
  let sum = 0;
  for (const x of buffer) sum += x * x;
  return Math.sqrt(sum / buffer.length);
}

/** Table de mixage du stream : applications, entrées et fichier, avec un volume chacun, puis un limiteur. */
export class StreamMixer {
  readonly context = new AudioContext({ sampleRate: 48000, latencyHint: "interactive" });
  private readonly destination = this.context.createMediaStreamDestination();
  private readonly bus = this.context.createGain();
  private readonly normalizer = this.context.createGain();
  private readonly limiter = this.context.createDynamicsCompressor();
  private readonly masterMeter = this.context.createAnalyser();
  private readonly preMeter = this.context.createAnalyser();
  private readonly sources = new Map<string, LiveSource>();
  private readonly buffer = new Float32Array(1024);
  private workletReady: Promise<void> | null = null;
  private nextId = 1;
  private normalizeTimer: ReturnType<typeof setInterval> | null = null;
  private pausedGain = 1;
  private duckTimer: ReturnType<typeof setInterval> | null = null;
  private duckUntil = 0;
  /** Le niveau de la voix hors de cette table : le vocal du salon. */
  talkLevel: () => number = () => 0;

  constructor() {
    this.destination.channelCount = 2;
    this.limiter.threshold.value = -1.5;
    this.limiter.knee.value = 0;
    this.limiter.ratio.value = 20;
    this.limiter.attack.value = 0.002;
    this.limiter.release.value = 0.12;
    this.masterMeter.fftSize = 1024;
    this.preMeter.fftSize = 2048;
    this.bus.connect(this.preMeter);
    this.bus.connect(this.normalizer).connect(this.limiter);
    this.limiter.connect(this.masterMeter);
    this.limiter.connect(this.destination);
    void this.context.resume();
  }

  get track() {
    return this.destination.stream.getAudioTracks()[0]!;
  }

  get list(): MixSource[] {
    return [...this.sources.values()].map(({ id, kind, label, icon, volume, muted, offsetMs, duck }) => ({ id, kind, label, icon, volume, muted, offsetMs, duck }));
  }

  private register(kind: MixSourceKind, label: string, icon: string | null, input: AudioNode, dispose: () => void) {
    const gain = this.context.createGain();
    const delay = this.context.createDelay(MAX_OFFSET_SECONDS);
    const ducker = this.context.createGain();
    const analyser = this.context.createAnalyser();
    analyser.fftSize = 1024;
    input.connect(delay).connect(gain).connect(ducker);
    ducker.connect(analyser);
    ducker.connect(this.bus);
    const source: LiveSource = { id: `m${this.nextId++}`, kind, label, icon, volume: 1, muted: false, offsetMs: 0, duck: false, gain, delay, ducker, analyser, dispose };
    this.sources.set(source.id, source);
    return source.id;
  }

  /** mode "include" : le son de cette application. mode "exclude" : tout le PC sauf elle. */
  async addCapture(mode: "include" | "exclude", pid: number, label: string, icon: string | null) {
    this.workletReady ??= this.context.audioWorklet.addModule(workletUrl);
    await this.workletReady;
    const captureId = await window.spoka.startCapture(mode, pid);
    const port = await portFor(captureId);
    const node = new AudioWorkletNode(this.context, "spoka-capture", { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2] });
    node.port.postMessage({ port }, [port]);
    return this.register("capture", label, icon, node, () => {
      node.disconnect();
      void window.spoka.stopCapture(captureId);
    });
  }

  /** Entrée de la machine : carte d'acquisition, câble virtuel, micro de commentaire. Sans traitement de la voix. */
  async addDevice(deviceId: string, label: string) {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { deviceId: { exact: deviceId }, echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 2, sampleRate: 48000 },
    });
    const node = this.context.createMediaStreamSource(stream);
    return this.register("device", label, null, node, () => {
      node.disconnect();
      stream.getTracks().forEach(t => t.stop());
    });
  }

  addMediaStream(stream: MediaStream, label: string) {
    const node = this.context.createMediaStreamSource(stream);
    return this.register("media", label, null, node, () => node.disconnect());
  }

  remove(id: string) {
    const source = this.sources.get(id);
    if (!source) return;
    source.dispose();
    source.ducker.disconnect();
    this.sources.delete(id);
  }

  clear() {
    for (const id of [...this.sources.keys()]) this.remove(id);
  }

  setVolume(id: string, volume: number) {
    const source = this.sources.get(id);
    if (!source) return;
    source.volume = volume;
    source.gain.gain.setTargetAtTime(source.muted ? 0 : volume, this.context.currentTime, 0.02);
  }

  setMuted(id: string, muted: boolean) {
    const source = this.sources.get(id);
    if (!source) return;
    source.muted = muted;
    source.gain.gain.setTargetAtTime(muted ? 0 : source.volume, this.context.currentTime, 0.02);
  }

  setOffset(id: string, offsetMs: number) {
    const source = this.sources.get(id);
    if (!source) return;
    source.offsetMs = offsetMs;
    source.delay.delayTime.setTargetAtTime(offsetMs / 1000, this.context.currentTime, 0.02);
  }

  /** Le jeu s'efface sous la voix, comme à la radio, et revient en douceur après. */
  setDuck(id: string, duck: boolean) {
    const source = this.sources.get(id);
    if (!source) return;
    source.duck = duck;
    if (!duck) source.ducker.gain.setTargetAtTime(1, this.context.currentTime, 0.1);
    if (this.duckTimer || !duck) return;
    this.duckTimer = setInterval(() => this.followVoice(), DUCK_INTERVAL_MS);
  }

  private followVoice() {
    const inputs = [...this.sources.values()].filter(s => s.kind === "device" && !s.muted);
    const level = Math.max(this.talkLevel(), ...inputs.map(s => rmsOf(s.analyser, this.buffer)));
    const now = performance.now();
    if (level > TALK_LEVEL) this.duckUntil = now + DUCK_HOLD_MS;
    const talking = this.duckUntil > now;
    for (const source of this.sources.values()) {
      if (source.duck) source.ducker.gain.setTargetAtTime(talking ? DUCK_GAIN : 1, this.context.currentTime, talking ? 0.05 : 0.4);
    }
  }

  /** Pause du stream : plus aucun son ne sort, pas seulement une image figée. */
  setSilenced(silenced: boolean) {
    this.pausedGain = silenced ? 0 : 1;
    this.bus.gain.setTargetAtTime(this.pausedGain, this.context.currentTime, 0.02);
  }

  /** Égalisation automatique : vise environ -18 dBFS, baisse vite, remonte doucement, laisse le silence tranquille. */
  setNormalize(enabled: boolean) {
    if (this.normalizeTimer) clearInterval(this.normalizeTimer);
    this.normalizeTimer = null;
    const preBuffer = new Float32Array(this.preMeter.fftSize);
    if (!enabled) {
      this.normalizer.gain.setTargetAtTime(1, this.context.currentTime, 0.2);
      return;
    }
    this.normalizeTimer = setInterval(() => {
      this.preMeter.getFloatTimeDomainData(preBuffer);
      let sum = 0;
      for (const x of preBuffer) sum += x * x;
      const rms = Math.sqrt(sum / preBuffer.length);
      if (rms < 0.003) return;
      const target = Math.max(0.5, Math.min(8, 0.12 / rms));
      const current = this.normalizer.gain.value;
      this.normalizer.gain.setTargetAtTime(target, this.context.currentTime, target < current ? 0.3 : 2.5);
    }, 250);
  }

  levels() {
    const result: Record<string, number> = { master: levelOf(this.masterMeter, this.buffer) };
    for (const source of this.sources.values()) result[source.id] = levelOf(source.analyser, this.buffer);
    return result;
  }

  dispose() {
    if (this.normalizeTimer) clearInterval(this.normalizeTimer);
    if (this.duckTimer) clearInterval(this.duckTimer);
    this.clear();
    void this.context.close();
  }
}
