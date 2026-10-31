import { app, MessageChannelMain } from "electron";
import type { MessagePortMain, WebContents } from "electron";
import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import path from "node:path";
import type { AudioEngineStatus, NativeVideo } from "../shared/ipc.ts";

const FRAME_JSON = 1;
const FRAME_AUDIO = 2;
const MAX_FRAME = 8 * 1024 * 1024;

export interface NativeApp {
  pid: number;
  name: string;
  path: string | null;
  title: string | null;
  peak: number;
}

export interface NativeWindowApp {
  pid: number;
  name: string;
  path: string | null;
  title: string | null;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

function enginePath() {
  const packaged = path.join(process.resourcesPath, "native", "SpokaAudio.exe");
  if (app.isPackaged) return packaged;
  const release = path.join(app.getAppPath(), "native", "publish", "SpokaAudio.exe");
  if (existsSync(release)) return release;
  return path.join(app.getAppPath(), "native", "SpokaAudio", "bin", "Release", "net9.0-windows10.0.19041.0", "SpokaAudio.exe");
}

/** Pilote du moteur natif. Le son ne transite pas par la page : il va droit du moteur au fil audio temps réel. */
export class AudioEngine extends EventEmitter<{ status: [AudioEngineStatus]; key: [number, boolean]; videoEnded: [string] }> {
  private child: ChildProcessWithoutNullStreams | null = null;
  private buffer: Buffer = Buffer.alloc(0);
  private nextId = 1;
  private nextCapture = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly ports = new Map<number, MessagePortMain>();
  private currentStatus: AudioEngineStatus = "starting";
  private restarts = 0;
  private stopping = false;
  private watchedKeys: number[] = [];

  get status() {
    return this.currentStatus;
  }

  start() {
    const file = enginePath();
    if (!existsSync(file)) {
      console.error(`[audio] moteur introuvable : ${file}`);
      this.setStatus("unavailable");
      return;
    }
    this.setStatus("starting");
    const child = spawn(file, [], { stdio: "pipe", windowsHide: true });
    this.child = child;
    this.buffer = Buffer.alloc(0);
    child.stdout.on("data", (chunk: Buffer) => this.onData(chunk));
    child.stderr.on("data", (chunk: Buffer) => console.error(`[audio] ${chunk.toString().trim()}`));
    child.on("error", e => console.error(`[audio] ${e.message}`));
    child.on("exit", code => this.onExit(code));
  }

  stop() {
    this.stopping = true;
    this.child?.stdin.end();
  }

  private onExit(code: number | null) {
    this.child = null;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("moteur audio arrêté"));
    }
    this.pending.clear();
    for (const port of this.ports.values()) port.close();
    this.ports.clear();
    if (this.stopping) return;
    console.error(`[audio] moteur arrêté (code ${code})`);
    if (this.restarts++ < 5) {
      this.setStatus("starting");
      setTimeout(() => this.start(), 500 * this.restarts);
    } else {
      this.setStatus("unavailable");
    }
  }

  private setStatus(status: AudioEngineStatus) {
    this.currentStatus = status;
    this.emit("status", status);
  }

  private onData(chunk: Buffer) {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    let offset = 0;
    while (this.buffer.length - offset >= 5) {
      const type = this.buffer[offset]!;
      const length = this.buffer.readUInt32LE(offset + 1);
      if (length > MAX_FRAME) {
        console.error("[audio] trame invalide, relance du moteur");
        this.child?.kill();
        return;
      }
      if (this.buffer.length - offset - 5 < length) break;
      const body = this.buffer.subarray(offset + 5, offset + 5 + length);
      if (type === FRAME_JSON) this.onJson(body);
      else if (type === FRAME_AUDIO) this.onAudio(body);
      offset += 5 + length;
    }
    this.buffer = offset === this.buffer.length ? Buffer.alloc(0) : this.buffer.subarray(offset);
  }

  private onAudio(body: Buffer) {
    const port = this.ports.get(body.readUInt16LE(0));
    if (!port) return;
    const bytes = body.subarray(2);
    const samples = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    port.postMessage(samples);
  }

  private onJson(body: Buffer) {
    const message = JSON.parse(body.toString("utf8")) as Record<string, unknown>;
    if (message.evt === "ready") {
      this.restarts = 0;
      if (this.watchedKeys.length) void this.request("keys.watch", { keys: this.watchedKeys });
      return this.setStatus("ready");
    }
    if (message.evt === "key") return void this.emit("key", message.key as number, message.down as boolean);
    if (message.evt === "video.ended") return void this.emit("videoEnded", message.url as string);
    if (message.evt === "capture.error") return console.error(`[audio] capture ${message.captureId} : ${message.message}`);
    const pending = this.pending.get(message.id as number);
    if (!pending) return;
    this.pending.delete(message.id as number);
    clearTimeout(pending.timer);
    if (message.error) pending.reject(new Error(String(message.error)));
    else pending.resolve(message.result);
  }

  request<T = unknown>(cmd: string, args: Record<string, unknown> = {}): Promise<T> {
    const child = this.child;
    if (!child) return Promise.reject(new Error("moteur audio indisponible"));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`délai dépassé : ${cmd}`));
      }, 5000);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      child.stdin.write(`${JSON.stringify({ id, cmd, ...args })}\n`);
    });
  }

  apps() {
    return this.request<NativeApp[]>("sessions");
  }

  windowApp(hwnd: string) {
    return this.request<NativeWindowApp | null>("window.app", { hwnd: Number(hwnd) });
  }

  windowRect(hwnd: string) {
    return this.request<{ x: number; y: number; width: number; height: number } | null>("window.rect", { hwnd: Number(hwnd) });
  }

  watchKeys(keys: number[]) {
    this.watchedKeys = keys;
    return this.request("keys.watch", { keys });
  }

  startVideo(target: { hwnd: number } | { x: number; y: number }, fps: number, maxHeight: number) {
    return this.request<NativeVideo | null>("video.start", { ...target, fps, maxHeight });
  }

  configureVideo(fps: number, maxHeight: number) {
    return this.request("video.configure", { fps, maxHeight });
  }

  stopVideo(url: string) {
    return this.request("video.stop", { url });
  }

  /** Le port part vers la page, qui le confie au fil audio : le son continue même si l'interface rame. */
  async startCapture(target: WebContents, mode: "include" | "exclude", pid: number) {
    const captureId = this.nextCapture++;
    const { port1, port2 } = new MessageChannelMain();
    this.ports.set(captureId, port1);
    port1.start();
    target.postMessage("audio:port", { captureId }, [port2]);
    await this.request("capture.start", { captureId, mode, pid });
    return captureId;
  }

  async stopCapture(captureId: number) {
    this.ports.get(captureId)?.close();
    this.ports.delete(captureId);
    await this.request("capture.stop", { captureId }).catch(() => {});
  }
}
