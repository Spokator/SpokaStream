import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { ChatMessage, RoomSettings } from "../src/shared/protocol.ts";

export interface StoredRoom {
  id: string;
  code: string;
  name: string;
  ownerId: string;
  settings: RoomSettings;
  bans: string[];
  history: ChatMessage[];
  createdAt: number;
  lastActivity: number;
}

export interface Store {
  load(): StoredRoom[];
  save(rooms: StoredRoom[]): void;
  flush(): void;
}

export class MemoryStore implements Store {
  private rooms: StoredRoom[] = [];
  load() {
    return this.rooms;
  }
  save(rooms: StoredRoom[]) {
    this.rooms = rooms;
  }
  flush() {}
}

/** Sauvegarde groupée et atomique : un arrêt brutal laisse toujours un fichier complet. */
export class JsonStore implements Store {
  private readonly file: string;
  private readonly delayMs: number;
  private timer: NodeJS.Timeout | null = null;
  private pending: StoredRoom[] | null = null;

  constructor(file: string, delayMs = 2000) {
    this.file = file;
    this.delayMs = delayMs;
    mkdirSync(path.dirname(file), { recursive: true });
  }

  load(): StoredRoom[] {
    try {
      return JSON.parse(readFileSync(this.file, "utf8")) as StoredRoom[];
    } catch {
      return [];
    }
  }

  save(rooms: StoredRoom[]) {
    this.pending = rooms;
    this.timer ??= setTimeout(() => this.flush(), this.delayMs);
  }

  flush() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (!this.pending) return;
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.pending));
    renameSync(tmp, this.file);
    this.pending = null;
  }
}
