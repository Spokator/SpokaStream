// Réglages que WebRTC n'expose que par le SDP. Chrome applique ces limites depuis le SDP DISTANT :
// c'est donc la réponse du spectateur qu'on annote avant de l'appliquer, côté diffuseur.

/** Plafond négocié une fois pour toutes : le débit réel se pilote ensuite à chaud, sans renégocier. */
export const NEGOTIATED_CEILING_KBPS = 300_000;

const VIDEO_CODECS = /^a=rtpmap:(\d+) (H264|H265|VP8|VP9|AV1)\//gm;

export function tuneVideoSdp(sdp: string, startKbps: number, ceilingKbps = NEGOTIATED_CEILING_KBPS) {
  const params = `x-google-start-bitrate=${Math.round(startKbps)};x-google-min-bitrate=${Math.min(800, Math.round(startKbps))};x-google-max-bitrate=${ceilingKbps}`;
  return sdp
    .split(/(?=^m=)/m)
    .map(section => {
      if (!section.startsWith("m=video")) return section;
      const payloads = [...section.matchAll(VIDEO_CODECS)].map(m => m[1]!);
      const lines = section.split("\r\n");
      const trailing = lines.at(-1) === "";
      if (trailing) lines.pop();
      const seen = new Set<string>();
      const out: string[] = [];
      for (const line of lines) {
        const fmtp = line.match(/^a=fmtp:(\d+) /);
        if (fmtp && payloads.includes(fmtp[1]!)) {
          seen.add(fmtp[1]!);
          out.push(`${line};${params}`);
          continue;
        }
        if (line.startsWith("b=AS:") || line.startsWith("b=TIAS:")) continue;
        out.push(line);
        if (line.startsWith("c=")) out.push(`b=AS:${ceilingKbps + 1000}`, `b=TIAS:${(ceilingKbps + 1000) * 1000}`);
      }
      for (const pt of payloads) if (!seen.has(pt)) out.push(`a=fmtp:${pt} ${params}`);
      if (trailing) out.push("");
      return out.join("\r\n");
    })
    .join("");
}

export interface OpusOptions {
  stereo: boolean;
  kbps: number;
  dtx: boolean;
}

export function tuneOpusSdp(sdp: string, options: OpusOptions) {
  const opus = sdp.match(/^a=rtpmap:(\d+) opus\/48000/m)?.[1];
  if (!opus) return sdp;
  const wanted: Record<string, string> = {
    stereo: options.stereo ? "1" : "0",
    "sprop-stereo": options.stereo ? "1" : "0",
    maxaveragebitrate: String(options.kbps * 1000),
    maxplaybackrate: "48000",
    cbr: "0",
    useinbandfec: "1",
    usedtx: options.dtx ? "1" : "0",
  };
  return sdp.replace(new RegExp(`^a=fmtp:${opus} (.*)$`, "m"), (_line, current: string) => {
    const merged = new Map(current.trim().split(";").map(pair => pair.split("=") as [string, string]));
    for (const [key, value] of Object.entries(wanted)) merged.set(key, value);
    return `a=fmtp:${opus} ${[...merged].map(([k, v]) => `${k}=${v}`).join(";")}`;
  });
}
