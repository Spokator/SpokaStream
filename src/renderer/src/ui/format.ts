export const mbps = (kbps: number) => (kbps / 1000).toFixed(kbps >= 10_000 ? 0 : 1).replace(".", ",");

export const initials = (name: string) => {
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] ?? "?") + (parts[1]?.[0] ?? "")).toUpperCase();
};

export const hueOf = (text: string) => {
  let hash = 0;
  for (const c of text) hash = (hash * 31 + c.charCodeAt(0)) >>> 0;
  return hash % 360;
};

export const clock = (at: number) => new Date(at).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });

export const duration = (ms: number) => {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `${h ? `${h}:${String(m).padStart(2, "0")}` : m}:${String(s).padStart(2, "0")}`;
};

/** « @tous » appelle tout le salon. */
export const mentionsName = (text: string, name: string) => {
  const lower = text.toLowerCase();
  return lower.includes("@tous") || (!!name && lower.includes(`@${name.toLowerCase()}`));
};

export const plural = (n: number, word: string) => `${n} ${word}${n > 1 ? "s" : ""}`;

const LIMIT_TEXT: Record<string, string> = {
  cpu: "Limité par le processeur",
  bandwidth: "Limité par la connexion",
  other: "Limité",
};
export const limitText = (reason: string) => LIMIT_TEXT[reason] ?? "";

/**
 * Pourquoi la cadence tombe. Sans surcharge ni perte réseau, ce n'est pas la connexion : la source n'envoie plus d'images,
 * parce que rien ne bouge ou parce que le jeu ne passe plus par la capture.
 */
export function streamTrouble(stats: { fps: number; limit: string; encMs: number | null }, targetFps: number, retransmitPct: number) {
  const budget = 1000 / targetFps;
  const overloaded = stats.limit === "cpu" || (stats.encMs ?? 0) > budget;
  if (overloaded && (stats.fps < targetFps * 0.7 || (stats.encMs ?? 0) > budget)) return "overloaded";
  if (retransmitPct > 5) return "network";
  return stats.fps < targetFps * 0.7 ? (stats.limit === "bandwidth" ? "network" : "source") : null;
}

export const pathText = (path: { relay: boolean; protocol: string; rttMs: number | null } | null) => {
  if (!path) return "";
  const route = path.relay ? `Relais ${path.protocol.toUpperCase()}` : "Direct";
  return path.rttMs != null ? `${route} · ${path.rttMs} ms` : route;
};
