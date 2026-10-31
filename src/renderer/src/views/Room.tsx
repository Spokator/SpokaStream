import { Check, Clapperboard, Headphones, HeadphoneOff, LayoutGrid, Link2, LogOut, Lock, Mic, MicOff, PanelRightClose, PanelRightOpen, PhoneCall, PhoneOff, Radio, Settings2, Square, Trash2, TvMinimalPlay, Unlock, X } from "lucide-react";
import { useEffect, useState } from "react";
import { core } from "../engine/core.ts";
import { get, set, useApp } from "../state/store.ts";
import { Avatar, Button, Field, IconButton, isTyping, Modal, Segmented, Select, Toggle } from "../ui/kit.tsx";
import { Chat } from "./Chat.tsx";
import { Members } from "./Members.tsx";
import { Stage } from "./Stage.tsx";
import { Studio } from "./Studio.tsx";

export function Room() {
  const room = useApp(s => s.room)!;
  const userId = useApp(s => s.userId);
  const panelOpen = useApp(s => s.settings!.chatPanelOpen);
  const panelTab = useApp(s => s.panelTab);
  const publish = useApp(s => s.publish);
  const unread = useApp(s => s.unread);
  const cinema = useApp(s => s.cinema);
  const [layout, setLayout] = useState<"focus" | "grid">("focus");
  const [copied, setCopied] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const isOwner = room.ownerId === userId;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && get().cinema && !document.querySelector(".modal-backdrop")) return set({ cinema: false });
      if (isTyping(e) || get().view !== "room") return;
      const key = e.key.toLowerCase();
      if (key === "t") set({ cinema: !get().cinema });
      else if (key === "c") void core.saveClip();
      else if (e.key === "Enter" && !document.querySelector(".floating-chat")) document.querySelector<HTMLTextAreaElement>(".chat-input textarea")?.focus();
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const copyInvite = () => {
    window.spoka.copyText(core.inviteLink(room.code));
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  };

  const openTab = (tab: "chat" | "members" | "studio") => {
    set({ panelTab: tab, ...(tab === "chat" ? { unread: 0 } : {}) });
  };

  return (
    <div className={`room ${panelOpen && !cinema ? "" : "no-panel"} ${cinema ? "is-cinema" : ""}`}>
      <div className="room-main">
        <header className="room-head">
          <h1>{room.name}</h1>
          <button type="button" className="room-code" title="Copier le lien d'invitation" onClick={copyInvite}>
            {copied ? <Check size={14} /> : <Link2 size={14} />}
            {copied ? "Lien copié" : room.code}
          </button>
          {room.settings.locked && <Lock size={14} className="muted-icon" aria-label="Salon verrouillé" />}
          <div className="room-head-spacer" />
          <div className="avatar-stack">
            {room.members.slice(0, 6).map(m => (
              <Avatar key={m.id} name={m.name} color={m.color} src={m.avatar} size={28} />
            ))}
            {room.members.length > 6 && <span className="avatar-more">+{room.members.length - 6}</span>}
          </div>
          {isOwner && (
            <IconButton label="Réglages du salon" onClick={() => setSettingsOpen(true)}>
              <Settings2 size={18} />
            </IconButton>
          )}
          <IconButton label={layout === "focus" ? "Afficher en grille" : "Afficher un stream en grand"} active={layout === "grid"} onClick={() => setLayout(layout === "focus" ? "grid" : "focus")}>
            <LayoutGrid size={18} />
          </IconButton>
          <IconButton label="Mode cinéma" onClick={() => set({ cinema: true })}>
            <Clapperboard size={18} />
          </IconButton>
          <IconButton label={panelOpen ? "Masquer le panneau" : "Afficher le panneau"} onClick={() => void core.updateSettings({ chatPanelOpen: !panelOpen })}>
            {panelOpen ? <PanelRightClose size={18} /> : <PanelRightOpen size={18} />}
          </IconButton>
        </header>

        <Stage layout={layout} />
        <Dock />
        {cinema && (
          <button type="button" className="cinema-exit" onClick={() => set({ cinema: false })}>
            <X size={14} /> Quitter le mode cinéma
          </button>
        )}
      </div>

      {panelOpen && !cinema && (
        <aside className="panel">
          <div className="panel-tabs" role="tablist">
            <button type="button" role="tab" aria-selected={panelTab === "chat"} className={panelTab === "chat" ? "is-on" : ""} onClick={() => openTab("chat")}>
              Chat {unread > 0 && <em>{unread}</em>}
            </button>
            <button type="button" role="tab" aria-selected={panelTab === "members"} className={panelTab === "members" ? "is-on" : ""} onClick={() => openTab("members")}>
              Membres <small>{room.members.length}</small>
            </button>
            {publish && (
              <button type="button" role="tab" aria-selected={panelTab === "studio"} className={panelTab === "studio" ? "is-on" : ""} onClick={() => openTab("studio")}>
                Studio
              </button>
            )}
          </div>
          <div className="panel-body">
            {panelTab === "chat" && <Chat />}
            {panelTab === "members" && <Members />}
            {panelTab === "studio" && publish && <Studio />}
          </div>
        </aside>
      )}
      {settingsOpen && <RoomSettingsModal onClose={() => setSettingsOpen(false)} />}
    </div>
  );
}

function Dock() {
  const voiceJoined = useApp(s => s.voiceJoined);
  const muted = useApp(s => s.muted);
  const deafened = useApp(s => s.deafened);
  const publish = useApp(s => s.publish);
  const whoCanStream = useApp(s => s.room!.settings.whoCanStream);
  const isOwner = useApp(s => s.room!.ownerId === s.userId);
  const canStream = whoCanStream === "everyone" || isOwner;

  return (
    <div className="dock">
      <div className="dock-group">
        <Button variant={voiceJoined ? "default" : "ghost"} className={voiceJoined ? "voice-on" : ""} icon={voiceJoined ? <PhoneOff size={17} /> : <PhoneCall size={17} />} onClick={() => (voiceJoined ? core.voiceLeave() : void core.voiceJoin())}>
          {voiceJoined ? "Quitter le vocal" : "Rejoindre le vocal"}
        </Button>
        <IconButton label={muted ? "Réactiver le micro" : "Couper le micro"} danger={muted} onClick={() => core.toggleMute()}>
          {muted ? <MicOff size={19} /> : <Mic size={19} />}
        </IconButton>
        <IconButton label={deafened ? "Réactiver le son" : "Couper tout le son"} danger={deafened} onClick={() => core.toggleDeafen()}>
          {deafened ? <HeadphoneOff size={19} /> : <Headphones size={19} />}
        </IconButton>
      </div>

      <div className="dock-center">
        {publish ? (
          <Button variant="danger" icon={<Square size={16} />} onClick={() => void core.stopLive()}>
            Arrêter le stream
          </Button>
        ) : (
          <Button variant="live" icon={<Radio size={18} />} disabled={!canStream} title={canStream ? undefined : "Seul le propriétaire peut diffuser dans ce salon"} onClick={() => set({ goLiveOpen: true })}>
            Diffuser
          </Button>
        )}
        <IconButton label="Regarder une vidéo YouTube ensemble" disabled={!canStream} onClick={() => set({ dialog: "together" })}>
          <TvMinimalPlay size={19} />
        </IconButton>
      </div>

      <div className="dock-group dock-right">
        <Button variant="ghost" icon={<LogOut size={17} />} onClick={() => core.leaveRoom()}>
          Quitter
        </Button>
      </div>
    </div>
  );
}

function RoomSettingsModal({ onClose }: { onClose: () => void }) {
  const room = useApp(s => s.room)!;
  const [name, setName] = useState(room.name);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const { settings } = room;

  return (
    <Modal title="Réglages du salon" onClose={onClose} width={520}>
      <label className="stack">
        <span className="label">Nom du salon</span>
        <input className="input" value={name} maxLength={48} onChange={e => setName(e.target.value)} onBlur={() => name.trim() && name !== room.name && core.updateRoom(name.trim())} />
      </label>
      <Field label="Qui peut diffuser ?">
        <Segmented
          label="Qui peut diffuser"
          value={settings.whoCanStream}
          options={[
            { value: "everyone", label: "Tout le monde" },
            { value: "owner", label: "Seulement moi" },
          ]}
          onChange={whoCanStream => core.updateRoom(undefined, { whoCanStream })}
        />
      </Field>
      <Field label="Débit maximum par diffuseur" hint="Utile si quelqu'un a une petite connexion dans le groupe">
        <Select
          label="Débit maximum"
          value={settings.maxKbps}
          options={[
            { value: 0, label: "Libre" },
            { value: 6000, label: "6 Mb/s" },
            { value: 12000, label: "12 Mb/s" },
            { value: 25000, label: "25 Mb/s" },
            { value: 50000, label: "50 Mb/s" },
          ]}
          onChange={maxKbps => core.updateRoom(undefined, { maxKbps })}
        />
      </Field>
      <Field label="Verrouiller le salon" hint="Plus personne ne peut entrer, même avec le code">
        <div className="row-gap">
          {settings.locked ? <Lock size={15} /> : <Unlock size={15} />}
          <Toggle label="Verrouiller" checked={settings.locked} onChange={locked => core.updateRoom(undefined, { locked })} />
        </div>
      </Field>
      <div className="danger-zone">
        {confirmDelete ? (
          <>
            <span>Supprimer ce salon pour tout le monde ?</span>
            <Button variant="danger" icon={<Trash2 size={15} />} onClick={() => (core.deleteRoom(), onClose())}>
              Oui, supprimer
            </Button>
            <Button variant="ghost" onClick={() => setConfirmDelete(false)}>
              Annuler
            </Button>
          </>
        ) : (
          <Button variant="ghost" icon={<Trash2 size={15} />} onClick={() => setConfirmDelete(true)}>
            Supprimer le salon
          </Button>
        )}
      </div>
    </Modal>
  );
}
