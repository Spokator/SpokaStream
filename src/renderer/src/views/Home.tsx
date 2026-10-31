import { ArrowRight, Keyboard, Radio, Server, Users, Volume2, WifiOff } from "lucide-react";
import { useState } from "react";
import { core } from "../engine/core.ts";
import { set, useApp } from "../state/store.ts";
import { hueOf, initials, plural } from "../ui/format.ts";
import { Avatar, Button } from "../ui/kit.tsx";
import { CreateRoomModal } from "./Shell.tsx";

export function Home() {
  const settings = useApp(s => s.settings)!;
  const statuses = useApp(s => s.statuses);
  const connection = useApp(s => s.connection);
  const audioEngine = useApp(s => s.audioEngine);
  const serverName = useApp(s => s.serverName);
  const unreachable = useApp(s => s.unreachable);
  const [code, setCode] = useState("");
  const [creating, setCreating] = useState(false);
  const rooms = [...settings.recentRooms].sort((a, b) => (statuses[b.id]?.live.length ?? 0) - (statuses[a.id]?.live.length ?? 0) || b.at - a.at);
  const liveRooms = rooms.filter(r => (statuses[r.id]?.live.length ?? 0) > 0);
  const liveNow = liveRooms.flatMap(room => statuses[room.id]!.live.map(live => ({ room, live })));

  const join = () => {
    if (code.trim()) void core.joinRoom(code);
    setCode("");
  };

  return (
    <div className="home">
      <div className="home-inner">
        <h1>Salut {settings.profile.name}</h1>
        <p className="home-sub">{liveRooms.length ? `${plural(liveRooms.length, "salon")} en direct en ce moment.` : "Lance un salon, invite tes amis, partage ce que tu veux avec le son que tu veux."}</p>

        {unreachable && (
          <section className="home-alert" role="status">
            <WifiOff size={20} />
            <div>
              <b>Le serveur de salons ne répond pas</b>
              <span>Vérifie ta connexion ou l'adresse du serveur. Tu peux aussi héberger sur ce PC, pour jouer en réseau local.</span>
            </div>
            <Button onClick={() => set({ view: "settings", settingsSection: "server" })}>Régler le serveur</Button>
          </section>
        )}

        <section className="home-actions">
          <button type="button" className="home-card home-card-primary" disabled={connection !== "online"} onClick={() => setCreating(true)}>
            <Radio size={22} />
            <span>
              <b>Créer un salon</b>
              <small>Un espace à toi pour streamer entre amis</small>
            </span>
            <ArrowRight size={18} />
          </button>
          <div className="home-card home-join">
            <Users size={22} />
            <span>
              <b>Rejoindre un salon</b>
              <small>Colle un code ou un lien d'invitation</small>
            </span>
            <div className="home-join-row">
              <input className="input" value={code} placeholder="ABCD2345" aria-label="Code du salon" onChange={e => setCode(e.target.value)} onKeyDown={e => e.key === "Enter" && join()} />
              <Button disabled={connection !== "online" || !code.trim()} onClick={join}>
                Rejoindre
              </Button>
            </div>
          </div>
        </section>

        {liveNow.length > 0 && (
          <section>
            <h2 className="section-title">En direct maintenant</h2>
            <div className="live-grid">
              {liveNow.map(({ room, live }, i) => (
                <button key={`${room.id}-${i}`} type="button" className="live-card" onClick={() => void core.openRoom(room.id)}>
                  {live.thumb ? <img src={live.thumb} alt="" /> : <div className="live-card-empty" />}
                  <span className="live-pill">En direct</span>
                  <span className="live-card-text">
                    <b>{live.ownerName}</b>
                    <small>{live.title ? `${live.title} · ${room.name}` : room.name}</small>
                  </span>
                </button>
              ))}
            </div>
          </section>
        )}

        {rooms.length > 0 && (
          <section>
            <h2 className="section-title">Tes salons</h2>
            <div className="room-grid">
              {rooms.map(r => {
                const status = statuses[r.id];
                const live = status?.live ?? [];
                return (
                  <button key={r.id} type="button" className="room-card" onClick={() => void core.openRoom(r.id)}>
                    <span className="room-card-icon" style={{ "--hue": hueOf(r.name) } as React.CSSProperties}>
                      {initials(r.name)}
                    </span>
                    <span className="room-card-text">
                      <b>{r.name}</b>
                      <small>{live.length ? `${live.map(l => l.ownerName).join(", ")} en direct` : status?.party ? `Watch Party : ${status.party}` : status ? plural(status.members, "personne") : "Hors ligne"}</small>
                    </span>
                    {status?.online.length ? (
                      <span className="room-card-people">
                        {status.online.slice(0, 4).map((person, index) => (
                          <Avatar key={index} name={person.name} color={person.color} size={22} />
                        ))}
                      </span>
                    ) : null}
                  </button>
                );
              })}
            </div>
          </section>
        )}

        <section className="health">
          <div className={`health-item ${connection === "online" ? "is-ok" : "is-bad"}`}>
            <Server size={15} />
            {connection === "online" ? `Connecté à ${serverName || "SpokaStream"}` : unreachable || connection !== "connecting" ? "Serveur injoignable" : "Connexion au serveur…"}
          </div>
          <div className={`health-item ${audioEngine === "ready" ? "is-ok" : audioEngine === "starting" ? "" : "is-bad"}`}>
            <Volume2 size={15} />
            {audioEngine === "ready" ? "Capture du son par application prête" : audioEngine === "starting" ? "Démarrage du moteur audio…" : "Moteur audio indisponible"}
          </div>
          <button type="button" className="health-item is-link" onClick={() => set({ dialog: "shortcuts" })}>
            <Keyboard size={15} />
            Raccourcis clavier
          </button>
        </section>
      </div>
      {creating && <CreateRoomModal onClose={() => setCreating(false)} />}
    </div>
  );
}
