const PROBE_MS = 12_000;

/** Essaie vraiment d'ouvrir la vidéo : seul le lecteur sait si le format et le serveur conviennent. */
export function canPlay(url: string) {
  return new Promise<boolean>(resolve => {
    const video = document.createElement("video");
    video.preload = "metadata";
    video.muted = true;
    const done = (ok: boolean) => {
      clearTimeout(timer);
      video.onloadedmetadata = video.onerror = null;
      video.removeAttribute("src");
      video.load();
      resolve(ok);
    };
    const timer = setTimeout(() => done(false), PROBE_MS);
    video.onloadedmetadata = () => done(true);
    video.onerror = () => done(false);
    video.src = url;
  });
}
