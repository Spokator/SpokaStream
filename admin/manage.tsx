/** @jsxImportSource preact */
import { Ban, Download, Lock, MessageSquareOff, ShieldBan, Square, Trash2, Unlock, UserMinus, Volume2, VolumeX } from "lucide-preact";
import { useMemo, useState } from "preact/hooks";
import type { AccountLimits } from "@shared/protocol.ts";
import { AccountBandwidth } from "./bandwidth.tsx";
import { act, ArmedButton, askedUser, can, count, date, DURATIONS, Note, number, time, useAction, usePolled } from "./lib.tsx";
import { LimitsForm, limitsSummary } from "./limits.tsx";

interface RoomRow {
  id: string;
  code: string;
  name: string;
  ownerId: string;
  ownerName: string;
  locked: boolean;
  bans: number;
  lastActivity: number;
  messages: number;
  party: string | null;
  liveMinutes: number;
  members: { id: string; account: string; name: string; color: string; online: boolean; web: boolean; voice: boolean }[];
  streams: { id: string; ownerId: string; ownerName: string; title: string; kind: string; width: number; height: number; fps: number; viewers: number; startedAt: number; paused: boolean }[];
}

interface RoomDetail {
  name: string;
  settings: { whoCanStream: "everyone" | "owner"; maxKbps: number; locked: boolean };
  history: { id: string; at: number; kind: string; name: string; color: string; text: string; image: boolean; clip: boolean }[];
  poll: { id: string; question: string; closed: boolean } | null;
  together: { title: string; playing: boolean; queue: number } | null;
  bans: { id: string; name: string }[];
}

interface UserRow {
  id: string;
  name: string;
  color: string;
  firstSeen: number;
  lastSeen: number;
  banned?: boolean;
  banReason?: string;
  bannedUntil?: number;
  mutedUntil?: number;
  admin: boolean;
  /** Ce qui s'applique vraiment, limites du serveur comprises. */
  limits: AccountLimits | null;
  ownLimits: AccountLimits | null;
  uploadKbps: number;
  online: boolean;
  rooms: number;
  stats?: { streams: number; streamMinutes: number; watchMinutes: number; messages: number };
  devices: { id: string; client: string; version: string; label: string; lastSeen: number }[];
}

interface UserDetail {
  sanctions?: { at: number; kind: string; by: string; reason: string; until: number }[];
  notes?: { at: number; by: string; text: string }[];
  ips?: { ip: string; at: number }[];
  sharingIp: { id: string; name: string; banned: boolean }[];
}

interface LogRow {
  at: number;
  level: "info" | "warning" | "error";
  topic: string;
  text: string;
}

interface ReportRow {
  id: string;
  at: number;
  kind: "error" | "feedback";
  name: string;
  client: string;
  text: string;
  details: string;
}

/** Le salon vu de l'intérieur : son chat, ses réglages et ce qui s'y passe, sans y entrer. */
function RoomInside({ room, users, run }: { room: RoomRow; users: UserRow[]; run: (action: string, fields: Record<string, unknown>, done: string) => void }) {
  const { data, refresh } = usePolled<RoomDetail>(`room?id=${room.id}`);
  const [name, setName] = useState(room.name);
  const [owner, setOwner] = useState(room.ownerId);
  const [say, setSay] = useState("");
  const [cap, setCap] = useState("");
  const send = (action: string, fields: Record<string, unknown>, done: string) => {
    run(action, { roomId: room.id, ...fields }, done);
    setTimeout(() => void refresh(), 300);
  };
  if (!data) return <p class="muted">Chargement…</p>;
  const messages = data.history.filter(m => m.kind === "user").slice(-40).reverse();
  return (
    <div class="tools">
      {data.together && (
        <div class="tool-row">
          <span>
            Watch Party : {data.together.title} {data.together.playing ? "" : "(en pause)"}
          </span>
          <button type="button" onClick={() => send("stopParty", {}, "Watch Party arrêtée.")}>
            Arrêter
          </button>
        </div>
      )}
      {data.poll && !data.poll.closed && (
        <div class="tool-row">
          <span>Sondage : {data.poll.question}</span>
          <button type="button" onClick={() => send("closePoll", {}, "Sondage fermé.")}>
            Fermer
          </button>
        </div>
      )}
      <div class="tool-row">
        <input value={say} maxLength={300} placeholder="Un message visible par tout le salon" aria-label={`Message dans ${room.name}`} onInput={e => setSay(e.currentTarget.value)} />
        <button type="button" disabled={!say.trim()} onClick={() => (send("roomSay", { text: say }, "Message envoyé."), setSay(""))}>
          Écrire
        </button>
      </div>
      <details>
        <summary>Chat, {count(data.history.filter(m => m.kind === "user").length, "message", "messages")}</summary>
        {messages.length === 0 && <p class="muted">Aucun message.</p>}
        <div class="chat-log">
          {messages.map(message => (
            <p key={message.id}>
              <time>{time(message.at)}</time>
              <b style={{ color: message.color }}>{message.name}</b>
              <span>{message.image ? "[image]" : message.text}</span>
              <button type="button" class="icon" title="Supprimer ce message" aria-label={`Supprimer le message de ${message.name}`} onClick={() => send("deleteMessage", { id: message.id }, "Message supprimé.")}>
                <Trash2 size={13} />
              </button>
            </p>
          ))}
        </div>
        {can("admin") && messages.length > 0 && (
          <div class="tool-row">
            <ArmedButton label="Vider tout le chat" confirm="Confirmer : tout le chat sera effacé" onConfirm={() => send("clearChat", {}, "Chat vidé.")} />
          </div>
        )}
      </details>
      {can("admin") && (
        <>
          <div class="tool-row">
            <input value={name} maxLength={48} aria-label={`Nouveau nom de ${room.name}`} onInput={e => setName(e.currentTarget.value)} />
            <button type="button" disabled={!name.trim() || name === room.name} onClick={() => send("renameRoom", { name }, "Salon renommé.")}>
              Renommer
            </button>
          </div>
          <div class="tool-row">
            <select value={owner} aria-label={`Propriétaire de ${room.name}`} onChange={e => setOwner(e.currentTarget.value)}>
              {users.map(user => (
                <option key={user.id} value={user.id}>
                  {user.name || "Sans nom"}
                </option>
              ))}
            </select>
            <button type="button" disabled={owner === room.ownerId} onClick={() => send("transferRoom", { accountId: owner }, "Salon donné.")}>
              Donner le salon
            </button>
          </div>
          <div class="tool-row">
            <span>Qui peut diffuser</span>
            <select value={data.settings.whoCanStream} aria-label={`Qui peut diffuser dans ${room.name}`} onChange={e => send("roomSettings", { whoCanStream: e.currentTarget.value }, "Réglage enregistré.")}>
              <option value="everyone">Tout le monde</option>
              <option value="owner">Le propriétaire seulement</option>
            </select>
          </div>
          <div class="tool-row">
            <span>Débit maximum : {data.settings.maxKbps ? `${number(data.settings.maxKbps / 1000, 1)} Mb/s` : "aucune limite"}</span>
            <input type="number" min={0} value={cap} placeholder="Mb/s, 0 pour aucune limite" aria-label={`Débit maximum de ${room.name}`} onInput={e => setCap(e.currentTarget.value)} />
            <button type="button" disabled={cap === ""} onClick={() => (send("roomSettings", { maxKbps: Number(cap) * 1000 }, "Débit enregistré."), setCap(""))}>
              Appliquer
            </button>
          </div>
          {data.bans.length > 0 && (
            <div class="tool-row">
              <span>Bannis de ce salon : {data.bans.map(ban => ban.name).join(", ")}</span>
              <button type="button" onClick={() => send("clearBans", {}, "Bannissements levés.")}>
                Tout lever
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

export function RoomsPage() {
  const { data, error, refresh } = usePolled<RoomRow[]>("rooms");
  const { data: users } = usePolled<UserRow[]>("users", 30_000);
  const { note, problem, run } = useAction(refresh);
  const [search, setSearch] = useState("");
  const [open, setOpen] = useState("");
  const [armed, setArmed] = useState("");
  if (!data) return <p class="empty">{error || "Chargement…"}</p>;
  if (!data.length) return <p class="empty">Aucun salon.</p>;
  const needle = search.toLowerCase();
  const shown = data.filter(room => !needle || room.name.toLowerCase().includes(needle) || room.code.toLowerCase().includes(needle) || room.ownerName.toLowerCase().includes(needle));
  return (
    <div class="list">
      <Note note={note} problem={problem} />
      <input class="search" value={search} placeholder="Chercher un salon, un code ou un propriétaire" aria-label="Chercher un salon" onInput={e => setSearch(e.currentTarget.value)} />
      {[...shown]
        .sort((a, b) => b.streams.length - a.streams.length || b.members.length - a.members.length || b.lastActivity - a.lastActivity)
        .map(room => (
          <article key={room.id} class="card">
            <header>
              <div>
                <h2>{room.name}</h2>
                <small>
                  {room.code} · à {room.ownerName} · actif le {date(room.lastActivity)} · {count(room.messages, "message", "messages")} · {room.liveMinutes} min de direct
                </small>
              </div>
              {room.streams.length > 1 && (
                <button type="button" class="icon" title="Arrêter tous les streams" aria-label="Arrêter tous les streams du salon" onClick={() => run("stopAll", { roomId: room.id }, "Streams arrêtés.")}>
                  <Square size={16} />
                </button>
              )}
              <button type="button" class="icon" title={room.locked ? "Déverrouiller" : "Verrouiller"} aria-label={room.locked ? "Déverrouiller le salon" : "Verrouiller le salon"} onClick={() => run("lockRoom", { roomId: room.id, locked: !room.locked }, room.locked ? "Salon déverrouillé." : "Salon verrouillé.")}>
                {room.locked ? <Lock size={16} /> : <Unlock size={16} />}
              </button>
              {can("admin") && (
                <button type="button" class={`icon ${armed === room.id ? "is-armed" : ""}`} title={armed === room.id ? "Toucher encore pour supprimer" : "Supprimer le salon"} aria-label="Supprimer le salon" onClick={() => (armed === room.id ? (setArmed(""), run("deleteRoom", { roomId: room.id }, "Salon supprimé.")) : setArmed(room.id))}>
                  <Trash2 size={16} />
                </button>
              )}
              <button type="button" class="manage" aria-expanded={open === room.id} onClick={() => setOpen(open === room.id ? "" : room.id)}>
                Gérer
              </button>
            </header>
            {room.party && <p class="tag">Watch Party : {room.party}</p>}
            {room.streams.map(stream => (
              <div key={stream.id} class="row-line is-live">
                <span>
                  <b>{stream.ownerName}</b> {stream.title || stream.kind} · {stream.width}×{stream.height} · {stream.fps} i/s · {count(stream.viewers, "spectateur", "spectateurs")} · depuis {time(stream.startedAt)}
                  {stream.paused ? " · en pause" : ""}
                </span>
                <button type="button" class="icon" title="Arrêter ce stream" aria-label={`Arrêter le stream de ${stream.ownerName}`} onClick={() => run("stopStream", { roomId: room.id, ownerId: stream.ownerId }, "Stream arrêté.")}>
                  <Square size={15} />
                </button>
              </div>
            ))}
            {room.members.map(member => (
              <div key={member.id} class="row-line">
                <span>
                  <i class="dot" style={{ background: member.color }} /> {member.name}
                  {!member.online && " · déconnecté"}
                  {member.web && " · site"}
                  {member.voice && " · vocal"}
                </span>
                <button type="button" class="icon" title="Retirer du salon" aria-label={`Retirer ${member.name}`} onClick={() => run("kick", { roomId: room.id, userId: member.id }, `${member.name} retiré du salon.`)}>
                  <UserMinus size={15} />
                </button>
              </div>
            ))}
            {open === room.id && <RoomInside room={room} users={users ?? []} run={run} />}
          </article>
        ))}
    </div>
  );
}

const SANCTIONS: Record<string, string> = { limit: "Limité", unlimit: "Limites levées", ban: "Banni", unban: "Débanni", mute: "Rendu muet", unmute: "Parole rendue", warn: "Averti", kick: "Retiré" };

function Duration({ value, onChange, label }: { value: number; onChange: (hours: number) => void; label: string }) {
  return (
    <select value={value} aria-label={label} onChange={e => onChange(Number(e.currentTarget.value))}>
      {DURATIONS.map(duration => (
        <option key={duration.hours} value={duration.hours}>
          {duration.label}
        </option>
      ))}
      <option value={0}>Sans limite</option>
    </select>
  );
}

function UserTools({ user, refresh }: { user: UserRow; refresh: () => void }) {
  const { data, refresh: refreshDetail } = usePolled<UserDetail>(`account?id=${user.id}`, 15_000);
  const [name, setName] = useState(user.name);
  const [message, setMessage] = useState("");
  const [reason, setReason] = useState("");
  const [note, setNote] = useState("");
  const [banHours, setBanHours] = useState(24);
  const [muteHours, setMuteHours] = useState(1);
  const [withRooms, setWithRooms] = useState(false);
  const [limitHours, setLimitHours] = useState(0);
  const [showBandwidth, setShowBandwidth] = useState(false);
  const [feedback, setFeedback] = useState("");
  const muted = !!user.mutedUntil && user.mutedUntil > Date.now();
  const run = (action: string, fields: Record<string, unknown>, done: string) =>
    void act(action, { accountId: user.id, ...fields }).then(
      () => {
        setFeedback(done);
        void refresh();
        void refreshDetail();
      },
      (e: Error) => setFeedback(e.message),
    );
  const blockIp = (ip: string) => run("blockIp", { ip, reason: `Compte ${user.name}` }, `Adresse ${ip} bloquée.`);
  return (
    <div class="tools">
      {feedback && (
        <p class="tool-note" role="status">
          {feedback}
        </p>
      )}
      <dl class="inline">
        <dt>A diffusé</dt>
        <dd>
          {user.stats?.streamMinutes ?? 0} min, {count(user.stats?.streams ?? 0, "direct", "directs")}
        </dd>
        <dt>A regardé</dt>
        <dd>{user.stats?.watchMinutes ?? 0} min</dd>
        <dt>Messages</dt>
        <dd>{user.stats?.messages ?? 0}</dd>
        {user.uploadKbps > 0 && (
          <>
            <dt>Envoie en ce moment</dt>
            <dd>{(user.uploadKbps / 1000).toFixed(1)} Mb/s</dd>
          </>
        )}
        {user.limits && (
          <>
            <dt>{user.ownLimits ? "Limité" : "Limites du serveur"}</dt>
            <dd>
              {limitsSummary(user.limits)}
              {user.ownLimits?.until ? `, jusqu'au ${date(user.ownLimits.until)}` : ""}
            </dd>
          </>
        )}
        <dt>Identifiant</dt>
        <dd>
          <code>{user.id}</code>
        </dd>
      </dl>
      <div class="tool-row">
        <input value={name} maxLength={32} aria-label={`Nouveau pseudo de ${user.name}`} onInput={e => setName(e.currentTarget.value)} />
        <button type="button" disabled={!name.trim() || name === user.name} onClick={() => run("renameUser", { name }, "Pseudo changé partout.")}>
          Renommer
        </button>
      </div>
      <div class="tool-row">
        <input value={message} maxLength={300} placeholder={user.online ? "Un message pour cette personne" : "Hors ligne pour l'instant"} aria-label={`Message pour ${user.name}`} disabled={!user.online} onInput={e => setMessage(e.currentTarget.value)} />
        <button type="button" disabled={!message.trim() || !user.online} onClick={() => (run("message", { text: message }, "Message envoyé."), setMessage(""))}>
          Envoyer
        </button>
        <button type="button" disabled={!message.trim() || !user.online} onClick={() => (run("warn", { text: message }, "Avertissement envoyé et gardé dans sa fiche."), setMessage(""))}>
          Avertir
        </button>
      </div>
      <div class="tool-row">
        <button type="button" disabled={!user.online} onClick={() => run("disconnect", {}, "Déconnecté.")}>
          Déconnecter
        </button>
        <button type="button" onClick={() => run("clearAvatar", {}, "Photo retirée.")}>
          Retirer la photo
        </button>
      </div>
      {!user.admin && (
        <>
          <div class="tool-row">
            <input value={reason} maxLength={200} placeholder="Motif, gardé dans sa fiche" aria-label={`Motif pour ${user.name}`} onInput={e => setReason(e.currentTarget.value)} />
          </div>
          <div class="tool-row">
            {muted ? (
              <>
                <span>Muet jusqu'au {date(user.mutedUntil!)}</span>
                <button type="button" onClick={() => run("mute", { hours: 0 }, "Parole rendue.")}>
                  <Volume2 size={14} /> Rendre la parole
                </button>
              </>
            ) : (
              <>
                <Duration value={muteHours} onChange={setMuteHours} label={`Durée du silence de ${user.name}`} />
                <button type="button" onClick={() => run("mute", { hours: muteHours || 87_600, reason }, "Cette personne ne peut plus écrire.")}>
                  <VolumeX size={14} /> Rendre muet
                </button>
              </>
            )}
          </div>
          <div class="tool-row">
            {user.banned ? (
              <>
                <span>
                  Banni{user.bannedUntil ? ` jusqu'au ${date(user.bannedUntil)}` : ""}
                  {user.banReason ? ` : ${user.banReason}` : ""}
                </span>
                <button type="button" onClick={() => run("ban", { banned: false }, "Bannissement levé.")}>
                  Lever le bannissement
                </button>
              </>
            ) : (
              <>
                <Duration value={banHours} onChange={setBanHours} label={`Durée du bannissement de ${user.name}`} />
                <button type="button" class="is-danger" onClick={() => run("ban", { banned: true, reason, hours: banHours }, "Banni du serveur.")}>
                  <Ban size={14} /> Bannir du serveur
                </button>
              </>
            )}
          </div>
        </>
      )}
      <details onToggle={e => setShowBandwidth(e.currentTarget.open)}>
        <summary>Bande passante</summary>
        {showBandwidth && <AccountBandwidth id={user.id} name={user.name} />}
      </details>
      {can("admin") && !user.admin && (
        <details>
          <summary>Limites de ce compte</summary>
          <p class="muted">Le débit est le total envoyé à tous ses spectateurs. L'application l'applique, et le serveur coupe le stream s'il reste au-dessus 30 secondes. Le reste est tenu par le serveur. Le relais déjà ouvert continue jusqu'à la fin de la connexion en cours.</p>
          <LimitsForm key={JSON.stringify(user.ownLimits)} value={user.ownLimits} label={user.name} clearLabel="Lever les limites" onApply={limits => run("setLimits", { limits, hours: limitHours, reason }, "Limites appliquées.")} onClear={() => run("setLimits", { limits: null }, "Limites levées.")}>
            <Duration value={limitHours} onChange={setLimitHours} label={`Durée des limites de ${user.name}`} />
          </LimitsForm>
        </details>
      )}
      {user.devices.map(device => (
        <div key={device.id} class="tool-row">
          <span>
            {device.client === "web" ? "Site" : `Application ${device.version}`} {device.label && `· ${device.label}`} · vu le {date(device.lastSeen)}
            {device.id === user.id ? " · appareil principal" : ""}
          </span>
          {can("admin") && device.id !== user.id && (
            <button type="button" onClick={() => run("detachDevice", { deviceId: device.id }, "Appareil détaché.")}>
              Détacher
            </button>
          )}
        </div>
      ))}
      {data?.ips?.map(row => (
        <div key={row.ip} class="tool-row">
          <span>
            <code>{row.ip}</code> · vue le {date(row.at)}
          </span>
          {can("admin") && !user.admin && (
            <button type="button" onClick={() => blockIp(row.ip)}>
              Bloquer cette adresse
            </button>
          )}
        </div>
      ))}
      {!!data?.sharingIp.length && <p class="muted">Même adresse que : {data.sharingIp.map(other => `${other.name || "Sans nom"}${other.banned ? " (banni)" : ""}`).join(", ")}.</p>}
      <details>
        <summary>Sanctions et notes</summary>
        <div class="tool-row">
          <input value={note} maxLength={500} placeholder="Une note, visible des administrateurs seulement" aria-label={`Note sur ${user.name}`} onInput={e => setNote(e.currentTarget.value)} />
          <button type="button" disabled={!note.trim()} onClick={() => (run("addNote", { text: note }, "Note ajoutée."), setNote(""))}>
            Ajouter
          </button>
        </div>
        {data?.notes?.map(row => (
          <div key={row.at} class="row-line">
            <span>
              {row.text} <small>{row.by}, le {date(row.at)}</small>
            </span>
            <button type="button" class="icon" title="Supprimer cette note" aria-label="Supprimer cette note" onClick={() => run("removeNote", { at: row.at }, "Note supprimée.")}>
              <Trash2 size={13} />
            </button>
          </div>
        ))}
        {data?.sanctions?.map(row => (
          <div key={row.at} class="row-line">
            <span>
              {SANCTIONS[row.kind] ?? row.kind}
              {row.reason ? ` : ${row.reason}` : ""}
            </span>
            <small>
              {row.by}, le {date(row.at)}
              {row.until ? `, jusqu'au ${date(row.until)}` : ""}
            </small>
          </div>
        ))}
        {!data?.notes?.length && !data?.sanctions?.length && <p class="muted">Rien pour l'instant.</p>}
      </details>
      {can("admin") && !user.admin && (
        <div class="tool-row">
          {user.rooms > 0 && (
            <label class="tool-check">
              <input type="checkbox" checked={withRooms} onChange={e => setWithRooms(e.currentTarget.checked)} /> Supprimer aussi ses {count(user.rooms, "salon", "salons")}
            </label>
          )}
          <ArmedButton label="Supprimer le compte" confirm="Confirmer la suppression" onConfirm={() => run("deleteUser", { rooms: withRooms }, "Compte supprimé.")} />
        </div>
      )}
    </div>
  );
}

type Sort = "recent" | "stream" | "watch" | "messages";

export function UsersPage() {
  const { data, error, refresh } = usePolled<UserRow[]>("users");
  const [search, setSearch] = useState(askedUser.name);
  const [filter, setFilter] = useState<"all" | "online" | "banned" | "muted" | "limited">("all");
  const [sort, setSort] = useState<Sort>("recent");
  const [open, setOpen] = useState(askedUser.id);
  askedUser.id = askedUser.name = "";
  const shown = useMemo(() => {
    const needle = search.toLowerCase();
    const value = (user: UserRow) => (sort === "stream" ? (user.stats?.streamMinutes ?? 0) : sort === "watch" ? (user.stats?.watchMinutes ?? 0) : sort === "messages" ? (user.stats?.messages ?? 0) : 0);
    return (data ?? [])
      .filter(u => (u.name.toLowerCase().includes(needle) || u.id.startsWith(needle)) && (filter === "limited" ? !!u.ownLimits : filter === "all" || (filter === "online" ? u.online : filter === "banned" ? u.banned : !!u.mutedUntil)))
      .sort((a, b) => value(b) - value(a) || Number(b.online) - Number(a.online) || b.lastSeen - a.lastSeen);
  }, [data, search, filter, sort]);
  if (!data) return <p class="empty">{error || "Chargement…"}</p>;
  return (
    <>
      <input class="search" value={search} placeholder="Chercher un pseudo ou un identifiant" aria-label="Chercher un pseudo" onInput={e => setSearch(e.currentTarget.value)} />
      <div class="filters">
        {(["all", "online", "banned", "muted", "limited"] as const).map(value => (
          <button key={value} type="button" class={filter === value ? "is-on" : ""} onClick={() => setFilter(value)}>
            {value === "all" ? `Tous (${data.length})` : value === "online" ? "En ligne" : value === "banned" ? "Bannis" : value === "limited" ? "Limités" : "Muets"}
          </button>
        ))}
        <select value={sort} aria-label="Trier les comptes" onChange={e => setSort(e.currentTarget.value as Sort)}>
          <option value="recent">Vus récemment</option>
          <option value="stream">Temps de diffusion</option>
          <option value="watch">Temps regardé</option>
          <option value="messages">Messages</option>
        </select>
      </div>
      {shown.length === 0 && <p class="empty">Aucun compte ici.</p>}
      <div class="list">
        {shown.map(user => (
          <article key={user.id} class={`card ${user.banned ? "is-banned" : ""}`}>
            <div class="user">
              <i class="dot is-large" style={{ background: user.color }} />
              <div>
                <h2>
                  {user.name || "Sans nom"} {user.admin && <em>Administrateur</em>} {user.banned && <em class="is-bad">Banni</em>}
                </h2>
                <small>
                  {user.online ? "En ligne" : `Vu le ${date(user.lastSeen)}`} · arrivé le {date(user.firstSeen)} · {count(user.rooms, "salon", "salons")} · {count(user.devices.length, "appareil", "appareils")}
                </small>
              </div>
              <button type="button" class="manage" aria-expanded={open === user.id} onClick={() => setOpen(open === user.id ? "" : user.id)}>
                Gérer
              </button>
            </div>
            {open === user.id && <UserTools user={user} refresh={refresh} />}
          </article>
        ))}
      </div>
    </>
  );
}

interface ModerationData {
  sanctions: { id: string; name: string; banned: boolean; banReason: string; bannedUntil: number; mutedUntil: number; muteReason: string }[];
  blockedIps: { ip: string; reason: string; by: string; at: number; until: number }[];
  words: string[];
  slowSeconds: number;
  connections: { name: string; accountId: string | null; client: string; version: string; label: string; ip: string; room: string | null; guest: boolean }[];
}

export function ModerationPage() {
  const { data, error, refresh } = usePolled<ModerationData>("moderation");
  const { note, problem, run } = useAction(refresh);
  const [words, setWords] = useState<string | null>(null);
  const [slow, setSlow] = useState<string | null>(null);
  const [ip, setIp] = useState("");
  const [reason, setReason] = useState("");
  const [hours, setHours] = useState(24);
  if (!data) return <p class="empty">{error || "Chargement…"}</p>;
  const shownWords = words ?? data.words.join(", ");
  const shownSlow = slow ?? String(data.slowSeconds);
  return (
    <div class="list">
      <Note note={note} problem={problem} />
      <section class="card">
        <h2>
          <ShieldBan size={16} /> Sanctions en cours
        </h2>
        {data.sanctions.length === 0 && <p class="muted">Personne n'est sanctionné.</p>}
        {data.sanctions.map(row => (
          <div key={row.id} class="row-line">
            <span>
              <b>{row.name || "Sans nom"}</b> {row.banned ? `banni${row.bannedUntil ? ` jusqu'au ${date(row.bannedUntil)}` : ""}` : `muet jusqu'au ${date(row.mutedUntil)}`}
              {(row.banReason || row.muteReason) && ` : ${row.banReason || row.muteReason}`}
            </span>
            <button type="button" onClick={() => run(row.banned ? "ban" : "mute", { accountId: row.id, banned: false, hours: 0 }, "Sanction levée.")}>
              Lever
            </button>
          </div>
        ))}
      </section>
      {can("admin") && (
        <section class="card">
          <h2>
            <MessageSquareOff size={16} /> Chat
          </h2>
          <p class="muted">Les mots listés sont masqués dans tous les salons, accents et majuscules compris. Chaque message filtré est noté au journal.</p>
          <textarea value={shownWords} rows={2} aria-label="Mots interdits, séparés par des virgules" placeholder="mot, autre mot" onInput={e => setWords(e.currentTarget.value)} />
          <div class="tool-row">
            <span>Délai entre deux messages</span>
            <input type="number" min={0} max={300} value={shownSlow} aria-label="Délai entre deux messages, en secondes" onInput={e => setSlow(e.currentTarget.value)} />
            <small>secondes, 0 pour aucun</small>
            <button
              type="button"
              class="primary"
              onClick={() => {
                run("setConfig", { patch: { words: shownWords.split(",").map(word => word.trim()), slowSeconds: Number(shownSlow) } }, "Enregistré.");
                setWords(null);
                setSlow(null);
              }}
            >
              Enregistrer
            </button>
          </div>
        </section>
      )}
      {can("admin") && (
        <section class="card">
          <h2>Adresses bloquées</h2>
          <p class="muted">Une adresse bloquée ne peut plus se connecter, quel que soit le compte. Une adresse de particulier change parfois, et peut être partagée par tout un foyer.</p>
          <div class="tool-row">
            <input value={ip} maxLength={64} placeholder="Adresse IP" aria-label="Adresse IP à bloquer" onInput={e => setIp(e.currentTarget.value)} />
            <input value={reason} maxLength={200} placeholder="Motif" aria-label="Motif du blocage" onInput={e => setReason(e.currentTarget.value)} />
            <Duration value={hours} onChange={setHours} label="Durée du blocage" />
            <button type="button" disabled={!ip.trim()} onClick={() => (run("blockIp", { ip: ip.trim(), reason, hours }, "Adresse bloquée."), setIp(""), setReason(""))}>
              Bloquer
            </button>
          </div>
          {data.blockedIps.map(row => (
            <div key={row.ip} class="row-line">
              <span>
                <code>{row.ip}</code> {row.reason && `· ${row.reason}`} · par {row.by}
                {row.until ? ` · jusqu'au ${date(row.until)}` : ""}
              </span>
              <button type="button" onClick={() => run("unblockIp", { ip: row.ip }, "Adresse débloquée.")}>
                Débloquer
              </button>
            </div>
          ))}
        </section>
      )}
      <section class="card">
        <h2>Connexions en cours</h2>
        {data.connections.length === 0 && <p class="muted">Personne en ligne.</p>}
        <div class="table-wrap">
          <table class="stack">
            <thead>
              <tr>
                <th>Qui</th>
                <th>Appareil</th>
                <th>Salon</th>
                <th>Adresse</th>
                <th aria-hidden="true" />
              </tr>
            </thead>
            <tbody>
              {data.connections.map((row, i) => (
                <tr key={i}>
                  <td class="is-title">{row.name || "Inconnu"}</td>
                  <td data-label="Appareil">
                    {row.client === "site" ? "Site" : `Application ${row.version}`} {row.label && <small>{row.label}</small>}
                  </td>
                  <td data-label="Salon">{row.room ?? "—"}</td>
                  <td data-label="Adresse">
                    <code>{row.ip}</code>
                  </td>
                  <td class="num is-action">
                    {can("admin") && (
                      <button type="button" class="icon" title="Bloquer cette adresse" aria-label={`Bloquer ${row.ip}`} onClick={() => run("blockIp", { ip: row.ip, reason: row.name, hours: 24 }, `Adresse ${row.ip} bloquée pour 24 heures.`)}>
                        <Ban size={14} />
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

export function LogsPage() {
  const { data, error } = usePolled<LogRow[]>("logs");
  const [level, setLevel] = useState<"all" | "warning" | "error">("all");
  const [topic, setTopic] = useState("");
  const [search, setSearch] = useState("");
  if (!data) return <p class="empty">{error || "Chargement…"}</p>;
  const topics = [...new Set(data.map(row => row.topic))].sort();
  const needle = search.toLowerCase();
  const shown = data.filter(row => (level === "all" || row.level === level || (level === "warning" && row.level === "error")) && (!topic || row.topic === topic) && (!needle || row.text.toLowerCase().includes(needle)));
  return (
    <>
      <input class="search" value={search} placeholder="Chercher dans le journal" aria-label="Chercher dans le journal" onInput={e => setSearch(e.currentTarget.value)} />
      <div class="filters">
        {(["all", "warning", "error"] as const).map(value => (
          <button key={value} type="button" class={level === value ? "is-on" : ""} onClick={() => setLevel(value)}>
            {value === "all" ? "Tout" : value === "warning" ? "Alertes" : "Erreurs"}
          </button>
        ))}
        <select value={topic} aria-label="Sujet" onChange={e => setTopic(e.currentTarget.value)}>
          <option value="">Tous les sujets</option>
          {topics.map(value => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </select>
        <a class="button" href="/admin/api/logs.csv">
          <Download size={14} /> Exporter
        </a>
      </div>
      {shown.length === 0 && <p class="empty">Rien ici. Le journal garde les 2 000 dernières lignes, y compris après un redémarrage.</p>}
      <div class="logs">
        {shown.slice(0, 500).map((row, i) => (
          <p key={i} class={`log is-${row.level}`}>
            <time>{date(row.at)}</time>
            <b>{row.topic}</b>
            <span>{row.text}</span>
          </p>
        ))}
      </div>
    </>
  );
}

export function ReportsPage() {
  const { data, error, refresh } = usePolled<ReportRow[]>("reports");
  if (!data) return <p class="empty">{error || "Chargement…"}</p>;
  if (!data.length) return <p class="empty">Aucun retour. Les erreurs des applications et les problèmes signalés arrivent ici.</p>;
  return (
    <div class="list">
      {data.map(report => (
        <article key={report.id} class="card">
          <header>
            <div>
              <h2>{report.kind === "feedback" ? "Problème signalé" : "Erreur de l'application"}</h2>
              <small>
                {report.name} · {report.client === "web" ? "site" : "application"} · {date(report.at)}
              </small>
            </div>
            <button type="button" class="icon" title="Classer" aria-label="Classer ce retour" onClick={() => void act("deleteReport", { id: report.id }).then(refresh)}>
              <Trash2 size={16} />
            </button>
          </header>
          <p class="report-text">{report.text}</p>
          {report.details && (
            <details>
              <summary>Diagnostic</summary>
              <pre>{report.details}</pre>
            </details>
          )}
        </article>
      ))}
    </div>
  );
}
