// MediaRecorder écrit un MP4 fragmenté : un en-tête, puis des fragments qui commencent chacun sur une image clé.
// Garder les N dernières secondes revient donc à garder l'en-tête et les derniers fragments, sans rien réencoder.

export interface Fragment {
  /** moof + mdat. */
  bytes: Uint8Array;
  at: number;
}

const text = new TextDecoder("latin1");

const u32 = (b: Uint8Array, o: number) => new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(o);
const boxType = (b: Uint8Array, o: number) => text.decode(b.subarray(o + 4, o + 8));

function boxSize(b: Uint8Array, o: number) {
  const size = u32(b, o);
  if (size === 1) return Number(new DataView(b.buffer, b.byteOffset, b.byteLength).getBigUint64(o + 8));
  return size;
}

function* children(b: Uint8Array, start: number, end: number) {
  for (let o = start; o + 8 <= end; ) {
    const size = boxSize(b, o);
    if (size < 8) return;
    yield { type: boxType(b, o), start: o, end: o + size };
    o += size;
  }
}

function child(b: Uint8Array, parent: { start: number; end: number }, type: string) {
  for (const box of children(b, parent.start + 8, parent.end)) if (box.type === type) return box;
  return null;
}

/** Découpe le flux de MediaRecorder en boîtes, quelle que soit la façon dont il arrive par morceaux. */
export class Mp4Splitter {
  header: Uint8Array | null = null;
  private pending = new Uint8Array(0);
  private headerParts: Uint8Array[] = [];
  private moof: Uint8Array | null = null;

  /** Rend les fragments complets arrivés avec ce morceau. */
  push(chunk: Uint8Array, at: number): Fragment[] {
    const joined = new Uint8Array(this.pending.length + chunk.length);
    joined.set(this.pending);
    joined.set(chunk, this.pending.length);
    const done: Fragment[] = [];
    let offset = 0;
    while (joined.length - offset >= 16) {
      const size = boxSize(joined, offset);
      if (size < 8 || offset + size > joined.length) break;
      const box = joined.subarray(offset, offset + size);
      const type = boxType(joined, offset);
      offset += size;
      if (type === "ftyp" || type === "moov") {
        this.headerParts.push(box);
        if (type === "moov") this.header = concat(this.headerParts);
      } else if (type === "moof") {
        this.moof = box;
      } else if (type === "mdat" && this.moof) {
        done.push({ bytes: concat([this.moof, box]), at });
        this.moof = null;
      }
    }
    this.pending = joined.slice(offset);
    return done;
  }
}

function concat(parts: Uint8Array[]) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function timescales(header: Uint8Array) {
  const scales = new Map<number, number>();
  const moov = [...children(header, 0, header.length)].find(b => b.type === "moov");
  if (!moov) return scales;
  for (const trak of children(header, moov.start + 8, moov.end)) {
    if (trak.type !== "trak") continue;
    const tkhd = child(header, trak, "tkhd");
    const mdia = child(header, trak, "mdia");
    const mdhd = mdia && child(header, mdia, "mdhd");
    if (!tkhd || !mdhd) continue;
    const tkhdVersion = header[tkhd.start + 8]!;
    const mdhdVersion = header[mdhd.start + 8]!;
    scales.set(u32(header, tkhd.start + (tkhdVersion ? 28 : 20)), u32(header, mdhd.start + (mdhdVersion ? 28 : 20)));
  }
  return scales;
}

function tracksOf(bytes: Uint8Array) {
  const moof = [...children(bytes, 0, bytes.length)].find(b => b.type === "moof");
  if (!moof) return [];
  const tracks: { id: number; tfdt: number; version: number; time: number }[] = [];
  for (const traf of children(bytes, moof.start + 8, moof.end)) {
    if (traf.type !== "traf") continue;
    const tfhd = child(bytes, traf, "tfhd");
    const tfdt = child(bytes, traf, "tfdt");
    if (!tfhd || !tfdt) continue;
    const version = bytes[tfdt.start + 8]!;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const time = version ? Number(view.getBigUint64(tfdt.start + 12)) : view.getUint32(tfdt.start + 12);
    tracks.push({ id: u32(bytes, tfhd.start + 12), tfdt: tfdt.start, version, time });
  }
  return tracks;
}

/** Durée entre le début du premier fragment et le début du dernier, en secondes. */
export function fragmentSpan(header: Uint8Array, fragments: Fragment[]) {
  if (fragments.length < 2) return 0;
  const scales = timescales(header);
  const first = tracksOf(fragments[0]!.bytes)[0];
  const last = tracksOf(fragments[fragments.length - 1]!.bytes)[0];
  const scale = first && scales.get(first.id);
  return first && last && scale ? (last.time - first.time) / scale : 0;
}

/** Assemble un fichier autonome : le temps repart de zéro, en gardant l'écart exact entre l'image et le son. */
export function assembleClip(header: Uint8Array, fragments: Fragment[]) {
  const scales = timescales(header);
  const firstTracks = tracksOf(fragments[0]!.bytes);
  const startSeconds = Math.min(...firstTracks.map(t => t.time / (scales.get(t.id) ?? 1)));
  const out = concat([header, ...fragments.map(f => f.bytes)]);
  const view = new DataView(out.buffer);
  let offset = header.length;
  fragments.forEach((fragment, index) => {
    const bytes = out.subarray(offset, offset + fragment.bytes.length);
    const moof = [...children(bytes, 0, bytes.length)].find(b => b.type === "moof")!;
    const mfhd = child(bytes, moof, "mfhd");
    if (mfhd) view.setUint32(offset + mfhd.start + 12, index + 1);
    for (const track of tracksOf(bytes)) {
      const shifted = Math.max(0, track.time - Math.round(startSeconds * (scales.get(track.id) ?? 1)));
      if (track.version) view.setBigUint64(offset + track.tfdt + 12, BigInt(shifted));
      else view.setUint32(offset + track.tfdt + 12, shifted);
    }
    offset += fragment.bytes.length;
  });
  return out;
}
