import { PROTOCOL_VERSION } from "@shared/protocol.ts";
import type { ClientMessage, ErrorCode, Profile, ServerMessage } from "@shared/protocol.ts";

export type ConnectionState = "offline" | "connecting" | "online" | "outdated";

export class RequestError extends Error {
  readonly code: ErrorCode;
  constructor(code: ErrorCode) {
    super(code);
    this.code = code;
  }
}

type Request = Extract<ClientMessage, { rid?: number }>;

interface Pending {
  resolve: (data: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class Signal {
  private ws: WebSocket | null = null;
  private url = "";
  private token = "";
  private profile: Profile | null = null;
  private client: "web" | undefined;
  private attempt = 0;
  private rid = 1;
  /** Échecs d'affilée : au bout de quelques-uns, autant dire clairement que le serveur ne répond pas. */
  get failedAttempts() {
    return this.attempt;
  }
  private stopped = true;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private ping: ReturnType<typeof setInterval> | null = null;
  private readonly pending = new Map<number, Pending>();
  rttMs = 0;

  onMessage: (message: ServerMessage) => void = () => {};
  onState: (state: ConnectionState) => void = () => {};
  /** Connexion établie et authentifiée, première fois ou retour après une coupure. */
  onReady: () => void = () => {};

  start(url: string, token: string, profile: Profile, client?: "web") {
    this.stop();
    this.url = url;
    this.token = token;
    this.profile = profile;
    this.client = client;
    this.stopped = false;
    this.attempt = 0;
    this.open();
  }

  stop() {
    this.stopped = true;
    if (this.retry) clearTimeout(this.retry);
    if (this.ping) clearInterval(this.ping);
    const ws = this.ws;
    this.ws = null;
    ws?.close();
    this.onState("offline");
  }

  private open() {
    if (this.stopped) return;
    this.onState("connecting");
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.url);
    } catch {
      return this.scheduleRetry();
    }
    this.ws = ws;
    ws.onopen = () => {
      if (ws !== this.ws) return;
      this.request({ t: "hello", protocol: PROTOCOL_VERSION, token: this.token, profile: this.profile!, client: this.client })
        .then(() => {
          this.attempt = 0;
          this.onState("online");
          this.onReady();
          if (this.ping) clearInterval(this.ping);
          this.ping = setInterval(() => this.send({ t: "ping", at: performance.now() }), 15_000);
        })
        .catch((e: RequestError) => {
          if (e.code === "version") {
            this.stopped = true;
            this.onState("outdated");
          }
          ws.close();
        });
    };
    ws.onmessage = event => {
      const message = JSON.parse(event.data as string) as ServerMessage;
      if (message.t === "ack") return this.settle(message.rid, message.ok, message.error, message.data);
      if (message.t === "pong") {
        this.rttMs = Math.round(performance.now() - message.at);
        return;
      }
      this.onMessage(message);
    };
    ws.onclose = () => {
      if (ws !== this.ws) return;
      this.ws = null;
      if (this.ping) clearInterval(this.ping);
      for (const [rid] of this.pending) this.settle(rid, false, "bad_request", undefined);
      if (!this.stopped) {
        this.onState("connecting");
        this.scheduleRetry();
      }
    };
  }

  private scheduleRetry() {
    const delay = Math.min(10_000, 500 * 2 ** this.attempt++);
    this.retry = setTimeout(() => this.open(), delay);
  }

  private settle(rid: number, ok: boolean, error: ErrorCode | undefined, data: unknown) {
    const pending = this.pending.get(rid);
    if (!pending) return;
    this.pending.delete(rid);
    clearTimeout(pending.timer);
    if (ok) pending.resolve(data);
    else pending.reject(new RequestError(error ?? "bad_request"));
  }

  send(message: ClientMessage) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(message));
  }

  request<T = unknown>(message: Request) {
    const rid = this.rid++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => this.settle(rid, false, "bad_request", undefined), 10_000);
      this.pending.set(rid, { resolve: resolve as (data: unknown) => void, reject, timer });
      this.send({ ...message, rid });
    });
  }
}
