// Un direct qui commence se voit dans Discord : c'est là que sont les amis, appli fermée ou pas. Un clic sur le lien et on regarde dans le navigateur.
import { validWebhook } from "./alerts.ts";

/** Un départ raté ou un essai de quelques secondes ne prévient personne. */
export const ANNOUNCE_DELAY_MS = 30_000;
/** Relancer son direct peu après ne poste pas un deuxième message : le premier repasse en direct. */
export const ANNOUNCE_REUSE_MS = 10 * 60_000;

export interface LiveInfo {
  name: string;
  room: string;
  title: string;
  link: string;
}

export interface AnnouncerOptions {
  webhook: () => string;
  fetch?: typeof fetch;
  now?: () => number;
  schedule?: (run: () => void, ms: number) => unknown;
  cancel?: (handle: unknown) => void;
}

interface Live {
  key: string;
  info: LiveInfo;
  startedAt: number;
  timer: unknown;
  message: Promise<string | null> | null;
}

/** Discord met en forme ce qui ressemble à du Markdown : un pseudo comme « *moi* » ne doit pas changer le message. */
const plain = (text: string) => text.replace(/([\\*_~`|>[\]()#-])/g, "\\$1");

export class LiveAnnouncer {
  private readonly lives = new Map<string, Live>();
  private readonly recent = new Map<string, { at: number; message: Promise<string | null> }>();
  private readonly options: AnnouncerOptions;
  private readonly now: () => number;

  constructor(options: AnnouncerOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
  }

  enabled() {
    return validWebhook(this.options.webhook());
  }

  start(streamId: string, key: string, info: LiveInfo) {
    if (!this.enabled()) return;
    const live: Live = { key, info, startedAt: this.now(), timer: null, message: null };
    this.lives.set(streamId, live);
    const previous = this.recent.get(key);
    if (previous && this.now() - previous.at < ANNOUNCE_REUSE_MS) {
      this.recent.delete(key);
      live.message = previous.message;
      void previous.message.then(id => id && this.send("PATCH", id, this.liveText(info)));
      return;
    }
    const schedule = this.options.schedule ?? ((run, ms) => setTimeout(run, ms).unref?.());
    live.timer = schedule(() => {
      live.timer = null;
      live.message = this.send("POST", null, this.liveText(info));
    }, ANNOUNCE_DELAY_MS);
  }

  end(streamId: string) {
    const live = this.lives.get(streamId);
    if (!live) return;
    this.lives.delete(streamId);
    if (live.timer !== null) {
      (this.options.cancel ?? (handle => clearTimeout(handle as NodeJS.Timeout)))(live.timer);
      return;
    }
    if (!live.message) return;
    const minutes = Math.max(1, Math.round((this.now() - live.startedAt) / 60_000));
    const text = `⚫ ${plain(live.info.name)} a diffusé ${minutes} min dans ${plain(live.info.room)}.`;
    void live.message.then(id => id && this.send("PATCH", id, text));
    this.recent.set(live.key, { at: this.now(), message: live.message });
  }

  private liveText({ name, room, title, link }: LiveInfo) {
    return `🔴 **${plain(name)}** est en direct dans **${plain(room)}**${title ? ` : ${plain(title)}` : ""}\nRegarder : ${link}`;
  }

  /** Sans mention possible : un titre qui contient @everyone ne doit prévenir personne. */
  private async send(method: "POST" | "PATCH", id: string | null, content: string): Promise<string | null> {
    try {
      const base = new URL(this.options.webhook());
      base.search = "";
      const url = id ? `${base}/messages/${id}` : `${base}?wait=true`;
      const response = await (this.options.fetch ?? fetch)(url, {
        method,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: "SpokaStream", content: content.slice(0, 1900), allowed_mentions: { parse: [] } }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) return null;
      return id ?? ((await response.json().catch(() => null)) as { id?: string } | null)?.id ?? null;
    } catch {
      return null;
    }
  }
}
