import type { CaptureSource } from "@shared/ipc.ts";
import NativeVideoWorker from "./nativeVideo.worker.ts?worker&inline";

declare class MediaStreamTrackGenerator extends MediaStreamTrack {
  constructor(init: { kind: "video" });
  readonly writable: WritableStream<VideoFrame>;
}

export type VideoSource =
  | { kind: "screen"; source: CaptureSource }
  | { kind: "window"; source: CaptureSource }
  | { kind: "camera"; deviceId: string; label: string }
  | { kind: "file"; file: File };

export interface OpenedSource {
  track: MediaStreamTrack;
  name: string;
  kind: VideoSource["kind"];
  /** Son propre à la source (un fichier vidéo). */
  audio: MediaStream | null;
  element: HTMLVideoElement | null;
  /** true : images du moteur natif, qui dépasse les ~47 i/s de la capture de Chromium. */
  native: boolean;
  width: number;
  height: number;
  /** La source a disparu : fenêtre fermée, écran débranché. */
  onEnded(listener: () => void): void;
  /** Taille réelle des images, quand une fenêtre est redimensionnée par exemple. */
  onResize(listener: (width: number, height: number) => void): void;
  configure(fps: number, maxHeight: number): void;
  stop(): void;
}

const NATIVE_START_TIMEOUT_MS = 3000;

async function openNative(source: CaptureSource, fps: number, maxHeight: number): Promise<OpenedSource | null> {
  if (!("MediaStreamTrackGenerator" in window)) return null;
  const started = await window.spoka.startNativeVideo({ sourceId: source.id, displayId: source.displayId, fps, maxHeight });
  if (!started) return null;

  const generator = new MediaStreamTrackGenerator({ kind: "video" });
  const worker = new NativeVideoWorker();
  let endedListener = () => {};
  let resizeListener = (_width: number, _height: number) => {};
  let width = started.width;
  let height = started.height;
  let stopped = false;

  const firstFrame = new Promise<boolean>(resolve => {
    const timer = setTimeout(() => resolve(false), NATIVE_START_TIMEOUT_MS);
    worker.onmessage = (event: MessageEvent<{ type: string; width: number; height: number }>) => {
      if (event.data.type === "size") {
        clearTimeout(timer);
        resolve(true);
        width = event.data.width;
        height = event.data.height;
        resizeListener(width, height);
      } else if (event.data.type === "closed" && !stopped) {
        clearTimeout(timer);
        resolve(false);
        endedListener();
      }
    };
  });
  worker.postMessage({ writable: generator.writable, url: started.url }, [generator.writable]);
  const offEnded = window.spoka.onNativeVideoEnded(url => {
    if (url === started.url && !stopped) endedListener();
  });
  const stop = () => {
    if (stopped) return;
    stopped = true;
    offEnded();
    worker.terminate();
    generator.stop();
    void window.spoka.stopNativeVideo(started.url);
  };

  if (!(await firstFrame)) {
    stop();
    return null;
  }
  return {
    track: generator,
    name: source.name,
    kind: source.kind,
    audio: null,
    element: null,
    native: true,
    get width() {
      return width;
    },
    get height() {
      return height;
    },
    onEnded: listener => (endedListener = listener),
    onResize: listener => (resizeListener = listener),
    configure: (nextFps, nextHeight) => void window.spoka.configureNativeVideo(nextFps, nextHeight),
    stop,
  };
}

export async function openSource(source: VideoSource, fps: number, maxHeight: number): Promise<OpenedSource> {
  if (source.kind === "screen" || source.kind === "window") {
    const native = await openNative(source.source, fps, maxHeight).catch(e => {
      console.warn("capture native :", e);
      return null;
    });
    if (native) return native;
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        // Pas de maxWidth : pour une fenêtre, Chromium agrandirait l'image jusqu'à cette limite au lieu de garder la taille réelle.
        mandatory: {
          chromeMediaSource: "desktop",
          chromeMediaSourceId: source.source.id,
          minFrameRate: Math.min(30, fps),
          maxFrameRate: fps,
        },
      } as MediaTrackConstraints,
    });
    const track = stream.getVideoTracks()[0]!;
    return fromTrack(track, source.source.name, source.kind);
  }
  if (source.kind === "camera") {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { deviceId: { exact: source.deviceId }, width: { ideal: 3840 }, height: { ideal: 2160 }, frameRate: { ideal: fps } },
    });
    return fromTrack(stream.getVideoTracks()[0]!, source.label, "camera");
  }
  const url = URL.createObjectURL(source.file);
  const element = document.createElement("video");
  element.src = url;
  element.loop = true;
  element.playsInline = true;
  await element.play();
  const stream = (element as HTMLVideoElement & { captureStream(): MediaStream }).captureStream();
  const track = stream.getVideoTracks()[0];
  if (!track) {
    element.pause();
    URL.revokeObjectURL(url);
    throw new Error("Ce fichier ne contient pas d'image lisible.");
  }
  const audioTracks = stream.getAudioTracks();
  return {
    ...fromTrack(track, source.file.name, "file"),
    audio: audioTracks.length ? new MediaStream(audioTracks) : null,
    element,
    stop: () => {
      element.pause();
      element.removeAttribute("src");
      element.load();
      URL.revokeObjectURL(url);
    },
  };
}

function fromTrack(track: MediaStreamTrack, name: string, kind: VideoSource["kind"]): OpenedSource {
  const settings = track.getSettings();
  return {
    track,
    name,
    kind,
    audio: null,
    element: null,
    native: false,
    width: settings.width ?? 1920,
    height: settings.height ?? 1080,
    onEnded: listener => (track.onended = listener),
    onResize: () => {},
    configure: () => {},
    stop: () => track.stop(),
  };
}

/** Image envoyée pendant une pause : l'écran réel cesse d'être capturé pour les spectateurs. */
export function createPauseCard() {
  const canvas = document.createElement("canvas");
  canvas.width = 1280;
  canvas.height = 720;
  const ctx = canvas.getContext("2d")!;
  const paint = () => {
    const gradient = ctx.createLinearGradient(0, 0, 1280, 720);
    gradient.addColorStop(0, "#14162a");
    gradient.addColorStop(1, "#0d1422");
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, 1280, 720);
    ctx.fillStyle = "#f1f3f9";
    ctx.textAlign = "center";
    ctx.font = "600 48px 'Inter Variable', 'Segoe UI', sans-serif";
    ctx.fillText("Stream en pause", 640, 350);
    ctx.fillStyle = "#9aa3b8";
    ctx.font = "400 26px 'Inter Variable', 'Segoe UI', sans-serif";
    ctx.fillText("Ça reprend dans un instant", 640, 400);
  };
  paint();
  const stream = canvas.captureStream(4);
  const track = stream.getVideoTracks()[0]!;
  track.contentHint = "detail";
  const timer = setInterval(paint, 500);
  return {
    track,
    stop() {
      clearInterval(timer);
      track.stop();
    },
  };
}

export function captureThumbnail(video: HTMLVideoElement) {
  if (!video.videoWidth) return null;
  const canvas = document.createElement("canvas");
  canvas.width = 384;
  canvas.height = Math.round((384 * video.videoHeight) / video.videoWidth);
  canvas.getContext("2d")!.drawImage(video, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/jpeg", 0.62);
}
