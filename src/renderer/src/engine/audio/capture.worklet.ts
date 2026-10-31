import { DriftBuffer } from "./driftBuffer.ts";

declare class AudioWorkletProcessor {
  readonly port: MessagePort;
}
declare function registerProcessor(name: string, processor: unknown): void;
declare const sampleRate: number;

const TARGET_MS = 40;
const CAPACITY_SECONDS = 1;

/** Reçoit le son du moteur natif sur un port dédié : il ne passe jamais par le fil de l'interface. */
class CaptureProcessor extends AudioWorkletProcessor {
  private readonly buffer = new DriftBuffer(sampleRate * CAPACITY_SECONDS, Math.round((sampleRate * TARGET_MS) / 1000));

  constructor() {
    super();
    this.port.onmessage = (event: MessageEvent<{ port?: MessagePort }>) => {
      const source = event.data.port;
      if (!source) return;
      source.onmessage = (audio: MessageEvent<ArrayBuffer | Uint8Array>) => {
        const data = audio.data;
        const samples = data instanceof ArrayBuffer ? new Float32Array(data) : new Float32Array(data.buffer, data.byteOffset, Math.floor(data.byteLength / 4));
        this.buffer.push(samples);
      };
      source.start();
    };
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]) {
    const output = outputs[0];
    if (output) this.buffer.pull(output);
    return true;
  }
}

registerProcessor("spoka-capture", CaptureProcessor);
