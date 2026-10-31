import { levelOf } from "./mixer.ts";

interface Channel {
  source: MediaStreamAudioSourceNode;
  gain: GainNode;
  analyser: AnalyserNode;
  /** Chromium ne fait sortir une piste distante dans Web Audio que si un élément la lit aussi. */
  sink: HTMLAudioElement;
  volume: number;
  muted: boolean;
  kind: "stream" | "voice";
}

/** Tout ce qu'on entend : un canal par stream et par personne, chacun jusqu'à 300 %. */
export class Playback {
  private context: AudioContext | null = null;
  private master: GainNode | null = null;
  private readonly channels = new Map<string, Channel>();
  private readonly buffer = new Float32Array(1024);
  private deafened = false;
  private outputId = "default";
  private readonly bus = { stream: 1, voice: 1 };

  /** Le volume général de tous les streams, ou de toutes les voix. */
  setBus(kind: Channel["kind"], volume: number) {
    this.bus[kind] = volume;
    for (const channel of this.channels.values()) this.applyGain(channel);
  }

  private ensure() {
    if (!this.context) {
      this.context = new AudioContext({ sampleRate: 48000, latencyHint: "interactive" });
      this.master = this.context.createGain();
      this.master.connect(this.context.destination);
      void this.applyOutput();
    }
    if (this.context.state === "suspended") void this.context.resume();
    return { context: this.context, master: this.master! };
  }

  private async applyOutput() {
    const context = this.context as (AudioContext & { setSinkId?: (id: string) => Promise<void> }) | null;
    await context?.setSinkId?.(this.outputId === "default" ? "" : this.outputId).catch(e => console.warn("sortie audio :", e));
  }

  setOutput(deviceId: string) {
    this.outputId = deviceId;
    void this.applyOutput();
  }

  add(id: string, kind: Channel["kind"], track: MediaStreamTrack, volume = 1, muted = false) {
    this.remove(id);
    const { context, master } = this.ensure();
    const stream = new MediaStream([track]);
    const sink = new Audio();
    sink.srcObject = stream;
    sink.muted = true;
    void sink.play().catch(() => {});
    const source = context.createMediaStreamSource(stream);
    const gain = context.createGain();
    const analyser = context.createAnalyser();
    analyser.fftSize = 1024;
    source.connect(analyser);
    source.connect(gain).connect(master);
    const channel: Channel = { source, gain, analyser, sink, volume, muted, kind };
    this.channels.set(id, channel);
    this.applyGain(channel);
  }

  remove(id: string) {
    const channel = this.channels.get(id);
    if (!channel) return;
    channel.source.disconnect();
    channel.gain.disconnect();
    channel.sink.srcObject = null;
    this.channels.delete(id);
  }

  private applyGain(channel: Channel) {
    if (!this.context) return;
    const silent = channel.muted || this.deafened;
    channel.gain.gain.setTargetAtTime(silent ? 0 : channel.volume * this.bus[channel.kind], this.context.currentTime, 0.02);
  }

  setVolume(id: string, volume: number) {
    const channel = this.channels.get(id);
    if (!channel) return;
    channel.volume = volume;
    this.applyGain(channel);
  }

  setMuted(id: string, muted: boolean) {
    const channel = this.channels.get(id);
    if (!channel) return;
    channel.muted = muted;
    this.applyGain(channel);
  }

  setDeafened(deafened: boolean) {
    this.deafened = deafened;
    for (const channel of this.channels.values()) this.applyGain(channel);
  }

  level(id: string) {
    const channel = this.channels.get(id);
    return channel ? levelOf(channel.analyser, this.buffer) : 0;
  }

  capture(id: string) {
    return this.channels.get(id)?.sink.srcObject as MediaStream | undefined;
  }
}
