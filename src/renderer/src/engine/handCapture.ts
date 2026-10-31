import type { ControlInput } from "@shared/protocol.ts";

const FLUSH_MS = 8;

/** Tout ce que fait la personne qui a la main : on le capte avant l'application, et on relâche tout si elle sort de la fenêtre. */
export class HandCapture {
  private readonly send: (events: ControlInput[]) => void;
  private readonly onExit: () => void;
  private readonly keys = new Set<string>();
  private readonly buttons = new Set<0 | 1 | 2>();
  private queue: ControlInput[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(send: (events: ControlInput[]) => void, onExit: () => void) {
    this.send = send;
    this.onExit = onExit;
    window.addEventListener("keydown", this.onKey, true);
    window.addEventListener("keyup", this.onKey, true);
    window.addEventListener("blur", this.releaseAll);
  }

  private readonly onKey = (e: KeyboardEvent) => {
    // F8 ne part jamais chez le diffuseur : c'est la sortie, même souris capturée.
    if (e.code === "F8") {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (e.type === "keydown" && !e.repeat) this.onExit();
      return;
    }
    if (!e.code) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    const down = e.type === "keydown";
    if (down) this.keys.add(e.code);
    else this.keys.delete(e.code);
    this.push({ k: "key", code: e.code, down }, true);
  };

  /** Les déplacements s'accumulent : seule la dernière position compte, et un clic ne doit pas les doubler. */
  private push(event: ControlInput, urgent: boolean) {
    const last = this.queue.at(-1);
    if (event.k === "move" && last?.k === "move") this.queue[this.queue.length - 1] = event;
    else if (event.k === "rel" && last?.k === "rel") this.queue[this.queue.length - 1] = { k: "rel", x: last.x + event.x, y: last.y + event.y };
    else this.queue.push(event);
    if (urgent) return this.flush();
    this.timer ??= setTimeout(() => this.flush(), FLUSH_MS);
  }

  private flush() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.queue.length) this.send(this.queue);
    this.queue = [];
  }

  move(x: number, y: number) {
    this.push({ k: "move", x: +x.toFixed(4), y: +y.toFixed(4) }, false);
  }

  moveBy(x: number, y: number) {
    // Le moteur n'accepte que des entiers, et une interface agrandie donne des déplacements fractionnaires.
    this.push({ k: "rel", x: Math.round(x), y: Math.round(y) }, false);
  }

  button(button: 0 | 1 | 2, down: boolean) {
    if (down) this.buttons.add(button);
    else this.buttons.delete(button);
    this.push({ k: "button", button, down }, true);
  }

  wheel(delta: number) {
    this.push({ k: "wheel", delta }, true);
  }

  readonly releaseAll = () => {
    for (const code of this.keys) this.queue.push({ k: "key", code, down: false });
    for (const button of this.buttons) this.queue.push({ k: "button", button, down: false });
    this.keys.clear();
    this.buttons.clear();
    this.flush();
  };

  stop() {
    this.releaseAll();
    window.removeEventListener("keydown", this.onKey, true);
    window.removeEventListener("keyup", this.onKey, true);
    window.removeEventListener("blur", this.releaseAll);
  }
}
