// Une sauvegarde est une copie de fichiers dans le dossier des données. Restaurer n'écrase rien pendant que le serveur tourne :
// un repère est posé, et c'est le prochain démarrage qui remet les fichiers, avant que quoi que ce soit ne les lise.
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

const FILES = ["rooms.json", "accounts.json", "push.json", "config.json", "usage.json"];
const AUTO_KEPT = 7;
const MANUAL_KEPT = 10;
const MARKER = "restore.json";

export interface BackupInfo {
  id: string;
  at: number;
  auto: boolean;
  label: string;
  bytes: number;
  files: number;
}

/** Au démarrage : remet la sauvegarde demandée, s'il y en a une. Rend son identifiant. */
export function applyPendingRestore(dataDir: string) {
  const marker = path.join(dataDir, MARKER);
  if (!existsSync(marker)) return null;
  const { id } = JSON.parse(readFileSync(marker, "utf8")) as { id: string };
  const source = path.join(dataDir, "backups", path.basename(id));
  if (existsSync(source)) {
    for (const file of FILES) {
      const from = path.join(source, file);
      if (existsSync(from)) copyFileSync(from, path.join(dataDir, file));
    }
  }
  rmSync(marker, { force: true });
  return id;
}

export class Backups {
  private readonly dataDir: string;
  private readonly root: string;
  private readonly now: () => number;

  constructor(dataDir: string, now: () => number = Date.now) {
    this.dataDir = dataDir;
    this.root = path.join(dataDir, "backups");
    this.now = now;
  }

  list(): BackupInfo[] {
    if (!existsSync(this.root)) return [];
    return readdirSync(this.root)
      .flatMap(id => {
        const info = path.join(this.root, id, "backup.json");
        if (!existsSync(info)) return [];
        return [JSON.parse(readFileSync(info, "utf8")) as BackupInfo];
      })
      .sort((a, b) => b.at - a.at);
  }

  /** Copie les fichiers tels qu'ils sont : à l'appelant de les avoir écrits juste avant. */
  create(label: string, auto: boolean): BackupInfo {
    const at = this.now();
    const id = `${new Date(at).toISOString().replace(/[:.]/g, "-")}${auto ? "-auto" : ""}`;
    const dir = path.join(this.root, id);
    const temporary = `${dir}.tmp`;
    mkdirSync(temporary, { recursive: true, mode: 0o700 });
    let bytes = 0;
    let files = 0;
    for (const file of FILES) {
      const from = path.join(this.dataDir, file);
      if (!existsSync(from)) continue;
      copyFileSync(from, path.join(temporary, file));
      bytes += statSync(from).size;
      files++;
    }
    const info: BackupInfo = { id, at, auto, label, bytes, files };
    writeFileSync(path.join(temporary, "backup.json"), JSON.stringify(info));
    renameSync(temporary, dir);
    this.prune();
    return info;
  }

  private prune() {
    const list = this.list();
    const drop = [...list.filter(b => b.auto).slice(AUTO_KEPT), ...list.filter(b => !b.auto).slice(MANUAL_KEPT)];
    for (const backup of drop) rmSync(path.join(this.root, backup.id), { recursive: true, force: true });
  }

  has(id: string) {
    return this.list().some(b => b.id === id);
  }

  remove(id: string) {
    if (!this.has(id)) return false;
    rmSync(path.join(this.root, path.basename(id)), { recursive: true, force: true });
    return true;
  }

  /** Le contenu d'une sauvegarde, pour la garder ailleurs que sur ce serveur. */
  read(id: string) {
    if (!this.has(id)) return null;
    const dir = path.join(this.root, path.basename(id));
    return Object.fromEntries(FILES.filter(file => existsSync(path.join(dir, file))).map(file => [file, JSON.parse(readFileSync(path.join(dir, file), "utf8")) as unknown]));
  }

  markRestore(id: string) {
    if (!this.has(id)) return false;
    writeFileSync(path.join(this.dataDir, MARKER), JSON.stringify({ id }));
    return true;
  }

  get lastAutoAt() {
    return this.list().find(b => b.auto)?.at ?? 0;
  }
}
