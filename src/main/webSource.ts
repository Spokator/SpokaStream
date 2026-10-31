import { BrowserWindow, net } from "electron";
import type { VideoInfo } from "../shared/ipc.ts";
import { titleFromUrl, videoUrl } from "../shared/protocol.ts";
import { appIcon } from "./windows.ts";

const PAGE_BYTES = 1_500_000;
const FETCH_MS = 8000;
const VIDEO_FILE = /\.(?:mp4|m4v|webm|ogv|mov|m3u8)(?:[?#]|$)/i;
const BROWSER = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36";

const unescapeHtml = (text: string) => text.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#0?39;/g, "'");

function metaTag(html: string, name: string) {
  const forward = new RegExp(`<meta[^>]+(?:property|name)=["']${name}["'][^>]+content=["']([^"']+)`, "i");
  const reverse = new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${name}["']`, "i");
  return html.match(forward)?.[1] ?? html.match(reverse)?.[1] ?? null;
}

/** Beaucoup de pages donnent leur vidéo telle quelle : balises de partage, lecteur simple, ou adresse dans le code. */
function videoInPage(html: string, base: string) {
  const candidates = [
    metaTag(html, "og:video:secure_url"),
    metaTag(html, "og:video:url"),
    metaTag(html, "og:video"),
    metaTag(html, "twitter:player:stream"),
    html.match(/<(?:video|source)\b[^>]*\ssrc=["']([^"']+)/i)?.[1],
    html.match(/https?:\/\/[^"'\s<>\\]+\.(?:mp4|webm|m3u8)(?:\?[^"'\s<>\\]*)?/i)?.[0],
  ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      const url = videoUrl(new URL(unescapeHtml(candidate), base).href);
      if (url && VIDEO_FILE.test(url)) return url;
    } catch {
      // Une adresse mal formée n'empêche pas d'essayer la suivante.
    }
  }
  return null;
}

async function readPage(response: Response) {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const decoder = new TextDecoder();
  let html = "";
  while (html.length < PAGE_BYTES) {
    const { done, value } = await reader.read();
    if (done) break;
    html += decoder.decode(value, { stream: true });
  }
  void reader.cancel().catch(() => {});
  return html;
}

/** Ce qui se cache derrière un lien : une vidéo que tout le salon peut lire, ou une page qu'il faudra diffuser. */
export async function videoInfo(raw: string): Promise<VideoInfo | null> {
  const url = videoUrl(raw);
  if (!url) return null;
  const response = await net.fetch(url, { headers: { "user-agent": BROWSER, range: "bytes=0-" }, signal: AbortSignal.timeout(FETCH_MS) }).catch(() => null);
  if (!response) return VIDEO_FILE.test(url) ? { kind: "direct", url, title: titleFromUrl(url) } : null;
  const type = response.headers.get("content-type") ?? "";
  if (!/html/i.test(type)) {
    void response.body?.cancel().catch(() => {});
    if (response.ok || VIDEO_FILE.test(url)) return { kind: "direct", url: response.url || url, title: titleFromUrl(url) };
    return null;
  }
  const html = await readPage(response).catch(() => "");
  const title = unescapeHtml(metaTag(html, "og:title") ?? html.match(/<title[^>]*>([^<]+)/i)?.[1]?.trim() ?? titleFromUrl(url));
  const direct = videoInPage(html, response.url || url);
  return direct ? { kind: "direct", url: direct, title } : { kind: "page", url, title };
}

/**
 * Une page ouverte par SpokaStream pour être diffusée, comme une source navigateur d'OBS : c'est l'image et le son de
 * cette seule page qui partent, jamais le reste du PC. Elle a sa propre session, et elle n'a accès à rien de l'application.
 */
export class WebSource {
  private win: BrowserWindow | null = null;
  onClosed = () => {};

  async open(url: string) {
    this.close();
    const win = new BrowserWindow({
      width: 1280,
      height: 720,
      title: "SpokaStream : page diffusée",
      icon: appIcon(),
      backgroundColor: "#000000",
      autoHideMenuBar: true,
      webPreferences: { partition: "persist:spoka-web", sandbox: true, contextIsolation: true, backgroundThrottling: false },
    });
    win.removeMenu();
    // Une fenêtre qui s'ouvrirait à part ne serait pas diffusée : elle reste dans celle-ci.
    win.webContents.setWindowOpenHandler(details => {
      if (/^https?:\/\//.test(details.url)) void win.loadURL(details.url);
      return { action: "deny" };
    });
    win.on("closed", () => {
      if (this.win !== win) return;
      this.win = null;
      this.onClosed();
    });
    this.win = win;
    await win.loadURL(url).catch(() => {});
    return !win.isDestroyed();
  }

  get frame() {
    return this.win && !this.win.isDestroyed() ? this.win.webContents.mainFrame : null;
  }

  close() {
    const win = this.win;
    this.win = null;
    if (win && !win.isDestroyed()) win.destroy();
  }
}
