/**
 * Tampon entre l'horloge de la carte son (capture) et celle du contexte audio (lecture).
 * Les deux dérivent toujours un peu : on lit légèrement plus vite ou plus lentement (±0,5 %, inaudible)
 * pour rester autour de la latence visée, sans jamais couper ni accumuler de retard.
 */
export class DriftBuffer {
  static readonly MAX_CORRECTION = 0.005;

  private readonly ring: Float32Array;
  private readonly capacity: number;
  private readonly channels: number;
  private readonly target: number;
  private writeIndex = 0;
  private readPosition = 0;
  private filled = 0;
  private primed = false;
  private smoothed = 0;

  constructor(capacityFrames: number, targetFrames: number, channels = 2) {
    this.capacity = capacityFrames;
    this.target = targetFrames;
    this.channels = channels;
    this.ring = new Float32Array(capacityFrames * channels);
  }

  get available() {
    return this.filled;
  }

  get isPrimed() {
    return this.primed;
  }

  /** Échantillons entrelacés. */
  push(samples: Float32Array) {
    const frames = Math.floor(samples.length / this.channels);
    for (let f = 0; f < frames; f++) {
      const base = this.writeIndex * this.channels;
      for (let c = 0; c < this.channels; c++) this.ring[base + c] = samples[f * this.channels + c]!;
      this.writeIndex = (this.writeIndex + 1) % this.capacity;
    }
    this.filled += frames;
    if (this.filled > this.capacity) {
      const excess = this.filled - this.capacity;
      this.readPosition = (this.readPosition + excess) % this.capacity;
      this.filled = this.capacity;
    }
    if (!this.primed && this.filled >= this.target) {
      this.primed = true;
      this.smoothed = this.filled;
    }
    // Retard accumulé (lecture suspendue, surcharge) : on rattrape d'un coup, mieux qu'un décalage son/image durable.
    if (this.filled > this.target * 4) {
      const skip = this.filled - this.target;
      this.readPosition = (this.readPosition + skip) % this.capacity;
      this.filled -= skip;
      this.smoothed = this.filled;
    }
  }

  /** Remplit des canaux séparés. Rend false s'il n'y avait rien à lire. */
  pull(output: Float32Array[]) {
    const length = output[0]?.length ?? 0;
    if (!this.primed) {
      for (const channel of output) channel.fill(0);
      return false;
    }
    this.smoothed += (this.filled - this.smoothed) * 0.02;
    const error = (this.smoothed - this.target) / this.target;
    const rate = 1 + Math.max(-DriftBuffer.MAX_CORRECTION, Math.min(DriftBuffer.MAX_CORRECTION, error * 0.02));

    for (let i = 0; i < length; i++) {
      if (this.filled < 2) {
        for (const channel of output) channel.fill(0, i);
        this.primed = false;
        return i > 0;
      }
      const index = Math.floor(this.readPosition);
      const fraction = this.readPosition - index;
      const next = (index + 1) % this.capacity;
      for (let c = 0; c < output.length; c++) {
        const source = Math.min(c, this.channels - 1);
        const a = this.ring[index * this.channels + source]!;
        const b = this.ring[next * this.channels + source]!;
        output[c]![i] = a + (b - a) * fraction;
      }
      const position = this.readPosition + rate;
      const consumed = Math.floor(position) - index;
      this.readPosition = position % this.capacity;
      this.filled -= consumed;
    }
    return true;
  }
}
