import { Check, Clapperboard, Columns2, Eye, Grid2x2, Headphones, HeadphoneOff, LayoutDashboard, LayoutGrid, Link2, LogOut, Lock, Mic, MicOff, Move, PanelBottom, PanelRightClose, PanelRightOpen, PhoneCall, PhoneOff, PictureInPicture2, QrCode, Radio, Settings2, Square, Trash2, TvMinimalPlay, Unlock, X } from "lucide-react";
import qrcode from "qrcode-generator";
import { useEffect, useMemo, useState } from "react";
import { core } from "../engine/core.ts";
import { get, set, toast, useApp } from "../state/store.ts";
import type { WallMode } from "@shared/ipc.ts";
import { Avatar, Button, Field, IconButton, isTyping, Modal, Popover, Segmented, Select, Toggle } from "../ui/kit.tsx";
import { Chat } from "./Chat.tsx";
import { Members } from "./Members.tsx";
import { LiveBar, RegieBoard } from "./Regie.tsx";
import { Stage, wallSnapshot } from "./Stage.tsx";
import { Studio } from "./Studio.tsx";

export function Room() {
  const room = useApp(s => s.room)!;
  const accountId = useApp(s => s.accountId);
  const panelOpen = useApp(s => s.settings!.chatPanelOpen);
  const panelTab = useApp(s => s.panelTab);
  const publish = useApp(s => s.publish);
  const unread = useApp(s => s.unread);
  const cinema = useApp(s => s.cinema);
  const regie = useApp(s => s.regie && !!s.publish && !s.cinema);
  const [copied, setCopied] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const isOwner = room.ownerId === accountId;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && get().cinema && !document.querySelector(".modal-backdrop")) return set({ cinema: false });
      if (isTyping(e) || get().view !== "room" || get().hand?.state === "granted") return;
      const key = e.key.toLowerCase();
      if (key === "t") set({ cinema: !get().cinema });
      else if (key === "c") void core.saveClip();
      else if (key === "r") void core.replay();
      else if (key === "g" && get().publish) get().regie ? set({ regie: false }) : core.openRegie();
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
    <div className={`room ${panelOpen && !cinema && !regie ? "" : "no-panel"} ${cinema ? "is-cinema" : ""} ${regie ? "is-regie" : ""}`}>
      <div className="room-main">
        <header className="room-head">
          <h1>{room.name}</h1>
          <button type="button" className="room-code" title="Copier le lien d'invitation" onClick={copyInvite}>
            {copied ? <Check size={14} /> : <Link2 size={14} />}
            {copied ? "Lien copié" : room.code}
          </button>
          <InviteMenu />
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
          <WallMenu />
          <IconButton label="Mode cinéma" onClick={() => set({ cinema: true })}>
            <Clapperboard size={18} />
          </IconButton>
          <IconButton label={panelOpen ? "Masquer le panneau" : "Afficher le panneau"} onClick={() => void core.updateSettings({ chatPanelOpen: !panelOpen })}>
            {panelOpen ? <PanelRightClose size={18} /> : <PanelRightOpen size={18} />}
          </IconButton>
        </header>

        {publish && !cinema && <LiveBar />}
        {regie ? <RegieBoard stage={<Stage />} /> : <Stage />}
        <Dock />
        {cinema && (
          <button type="button" className="cinema-exit" onClick={() => set({ cinema: false })}>
            <X size={14} /> Quitter le mode cinéma
          </button>
        )}
      </div>

      {panelOpen && !cinema && !regie && (
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

/** Un téléphone n'a rien à installer : il scanne, et il est dans le salon. */
function InviteMenu() {
  const code = useApp(s => s.room!.code);
  const link = core.inviteLink(code);
  const picture = useMemo(() => {
    const qr = qrcode(0, "M");
    qr.addData(link);
    qr.make();
    return qr.createDataURL(5, 8);
  }, [link]);
  return (
    <Popover
      trigger={(open, toggle) => (
        <IconButton label="Inviter : QR code pour téléphone" active={open} onClick={toggle}>
          <QrCode size={16} />
        </IconButton>
      )}
    >
      {() => (
        <div className="menu invite-menu">
          <img src={picture} alt={`QR code du salon ${code}`} />
          <b>Scanne avec ton téléphone</b>
          <small>Le salon s'ouvre dans le navigateur, sans rien installer.</small>
          <Button icon={<Link2 size={15} />} onClick={() => (window.spoka.copyText(link), toast("Lien copié", "success"))}>
            Copier le lien
          </Button>
        </div>
      )}
    </Popover>
  );
}

const WALL_MODES: { value: WallMode; label: string; hint: string; icon: typeof Grid2x2 }[] = [
  { value: "focus", label: "Un grand, bandeau en bas", hint: "L'image principale, les autres dessous", icon: PanelBottom },
  { value: "side", label: "Un grand, colonne à droite", hint: "Comme une régie", icon: Columns2 },
  { value: "grid", label: "Grille", hint: "Tout le monde à la même taille", icon: Grid2x2 },
  { value: "pip", label: "Incrustation", hint: "Les autres par-dessus l'image principale", icon: PictureInPicture2 },
  { value: "free", label: "Libre", hint: "Tu glisses et tu redimensionnes chaque image", icon: Move },
];

/** Chacun arrange sa scène comme il veut, spectateur comme diffuseur : rien de tout ça ne change l'écran des autres. */
function WallMenu() {
  const wall = useApp(s => s.settings!.wall);
  const missing = useApp(s => (s.room?.streams ?? []).filter(x => x.ownerId !== s.userId && !s.subs[x.id]).length);
  const live = useApp(s => !!s.publish);
  return (
    <Popover
      align="right"
      trigger={(open, toggle) => (
        <IconButton label="Disposition des images" active={open} onClick={toggle}>
          <LayoutGrid size={18} />
        </IconButton>
      )}
    >
      {close => (
        <div className="menu wall-menu">
          <div className="menu-title">Disposition</div>
          {WALL_MODES.map(mode => (
            <button
              key={mode.value}
              type="button"
              className={`menu-item ${wall.mode === mode.value ? "is-on" : ""}`}
              onClick={() => {
                core.setWallMode(mode.value, wallSnapshot());
                close();
              }}
            >
              <span>
                <mode.icon size={15} /> {mode.label}
              </span>
              <small>{mode.hint}</small>
            </button>
          ))}
          {wall.mode === "free" && (
            <button type="button" className="menu-item" onClick={() => core.updateWall({ free: {} })}>
              <span>
                <LayoutDashboard size={15} /> Tout remettre en grille
              </span>
            </button>
          )}
          <div className="menu-title">Streams</div>
          {missing > 0 && (
            <button
              type="button"
              className="menu-item"
              onClick={() => {
                core.watchAll();
                close();
              }}
            >
              <span>
                <Eye size={15} /> Tout regarder ({missing})
              </span>
            </button>
          )}
          <label className="menu-toggle">
            <span>Ouvrir tous les streams du salon</span>
            <Toggle label="Ouvrir tous les streams du salon" checked={wall.watchAll} onChange={watchAll => core.updateWall({ watchAll })} />
          </label>
          <label className="menu-toggle">
            <span>Le son suit l'image en grand</span>
            <Toggle label="Le son suit l'image en grand" checked={wall.audioFollows} onChange={audioFollows => core.updateWall({ audioFollows })} />
          </label>
          <label className="menu-toggle" title="Une petite image n'a pas besoin de 1080p : ton diffuseur et ta connexion respirent">
            <span>Adapter la qualité à la taille</span>
            <Toggle label="Adapter la qualité à la taille" checked={wall.fitQuality} onChange={fitQuality => core.updateWall({ fitQuality })} />
          </label>
          {live && (
            <label className="menu-toggle">
              <span>Voir mon retour</span>
              <Toggle label="Voir mon retour" checked={wall.showOwn} onChange={showOwn => core.updateWall({ showOwn })} />
            </label>
          )}
        </div>
      )}
    </Popover>
  );
}

function Dock() {
  const voiceJoined = useApp(s => s.voiceJoined);
  const muted = useApp(s => s.muted);
  const deafened = useApp(s => s.deafened);
  const publish = useApp(s => s.publish);
  const whoCanStream = useApp(s => s.room!.settings.whoCanStream);
  const isOwner = useApp(s => s.room!.ownerId === s.accountId);
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
        <IconButton label="Lancer une Watch Party" disabled={!canStream} onClick={() => set({ dialog: "together" })}>
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
      <Field label="Qui peut diffuser ?" hint="Et lancer une Watch Party">
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
