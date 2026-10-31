import { LIMITS } from "@shared/protocol.ts";

const MAX_SIDE = 1280;

function shrink(canvas: HTMLCanvasElement) {
  for (const quality of [0.82, 0.7, 0.55, 0.4]) {
    const data = canvas.toDataURL("image/webp", quality);
    if (data.length <= LIMITS.image) return data;
  }
  return null;
}

function draw(source: CanvasImageSource, width: number, height: number) {
  const scale = Math.min(1, MAX_SIDE / Math.max(width, height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(width * scale);
  canvas.height = Math.round(height * scale);
  canvas.getContext("2d")!.drawImage(source, 0, 0, canvas.width, canvas.height);
  return canvas;
}

/** Une image collée dans le chat passe par le serveur : elle est réduite ici, chez celui qui l'envoie. */
export async function compressImage(file: Blob) {
  const bitmap = await createImageBitmap(file);
  const canvas = draw(bitmap, bitmap.width, bitmap.height);
  bitmap.close();
  return shrink(canvas);
}

/** La vignette d'un clip passe par le serveur : petite, et sans transparence à garder. */
export function clipThumb(video: HTMLVideoElement) {
  if (!video.videoWidth) return null;
  const canvas = document.createElement("canvas");
  canvas.width = 360;
  canvas.height = Math.round((360 * video.videoHeight) / video.videoWidth);
  canvas.getContext("2d")!.drawImage(video, 0, 0, canvas.width, canvas.height);
  const data = canvas.toDataURL("image/jpeg", 0.7);
  return data.length <= LIMITS.clipThumb ? data : null;
}

export async function frameForChat(video: HTMLVideoElement) {
  return video.videoWidth ? shrink(draw(video, video.videoWidth, video.videoHeight)) : null;
}
