import { randomBytes, timingSafeEqual } from "node:crypto";
import { EventEmitter } from "node:events";
import http from "node:http";
import type { AddressInfo } from "node:net";

const FIRST_PORT = 8189;
const PORTS_TO_TRY = 10;
const MAX_OFFER_BYTES = 64 * 1024;
const ANSWER_TIMEOUT_MS = 10_000;

const sameKey = (given: string, key: string) => {
  const a = Buffer.from(given);
  const b = Buffer.from(key);
  return a.length === b.length && timingSafeEqual(a, b);
};

/**
 * Entrée WHIP : OBS y envoie sa sortie comme vers n'importe quel service de stream.
 * Elle n'écoute que sur ce PC, et exige la clé : une page web ouverte à côté ne peut pas s'y faire passer pour OBS.
 * Le serveur ne fait que transmettre l'offre à la page, c'est elle qui reçoit l'image et le son.
 */
export class WhipServer extends EventEmitter<{ offer: [string, string]; end: [string] }> {
  private server: http.Server | null = null;
  private readonly key: () => string;
  private readonly waiting = new Map<string, { res: http.ServerResponse; timer: NodeJS.Timeout }>();

  constructor(key: () => string) {
    super();
    this.key = key;
  }

  get port() {
    return (this.server?.address() as AddressInfo | null)?.port ?? 0;
  }

  async start() {
    for (let port = FIRST_PORT; port < FIRST_PORT + PORTS_TO_TRY; port++) {
      const server = http.createServer((req, res) => this.handle(req, res));
      const ok = await new Promise<boolean>(resolve => {
        server.once("error", () => resolve(false));
        server.listen(port, "127.0.0.1", () => resolve(true));
      });
      if (ok) {
        this.server = server;
        return;
      }
    }
    console.warn("entrée OBS : aucun port libre");
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse) {
    const path = (req.url ?? "").split("?")[0]!;
    if (req.method === "OPTIONS") return this.reply(res, 204);
    if (!path.startsWith("/whip")) return this.reply(res, 404);
    if (!sameKey((req.headers.authorization ?? "").replace(/^Bearer\s+/i, ""), this.key())) return this.reply(res, 401);
    if (req.method === "POST" && path === "/whip") return this.onOffer(req, res);
    const id = path.match(/^\/whip\/([0-9a-f]{16})$/)?.[1];
    if (!id) return this.reply(res, 404);
    if (req.method === "DELETE") {
      this.emit("end", id);
      return this.reply(res, 200);
    }
    // OBS donne ses adresses dès l'offre : les mises à jour de connexion n'ont rien à apporter ici.
    return this.reply(res, req.method === "PATCH" ? 204 : 405);
  }

  private onOffer(req: http.IncomingMessage, res: http.ServerResponse) {
    const parts: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_OFFER_BYTES) return req.destroy();
      parts.push(chunk);
    });
    req.on("end", () => {
      const id = randomBytes(8).toString("hex");
      const timer = setTimeout(() => this.answer(id, null), ANSWER_TIMEOUT_MS);
      this.waiting.set(id, { res, timer });
      this.emit("offer", id, Buffer.concat(parts).toString("utf8"));
    });
  }

  answer(id: string, sdp: string | null) {
    const waiting = this.waiting.get(id);
    if (!waiting) return;
    this.waiting.delete(id);
    clearTimeout(waiting.timer);
    if (!sdp) return this.reply(waiting.res, 503);
    waiting.res.writeHead(201, { "content-type": "application/sdp", "content-length": Buffer.byteLength(sdp), location: `/whip/${id}` });
    waiting.res.end(sdp);
  }

  private reply(res: http.ServerResponse, status: number) {
    res.writeHead(status);
    res.end();
  }

  stop() {
    this.server?.close();
    this.server = null;
  }
}
