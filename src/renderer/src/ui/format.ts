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

export const plural = (n: number, word: string) => `${n} ${word}${n > 1 ? "s" : ""}`;

const LIMIT_TEXT: Record<string, string> = {
  cpu: "Limité par le processeur",
  bandwidth: "Limité par la connexion",
  other: "Limité",
};
export const limitText = (reason: string) => LIMIT_TEXT[reason] ?? "";

export const pathText = (path: { relay: boolean; protocol: string; rttMs: number | null } | null) => {
  if (!path) return "";
  const route = path.relay ? `Relais ${path.protocol.toUpperCase()}` : "Direct";
  return path.rttMs != null ? `${route} · ${path.rttMs} ms` : route;
};
