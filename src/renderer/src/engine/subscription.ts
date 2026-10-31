import type { LatencyMode } from "@shared/ipc.ts";
import type { ControlToHost, ControlToViewer, IceServer } from "@shared/protocol.ts";
import { rtcConfig } from "./rtc.ts";
import { tuneOpusSdp } from "./sdp.ts";
import { ReceiveMeter } from "./stats.ts";
import type { ReceiveStats } from "./stats.ts";

export const LATENCY_MS: Record<LatencyMode, number> = { ultra: 0, balanced: 60, stable: 400 };

export type SubscriptionState = "connecting" | "connected" | "unstable" | "failed";

/** Un stream regardé. La connexion n'existe que pendant qu'on regarde : le diffuseur n'encode rien pour personne d'autre. */
export class Subscription {
  readonly streamId: string;
  readonly ownerId: string;
  readonly media = new MediaStream();
  readonly camera = new MediaStream();
  private pc: RTCPeerConnection | null = null;
  private control: RTCDataChannel | null = null;
  private readonly iceServers: () => IceServer[];
  private readonly sendSignal: (data: unknown) => void;
  private readonly meter = new ReceiveMeter();
  private pending: RTCIceCandidateInit[] = [];
  private ready = false;
  private latency: LatencyMode;
  private unstableTimer: ReturnType<typeof setTimeout> | null = null;

  onState: (state: SubscriptionState) => void = () => {};
  onTrack: (track: MediaStreamTrack) => void = () => {};
  /** La connexion ne reviendra pas seule : il faut demander au diffuseur d'en ouvrir une nouvelle. */
  onLost: () => void = () => {};
  onControl: (message: ControlToViewer) => void = () => {};

  constructor(streamId: string, ownerId: string, latency: LatencyMode, iceServers: () => IceServer[], sendSignal: (data: unknown) => void) {
    this.streamId = streamId;
    this.ownerId = ownerId;
    this.latency = latency;
    this.iceServers = iceServers;
    this.sendSignal = sendSignal;
  }

  get peer() {
    return this.pc;
  }

  private applyLatency() {
    for (const receiver of this.pc?.getReceivers() ?? []) {
      (receiver as RTCRtpReceiver & { jitterBufferTarget: number | null }).jitterBufferTarget = LATENCY_MS[this.latency];
    }
  }

  setLatency(latency: LatencyMode) {
    this.latency = latency;
    this.applyLatency();
  }

  async onSignal(data: { sdp?: RTCSessionDescriptionInit; candidate?: RTCIceCandidateInit }) {
    if (data.sdp?.type === "offer") {
      this.pc?.close();
      if (this.unstableTimer) clearTimeout(this.unstableTimer);
      this.ready = false;
      const pc = new RTCPeerConnection(rtcConfig(this.iceServers()));
      this.pc = pc;
      pc.onicecandidate = e => e.candidate && this.sendSignal({ candidate: e.candidate });
      pc.ontrack = e => {
        // Le diffuseur réserve toujours la bulle caméra après l'image et le son.
        const isCamera = e.track.kind === "video" && e.transceiver.mid !== "0";
        const target = isCamera ? this.camera : this.media;
        for (const old of target.getTracks().filter(t => t.kind === e.track.kind)) target.removeTrack(old);
        target.addTrack(e.track);
        this.applyLatency();
        if (!isCamera) this.onTrack(e.track);
      };
      pc.ondatachannel = event => {
        if (event.channel.label !== "control") return;
        this.control = event.channel;
        event.channel.onmessage = message => this.onControl(JSON.parse(message.data as string) as ControlToViewer);
      };
      pc.onconnectionstatechange = () => {
        if (pc !== this.pc) return;
        if (this.unstableTimer) clearTimeout(this.unstableTimer);
        switch (pc.connectionState) {
          case "connected":
            return this.onState("connected");
          case "disconnected":
            this.onState("unstable");
            this.unstableTimer = setTimeout(() => this.onLost(), 6000);
            return;
          case "failed":
            this.onState("failed");
            this.unstableTimer = setTimeout(() => this.onLost(), 1000);
            return;
          default:
            return;
        }
      };
      this.onState("connecting");
      await pc.setRemoteDescription(data.sdp);
      const answer = await pc.createAnswer();
      answer.sdp = tuneOpusSdp(answer.sdp!, { stereo: true, kbps: 510, dtx: false });
      await pc.setLocalDescription(answer);
      this.sendSignal({ sdp: pc.localDescription });
      this.ready = true;
      for (const candidate of this.pending.splice(0)) await pc.addIceCandidate(candidate).catch(() => {});
    } else if (data.candidate) {
      if (this.ready && this.pc) await this.pc.addIceCandidate(data.candidate).catch(() => {});
      else this.pending.push(data.candidate);
    }
  }

  sendControl(message: ControlToHost) {
    if (this.control?.readyState === "open") this.control.send(JSON.stringify(message));
  }

  async stats(): Promise<ReceiveStats | null> {
    return this.pc ? this.meter.read(this.pc).catch(() => null) : null;
  }

  close() {
    if (this.unstableTimer) clearTimeout(this.unstableTimer);
    this.pc?.close();
    this.pc = null;
    for (const stream of [this.media, this.camera]) stream.getTracks().forEach(t => stream.removeTrack(t));
  }
}
