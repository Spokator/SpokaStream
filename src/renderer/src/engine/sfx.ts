// Petits sons d'interface, synthétisés : pas de fichier à embarquer, et ils restent discrets.

let context: AudioContext | null = null;

function tone(frequency: number, at: number, duration: number, volume: number) {
  context ??= new AudioContext();
  const start = context.currentTime + at;
  const oscillator = context.createOscillator();
  const gain = context.createGain();
  oscillator.type = "sine";
  oscillator.frequency.value = frequency;
  gain.gain.setValueAtTime(0, start);
  gain.gain.linearRampToValueAtTime(volume, start + 0.012);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
  oscillator.connect(gain).connect(context.destination);
  oscillator.start(start);
  oscillator.stop(start + duration + 0.02);
}

const SOUNDS = {
  join: () => (tone(523, 0, 0.14, 0.05), tone(784, 0.09, 0.2, 0.05)),
  leave: () => (tone(659, 0, 0.14, 0.04), tone(440, 0.09, 0.2, 0.04)),
  live: () => (tone(523, 0, 0.12, 0.06), tone(659, 0.08, 0.12, 0.06), tone(880, 0.16, 0.24, 0.06)),
  mute: () => tone(392, 0, 0.09, 0.05),
  unmute: () => tone(659, 0, 0.09, 0.05),
  message: () => tone(880, 0, 0.1, 0.025),
};

export function playSound(name: keyof typeof SOUNDS, enabled: boolean) {
  if (!enabled) return;
  try {
    SOUNDS[name]();
  } catch {
    // Pas de sortie audio disponible : tant pis pour le petit son.
  }
}
