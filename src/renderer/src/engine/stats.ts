export interface PathInfo {
  relay: boolean;
  protocol: string;
  rttMs: number | null;
}

export interface SendStats {
  width: number;
  height: number;
  fps: number;
  kbps: number;
  targetKbps: number;
  codec: string;
  encoder: string;
  hardware: boolean;
  encMs: number | null;
  limit: string;
  retransmitPct: number;
  path: PathInfo | null;
}

export interface ReceiveStats {
  width: number;
  height: number;
  fps: number;
  kbps: number;
  audioKbps: number;
  codec: string;
  decoder: string;
  hardware: boolean;
  lostPct: number;
  jitterMs: number;
  bufferMs: number | null;
  freezes: number;
  dropped: number;
  path: PathInfo | null;
}

interface Previous {
  bytes: number;
  audioBytes: number;
  at: number;
  sent: number;
  retransmitted: number;
  received: number;
  lost: number;
  bufferDelay: number;
  bufferEmitted: number;
}

const blank = (): Previous => ({ bytes: 0, audioBytes: 0, at: 0, sent: 0, retransmitted: 0, received: 0, lost: 0, bufferDelay: 0, bufferEmitted: 0 });

type Row = Record<string, unknown> & { type: string; kind?: string; id: string; timestamp: number };

function pathOf(report: RTCStatsReport): PathInfo | null {
  let pair: Row | undefined;
  report.forEach((r: Row) => {
    if (r.type === "transport" && r.selectedCandidatePairId) pair = report.get(r.selectedCandidatePairId as string) as Row;
  });
  if (!pair) {
    report.forEach((r: Row) => {
      if (r.type === "candidate-pair" && r.nominated && r.state === "succeeded") pair = r;
    });
  }
  if (!pair) return null;
  const local = report.get(pair.localCandidateId as string) as Row | undefined;
  const remote = report.get(pair.remoteCandidateId as string) as Row | undefined;
  const relay = local?.candidateType === "relay" || remote?.candidateType === "relay";
  const protocol = String((local?.candidateType === "relay" ? local?.relayProtocol : local?.protocol) ?? "");
  const rtt = pair.currentRoundTripTime as number | undefined;
  return { relay, protocol, rttMs: rtt != null ? Math.round(rtt * 1000) : null };
}

export class SendMeter {
  private previous = blank();

  async read(pc: RTCPeerConnection): Promise<SendStats | null> {
    const report = await pc.getStats();
    let result: SendStats | null = null;
    report.forEach((r: Row) => {
      if (r.type !== "outbound-rtp" || r.kind !== "video") return;
      const now = r.timestamp;
      const bytes = Number(r.bytesSent ?? 0);
      const sent = Number(r.packetsSent ?? 0);
      const retransmitted = Number(r.retransmittedPacketsSent ?? 0);
      const p = this.previous;
      const seconds = p.at ? (now - p.at) / 1000 : 0;
      const implementation = String(r.encoderImplementation ?? "");
      const framesEncoded = Number(r.framesEncoded ?? 0);
      const packets = sent - p.sent;
      result = {
        width: Number(r.frameWidth ?? 0),
        height: Number(r.frameHeight ?? 0),
        fps: Math.round(Number(r.framesPerSecond ?? 0)),
        kbps: seconds > 0 ? Math.round(((bytes - p.bytes) * 8) / seconds / 1000) : 0,
        targetKbps: Math.round(Number(r.targetBitrate ?? 0) / 1000),
        codec: String((report.get(r.codecId as string) as Row | undefined)?.mimeType ?? "").replace("video/", ""),
        encoder: implementation,
        hardware: r.powerEfficientEncoder === true || /external|hardware|mediafoundation/i.test(implementation),
        encMs: framesEncoded ? Math.round((Number(r.totalEncodeTime ?? 0) / framesEncoded) * 1000) : null,
        limit: String(r.qualityLimitationReason ?? "none"),
        retransmitPct: packets > 0 ? +(((retransmitted - p.retransmitted) / packets) * 100).toFixed(1) : 0,
        path: pathOf(report),
      };
      this.previous = { ...blank(), bytes, at: now, sent, retransmitted };
    });
    return result;
  }
}

export class ReceiveMeter {
  private previous = blank();

  async read(pc: RTCPeerConnection): Promise<ReceiveStats | null> {
    const report = await pc.getStats();
    let video: Row | undefined;
    let audio: Row | undefined;
    report.forEach((r: Row) => {
      if (r.type !== "inbound-rtp") return;
      if (r.kind === "video") video = r;
      else if (r.kind === "audio") audio = r;
    });
    if (!video && !audio) return null;
    const v: Row = video ?? audio!;
    const now = v.timestamp;
    const p = this.previous;
    const seconds = p.at ? (now - p.at) / 1000 : 0;
    const bytes = Number(video?.bytesReceived ?? 0);
    const audioBytes = Number(audio?.bytesReceived ?? 0);
    const received = Number(video?.packetsReceived ?? 0);
    const lost = Number(video?.packetsLost ?? 0);
    const bufferDelay = Number(video?.jitterBufferDelay ?? 0);
    const bufferEmitted = Number(video?.jitterBufferEmittedCount ?? 0);
    const packets = received - p.received + (lost - p.lost);
    const implementation = String(video?.decoderImplementation ?? "");
    const result: ReceiveStats = {
      width: Number(video?.frameWidth ?? 0),
      height: Number(video?.frameHeight ?? 0),
      fps: Math.round(Number(video?.framesPerSecond ?? 0)),
      kbps: seconds > 0 ? Math.round(((bytes - p.bytes) * 8) / seconds / 1000) : 0,
      audioKbps: seconds > 0 ? Math.round(((audioBytes - p.audioBytes) * 8) / seconds / 1000) : 0,
      codec: String((report.get(video?.codecId as string) as Row | undefined)?.mimeType ?? "").replace("video/", ""),
      decoder: implementation,
      hardware: video?.powerEfficientDecoder === true || /external|hardware|d3d11|mediafoundation/i.test(implementation),
      lostPct: packets > 0 ? +(((lost - p.lost) / packets) * 100).toFixed(1) : 0,
      jitterMs: Math.round(Number(video?.jitter ?? 0) * 1000),
      bufferMs: bufferEmitted > p.bufferEmitted ? Math.round(((bufferDelay - p.bufferDelay) / (bufferEmitted - p.bufferEmitted)) * 1000) : null,
      freezes: Number(video?.freezeCount ?? 0),
      dropped: Number(video?.framesDropped ?? 0),
      path: pathOf(report),
    };
    this.previous = { ...blank(), bytes, audioBytes, at: now, received, lost, bufferDelay, bufferEmitted };
    return result;
  }
}
