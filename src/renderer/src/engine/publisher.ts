import type { CodecChoice, VideoPriority } from "@shared/ipc.ts";
import { DEFAULT_VIEWER_QUALITY } from "@shared/protocol.ts";
import type { IceServer, ViewerQuality } from "@shared/protocol.ts";
import { rtcConfig } from "./rtc.ts";
import { codecPreferences } from "./encoders.ts";
import type { BenchResult } from "./encoders.ts";
import { tuneOpusSdp, tuneVideoSdp } from "./sdp.ts";
import { SendMeter } from "./stats.ts";
import type { SendStats } from "./stats.ts";

const TCP_RELAY_CAP_KBPS = 4000;
const CAMERA_KBPS = 700;

export interface EncodingTarget {
  kbps: number;
  /** Plafond imposé par le salon. 0 = aucun. */
  roomMaxKbps: number;
  fps: number;
  maxHeight: number;
  priority: VideoPriority;
  codec: CodecChoice;
  audioKbps: number;
}

interface Viewer {
  id: string;
  pc: RTCPeerConnection;
  video: RTCRtpSender;
  audio: RTCRtpSender | null;
  /** Réservé dès la connexion : la caméra s'allume et s'éteint ensuite sans renégocier. */
  camera: RTCRtpSender;
  quality: ViewerQuality;
  meter: SendMeter;
  stats: SendStats | null;
  state: RTCPeerConnectionState;
  tcpRelay: boolean;
  answered: boolean;
  pending: RTCIceCandidateInit[];
}

export interface ViewerView {
  id: string;
  state: RTCPeerConnectionState;
  quality: ViewerQuality;
  stats: SendStats | null;
}

/** En maillage, chaque spectateur a son propre encodage : on peut lui donner exactement ce que sa connexion supporte. */
export class Publisher {
  private readonly viewers = new Map<string, Viewer>();
  private videoTrack: MediaStreamTrack;
  private cameraTrack: MediaStreamTrack | null = null;
  private readonly audioTrack: MediaStreamTrack | null;
  private readonly mediaStream: MediaStream;
  private readonly session: string;
  private readonly iceServers: () => IceServer[];
  private readonly sendSignal: (to: string, data: unknown) => void;
  private target: EncodingTarget;
  private bench: BenchResult[];
  private sourceHeight: number;

  constructor(options: {
    session: string;
    video: MediaStreamTrack;
    sourceHeight: number;
    audio: MediaStreamTrack | null;
    target: EncodingTarget;
    bench: BenchResult[];
    iceServers: () => IceServer[];
    sendSignal: (to: string, data: unknown) => void;
  }) {
    this.session = options.session;
    this.videoTrack = options.video;
    this.audioTrack = options.audio;
    this.target = options.target;
    this.bench = options.bench;
    this.iceServers = options.iceServers;
    this.sendSignal = options.sendSignal;
    this.mediaStream = new MediaStream([options.video, ...(options.audio ? [options.audio] : [])]);
    this.sourceHeight = options.sourceHeight;
  }

  get viewerList(): ViewerView[] {
    return [...this.viewers.values()].map(v => ({ id: v.id, state: v.state, quality: v.quality, stats: v.stats }));
  }

  get peers() {
    return [...this.viewers.entries()].map(([id, v]) => ({ id, pc: v.pc }));
  }

  async addViewer(id: string, quality: ViewerQuality | null) {
    this.removeViewer(id);
    const pc = new RTCPeerConnection(rtcConfig(this.iceServers()));
    const video = pc.addTrack(this.videoTrack, this.mediaStream);
    const audio = this.audioTrack ? pc.addTrack(this.audioTrack, this.mediaStream) : null;
    const cameraTransceiver = pc.addTransceiver("video", { direction: "sendonly" });
    const viewer: Viewer = {
      id,
      pc,
      video,
      audio,
      camera: cameraTransceiver.sender,
      quality: quality ?? DEFAULT_VIEWER_QUALITY,
      meter: new SendMeter(),
      stats: null,
      state: "new",
      tcpRelay: false,
      answered: false,
      pending: [],
    };
    this.viewers.set(id, viewer);
    pc.onicecandidate = e => e.candidate && this.sendSignal(id, { candidate: e.candidate });
    pc.onconnectionstatechange = () => {
      viewer.state = pc.connectionState;
    };
    pc.getTransceivers().find(t => t.sender === video)?.setCodecPreferences(codecPreferences(this.bench, this.target.codec));
    await this.applyEncoding(viewer);
    if (!viewer.quality.video) await video.replaceTrack(null);
    else if (this.cameraTrack) await viewer.camera.replaceTrack(this.cameraTrack);
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    this.sendSignal(id, { sdp: pc.localDescription });
  }

  removeViewer(id: string) {
    const viewer = this.viewers.get(id);
    if (!viewer) return;
    viewer.pc.close();
    this.viewers.delete(id);
  }

  async onSignal(from: string, data: { sdp?: RTCSessionDescriptionInit; candidate?: RTCIceCandidateInit }) {
    const viewer = this.viewers.get(from);
    if (!viewer) return;
    if (data.sdp?.type === "answer") {
      const video = tuneVideoSdp(data.sdp.sdp!, Math.max(1000, this.effectiveKbps(viewer) * 0.6));
      const sdp = tuneOpusSdp(video, { stereo: true, kbps: this.target.audioKbps, dtx: false });
      await viewer.pc.setRemoteDescription({ type: "answer", sdp });
      viewer.answered = true;
      for (const candidate of viewer.pending.splice(0)) await viewer.pc.addIceCandidate(candidate).catch(() => {});
      await this.applyEncoding(viewer);
    } else if (data.candidate) {
      if (viewer.answered) await viewer.pc.addIceCandidate(data.candidate).catch(() => {});
      else viewer.pending.push(data.candidate);
    }
  }

  private effectiveKbps(viewer: Viewer) {
    const limits = [this.target.kbps];
    if (this.target.roomMaxKbps > 0) limits.push(this.target.roomMaxKbps);
    if (viewer.quality.maxKbps > 0) limits.push(viewer.quality.maxKbps);
    // Un relais TCP retransmet tout ce qui se perd : au-delà, l'image saccade au lieu de s'améliorer.
    if (viewer.tcpRelay) limits.push(TCP_RELAY_CAP_KBPS);
    return Math.min(...limits);
  }

  private async applyEncoding(viewer: Viewer) {
    const parameters = viewer.video.getParameters();
    if (!parameters.encodings?.length) parameters.encodings = [{}];
    const encoding = parameters.encodings[0]!;
    const heights = [this.target.maxHeight, viewer.quality.maxHeight].filter(h => h > 0);
    const height = Math.min(this.sourceHeight, ...heights);
    encoding.maxBitrate = this.effectiveKbps(viewer) * 1000;
    // La cadence du stream est tenue à la source : pile à 60, le limiteur de WebRTC jette des images au moindre écart.
    encoding.maxFramerate = viewer.quality.maxFps > 0 ? Math.min(viewer.quality.maxFps, this.target.fps) : Math.ceil(this.target.fps * 1.1);
    encoding.scaleResolutionDownBy = Math.max(1, this.sourceHeight / height);
    encoding.priority = "high";
    encoding.networkPriority = "high";
    parameters.degradationPreference = this.target.priority === "detail" ? "maintain-resolution" : "maintain-framerate";
    await viewer.video.setParameters(parameters).catch(e => console.warn("encodage :", e));
    if (viewer.audio) {
      const audioParameters = viewer.audio.getParameters();
      if (!audioParameters.encodings?.length) audioParameters.encodings = [{}];
      audioParameters.encodings[0]!.maxBitrate = this.target.audioKbps * 1000;
      audioParameters.encodings[0]!.priority = "high";
      audioParameters.encodings[0]!.networkPriority = "high";
      await viewer.audio.setParameters(audioParameters).catch(() => {});
    }
    if (this.cameraTrack) {
      const cameraParameters = viewer.camera.getParameters();
      if (cameraParameters.encodings?.length) {
        cameraParameters.encodings[0]!.maxBitrate = CAMERA_KBPS * 1000;
        cameraParameters.encodings[0]!.maxFramerate = 30;
        await viewer.camera.setParameters(cameraParameters).catch(() => {});
      }
    }
  }

  /** La bulle reste légère : elle coûte moins que le son, et un spectateur « son seul » ne la reçoit pas. */
  async setCamera(track: MediaStreamTrack | null) {
    this.cameraTrack = track;
    for (const viewer of this.viewers.values()) {
      await viewer.camera.replaceTrack(viewer.quality.video ? track : null);
      await this.applyEncoding(viewer);
    }
  }

  /** Changement à chaud : le spectateur ne voit qu'une image qui change, jamais de coupure. */
  async applyTarget(target: EncodingTarget, bench: BenchResult[]) {
    const codecChanged = target.codec !== this.target.codec;
    this.target = target;
    this.bench = bench;
    for (const viewer of this.viewers.values()) await this.applyEncoding(viewer);
    if (codecChanged) for (const viewer of [...this.viewers.values()]) await this.addViewer(viewer.id, viewer.quality);
  }

  async setQuality(id: string, quality: ViewerQuality) {
    const viewer = this.viewers.get(id);
    if (!viewer) return;
    const wasVideo = viewer.quality.video;
    viewer.quality = quality;
    if (wasVideo !== quality.video) {
      await viewer.video.replaceTrack(quality.video ? this.videoTrack : null);
      await viewer.camera.replaceTrack(quality.video ? this.cameraTrack : null);
    }
    await this.applyEncoding(viewer);
  }

  /** Une fenêtre redimensionnée change la taille de la source : les réductions par spectateur se recalculent. */
  async setSourceHeight(height: number) {
    this.sourceHeight = height;
    for (const viewer of this.viewers.values()) await this.applyEncoding(viewer);
  }

  async replaceVideo(track: MediaStreamTrack, sourceHeight: number) {
    this.videoTrack = track;
    this.sourceHeight = sourceHeight;
    for (const stream of this.mediaStream.getVideoTracks()) this.mediaStream.removeTrack(stream);
    this.mediaStream.addTrack(track);
    for (const viewer of this.viewers.values()) {
      if (viewer.quality.video) await viewer.video.replaceTrack(track);
      await this.applyEncoding(viewer);
    }
  }

  /** Met à jour les mesures et rend celles du spectateur le mieux servi. */
  async pollStats() {
    let best: SendStats | null = null;
    for (const viewer of this.viewers.values()) {
      viewer.stats = await viewer.meter.read(viewer.pc).catch(() => null);
      const onTcpRelay = viewer.stats?.path?.relay === true && viewer.stats.path.protocol === "tcp";
      if (onTcpRelay !== viewer.tcpRelay) {
        viewer.tcpRelay = onTcpRelay;
        await this.applyEncoding(viewer);
      }
      if (viewer.stats && (!best || viewer.stats.kbps > best.kbps)) best = viewer.stats;
    }
    return best;
  }

  close() {
    for (const id of [...this.viewers.keys()]) this.removeViewer(id);
  }

  get sessionId() {
    return this.session;
  }
}
