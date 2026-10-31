import { app } from "electron";
import { networkInterfaces } from "node:os";
import path from "node:path";
import { startServer } from "../../server/index.ts";
import type { RunningServer } from "../../server/index.ts";
import { JsonStore } from "../../server/store.ts";
import type { HostStatus } from "../shared/ipc.ts";

function lanAddresses() {
  const found: string[] = [];
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === "IPv4" && !entry.internal) found.push(entry.address);
    }
  }
  return found;
}

/** Salons hébergés par ce PC : tout marche sur un réseau local, sans aucun serveur. */
export class LocalHost {
  private running: RunningServer | null = null;
  private lastError: string | null = null;

  get status(): HostStatus {
    return { running: !!this.running, port: this.running?.port ?? 0, addresses: this.running ? lanAddresses() : [], error: this.lastError };
  }

  async start(port: number) {
    await this.stop();
    try {
      this.running = await startServer({
        port,
        host: "0.0.0.0",
        store: new JsonStore(path.join(app.getPath("userData"), "host-rooms.json")),
        serverName: "Ce PC",
      });
      this.lastError = null;
    } catch (e) {
      this.lastError = (e as NodeJS.ErrnoException).code === "EADDRINUSE" ? `Le port ${port} est déjà utilisé.` : String(e);
    }
    return this.status;
  }

  async stop() {
    await this.running?.close();
    this.running = null;
    return this.status;
  }
}
