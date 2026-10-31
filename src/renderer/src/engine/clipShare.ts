import type { IceServer } from "@shared/protocol.ts";
import { rtcConfig } from "./rtc.ts";

const CHUNK_BYTES = 64 * 1024;
const QUEUE_HIGH = 4 * 1024 * 1024;
const QUEUE_LOW = 1024 * 1024;
const HELD_CLIPS = 6;
const STALL_MS = 15_000;
const SEND_TIMEOUT_MS = 180_000;

export const CLIP_SESSION = "clip:";

interface ClipSignal {
  sdp?: RTCSessionDescriptionInit;
  candidate?: RTCIceCandidateInit;
  missing?: boolean;
}

interface Link {
  pc: RTCPeerConnection;
  pending: RTCIceCandidateInit[];
  ready: boolean;
  fail: (error: Error) => void;
}

/**
 * Un clip pèse des dizaines de Mo : il reste chez son auteur et part de PC à PC quand quelqu'un l'ouvre.
 * Le serveur n'en voit que la vignette, comme pour les streams. Une connexion ne vit que le temps d'un envoi.
 */
export class ClipShare {
  private readonly held = new Map<string, Uint8Array>();
  private readonly links = new Map<string, Link>();
  private readonly iceServers: () => IceServer[];
  private readonly sendSignal: (to: string, session: string, data: ClipSignal) => void;

  constructor(iceServers: () => IceServer[], sendSignal: (to: string, session: string, data: ClipSignal) => void) {
    this.iceServers = iceServers;
    this.sendSignal = sendSignal;
  }

  hold(id: string, bytes: Uint8Array) {
    this.held.set(id, bytes);
    for (const old of [...this.held.keys()].slice(0, -HELD_CLIPS)) this.held.delete(old);
  }

  get(id: string) {
    return this.held.get(id) ?? null;
  }

  fetch(ownerId: string, id: string, expected: number, onProgress: (share: number) => void) {
    return new Promise<Uint8Array>((resolve, reject) => {
      const session = `${CLIP_SESSION}${id}`;
      const key = `${ownerId}|${session}`;
      const pc = new RTCPeerConnection(rtcConfig(this.iceServers()));
      const channel = pc.createDataChannel("clip");
      channel.binaryType = "arraybuffer";
      const bytes = new Uint8Array(expected);
      let received = 0;
      let stall: ReturnType<typeof setTimeout>;
      const close = () => {
        clearTimeout(stall);
        this.links.delete(key);
        pc.close();
      };
      const fail = (error: Error) => {
        close();
        reject(error);
      };
      const alive = () => {
        clearTimeout(stall);
        stall = setTimeout(() => fail(new Error("Le clip ne répond plus.")), STALL_MS);
      };
      alive();
      channel.onmessage = event => {
        const chunk = new Uint8Array(event.data as ArrayBuffer);
        if (received + chunk.length > expected) return fail(new Error("Clip invalide."));
        bytes.set(chunk, received);
        received += chunk.length;
        onProgress(received / expected);
        alive();
        if (received < expected) return;
        channel.send("reçu");
        // Laisse partir l'accusé : l'auteur ferme de son côté en le recevant.
        setTimeout(close, 200);
        resolve(bytes);
      };
      this.links.set(key, { pc, pending: [], ready: false, fail });
      pc.onicecandidate = e => e.candidate && this.sendSignal(ownerId, session, { candidate: e.candidate });
      void pc
        .createOffer()
        .then(offer => pc.setLocalDescription(offer))
        .then(() => this.sendSignal(ownerId, session, { sdp: pc.localDescription! }))
        .catch(e => fail(e as Error));
    });
  }

  async onSignal(from: string, session: string, data: ClipSignal) {
    const key = `${from}|${session}`;
    if (data.sdp?.type === "offer") return this.serve(from, session, data.sdp);
    const link = this.links.get(key);
    if (!link) return;
    if (data.missing) return link.fail(new Error("Ce clip n'est plus disponible."));
    if (data.sdp?.type === "answer") {
      await link.pc.setRemoteDescription(data.sdp);
      await this.opened(link);
    } else if (data.candidate) {
      if (link.ready) await link.pc.addIceCandidate(data.candidate).catch(() => {});
      else link.pending.push(data.candidate);
    }
  }

  private async opened(link: Link) {
    link.ready = true;
    for (const candidate of link.pending.splice(0)) await link.pc.addIceCandidate(candidate).catch(() => {});
  }

  private async serve(from: string, session: string, offer: RTCSessionDescriptionInit) {
    const bytes = this.held.get(session.slice(CLIP_SESSION.length));
    if (!bytes) return this.sendSignal(from, session, { missing: true });
    const key = `${from}|${session}`;
    this.links.get(key)?.pc.close();
    const pc = new RTCPeerConnection(rtcConfig(this.iceServers()));
    const close = () => {
      clearTimeout(timeout);
      this.links.delete(key);
      pc.close();
    };
    const timeout = setTimeout(close, SEND_TIMEOUT_MS);
    const link: Link = { pc, pending: [], ready: false, fail: close };
    this.links.set(key, link);
    pc.onicecandidate = e => e.candidate && this.sendSignal(from, session, { candidate: e.candidate });
    pc.ondatachannel = event => this.push(event.channel, bytes, close);
    await pc.setRemoteDescription(offer);
    await pc.setLocalDescription(await pc.createAnswer());
    this.sendSignal(from, session, { sdp: pc.localDescription! });
    await this.opened(link);
  }

  /** La file d'envoi reste bornée : un clip de 100 Mo ne doit pas se retrouver d'un bloc en mémoire de WebRTC. */
  private push(channel: RTCDataChannel, bytes: Uint8Array, close: () => void) {
    let offset = 0;
    const pump = () => {
      while (offset < bytes.length && channel.readyState === "open" && channel.bufferedAmount < QUEUE_HIGH) {
        channel.send(bytes.subarray(offset, offset + CHUNK_BYTES) as Uint8Array<ArrayBuffer>);
        offset += CHUNK_BYTES;
      }
    };
    channel.bufferedAmountLowThreshold = QUEUE_LOW;
    channel.onbufferedamountlow = pump;
    channel.onopen = pump;
    channel.onmessage = close;
    pump();
  }
}
