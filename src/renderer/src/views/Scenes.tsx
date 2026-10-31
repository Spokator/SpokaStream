import { Plus, X } from "lucide-react";
import { useEffect, useState } from "react";
import { core } from "../engine/core.ts";
import { useApp } from "../state/store.ts";
import { IconButton } from "../ui/kit.tsx";

function BannerInput() {
  const banner = useApp(s => s.publish!.banner);
  const [value, setValue] = useState(banner);
  useEffect(() => setValue(banner), [banner]);
  const commit = () => value.trim() !== banner && core.setBanner(value.trim());
  return <input className="input" value={value} maxLength={80} placeholder="Bandeau sur l'image : pseudo, partie classée…" aria-label="Bandeau sur l'image" onChange={e => setValue(e.target.value)} onBlur={commit} onKeyDown={e => e.key === "Enter" && e.currentTarget.blur()} />;
}

/** Comme dans OBS : on prépare ses plans à l'avance, et un clic passe de l'un à l'autre sans couper le stream. */
export function Scenes() {
  const scenes = useApp(s => s.settings!.scenes);
  const active = useApp(s => s.publish!.scene);
  const [naming, setNaming] = useState<string | null>(null);

  const save = () => {
    if (naming?.trim()) void core.saveScene(naming.trim());
    setNaming(null);
  };

  return (
    <section className="studio-section">
      <div className="studio-head">
        <h3>Scènes</h3>
        <IconButton label="Enregistrer cette scène" onClick={() => setNaming("")}>
          <Plus size={17} />
        </IconButton>
      </div>
      {naming !== null && <input className="input" autoFocus value={naming} maxLength={32} placeholder="Nom de la scène, puis Entrée" aria-label="Nom de la scène" onChange={e => setNaming(e.target.value)} onBlur={save} onKeyDown={e => e.key === "Enter" && e.currentTarget.blur()} />}
      {scenes.length === 0 && naming === null && <p className="muted-text">Une scène retient la source, la caméra et le bandeau. Prépare-en plusieurs : « Jeu », « Discussion », « Je reviens »…</p>}
      <div className="scene-list">
        {scenes.map(scene => (
          <div key={scene.id} className={`scene ${scene.id === active ? "is-on" : ""}`}>
            <button type="button" onClick={() => void core.applyScene(scene.id)}>
              {scene.name}
            </button>
            <IconButton label={`Supprimer la scène ${scene.name}`} onClick={() => core.deleteScene(scene.id)}>
              <X size={13} />
            </IconButton>
          </div>
        ))}
      </div>
      <BannerInput />
    </section>
  );
}
