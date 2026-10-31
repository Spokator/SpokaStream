import { ImagePlus, Trash2 } from "lucide-react";
import { useRef, useState } from "react";
import { LIMITS } from "@shared/protocol.ts";
import { core } from "../engine/core.ts";
import { useApp } from "../state/store.ts";
import { Avatar, Button } from "../ui/kit.tsx";

export const PROFILE_COLORS = ["#7c5cff", "#22d3ee", "#34d399", "#f59e0b", "#f472b6", "#fb7185", "#a78bfa", "#60a5fa"];

/** Réduit l'image choisie à 128 px : l'avatar voyage dans chaque liste de membres, il doit rester léger. */
export async function resizeAvatar(file: File) {
  const bitmap = await createImageBitmap(file);
  const size = Math.min(bitmap.width, bitmap.height);
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 128;
  canvas.getContext("2d")!.drawImage(bitmap, (bitmap.width - size) / 2, (bitmap.height - size) / 2, size, size, 0, 0, 128, 128);
  return canvas.toDataURL("image/webp", 0.82);
}

export function ProfileEditor({ name, color, avatar, autoFocus, onChange }: { name: string; color: string; avatar: string | null; autoFocus?: boolean; onChange: (p: { name: string; color: string; avatar: string | null }) => void }) {
  const file = useRef<HTMLInputElement>(null);
  return (
    <div className="profile-editor">
      <div className="profile-avatar">
        <Avatar name={name || "?"} color={color} src={avatar} size={84} />
        <input
          ref={file}
          type="file"
          accept="image/*"
          hidden
          onChange={async e => {
            const picked = e.target.files?.[0];
            if (picked) onChange({ name, color, avatar: await resizeAvatar(picked) });
            e.target.value = "";
          }}
        />
        <div className="profile-avatar-actions">
          <Button variant="ghost" icon={<ImagePlus size={15} />} onClick={() => file.current?.click()}>
            Image
          </Button>
          {avatar && (
            <Button variant="ghost" icon={<Trash2 size={15} />} onClick={() => onChange({ name, color, avatar: null })}>
              Retirer
            </Button>
          )}
        </div>
      </div>
      <label className="stack">
        <span className="label">Ton pseudo</span>
        <input className="input" autoFocus={autoFocus} value={name} maxLength={LIMITS.name} placeholder="Comment tes amis te voient" onChange={e => onChange({ name: e.target.value, color, avatar })} />
      </label>
      <div className="stack">
        <span className="label">Ta couleur</span>
        <div className="swatches">
          {PROFILE_COLORS.map(c => (
            <button key={c} type="button" aria-label={`Couleur ${c}`} className={`swatch ${c === color ? "is-on" : ""}`} style={{ background: c }} onClick={() => onChange({ name, color: c, avatar })} />
          ))}
        </div>
      </div>
    </div>
  );
}

export function Onboarding() {
  const settings = useApp(s => s.settings)!;
  const [profile, setProfile] = useState(settings.profile);
  const ready = profile.name.trim().length > 0;

  return (
    <div className="onboarding">
      <div className="titlebar-drag" />
      <div className="onboarding-card">
        <img className="onboarding-logo" src="./logo.png" alt="" />
        <h1>Bienvenue sur SpokaStream</h1>
        <p>Pas de compte ni de mot de passe. Choisis comment tes amis te verront, tu pourras changer ça quand tu veux.</p>
        <ProfileEditor {...profile} autoFocus onChange={setProfile} />
        <Button
          variant="primary"
          className="btn-wide"
          disabled={!ready}
          onClick={async () => {
            await core.updateSettings({ profile: { ...profile, name: profile.name.trim() }, onboarded: true });
            core.connect();
          }}
        >
          C'est parti
        </Button>
      </div>
    </div>
  );
}
