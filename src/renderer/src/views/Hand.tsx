import { Gamepad2, ShieldAlert } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { core } from "../engine/core.ts";
import { HandCapture } from "../engine/handCapture.ts";
import { memberOf, useApp } from "../state/store.ts";
import { Button, Modal } from "../ui/kit.tsx";

interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

const BUTTONS: Record<number, 0 | 1 | 2> = { 0: 0, 1: 1, 2: 2 };

/** Posé exactement sur l'image : la position de la souris y devient une position dans la fenêtre du diffuseur. */
export function HandLayer({ box, blocked, ownerName }: { box: Box; blocked: boolean; ownerName: string }) {
  const layer = useRef<HTMLDivElement>(null);
  const capture = useRef<HandCapture | null>(null);
  const [relative, setRelative] = useState(false);
  const [locked, setLocked] = useState(false);

  useEffect(() => {
    const hand = new HandCapture(
      events => core.sendControlInput(events),
      () => core.releaseControl(),
    );
    capture.current = hand;
    const onLock = () => setLocked(document.pointerLockElement === layer.current);
    document.addEventListener("pointerlockchange", onLock);
    return () => {
      document.removeEventListener("pointerlockchange", onLock);
      if (document.pointerLockElement) document.exitPointerLock();
      hand.stop();
    };
  }, []);

  useEffect(() => {
    const element = layer.current!;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      e.stopPropagation();
      capture.current?.wheel(Math.round(-e.deltaY * 1.2));
    };
    element.addEventListener("wheel", onWheel, { passive: false });
    return () => element.removeEventListener("wheel", onWheel);
  }, []);

  useEffect(() => {
    if (!relative && document.pointerLockElement) document.exitPointerLock();
  }, [relative]);

  const place = (e: React.PointerEvent) => {
    const rect = e.currentTarget.getBoundingClientRect();
    capture.current?.move((e.clientX - rect.left) / rect.width, (e.clientY - rect.top) / rect.height);
  };

  return (
    <>
      <div
        ref={layer}
        className="hand-layer"
        style={box}
        onPointerDown={e => {
          e.stopPropagation();
          e.preventDefault();
          e.currentTarget.setPointerCapture(e.pointerId);
          if (relative && !locked) return void e.currentTarget.requestPointerLock();
          if (!relative) place(e);
          const button = BUTTONS[e.button];
          if (button !== undefined) capture.current?.button(button, true);
        }}
        onPointerUp={e => {
          e.stopPropagation();
          const button = BUTTONS[e.button];
          if (button !== undefined) capture.current?.button(button, false);
        }}
        onPointerMove={e => {
          if (relative && locked) capture.current?.moveBy(e.movementX, e.movementY);
          else if (!relative) place(e);
        }}
        onContextMenu={e => e.preventDefault()}
        onDoubleClick={e => e.stopPropagation()}
      />
      <div className="hand-bar" role="status">
        {blocked ? (
          <span className="is-blocked">
            <ShieldAlert size={15} /> {ownerName} n'est plus sur la fenêtre partagée : tes gestes sont ignorés
          </span>
        ) : (
          <span>
            <Gamepad2 size={15} /> Tu as la main · <kbd>F8</kbd> pour la rendre
          </span>
        )}
        <button type="button" className={relative ? "is-on" : ""} title="Pour les jeux à la souris : clique sur l'image pour la capturer, Échap pour la libérer" onClick={() => setRelative(on => !on)}>
          Souris de jeu
        </button>
        <button type="button" onClick={() => core.releaseControl()}>
          Rendre la main
        </button>
      </div>
    </>
  );
}

/** La demande arrive pendant que le diffuseur joue : ce choix doit être clair, et jamais accepté par accident. */
export function ControlRequest() {
  const asker = useApp(s => s.publish?.controlAsk ?? null);
  const scope = useApp(s => s.publish?.controlScope ?? null);
  const source = useApp(s => s.publish?.sourceName ?? "");
  const hotkey = useApp(s => s.settings!.hotkeys.control);
  if (!asker || !scope) return null;
  const name = memberOf(asker)?.name ?? "Quelqu'un";
  return (
    <Modal
      title={`${name} demande la main`}
      onClose={() => core.refuseControl()}
      width={480}
      footer={
        <>
          <Button variant="ghost" onClick={() => core.refuseControl()}>
            Refuser
          </Button>
          <Button variant={scope === "screen" ? "danger" : "primary"} icon={<Gamepad2 size={15} />} onClick={() => void core.acceptControl()}>
            Donner la main
          </Button>
        </>
      }
    >
      {scope === "window" ? (
        <p>
          {name} pourra utiliser le clavier et la souris dans <b>{source}</b>, et seulement là : dès que tu quittes cette fenêtre, ses gestes sont ignorés. Tu gardes aussi les tiens.
        </p>
      ) : (
        <div className="control-warning">
          <ShieldAlert size={18} />
          <p>
            Tu partages un écran entier : {name} pourra ouvrir et utiliser <b>tout ce qui s'y trouve</b>, comme s'il était devant ton PC. N'accepte que si tu lui fais entièrement confiance. Pour un jeu, partage plutôt sa fenêtre.
          </p>
        </div>
      )}
      <p className="muted-text">Tu reprends la main à tout moment avec {hotkey || "le Studio"}.</p>
    </Modal>
  );
}
