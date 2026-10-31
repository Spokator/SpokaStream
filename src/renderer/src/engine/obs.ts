import { revealCandidates } from "./candidates.ts";

const GATHER_TIMEOUT_MS = 1500;

export interface ObsState {
  connected: boolean;
  width: number;
  height: number;
}

/**
 * La sortie d'OBS, reçue sur ce PC. Elle devient une source comme une autre : image et son passent ensuite par
 * la même publication vers chaque spectateur. OBS garde la main sur ses scènes, ses filtres et son mix.
 */
export class ObsIngest {
  private pc: RTCPeerConnection | null = null;
  private session: string | null = null;
  private media = new MediaStream();
  private readonly meter = document.createElement("video");
  /** Chromium ne fait sortir une piste distante dans Web Audio que si un élément la lit aussi. */
  private readonly sink = new Audio();
  private width = 0;
  private height = 0;

  onChange: (state: ObsState) => void = () => {};
  onEnded: () => void = () => {};
  onResize: (width: number, height: number) => void = () => {};

  constructor() {
    this.meter.muted = true;
    this.sink.muted = true;
    this.meter.onresize = () => {
      this.width = this.meter.videoWidth;
      this.height = this.meter.videoHeight;
      this.onResize(this.width, this.height);
      this.notify();
    };
  }

  get videoTrack() {
    return this.media.getVideoTracks()[0] ?? null;
  }

  get audio() {
    return this.media.getAudioTracks().length ? new MediaStream(this.media.getAudioTracks()) : null;
  }

  get size() {
    return { width: this.width || 1920, height: this.height || 1080 };
  }

  get connected() {
    return !!this.session && !!this.videoTrack;
  }

  private notify() {
    this.onChange({ connected: this.connected, width: this.width, height: this.height });
  }

  /** Rend la réponse à envoyer à OBS. Une nouvelle sortie remplace l'ancienne : OBS n'en a qu'une. */
  async accept(id: string, offer: string, addresses: string[]) {
    this.close();
    const pc = new RTCPeerConnection({ bundlePolicy: "max-bundle" });
    const media = new MediaStream();
    this.pc = pc;
    this.session = id;
    this.media = media;
    pc.ontrack = event => {
      media.addTrack(event.track);
      (event.receiver as RTCRtpReceiver & { jitterBufferTarget: number | null }).jitterBufferTarget = 0;
      if (event.track.kind === "audio") {
        this.sink.srcObject = new MediaStream([event.track]);
        void this.sink.play().catch(() => {});
      } else {
        this.meter.srcObject = new MediaStream([event.track]);
        void this.meter.play().catch(() => {});
      }
      this.notify();
    };
    pc.onconnectionstatechange = () => {
      if (pc === this.pc && (pc.connectionState === "failed" || pc.connectionState === "closed")) this.end(id);
    };
    // OBS passe tel quel. ffmpeg, lui, se présente en active et déclare une retransmission que Chromium refuse.
    await pc.setRemoteDescription({ type: "offer", sdp: offer.replace(/a=setup:\w+/g, "a=setup:actpass").replace(/^a=ssrc-group:.*\r?\n/gm, "") });
    const answer = await pc.createAnswer();
    // OBS doit ouvrir le chiffrement. Mesuré sur OBS 31 : si c'est Chromium qui l'ouvre, OBS abandonne 2 ms après la
    // connexion réseau. Cause probable, non prouvée : un premier message trop gros, découpé, qu'OBS ne recolle pas.
    answer.sdp = answer.sdp!.replace(/a=setup:active/g, "a=setup:passive");
    await pc.setLocalDescription(answer);
    await this.gathered(pc);
    return revealCandidates(pc.localDescription!.sdp, addresses);
  }

  /** WHIP n'envoie qu'une réponse : les adresses doivent toutes y être. */
  private gathered(pc: RTCPeerConnection) {
    return new Promise<void>(resolve => {
      if (pc.iceGatheringState === "complete") return resolve();
      const timer = setTimeout(resolve, GATHER_TIMEOUT_MS);
      pc.onicegatheringstatechange = () => {
        if (pc.iceGatheringState !== "complete") return;
        clearTimeout(timer);
        resolve();
      };
    });
  }

  end(id: string) {
    if (id !== this.session) return;
    this.close();
    this.onEnded();
  }

  private close() {
    const had = !!this.session;
    this.pc?.close();
    this.pc = null;
    this.session = null;
    this.width = 0;
    this.height = 0;
    this.meter.srcObject = null;
    this.sink.srcObject = null;
    if (had) this.notify();
  }
}
