import { AlertTriangle, CheckCircle2, Download, Info, Plus, Search, Settings as SettingsIcon, WifiOff, XCircle } from "lucide-react";
import { useEffect, useState } from "react";
import { core } from "../engine/core.ts";
import { set, useApp } from "../state/store.ts";
import { hueOf, initials, plural } from "../ui/format.ts";
import { Avatar, Button, Modal } from "../ui/kit.tsx";

export function TitleBar() {
  const connection = useApp(s => s.connection);
  const update = useApp(s => s.update);
  const publish = useApp(s => s.publish);
  const room = useApp(s => s.room);
  const viewers = room?.streams.find(s => s.id === publish?.streamId)?.viewers.length ?? 0;

  return (
    <header className="titlebar">
      <div className="titlebar-brand">
        <img src="./logo.png" alt="" />
        <span>SpokaStream</span>
      </div>
      {publish && (
        <div className={`titlebar-live ${publish.paused ? "is-paused" : ""}`}>
          <i />
          {publish.paused ? "En pause" : "En direct"} · {plural(viewers, "spectateur")}
        </div>
      )}
      <button type="button" className="titlebar-search" onClick={() => set({ dialog: "palette" })}>
        <Search size={13} />
        Rechercher
        <kbd>Ctrl K</kbd>
      </button>
      <div className="titlebar-spacer" />
      {connection !== "online" && (
        <div className="titlebar-status" role="status">
          <WifiOff size={14} />
          {connection === "outdated" ? "Mise à jour nécessaire" : connection === "connecting" ? "Connexion au serveur…" : "Hors ligne"}
        </div>
      )}
      {update.state === "ready" && (
        <button type="button" className="titlebar-update" onClick={() => window.spoka.updateInstall()}>
          <Download size={14} />
          Mettre à jour vers {update.version}
        </button>
      )}
    </header>
  );
}

export function Rail() {
  const settings = useApp(s => s.settings)!;
  const statuses = useApp(s => s.statuses);
  const room = useApp(s => s.room);
  const view = useApp(s => s.view);
  const [creating, setCreating] = useState(false);

  return (
    <nav className="rail" aria-label="Salons">
      <button type="button" className={`rail-item rail-home ${view === "home" ? "is-on" : ""}`} title="Accueil" onClick={() => set({ view: "home" })}>
        <img src="./logo.png" alt="Accueil" />
      </button>
      <div className="rail-divider" />
      <div className="rail-rooms">
        {settings.recentRooms.map(r => {
          const status = statuses[r.id];
          const live = (status?.live.length ?? 0) > 0;
          const here = room?.id === r.id;
          return (
            <button
              key={r.id}
              type="button"
              title={live ? `${r.name}\n${status!.live.map(l => l.ownerName).join(", ")} en direct` : r.name}
              className={`rail-item ${here && view === "room" ? "is-on" : ""} ${here ? "is-here" : ""}`}
              style={{ "--hue": hueOf(r.name) } as React.CSSProperties}
              onClick={() => void core.openRoom(r.id)}
            >
              <span>{initials(r.name)}</span>
              {live && <i className="rail-live" />}
            </button>
          );
        })}
        <button type="button" className="rail-item rail-add" title="Créer un salon" onClick={() => setCreating(true)}>
          <Plus size={20} />
        </button>
      </div>
      <div className="rail-bottom">
        <button type="button" className={`rail-item rail-plain ${view === "settings" ? "is-on" : ""}`} title="Paramètres" onClick={() => set({ view: view === "settings" ? (room ? "room" : "home") : "settings" })}>
          <SettingsIcon size={20} />
        </button>
        <div className="rail-profile" title={settings.profile.name}>
          <Avatar name={settings.profile.name} color={settings.profile.color} src={settings.profile.avatar} size={36} />
        </div>
      </div>
      {creating && <CreateRoomModal onClose={() => setCreating(false)} />}
    </nav>
  );
}

export function CreateRoomModal({ onClose }: { onClose: () => void }) {
  const [name, setName] = useState("");
  const submit = () => {
    if (!name.trim()) return;
    void core.createRoom(name.trim());
    onClose();
  };
  return (
    <Modal
      title="Créer un salon"
      onClose={onClose}
      width={420}
      footer={
        <Button variant="primary" disabled={!name.trim()} onClick={submit}>
          Créer le salon
        </Button>
      }
    >
      <label className="stack">
        <span className="label">Nom du salon</span>
        <input className="input" autoFocus value={name} maxLength={48} placeholder="La soirée film, Les potes…" onChange={e => setName(e.target.value)} onKeyDown={e => e.key === "Enter" && submit()} />
      </label>
      <p className="muted-text">Tu recevras un code à partager. Le salon reste disponible, on peut y revenir quand on veut.</p>
    </Modal>
  );
}

const TOAST_ICONS = { info: Info, success: CheckCircle2, warning: AlertTriangle, error: XCircle };
const dismiss = (id: number) => set(s => ({ toasts: s.toasts.filter(t => t.id !== id) }));

export function Lightbox() {
  const image = useApp(s => s.lightbox);
  useEffect(() => {
    if (!image) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && set({ lightbox: null });
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [image]);
  if (!image) return null;
  return (
    <div className="modal-backdrop lightbox" onMouseDown={() => set({ lightbox: null })}>
      <img src={image} alt="" />
    </div>
  );
}

export function Toasts() {
  const toasts = useApp(s => s.toasts);
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map(t => {
        const Icon = TOAST_ICONS[t.kind];
        return (
          <div key={t.id} className={`toast toast-${t.kind}`}>
            <Icon size={16} />
            {t.text}
            {t.action && (
              <button
                type="button"
                className="toast-action"
                onClick={() => {
                  t.action!.run();
                  dismiss(t.id);
                }}
              >
                {t.action.label}
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}
