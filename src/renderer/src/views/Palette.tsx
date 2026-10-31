import { Bell, Clapperboard, Eye, Gamepad2, Keyboard, LayoutDashboard, Tag, Link2, LogOut, Mic, Monitor, Palette as PaletteIcon, Phone, Radio, Rewind, Scissors, Search, Settings as SettingsIcon, TvMinimalPlay, Users, Volume2, Vote } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { core } from "../engine/core.ts";
import { get, memberOf, set, toast, useApp } from "../state/store.ts";
import type { SettingsSection } from "../state/store.ts";
import { Modal } from "../ui/kit.tsx";

interface Command {
  id: string;
  group: string;
  label: string;
  hint?: string;
  icon: ReactNode;
  run: () => void;
}

const SETTINGS: { id: SettingsSection; label: string }[] = [
  { id: "appearance", label: "Apparence" },
  { id: "voice", label: "Son et voix" },
  { id: "stream", label: "Diffusion" },
  { id: "hotkeys", label: "Raccourcis" },
  { id: "notifications", label: "Notifications" },
];

const normalize = (text: string) => text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

function commands(): Command[] {
  const { settings, room, publish, voiceJoined, muted, deafened, cinema } = get();
  const list: Command[] = [];
  for (const r of settings!.recentRooms) list.push({ id: `room:${r.id}`, group: "Salons", label: r.name, hint: r.code, icon: <Users size={16} />, run: () => void core.openRoom(r.id) });
  if (room) {
    const canShare = room.settings.whoCanStream === "everyone" || room.ownerId === get().userId;
    for (const s of room.streams) {
      if (s.ownerId === get().userId) continue;
      const name = memberOf(s.ownerId)?.name ?? "?";
      list.push({ id: `stream:${s.id}`, group: "Streams", label: `Regarder ${name}`, hint: s.title || s.sourceName, icon: <Eye size={16} />, run: () => (set({ view: "room", focused: s.id }), void core.watch(s.id)) });
    }
    if (publish) list.push({ id: "stop", group: "Actions", label: "Arrêter le stream", icon: <Radio size={16} />, run: () => void core.stopLive() });
    else if (canShare) list.push({ id: "live", group: "Actions", label: "Lancer un stream", icon: <Radio size={16} />, run: () => set({ goLiveOpen: true, view: "room" }) });
    if (canShare) list.push({ id: "together", group: "Actions", label: "Lancer une Watch Party", icon: <TvMinimalPlay size={16} />, run: () => set({ dialog: "together", view: "room" }) });
    list.push(
      { id: "poll", group: "Actions", label: "Lancer un sondage", icon: <Vote size={16} />, run: () => set({ dialog: "poll", view: "room" }) },
      { id: "clip", group: "Actions", label: "Garder un clip", hint: settings!.hotkeys.saveClip, icon: <Scissors size={16} />, run: () => void core.saveClip() },
      { id: "replay", group: "Actions", label: "Revoir les dernières secondes", hint: "R", icon: <Rewind size={16} />, run: () => void core.replay() },
      ...(publish ? [{ id: "regie", group: "Actions", label: get().regie ? "Fermer la régie" : "Ouvrir la régie", hint: "G", icon: <LayoutDashboard size={16} />, run: () => (get().regie ? set({ regie: false }) : core.openRegie()) }, { id: "marker", group: "Actions", label: "Poser un marqueur", hint: settings!.hotkeys.marker, icon: <Tag size={16} />, run: () => core.addMarker() }] : []),
      ...(publish ? settings!.scenes.map(scene => ({ id: `scene:${scene.id}`, group: "Scènes", label: scene.name, icon: <Clapperboard size={16} />, run: () => void core.applyScene(scene.id) })) : []),
      ...(publish?.controller ? [{ id: "hand", group: "Actions", label: "Reprendre la main", hint: settings!.hotkeys.control, icon: <Gamepad2 size={16} />, run: () => core.endControl() }] : []),
      { id: "cinema", group: "Actions", label: cinema ? "Quitter le mode cinéma" : "Mode cinéma", hint: "T", icon: <Clapperboard size={16} />, run: () => set({ cinema: !cinema, view: "room" }) },
      { id: "voice", group: "Actions", label: voiceJoined ? "Quitter le vocal" : "Rejoindre le vocal", icon: <Phone size={16} />, run: () => (voiceJoined ? core.voiceLeave() : void core.voiceJoin()) },
      { id: "mic", group: "Actions", label: muted ? "Réactiver le micro" : "Couper le micro", hint: settings!.hotkeys.toggleMic, icon: <Mic size={16} />, run: () => core.toggleMute() },
      { id: "deafen", group: "Actions", label: deafened ? "Réactiver le son" : "Couper tout le son", hint: settings!.hotkeys.toggleDeafen, icon: <Volume2 size={16} />, run: () => core.toggleDeafen() },
      {
        id: "invite",
        group: "Actions",
        label: "Copier le lien d'invitation",
        hint: room.code,
        icon: <Link2 size={16} />,
        run: () => {
          window.spoka.copyText(core.inviteLink(room.code));
          toast("Lien copié", "success");
        },
      },
      { id: "leave", group: "Actions", label: "Quitter le salon", icon: <LogOut size={16} />, run: () => core.leaveRoom() },
    );
  }
  list.push({ id: "home", group: "Aller à", label: "Accueil", icon: <Monitor size={16} />, run: () => set({ view: "home" }) });
  for (const s of SETTINGS) list.push({ id: `settings:${s.id}`, group: "Aller à", label: `Paramètres : ${s.label}`, icon: s.id === "appearance" ? <PaletteIcon size={16} /> : s.id === "notifications" ? <Bell size={16} /> : s.id === "hotkeys" ? <Keyboard size={16} /> : <SettingsIcon size={16} />, run: () => set({ view: "settings", settingsSection: s.id }) });
  list.push({ id: "shortcuts", group: "Aller à", label: "Raccourcis clavier", hint: "?", icon: <Keyboard size={16} />, run: () => set({ dialog: "shortcuts" }) });
  return list;
}

export function Palette() {
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const all = useMemo(commands, []);
  const list = useRef<HTMLDivElement>(null);
  const close = () => set({ dialog: null });

  const shown = useMemo(() => {
    const words = normalize(query).split(/\s+/).filter(Boolean);
    return all.filter(c => {
      const text = normalize(`${c.label} ${c.hint ?? ""} ${c.group}`);
      return words.every(w => text.includes(w));
    });
  }, [all, query]);

  useEffect(() => setIndex(0), [query]);
  useEffect(() => {
    list.current?.querySelector(".is-on")?.scrollIntoView({ block: "nearest" });
  }, [index]);

  const run = (command: Command | undefined) => {
    if (!command) return;
    close();
    command.run();
  };

  let lastGroup = "";
  return (
    <div className="modal-backdrop palette-backdrop" onMouseDown={e => e.target === e.currentTarget && close()}>
      <div className="modal palette" role="dialog" aria-modal aria-label="Palette de commandes">
        <div className="palette-search">
          <Search size={17} />
          <input
            autoFocus
            value={query}
            placeholder="Salon, stream, action…"
            aria-label="Rechercher"
            onChange={e => setQuery(e.target.value)}
            onKeyDown={e => {
              if (e.key === "Escape") close();
              else if (e.key === "ArrowDown") (e.preventDefault(), setIndex(i => Math.min(i + 1, shown.length - 1)));
              else if (e.key === "ArrowUp") (e.preventDefault(), setIndex(i => Math.max(i - 1, 0)));
              else if (e.key === "Enter") run(shown[index]);
            }}
          />
        </div>
        <div className="palette-list" ref={list}>
          {shown.length === 0 && <p className="muted-text">Rien ne correspond.</p>}
          {shown.map((command, i) => {
            const title = command.group !== lastGroup ? command.group : null;
            lastGroup = command.group;
            return (
              <div key={command.id}>
                {title && <div className="menu-title">{title}</div>}
                <button type="button" className={`palette-item ${i === index ? "is-on" : ""}`} onMouseEnter={() => setIndex(i)} onClick={() => run(command)}>
                  {command.icon}
                  <span>{command.label}</span>
                  {command.hint && <small>{command.hint}</small>}
                </button>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

const SHORTCUTS: [string, string][] = [
  ["Ctrl + K", "Tout trouver : salons, streams, actions"],
  ["T", "Mode cinéma"],
  ["F", "Plein écran"],
  ["M", "Couper le son du stream"],
  ["Flèches haut et bas", "Volume du stream"],
  ["R", "Revoir les dernières secondes, les couper, les envoyer"],
  ["C", "Garder un clip"],
  ["G", "Ouvrir ou fermer la régie, pendant un direct"],
  ["I", "Statistiques"],
  ["Ctrl + molette, + ou -", "Zoomer dans l'image"],
  ["0", "Enlever le zoom"],
  ["Entrée", "Écrire dans le chat"],
  ["?", "Cette aide"],
];

export function ShortcutsModal() {
  const hotkeys = useApp(s => s.settings!.hotkeys);
  return (
    <Modal title="Raccourcis clavier" onClose={() => set({ dialog: null })} width={480}>
      <div className="shortcuts">
        {SHORTCUTS.map(([keys, label]) => (
          <div key={keys}>
            <kbd>{keys}</kbd>
            <span>{label}</span>
          </div>
        ))}
      </div>
      <h3 className="shortcuts-title">Partout, même en jeu</h3>
      <div className="shortcuts">
        {[
          [hotkeys.toggleMic, "Couper ou réactiver le micro"],
          [hotkeys.toggleDeafen, "Couper ou réactiver tout le son"],
          [hotkeys.toggleStream, "Lancer ou arrêter le stream"],
          [hotkeys.pauseStream, "Mettre le stream en pause"],
          [hotkeys.saveClip, "Garder un clip"],
          [hotkeys.control, "Accepter une demande de main, ou la reprendre"],
          [hotkeys.marker, "Poser un marqueur dans le direct"],
        ]
          .filter(([keys]) => keys)
          .map(([keys, label]) => (
            <div key={label}>
              <kbd>{keys}</kbd>
              <span>{label}</span>
            </div>
          ))}
      </div>
    </Modal>
  );
}
