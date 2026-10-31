// Le journal et les retours survivent aux redémarrages : c'est justement après un incident qu'on veut les relire.
import { appendFile, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { LogEntry, Report } from "./hub.ts";

const KEPT = 2000;
/** On laisse le fichier grandir un peu avant de le récrire : il n'est réécrit qu'une fois de temps en temps. */
const REWRITE_AT = 4000;

export class Journal {
  private readonly file?: string;
  private readonly reportsFile?: string;
  private lines = 0;

  constructor(dataDir?: string) {
    if (!dataDir) return;
    mkdirSync(dataDir, { recursive: true });
    this.file = path.join(dataDir, "journal.jsonl");
    this.reportsFile = path.join(dataDir, "reports.json");
  }

  /** Les entrées les plus récentes d'abord, comme le journal en mémoire. */
  load(): LogEntry[] {
    if (!this.file) return [];
    try {
      const rows = readFileSync(this.file, "utf8").split("\n").filter(Boolean);
      this.lines = rows.length;
      return rows.slice(-KEPT).reverse().flatMap(line => {
        try {
          return [JSON.parse(line) as LogEntry];
        } catch {
          return [];
        }
      });
    } catch {
      return [];
    }
  }

  add(entry: LogEntry, all: LogEntry[]) {
    if (!this.file) return;
    if (++this.lines >= REWRITE_AT) {
      this.lines = Math.min(all.length, KEPT);
      const temporary = `${this.file}.tmp`;
      writeFileSync(temporary, `${[...all].slice(0, KEPT).reverse().map(row => JSON.stringify(row)).join("\n")}\n`, { mode: 0o600 });
      renameSync(temporary, this.file);
      return;
    }
    appendFile(this.file, `${JSON.stringify(entry)}\n`, { mode: 0o600 }, () => {});
  }

  loadReports(): Report[] {
    if (!this.reportsFile) return [];
    try {
      return JSON.parse(readFileSync(this.reportsFile, "utf8")) as Report[];
    } catch {
      return [];
    }
  }

  saveReports(reports: Report[]) {
    if (!this.reportsFile) return;
    const temporary = `${this.reportsFile}.tmp`;
    writeFileSync(temporary, JSON.stringify(reports), { mode: 0o600 });
    renameSync(temporary, this.reportsFile);
  }
}

const cell = (value: string) => `"${value.replace(/"/g, '""')}"`;

/** Un point-virgule et un BOM : Excel en français ouvre le fichier directement dans les bonnes colonnes. */
export const logsCsv = (logs: LogEntry[]) => `﻿Date;Niveau;Sujet;Texte\n${logs.map(l => [new Date(l.at).toISOString(), l.level, l.topic, l.text].map(cell).join(";")).join("\n")}\n`;
