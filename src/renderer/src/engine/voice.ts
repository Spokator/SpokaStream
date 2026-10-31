import type { Settings } from "@shared/ipc.ts";
import type { IceServer } from "@shared/protocol.ts";
import { rtcConfig } from "./rtc.ts";
import { tuneOpusSdp } from "./sdp.ts";

export const VOICE_SESSION = "voice";

/** Le lecteur web n'a pas de réglages : il passe seulement ce dont la voix a besoin. */
type VoiceSettings = Pick<Settings, "micId" | "noiseSuppression" | "echoCancellation" | "autoGain" | "voiceKbps">;

interface Peer {
  pc: RTCPeerConnection;
  answered: boolean;
  pending: RTCIceCandidateInit[];
}

/** Salon vocal en maillage : une connexion légère par personne, séparée des streams pour ne jamais les perturber. */
export class Voice {
  private readonly peers = new Map<string, Peer>();
  private stream: MediaStream | null = null;
  private context: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private readonly buffer = new Float32Array(1024);
  private readonly selfId: () => string;
  private readonly iceServers: () => IceServer[];
  private readonly sendSignal: (to: string, data: unknown) => void;
  private settings: VoiceSettings;
  private transmitting = true;

  onRemoteTrack: (userId: string, track: MediaStreamTrack) => void = () => {};
  onPeerGone: (userId: string) => void = () => {};

  constructor(options: { selfId: () => string; iceServers: () => IceServer[]; sendSignal: (to: string, data: unknown) => void; settings: VoiceSettings }) {
    this.selfId = options.selfId;
    this.iceServers = options.iceServers;
    this.sendSignal = options.sendSignal;
    this.settings = options.settings;
  }

  get active() {
    return !!this.stream;
  }

  private async openMicrophone() {
    const s = this.settings;
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: s.micId === "default" ? undefined : { exact: s.micId },
        noiseSuppression: s.noiseSuppression,
        echoCancellation: s.echoCancellation,
        autoGainControl: s.autoGain,
        channelCount: 1,
        sampleRate: 48000,
      },
    });
    this.context ??= new AudioContext();
    this.analyser = this.context.createAnalyser();
    this.analyser.fftSize = 1024;
    this.context.createMediaStreamSource(stream).connect(this.analyser);
    void this.context.resume();
    return stream;
  }

  async join() {
    this.stream = await this.openMicrophone();
    this.applyTransmit();
  }

  /** Bascule d'un micro à l'autre sans recouper les conversations. */
  async reconfigure(settings: Settings) {
    this.settings = settings;
    if (!this.stream) return;
    const next = await this.openMicrophone();
    const track = next.getAudioTracks()[0]!;
    for (const peer of this.peers.values()) {
      await peer.pc.getSenders().find(s => s.track?.kind === "audio")?.replaceTrack(track);
    }
    this.stream.getTracks().forEach(t => t.stop());
    this.stream = next;
    this.applyTransmit();
  }

  leave() {
    for (const id of [...this.peers.keys()]) this.dropPeer(id);
    this.stream?.getTracks().forEach(t => t.stop());
    this.stream = null;
    this.analyser = null;
  }

  setTransmitting(on: boolean) {
    this.transmitting = on;
    this.applyTransmit();
  }

  private applyTransmit() {
    for (const track of this.stream?.getAudioTracks() ?? []) track.enabled = this.transmitting;
  }

  get level() {
    if (!this.analyser) return 0;
    this.analyser.getFloatTimeDomainData(this.buffer);
    let sum = 0;
    for (const x of this.buffer) sum += x * x;
    return Math.sqrt(sum / this.buffer.length);
  }

  /** Une seule offre par paire : c'est l'identifiant le plus petit qui la fait, jamais les deux à la fois. */
  sync(otherIds: string[]) {
    if (!this.stream) return;
    const wanted = new Set(otherIds);
    for (const id of [...this.peers.keys()]) if (!wanted.has(id)) this.dropPeer(id);
    for (const id of otherIds) if (!this.peers.has(id) && this.selfId() < id) void this.call(id);
  }

  private createPeer(id: string) {
    const pc = new RTCPeerConnection(rtcConfig(this.iceServers()));
    const peer: Peer = { pc, answered: false, pending: [] };
    this.peers.set(id, peer);
    for (const track of this.stream!.getTracks()) pc.addTrack(track, this.stream!);
    pc.onicecandidate = e => e.candidate && this.sendSignal(id, { candidate: e.candidate });
    pc.ontrack = e => this.onRemoteTrack(id, e.track);
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "failed" && this.selfId() < id && this.peers.get(id)?.pc === pc) {
        this.dropPeer(id);
        void this.call(id);
      }
    };
    return peer;
  }

  private async call(id: string) {
    const peer = this.createPeer(id);
    const offer = await peer.pc.createOffer();
    await peer.pc.setLocalDescription(offer);
    this.sendSignal(id, { sdp: peer.pc.localDescription });
  }

  async onSignal(from: string, data: { sdp?: RTCSessionDescriptionInit; candidate?: RTCIceCandidateInit }) {
    if (!this.stream) return;
    const tune = (sdp: string) => tuneOpusSdp(sdp, { stereo: false, kbps: this.settings.voiceKbps, dtx: true });
    if (data.sdp?.type === "offer") {
      this.dropPeer(from);
      const peer = this.createPeer(from);
      await peer.pc.setRemoteDescription(data.sdp);
      const answer = await peer.pc.createAnswer();
      answer.sdp = tune(answer.sdp!);
      await peer.pc.setLocalDescription(answer);
      this.sendSignal(from, { sdp: peer.pc.localDescription });
      peer.answered = true;
      for (const candidate of peer.pending.splice(0)) await peer.pc.addIceCandidate(candidate).catch(() => {});
      return;
    }
    const peer = this.peers.get(from);
    if (!peer) return;
    if (data.sdp?.type === "answer") {
      await peer.pc.setRemoteDescription({ type: "answer", sdp: tune(data.sdp.sdp!) });
      peer.answered = true;
      for (const candidate of peer.pending.splice(0)) await peer.pc.addIceCandidate(candidate).catch(() => {});
    } else if (data.candidate) {
      if (peer.answered) await peer.pc.addIceCandidate(data.candidate).catch(() => {});
      else peer.pending.push(data.candidate);
    }
  }

  private dropPeer(id: string) {
    const peer = this.peers.get(id);
    if (!peer) return;
    peer.pc.close();
    this.peers.delete(id);
    this.onPeerGone(id);
  }
}
