import { Plus, Settings2 } from "lucide-react";
import { useEffect, useState } from "react";
import type { Scene } from "@shared/ipc.ts";
import { core } from "../engine/core.ts";
import { useApp } from "../state/store.ts";
import { Button, IconButton, Popover } from "../ui/kit.tsx";
import { HotkeyInput } from "./Settings.tsx";

function SceneMenu({ scene }: { scene: Scene }) {
  const [name, setName] = useState(scene.name);
  useEffect(() => setName(scene.name), [scene.name]);
  return (
    <Popover
      align="right"
      trigger={(open, toggle) => (
        <IconButton label={`Réglages de la scène ${scene.name}`} active={open} onClick={toggle}>
          <Settings2 size={13} />
        </IconButton>
      )}
    >
      {close => (
        <div className="menu menu-form">
          <input className="input" value={name} maxLength={32} aria-label="Nom de la scène" onChange={e => setName(e.target.value)} onBlur={() => name.trim() && name !== scene.name && core.updateScene(scene.id, { name: name.trim() })} />
          <div className="menu-title">Raccourci, même en plein jeu</div>
          <HotkeyInput value={scene.hotkey} onChange={hotkey => core.updateScene(scene.id, { hotkey })} />
          <Button
            onClick={() => {
              core.captureScene(scene.id);
              close();
            }}
          >
            Reprendre l'état actuel
          </Button>
          <Button variant="ghost" onClick={() => core.deleteScene(scene.id)}>
            Supprimer la scène
          </Button>
        </div>
      )}
    </Popover>
  );
}

let startNaming: (() => void) | null = null;

export function ScenesAdd() {
  return (
    <IconButton label="Enregistrer cette scène" onClick={() => startNaming?.()}>
      <Plus size={16} />
    </IconButton>
  );
}

/** Comme dans OBS : on prépare ses plans à l'avance, et un clic ou un raccourci passe de l'un à l'autre sans couper le stream. */
export function Scenes() {
  const scenes = useApp(s => s.settings!.scenes);
  const active = useApp(s => s.publish!.scene);
  const [naming, setNaming] = useState<string | null>(null);

  useEffect(() => {
    startNaming = () => setNaming("");
    return () => {
      startNaming = null;
    };
  }, []);

  const save = () => {
    if (naming?.trim()) void core.saveScene(naming.trim());
    setNaming(null);
  };

  return (
    <>
      {naming !== null && <input className="input" autoFocus value={naming} maxLength={32} placeholder="Nom de la scène, puis Entrée" aria-label="Nom de la nouvelle scène" onChange={e => setNaming(e.target.value)} onBlur={save} onKeyDown={e => e.key === "Enter" && e.currentTarget.blur()} />}
      {scenes.length === 0 && naming === null && <p className="muted-text">Une scène retient la source, le son, la caméra et le bandeau. Prépare-en plusieurs : « Jeu », « Discussion », « Je reviens »…</p>}
      <div className="scene-list">
        {scenes.map(scene => (
          <div key={scene.id} className={`scene ${scene.id === active ? "is-on" : ""}`}>
            <button type="button" onClick={() => void core.applyScene(scene.id)}>
              {scene.name}
              {scene.hotkey && <kbd>{scene.hotkey}</kbd>}
            </button>
            <SceneMenu scene={scene} />
          </div>
        ))}
      </div>
    </>
  );
}
