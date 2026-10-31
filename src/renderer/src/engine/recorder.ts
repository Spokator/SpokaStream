const FORMATS = [
  { mime: "video/x-matroska;codecs=avc1,opus", extension: "mkv" },
  { mime: "video/webm;codecs=h264,opus", extension: "webm" },
  { mime: "video/webm;codecs=vp9,opus", extension: "webm" },
];

const stamp = () => new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
const safeName = (name: string) => name.replace(/[^\p{L}\p{N} _-]/gu, "").trim().slice(0, 40) || "stream";

/** Enregistrement sur disque au fil de l'eau : un plantage ne fait perdre que la dernière seconde. */
export class Recorder {
  private recorder: MediaRecorder | null = null;
  private id = 0;
  private queue: Promise<void> = Promise.resolve();
  path = "";

  async start(stream: MediaStream, name: string, kbps: number) {
    const format = FORMATS.find(f => MediaRecorder.isTypeSupported(f.mime));
    if (!format) throw new Error("Aucun format d'enregistrement disponible.");
    const opened = await window.spoka.recordStart(`${safeName(name)} ${stamp()}.${format.extension}`);
    this.id = opened.id;
    this.path = opened.path;
    this.recorder = new MediaRecorder(stream, { mimeType: format.mime, videoBitsPerSecond: Math.max(4000, kbps) * 1000, audioBitsPerSecond: 256_000 });
    this.recorder.ondataavailable = event => {
      if (!event.data.size) return;
      this.queue = this.queue.then(async () => window.spoka.recordWrite(this.id, await event.data.arrayBuffer()));
    };
    this.recorder.start(1000);
  }

  async stop() {
    const recorder = this.recorder;
    if (!recorder) return;
    this.recorder = null;
    await new Promise<void>(resolve => {
      recorder.onstop = () => resolve();
      recorder.stop();
    });
    await this.queue;
    await window.spoka.recordStop(this.id);
  }
}

export async function saveClipFile(data: Uint8Array, name: string) {
  const opened = await window.spoka.recordStart(`Clip ${safeName(name)} ${stamp()}.mp4`);
  await window.spoka.recordWrite(opened.id, data.slice().buffer);
  await window.spoka.recordStop(opened.id);
  return opened.path;
}

export async function saveVideoFrame(video: HTMLVideoElement, name: string) {
  const canvas = document.createElement("canvas");
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  canvas.getContext("2d")!.drawImage(video, 0, 0);
  const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, "image/png"));
  if (!blob) throw new Error("Image illisible.");
  return window.spoka.saveScreenshot(`${safeName(name)} ${stamp()}.png`, await blob.arrayBuffer());
}
