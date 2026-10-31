// Les réglages du serveur qu'on change depuis le panneau, sans toucher au .env ni redémarrer.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

export interface BlockedIp {
  ip: string;
  reason: string;
  by: string;
  at: number;
  /** 0 : pour toujours. */
  until: number;
}

export interface AlertRule {
  on: boolean;
  limit: number;
}

export interface ServerConfig {
  /** Serveur fermé : seuls les appareils déjà connus entrent dans un salon. */
  closed: boolean;
  roomCreation: "everyone" | "admins";
  webViewers: boolean;
  watchParty: boolean;
  maxMembers: number;
  maxRooms: number;
  /** Affiché à chaque connexion. */
  motd: string;
  /** Une application plus ancienne doit se mettre à jour avant d'entrer. Vide : aucune limite. */
  minVersion: string;
  /** Secondes entre deux messages, pour tout le monde sauf le propriétaire du salon. */
  slowSeconds: number;
  words: string[];
  blockedIps: BlockedIp[];
  discord: string;
  rules: Record<string, AlertRule>;
  /** Maintenance prévue : prévenue à l'avance, puis appliquée toute seule. */
  plan: { at: number; text: string; restart: boolean } | null;
  /** L'adresse publique, retenue à la première visite du panneau : la sonde passe par elle, comme un vrai visiteur. */
  publicHost: string;
}

export const DEFAULT_CONFIG: ServerConfig = { closed: false, roomCreation: "everyone", webViewers: true, watchParty: true, maxMembers: 32, maxRooms: 50, motd: "", minVersion: "", slowSeconds: 0, words: [], blockedIps: [], discord: "", rules: {}, plan: null, publicHost: "" };

export class ConfigStore {
  value: ServerConfig = { ...DEFAULT_CONFIG };
  private readonly file?: string;

  constructor(file?: string) {
    this.file = file;
    if (!file) return;
    mkdirSync(path.dirname(file), { recursive: true });
    try {
      this.value = { ...DEFAULT_CONFIG, ...(JSON.parse(readFileSync(file, "utf8")) as Partial<ServerConfig>) };
    } catch {
      // Premier démarrage : les valeurs par défaut.
    }
  }

  /** Écrit tout de suite : ce fichier change rarement, et il porte des décisions qu'on ne veut pas perdre. */
  update(patch: Partial<ServerConfig>) {
    Object.assign(this.value, patch);
    if (!this.file) return;
    const temporary = `${this.file}.tmp`;
    writeFileSync(temporary, JSON.stringify(this.value), { mode: 0o600 });
    renameSync(temporary, this.file);
  }
}

/** Compare sans tenir compte des accents ni de la casse : « CONNARD » et « cônnard » sont le même mot. */
const fold = (text: string) => text.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();

/** Masque les mots interdits. Rend le texte tel quel s'il n'y a rien à masquer, pour que l'appelant sache s'il faut le noter. */
export function maskWords(text: string, words: string[]) {
  if (!words.length) return text;
  const folded = fold(text);
  // La forme sans accent garde la même longueur que l'original pour le français : les positions restent valables.
  if (folded.length !== text.length) return text;
  let masked = text;
  for (const word of words) {
    const needle = fold(word.trim());
    if (!needle) continue;
    const pattern = new RegExp(`(?<![\\p{L}\\p{N}])${needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}\\p{N}])`, "gu");
    for (const match of folded.matchAll(pattern)) masked = masked.slice(0, match.index) + "•".repeat(match[0].length) + masked.slice(match.index + match[0].length);
  }
  return masked;
}

/** Compare 1.5.0 et 1.10.2 comme des versions, pas comme du texte. */
export function olderThan(version: string, minimum: string) {
  const parts = (v: string) => v.split(".").map(n => Number.parseInt(n, 10) || 0);
  const a = parts(version);
  const b = parts(minimum);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const left = a[i] ?? 0;
    const right = b[i] ?? 0;
    if (left !== right) return left < right;
  }
  return false;
}
