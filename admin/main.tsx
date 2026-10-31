/** @jsxImportSource preact */
import { Activity, AlertTriangle, Ban, CheckCircle2, Download, Inbox, KeyRound, LayoutDashboard, Lock, LogOut, Megaphone, MessagesSquare, RefreshCw, ScrollText, Server, ShieldCheck, Square, Trash2, Unlock, UserCog, UserMinus, UserPlus, Users, Wrench, XCircle } from "lucide-preact";
import { render } from "preact";
import qrcode from "qrcode-generator";
import type { ComponentChildren } from "preact";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";

type Page = "overview" | "rooms" | "users" | "logs" | "reports" | "server" | "admins" | "security";
type Role = "owner" | "admin" | "moderator";

const RANK: Record<Role, number> = { moderator: 1, admin: 2, owner: 3 };
const ROLE_NAMES: Record<Role, string> = { owner: "Propriétaire", admin: "Administrateur", moderator: "Modérateur" };
const ROLE_HINTS: Record<Role, string> = {
  owner: "Tout, y compris les accès au panneau, la sauvegarde et le redémarrage",
  admin: "Tout gérer sauf les accès au panneau",
  moderator: "Surveiller, couper un stream, retirer, renommer, bannir",
};

/** Le rôle connecté : il masque ce que le serveur refuserait de toute façon. */
let myRole: Role = "moderator";
const can = (role: Role) => RANK[myRole] >= RANK[role];

interface Overview {
  version: string;
  uptime: number;
  stats: { rooms: number; connections: number; members: number; streams: number };
  viewers: number;
  parties: number;
  accounts: number;
  pushSubscriptions: number;
  versions: Record<string, number>;
  maintenance: string;
  canRestart: boolean;
  system: { load: number; cpus: number; memTotalMb: number; memFreeMb: number; processMb: number; uptime: number; disk: { totalGb: number; freeGb: number } | null };
  services: Record<string, string>;
  certificate: string | null;
  release: { tag: string; publishedAt: string; downloads: number } | null;
  history: { at: number; connections: number; streams: number; memoryMb: number }[];
  errors: number;
  reports: number;
}

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
  members: { id: string; account: string; name: string; color: string; online: boolean; web: boolean; voice: boolean }[];
  streams: { id: string; ownerId: string; ownerName: string; title: string; kind: string; width: number; height: number; fps: number; viewers: number; startedAt: number; paused: boolean }[];
}

interface UserRow {
  id: string;
  name: string;
  color: string;
  firstSeen: number;
  lastSeen: number;
  banned?: boolean;
  banReason?: string;
  admin: boolean;
  online: boolean;
  rooms: number;
  devices: { id: string; client: string; version: string; label: string; lastSeen: number }[];
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

const REFRESH_MS = 5000;

const api = async <T,>(path: string, body?: unknown): Promise<T> => {
  const response = await fetch(`/admin/api/${path}`, body === undefined ? undefined : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const data = (await response.json()) as T & { error?: string; needCode?: boolean };
  if (response.status === 401) throw new Error(data.needCode ? "code" : "login");
  if (!response.ok) throw new Error(data.error ?? "Action refusée.");
  return data;
};

const act = (action: string, fields: Record<string, unknown> = {}) => api("action", { action, ...fields });
const date = (at: number) => new Date(at).toLocaleString("fr-FR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
const count = (n: number, one: string, many: string) => `${n} ${n > 1 ? many : one}`;
const time = (at: number) => new Date(at).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });

function span(seconds: number) {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return days ? `${days} j ${hours} h` : hours ? `${hours} h ${minutes} min` : `${minutes} min`;
}

function usePolled<T>(path: string) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState("");
  const refresh = () => api<T>(path).then(value => (setData(value), setError("")), (e: Error) => (e.message === "login" ? location.reload() : setError(e.message)));
  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), REFRESH_MS);
    return () => clearInterval(timer);
  }, [path]);
  return { data, error, refresh };
}

/** Une mesure, une courbe, une échelle. La valeur du point survolé s'affiche à la place du titre chiffré. */
function Trend({ title, unit, points }: { title: string; unit: string; points: { at: number; value: number }[] }) {
  const box = useRef<SVGSVGElement>(null);
  const [hover, setHover] = useState<number | null>(null);
  const width = 320;
  const height = 72;
  const max = Math.max(1, ...points.map(p => p.value));
  const x = (i: number) => (points.length < 2 ? 0 : (i / (points.length - 1)) * width);
  const y = (value: number) => height - 3 - (value / max) * (height - 8);
  const path = points.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)} ${y(p.value).toFixed(1)}`).join(" ");
  const shown = hover !== null ? points[hover] : points.at(-1);
  return (
    <figure class="trend">
      <figcaption>
        <span>{title}</span>
        <b>
          {shown?.value ?? 0} {unit}
        </b>
        {hover !== null && shown && <small>{date(shown.at)}</small>}
      </figcaption>
      <svg
        ref={box}
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={`${title} sur 24 heures, maximum ${max} ${unit}`}
        onPointerMove={e => {
          const rect = box.current!.getBoundingClientRect();
          setHover(Math.max(0, Math.min(points.length - 1, Math.round(((e.clientX - rect.left) / rect.width) * (points.length - 1)))));
        }}
        onPointerLeave={() => setHover(null)}
      >
        <line x1="0" x2={width} y1={height - 3} y2={height - 3} class="trend-base" vector-effect="non-scaling-stroke" />
        {points.length > 1 && <path d={path} class="trend-line" vector-effect="non-scaling-stroke" />}
        {hover !== null && <line x1={x(hover)} x2={x(hover)} y1="0" y2={height} class="trend-cross" vector-effect="non-scaling-stroke" />}
      </svg>
    </figure>
  );
}

function Stat({ label, value, hint }: { label: string; value: string | number; hint?: string }) {
  return (
    <div class="stat">
      <span>{label}</span>
      <b>{value}</b>
      {hint && <small>{hint}</small>}
    </div>
  );
}

function ServiceState({ name, state }: { name: string; state: string }) {
  const ok = state === "active";
  const unknown = state === "inconnu";
  return (
    <div class={`service ${ok ? "is-ok" : unknown ? "" : "is-bad"}`}>
      {ok ? <CheckCircle2 size={16} /> : unknown ? <AlertTriangle size={16} /> : <XCircle size={16} />}
      <span>{name}</span>
      <small>{ok ? "En marche" : unknown ? "Non vérifiable ici" : state}</small>
    </div>
  );
}

function OverviewPage() {
  const { data, error } = usePolled<Overview>("overview");
  if (!data) return <p class="empty">{error || "Chargement…"}</p>;
  const { system, stats } = data;
  const series = (key: "connections" | "streams" | "memoryMb") => data.history.map(h => ({ at: h.at, value: h[key] }));
  const memoryUsed = Math.round(((system.memTotalMb - system.memFreeMb) / system.memTotalMb) * 100);
  const certificateDays = data.certificate ? Math.round((Date.parse(data.certificate) - Date.now()) / 86_400_000) : null;
  const alerts = [
    ...Object.entries(data.services).filter(([, state]) => state !== "active" && state !== "inconnu").map(([name]) => `${name} ne tourne pas`),
    ...(system.disk && system.disk.freeGb < 3 ? [`Il ne reste que ${system.disk.freeGb} Go sur le disque`] : []),
    ...(memoryUsed > 92 ? [`Mémoire du serveur pleine à ${memoryUsed} %`] : []),
    ...(certificateDays !== null && certificateDays < 14 ? [`Le certificat expire dans ${certificateDays} jours`] : []),
    ...(data.maintenance ? [`Maintenance en cours : ${data.maintenance}`] : []),
  ];
  return (
    <>
      {alerts.length > 0 && (
        <section class="alerts" role="status">
          {alerts.map(alert => (
            <p key={alert}>
              <AlertTriangle size={16} /> {alert}
            </p>
          ))}
        </section>
      )}
      <section class="stats">
        <Stat label="En ligne" value={stats.connections} hint={`${stats.members} dans un salon`} />
        <Stat label="En direct" value={stats.streams} hint={count(data.viewers, "spectateur", "spectateurs")} />
        <Stat label="Watch Party" value={data.parties} />
        <Stat label="Salons" value={stats.rooms} />
        <Stat label="Comptes" value={data.accounts} hint={count(data.pushSubscriptions, "téléphone abonné", "téléphones abonnés")} />
        <Stat label="Erreurs" value={data.errors} hint={count(data.reports, "retour reçu", "retours reçus")} />
      </section>
      <section class="trends">
        <Trend title="Connexions" unit="" points={series("connections")} />
        <Trend title="Streams" unit="" points={series("streams")} />
        <Trend title="Mémoire du serveur SpokaStream" unit="Mo" points={series("memoryMb")} />
      </section>
      <section class="columns">
        <div class="card">
          <h2>Services</h2>
          {Object.entries(data.services).map(([name, state]) => (
            <ServiceState key={name} name={name} state={state} />
          ))}
        </div>
        <div class="card">
          <h2>Machine</h2>
          <dl>
            <dt>Serveur SpokaStream</dt>
            <dd>
              {data.version}, lancé depuis {span(data.uptime)}
            </dd>
            <dt>Processeur</dt>
            <dd>
              Charge {system.load.toFixed(2)} sur {system.cpus} cœurs
            </dd>
            <dt>Mémoire</dt>
            <dd>
              {memoryUsed} % de {Math.round(system.memTotalMb / 1024)} Go utilisés
            </dd>
            <dt>Disque</dt>
            <dd>{system.disk ? `${system.disk.freeGb} Go libres sur ${system.disk.totalGb} Go` : "Inconnu"}</dd>
            <dt>Certificat HTTPS</dt>
            <dd>{certificateDays === null ? "Inconnu" : `Encore ${certificateDays} jours`}</dd>
            <dt>Machine allumée depuis</dt>
            <dd>{span(system.uptime)}</dd>
          </dl>
        </div>
        <div class="card">
          <h2>Application</h2>
          <dl>
            <dt>Dernière version publiée</dt>
            <dd>{data.release ? `${data.release.tag}, ${new Date(data.release.publishedAt).toLocaleDateString("fr-FR")}` : "Inconnue"}</dd>
            <dt>Téléchargements de l'installeur</dt>
            <dd>{data.release?.downloads ?? "Inconnu"}</dd>
          </dl>
          <h3>Versions connectées</h3>
          {Object.keys(data.versions).length === 0 && <p class="muted">Personne en ligne.</p>}
          {Object.entries(data.versions).map(([version, count]) => (
            <div key={version} class="row-line">
              <span>{version}</span>
              <b>{count}</b>
            </div>
          ))}
        </div>
      </section>
    </>
  );
}

function RoomTools({ room, users, run }: { room: RoomRow; users: UserRow[]; run: (action: string, fields: Record<string, unknown>) => void }) {
  const [name, setName] = useState(room.name);
  const [owner, setOwner] = useState(room.ownerId);
  return (
    <details class="tools">
      <summary>Gérer ce salon</summary>
      <div class="tool-row">
        <input value={name} maxLength={48} aria-label={`Nouveau nom de ${room.name}`} onInput={e => setName(e.currentTarget.value)} />
        <button type="button" disabled={!name.trim() || name === room.name} onClick={() => run("renameRoom", { roomId: room.id, name })}>
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
        <button type="button" disabled={owner === room.ownerId} onClick={() => run("transferRoom", { roomId: room.id, accountId: owner })}>
          Donner le salon
        </button>
      </div>
      {room.bans > 0 && (
        <div class="tool-row">
          <span>{count(room.bans, "personne bannie", "personnes bannies")} de ce salon</span>
          <button type="button" onClick={() => run("clearBans", { roomId: room.id })}>
            Tout lever
          </button>
        </div>
      )}
    </details>
  );
}

function RoomsPage() {
  const { data, error, refresh } = usePolled<RoomRow[]>("rooms");
  const { data: users } = usePolled<UserRow[]>("users");
  const [armed, setArmed] = useState("");
  const run = (action: string, fields: Record<string, unknown>) => void act(action, fields).then(refresh, (e: Error) => alert(e.message));
  if (!data) return <p class="empty">{error || "Chargement…"}</p>;
  if (!data.length) return <p class="empty">Aucun salon.</p>;
  return (
    <div class="list">
      {[...data]
        .sort((a, b) => b.streams.length - a.streams.length || b.lastActivity - a.lastActivity)
        .map(room => (
          <article key={room.id} class="card">
            <header>
              <div>
                <h2>{room.name}</h2>
                <small>
                  {room.code} · à {room.ownerName} · actif le {date(room.lastActivity)} · {room.messages} messages
                </small>
              </div>
              <button type="button" class="icon" title={room.locked ? "Déverrouiller" : "Verrouiller"} aria-label={room.locked ? "Déverrouiller le salon" : "Verrouiller le salon"} onClick={() => run("lockRoom", { roomId: room.id, locked: !room.locked })}>
                {room.locked ? <Lock size={16} /> : <Unlock size={16} />}
              </button>
              {can("admin") && (
                <button type="button" class={`icon ${armed === room.id ? "is-armed" : ""}`} title={armed === room.id ? "Toucher encore pour supprimer" : "Supprimer le salon"} aria-label="Supprimer le salon" onClick={() => (armed === room.id ? (setArmed(""), run("deleteRoom", { roomId: room.id })) : setArmed(room.id))}>
                  <Trash2 size={16} />
                </button>
              )}
            </header>
            {room.party && <p class="tag">Watch Party : {room.party}</p>}
            {room.streams.map(stream => (
              <div key={stream.id} class="row-line is-live">
                <span>
                  <b>{stream.ownerName}</b> {stream.title || stream.kind} · {stream.width}×{stream.height} · {stream.fps} i/s · {count(stream.viewers, "spectateur", "spectateurs")} · depuis {time(stream.startedAt)}
                  {stream.paused ? " · en pause" : ""}
                </span>
                <button type="button" class="icon" title="Arrêter ce stream" aria-label={`Arrêter le stream de ${stream.ownerName}`} onClick={() => run("stopStream", { roomId: room.id, ownerId: stream.ownerId })}>
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
                <button type="button" class="icon" title="Retirer du salon" aria-label={`Retirer ${member.name}`} onClick={() => run("kick", { roomId: room.id, userId: member.id })}>
                  <UserMinus size={15} />
                </button>
              </div>
            ))}
            {can("admin") && users && <RoomTools room={room} users={users} run={run} />}
          </article>
        ))}
    </div>
  );
}

function UserTools({ user, refresh }: { user: UserRow; refresh: () => void }) {
  const [name, setName] = useState(user.name);
  const [message, setMessage] = useState("");
  const [reason, setReason] = useState("");
  const [withRooms, setWithRooms] = useState(false);
  const [armed, setArmed] = useState(false);
  const [note, setNote] = useState("");
  const run = (action: string, fields: Record<string, unknown>, done: string) =>
    void act(action, { accountId: user.id, ...fields }).then(
      () => {
        setNote(done);
        void refresh();
      },
      (e: Error) => setNote(e.message),
    );
  return (
    <div class="tools">
      {note && (
        <p class="tool-note" role="status">
          {note}
        </p>
      )}
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
        <div class="tool-row">
          {user.banned ? (
            <>
              <span>Banni{user.banReason ? ` : ${user.banReason}` : ""}</span>
              <button type="button" onClick={() => run("ban", { banned: false }, "Bannissement levé.")}>
                Lever le bannissement
              </button>
            </>
          ) : (
            <>
              <input value={reason} maxLength={200} placeholder="Motif, gardé dans le panneau" aria-label={`Motif du bannissement de ${user.name}`} onInput={e => setReason(e.currentTarget.value)} />
              <button type="button" class="is-danger" onClick={() => run("ban", { banned: true, reason }, "Banni du serveur.")}>
                <Ban size={14} /> Bannir du serveur
              </button>
            </>
          )}
        </div>
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
      {can("admin") && !user.admin && (
        <div class="tool-row">
          {user.rooms > 0 && (
            <label class="tool-check">
              <input type="checkbox" checked={withRooms} onChange={e => setWithRooms(e.currentTarget.checked)} /> Supprimer aussi ses {count(user.rooms, "salon", "salons")}
            </label>
          )}
          <button type="button" class="is-danger" onClick={() => (armed ? run("deleteUser", { rooms: withRooms }, "Compte supprimé.") : setArmed(true))}>
            {armed ? "Confirmer la suppression" : "Supprimer le compte"}
          </button>
        </div>
      )}
    </div>
  );
}

function UsersPage() {
  const { data, error, refresh } = usePolled<UserRow[]>("users");
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<"all" | "online" | "banned">("all");
  const [open, setOpen] = useState("");
  const shown = useMemo(
    () =>
      (data ?? [])
        .filter(u => u.name.toLowerCase().includes(search.toLowerCase()) && (filter === "all" || (filter === "online" ? u.online : u.banned)))
        .sort((a, b) => Number(b.online) - Number(a.online) || b.lastSeen - a.lastSeen),
    [data, search, filter],
  );
  if (!data) return <p class="empty">{error || "Chargement…"}</p>;
  return (
    <>
      <input class="search" value={search} placeholder="Chercher un pseudo" aria-label="Chercher un pseudo" onInput={e => setSearch(e.currentTarget.value)} />
      <div class="filters">
        {(["all", "online", "banned"] as const).map(value => (
          <button key={value} type="button" class={filter === value ? "is-on" : ""} onClick={() => setFilter(value)}>
            {value === "all" ? `Tous (${data.length})` : value === "online" ? "En ligne" : "Bannis"}
          </button>
        ))}
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

interface AdminRow {
  id: string;
  username: string;
  role: Role;
  disabled: boolean;
  appAccount: string | null;
  lastLogin: number;
  totp: boolean;
}

interface InviteRow {
  id: string;
  expires: number;
  role: Role;
  username: string;
  reset: boolean;
}

function RoleSelect({ value, label, onChange }: { value: Role; label: string; onChange: (role: Role) => void }) {
  return (
    <select value={value} aria-label={label} onChange={e => onChange(e.currentTarget.value as Role)}>
      {(Object.keys(ROLE_NAMES) as Role[]).map(role => (
        <option key={role} value={role}>
          {ROLE_NAMES[role]}
        </option>
      ))}
    </select>
  );
}

function AdminsPage() {
  const { data, error, refresh } = usePolled<{ users: AdminRow[]; invites: InviteRow[]; self: string | null }>("admins");
  const [username, setUsername] = useState("");
  const [role, setRole] = useState<Role>("moderator");
  const [link, setLink] = useState<{ title: string; url: string } | null>(null);
  const [problem, setProblem] = useState("");
  const call = (path: string, body: Record<string, unknown>) => void api(`admins/${path}`, body).then(() => (setProblem(""), void refresh()), (e: Error) => setProblem(e.message));
  const makeLink = (path: string, body: Record<string, unknown>, title: string) =>
    void api<{ code: string }>(`admins/${path}`, body).then(
      ({ code }) => {
        setLink({ title, url: `${location.origin}/admin#setup=${code}` });
        setProblem("");
        void refresh();
      },
      (e: Error) => setProblem(e.message),
    );
  if (!data) return <p class="empty">{error || "Chargement…"}</p>;
  return (
    <div class="list">
      {problem && (
        <p class="form-problem" role="alert">
          {problem}
        </p>
      )}
      {link && (
        <section class="card">
          <h2>{link.title}</h2>
          <p class="muted">Envoie ce lien à la personne. Il ne sert qu'une fois, pendant 24 heures, et il ne s'affichera plus.</p>
          <input class="link-box" readOnly value={link.url} aria-label="Lien à usage unique" onFocus={e => e.currentTarget.select()} />
          <div class="actions">
            <button type="button" onClick={() => void navigator.clipboard?.writeText(link.url)}>
              Copier
            </button>
            <button type="button" onClick={() => setLink(null)}>
              Fermer
            </button>
          </div>
        </section>
      )}
      <section class="card">
        <h2>
          <UserPlus size={16} /> Ajouter un accès
        </h2>
        <p class="muted">{ROLE_HINTS[role]}.</p>
        <div class="tool-row">
          <input value={username} maxLength={64} placeholder="Identifiant, facultatif" aria-label="Identifiant du nouvel accès" onInput={e => setUsername(e.currentTarget.value)} />
          <RoleSelect value={role} label="Rôle du nouvel accès" onChange={setRole} />
          <button
            type="button"
            class="primary"
            onClick={() => {
              makeLink("invite", { role, username }, `Invitation ${ROLE_NAMES[role].toLowerCase()}`);
              setUsername("");
            }}
          >
            Créer le lien
          </button>
        </div>
      </section>
      {data.users.map(user => (
        <article key={user.id} class={`card ${user.disabled ? "is-banned" : ""}`}>
          <header>
            <div>
              <h2>
                {user.username} {user.id === data.self && <em>toi</em>} {user.disabled && <em class="is-bad">Désactivé</em>}
              </h2>
              <small>
                {user.lastLogin ? `Dernière connexion le ${date(user.lastLogin)}` : "Jamais connecté"} · {user.totp ? "code à 6 chiffres actif" : "sans code à 6 chiffres"}
              </small>
            </div>
            <RoleSelect value={user.role} label={`Rôle de ${user.username}`} onChange={next => call("role", { id: user.id, role: next })} />
          </header>
          <div class="tool-row">
            <input value={user.appAccount ?? ""} placeholder="Identifiant du compte de l'application, facultatif" aria-label={`Compte de l'application de ${user.username}`} onChange={e => call("app", { id: user.id, appAccount: e.currentTarget.value })} />
          </div>
          <div class="tool-row">
            <button type="button" onClick={() => makeLink("reset", { id: user.id }, `Nouveau mot de passe pour ${user.username}`)}>
              Nouveau mot de passe
            </button>
            {user.id !== data.self && (
              <>
                <button type="button" onClick={() => call("disable", { id: user.id, disabled: !user.disabled })}>
                  {user.disabled ? "Réactiver" : "Désactiver"}
                </button>
                <button type="button" class="is-danger" onClick={() => call("remove", { id: user.id })}>
                  Supprimer
                </button>
              </>
            )}
          </div>
        </article>
      ))}
      {data.invites.length > 0 && (
        <section class="card">
          <h2>Liens en attente</h2>
          {data.invites.map(invite => (
            <div key={invite.id} class="row-line">
              <span>
                {invite.username || "Nouvel accès"} · {invite.reset ? "mot de passe" : ROLE_NAMES[invite.role]} · jusqu'au {date(invite.expires)}
              </span>
              <button type="button" class="icon" aria-label="Annuler ce lien" title="Annuler ce lien" onClick={() => call("cancel", { id: invite.id })}>
                <XCircle size={15} />
              </button>
            </div>
          ))}
        </section>
      )}
    </div>
  );
}

function LogsPage() {
  const { data, error } = usePolled<LogRow[]>("logs");
  const [level, setLevel] = useState<"all" | "warning" | "error">("all");
  if (!data) return <p class="empty">{error || "Chargement…"}</p>;
  const shown = data.filter(row => level === "all" || row.level === level || (level === "warning" && row.level === "error"));
  return (
    <>
      <div class="filters">
        {(["all", "warning", "error"] as const).map(value => (
          <button key={value} type="button" class={level === value ? "is-on" : ""} onClick={() => setLevel(value)}>
            {value === "all" ? "Tout" : value === "warning" ? "Alertes" : "Erreurs"}
          </button>
        ))}
      </div>
      {shown.length === 0 && <p class="empty">Rien pour l'instant. Le journal repart de zéro à chaque redémarrage du serveur.</p>}
      <div class="logs">
        {shown.map((row, i) => (
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

function ReportsPage() {
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

function ServerPage() {
  const { data } = usePolled<Overview>("overview");
  const [announce, setAnnounce] = useState("");
  const [maintenance, setMaintenance] = useState("");
  const [note, setNote] = useState("");
  const [armed, setArmed] = useState(false);
  const say = (text: string) => setNote(text);
  return (
    <div class="list">
      {note && (
        <p class="note" role="status">
          {note}
        </p>
      )}
      <section class="card">
        <h2>
          <Megaphone size={16} /> Annonce à tout le monde
        </h2>
        <p class="muted">Elle s'affiche tout de suite dans chaque application et sur chaque téléphone connecté.</p>
        <textarea value={announce} maxLength={300} rows={2} aria-label="Texte de l'annonce" placeholder="La mise à jour arrive dans 5 minutes" onInput={e => setAnnounce(e.currentTarget.value)} />
        <div class="actions">
          <button
            type="button"
            class="primary"
            disabled={!announce.trim()}
            onClick={() =>
              void act("announce", { text: announce, level: "info" }).then(() => {
                setAnnounce("");
                say("Annonce envoyée.");
              })
            }
          >
            Envoyer
          </button>
        </div>
      </section>
      <section class="card">
        <h2>
          <Wrench size={16} /> Maintenance
        </h2>
        <p class="muted">Personne ne peut créer de salon ni entrer dans celui d'un autre. Les streams en cours continuent.</p>
        {data?.maintenance ? (
          <div class="actions">
            <span>En cours : {data.maintenance}</span>
            <button type="button" onClick={() => void act("maintenance", { text: "" }).then(() => say("Maintenance terminée."))}>
              Terminer
            </button>
          </div>
        ) : (
          <>
            <input value={maintenance} maxLength={300} aria-label="Message de maintenance" placeholder="Maintenance, retour dans 10 minutes" onInput={e => setMaintenance(e.currentTarget.value)} />
            <div class="actions">
              <button type="button" disabled={!maintenance.trim()} onClick={() => void act("maintenance", { text: maintenance }).then(() => say("Maintenance activée."))}>
                Activer
              </button>
            </div>
          </>
        )}
      </section>
      {can("owner") && (
        <section class="card">
          <h2>
            <Download size={16} /> Sauvegarde
          </h2>
          <p class="muted">Les salons, leur historique de chat et les comptes, dans un fichier JSON.</p>
          <div class="actions">
            <a class="button" href="/admin/api/backup">
              Télécharger
            </a>
          </div>
        </section>
      )}
      {data?.canRestart && can("owner") && (
        <section class="card">
          <h2>
            <RefreshCw size={16} /> Redémarrer le serveur
          </h2>
          <p class="muted">Les streams continuent de PC à PC et les applications se reconnectent seules, en quelques secondes. {data.stats.streams > 0 ? `${data.stats.streams} streams sont en cours.` : "Personne ne diffuse."}</p>
          <div class="actions">
            <button type="button" class={armed ? "is-danger" : ""} onClick={() => (armed ? void act("restart").then(() => (setArmed(false), say("Redémarrage en cours…"))) : setArmed(true))}>
              {armed ? "Confirmer le redémarrage" : "Redémarrer"}
            </button>
          </div>
        </section>
      )}
    </div>
  );
}

const PAGES: { id: Page; label: string; icon: typeof Activity }[] = [
  { id: "overview", label: "Vue d'ensemble", icon: LayoutDashboard },
  { id: "rooms", label: "Salons", icon: MessagesSquare },
  { id: "users", label: "Comptes", icon: Users },
  { id: "logs", label: "Journal", icon: ScrollText },
  { id: "reports", label: "Retours", icon: Inbox },
  { id: "server", label: "Serveur", icon: Server },
  { id: "admins", label: "Administrateurs", icon: UserCog },
  { id: "security", label: "Sécurité", icon: ShieldCheck },
];

function Panel() {
  const [page, setPage] = useState<Page>("overview");
  const [me, setMe] = useState<{ name: string; role: Role; hasLogin: boolean } | null>(null);
  useEffect(() => {
    void api<{ name: string; role: Role; hasLogin: boolean }>("me").then(value => {
      myRole = value.role;
      setMe(value);
    });
  }, []);
  if (!me) return null;
  const pages = PAGES.filter(item => (item.id === "admins" ? can("owner") : item.id === "server" ? can("admin") : item.id === "security" ? me.hasLogin : true));
  const Current = { overview: OverviewPage, rooms: RoomsPage, users: UsersPage, logs: LogsPage, reports: ReportsPage, server: ServerPage, admins: AdminsPage, security: SecurityPage }[page];
  return (
    <div class="panel">
      <nav aria-label="Administration">
        <h1>SpokaStream</h1>
        <p class="me">
          {me.name}
          <small>{ROLE_NAMES[me.role]}</small>
        </p>
        {pages.map(item => (
          <button key={item.id} type="button" class={page === item.id ? "is-on" : ""} onClick={() => setPage(item.id)}>
            <item.icon size={17} />
            <span>{item.label}</span>
          </button>
        ))}
        <span class="grow" />
        <button type="button" onClick={() => void api("logout", {}).finally(() => location.reload())}>
          <LogOut size={17} />
          <span>Se déconnecter</span>
        </button>
      </nav>
      <main>
        <h1>{PAGES.find(p => p.id === page)!.label}</h1>
        <Current />
      </main>
    </div>
  );
}

function Field({ label, children }: { label: string; children: ComponentChildren }) {
  return (
    <label class="form-field">
      <span>{label}</span>
      {children}
    </label>
  );
}

function Login({ onDone }: { onDone: () => void }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [needCode, setNeedCode] = useState(false);
  const [problem, setProblem] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = (e: Event) => {
    e.preventDefault();
    setBusy(true);
    void api("login", { username, password, code })
      .then(onDone, (error: Error) => {
        if (error.message === "code") {
          setNeedCode(true);
          setProblem("");
        } else {
          setProblem(error.message);
          setCode("");
        }
      })
      .finally(() => setBusy(false));
  };
  return (
    <main class="login">
      <ShieldCheck size={28} />
      <h1>Panneau d'administration</h1>
      <form onSubmit={submit}>
        <Field label="Identifiant">
          <input value={username} name="username" autoComplete="username" required autoFocus onInput={e => setUsername(e.currentTarget.value)} />
        </Field>
        <Field label="Mot de passe">
          <input type="password" value={password} name="password" autoComplete="current-password" required onInput={e => setPassword(e.currentTarget.value)} />
        </Field>
        {needCode && (
          <Field label="Code à 6 chiffres, ou code de secours">
            <input value={code} name="code" inputMode="text" autoComplete="one-time-code" required autoFocus onInput={e => setCode(e.currentTarget.value)} />
          </Field>
        )}
        {problem && (
          <p class="form-problem" role="alert">
            {problem}
          </p>
        )}
        <button type="submit" class="primary" disabled={busy}>
          {busy ? "Vérification…" : "Se connecter"}
        </button>
      </form>
    </main>
  );
}

function Setup({ code, onDone }: { code: string; onDone: () => void }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [again, setAgain] = useState("");
  const [problem, setProblem] = useState("");
  const [invite, setInvite] = useState<{ username: string; role: Role; reset: boolean } | null>(null);
  const [gone, setGone] = useState(false);
  useEffect(() => {
    void api<{ username: string; role: Role; reset: boolean }>("invite", { code }).then(
      value => {
        setInvite(value);
        setUsername(value.username);
      },
      () => setGone(true),
    );
  }, []);
  if (gone) {
    return (
      <main class="login">
        <KeyRound size={28} />
        <h1>Ce lien n'est plus valable</h1>
        <p class="muted">Il ne sert qu'une fois, pendant 24 heures. Demande-en un nouveau.</p>
      </main>
    );
  }
  if (!invite) return null;
  return (
    <main class="login">
      <KeyRound size={28} />
      <h1>{invite.reset ? `Nouveau mot de passe pour ${invite.username}` : "Crée ton accès"}</h1>
      <p class="muted">
        {invite.reset ? "Le code à 6 chiffres de cet accès sera retiré : tu pourras le réactiver." : `Rôle : ${ROLE_NAMES[invite.role]}. Tu choisis tes identifiants : personne d'autre ne les connaît.`} Ce lien ne sert qu'une fois.
      </p>
      <form
        onSubmit={e => {
          e.preventDefault();
          if (password !== again) return setProblem("Les deux mots de passe sont différents.");
          void api("setup", { code, username, password }).then(onDone, (error: Error) => setProblem(error.message));
        }}
      >
        <Field label="Identifiant">
          <input value={username} name="username" autoComplete="username" required autoFocus readOnly={invite.reset} onInput={e => setUsername(e.currentTarget.value)} />
        </Field>
        <Field label="Mot de passe (12 caractères ou plus)">
          <input type="password" value={password} name="new-password" autoComplete="new-password" required minLength={12} onInput={e => setPassword(e.currentTarget.value)} />
        </Field>
        <Field label="Encore une fois">
          <input type="password" value={again} name="confirm-password" autoComplete="new-password" required onInput={e => setAgain(e.currentTarget.value)} />
        </Field>
        {problem && (
          <p class="form-problem" role="alert">
            {problem}
          </p>
        )}
        <button type="submit" class="primary">
          {invite.reset ? "Enregistrer" : "Créer mon accès"}
        </button>
      </form>
    </main>
  );
}

interface Security {
  username: string;
  role: Role;
  changedAt: number;
  totp: boolean;
  recoveryLeft: number;
  sessions: number;
}

function SecurityPage() {
  const { data, refresh } = usePolled<Security>("security");
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [enrol, setEnrol] = useState<{ secret: string; uri: string } | null>(null);
  const [code, setCode] = useState("");
  const [recovery, setRecovery] = useState<string[] | null>(null);
  const [disablePassword, setDisablePassword] = useState("");
  const [note, setNote] = useState("");
  const [problem, setProblem] = useState("");
  const fail = (e: Error) => (setProblem(e.message), setNote(""));
  const done = (text: string) => (setNote(text), setProblem(""), void refresh());
  const picture = useMemo(() => {
    if (!enrol) return "";
    const qr = qrcode(0, "M");
    qr.addData(enrol.uri);
    qr.make();
    return qr.createDataURL(4, 8);
  }, [enrol]);
  if (!data) return <p class="empty">Chargement…</p>;
  return (
    <div class="list">
      {note && (
        <p class="note" role="status">
          {note}
        </p>
      )}
      {problem && (
        <p class="form-problem" role="alert">
          {problem}
        </p>
      )}
      <section class="card">
        <h2>
          <KeyRound size={16} /> Mot de passe
        </h2>
        <p class="muted">
          Compte {data.username}, mot de passe changé le {date(data.changedAt)}. Le changer déconnecte tes autres sessions.
        </p>
        <form
          onSubmit={e => {
            e.preventDefault();
            void api("password", { current, next }).then(() => {
              setCurrent("");
              setNext("");
              done("Mot de passe changé.");
            }, fail);
          }}
        >
          <Field label="Mot de passe actuel">
            <input type="password" value={current} autoComplete="current-password" required onInput={e => setCurrent(e.currentTarget.value)} />
          </Field>
          <Field label="Nouveau mot de passe (12 caractères ou plus)">
            <input type="password" value={next} autoComplete="new-password" required minLength={12} onInput={e => setNext(e.currentTarget.value)} />
          </Field>
          <div class="actions">
            <button type="submit">Changer</button>
          </div>
        </form>
      </section>

      <section class="card">
        <h2>
          <ShieldCheck size={16} /> Code à 6 chiffres
        </h2>
        {recovery ? (
          <>
            <p class="muted">Garde ces codes de secours en lieu sûr, ils ne s'afficheront plus. Chacun remplace une fois le code à 6 chiffres si tu perds ton téléphone.</p>
            <pre class="recovery">{recovery.join("\n")}</pre>
            <div class="actions">
              <button type="button" onClick={() => setRecovery(null)}>
                C'est noté
              </button>
            </div>
          </>
        ) : data.totp ? (
          <>
            <p class="muted">Activé. Il reste {data.recoveryLeft} codes de secours.</p>
            <form
              onSubmit={e => {
                e.preventDefault();
                void api("totp/disable", { password: disablePassword }).then(() => {
                  setDisablePassword("");
                  done("Code à 6 chiffres désactivé.");
                }, fail);
              }}
            >
              <Field label="Mot de passe, pour désactiver">
                <input type="password" value={disablePassword} autoComplete="current-password" required onInput={e => setDisablePassword(e.currentTarget.value)} />
              </Field>
              <div class="actions">
                <button type="submit" class="is-danger">
                  Désactiver
                </button>
              </div>
            </form>
          </>
        ) : enrol ? (
          <>
            <p class="muted">Scanne ce QR code avec une application d'authentification : Google Authenticator, Authy, 1Password… Ou entre la clé à la main.</p>
            <div class="enrol">
              <img src={picture} alt="QR code du code à 6 chiffres" />
              <code>{enrol.secret}</code>
            </div>
            <form
              onSubmit={e => {
                e.preventDefault();
                void api<{ recovery: string[] }>("totp/confirm", { code }).then(result => {
                  setRecovery(result.recovery);
                  setEnrol(null);
                  setCode("");
                  done("Code à 6 chiffres activé.");
                }, fail);
              }}
            >
              <Field label="Le code affiché par l'application">
                <input value={code} inputMode="numeric" autoComplete="one-time-code" maxLength={6} required onInput={e => setCode(e.currentTarget.value)} />
              </Field>
              <div class="actions">
                <button type="submit" class="primary">
                  Activer
                </button>
              </div>
            </form>
          </>
        ) : (
          <>
            <p class="muted">Conseillé : même avec ton mot de passe, personne n'entre sans ton téléphone.</p>
            <div class="actions">
              <button type="button" class="primary" onClick={() => void api<{ secret: string; uri: string }>("totp/start", {}).then(setEnrol, fail)}>
                Activer
              </button>
            </div>
          </>
        )}
      </section>

      <section class="card">
        <h2>
          <LogOut size={16} /> Sessions
        </h2>
        <p class="muted">{count(data.sessions, "session ouverte", "sessions ouvertes")}. Une session dure 12 heures.</p>
        {data.sessions > 1 && (
          <div class="actions">
            <button type="button" onClick={() => void api("sessions/revoke", {}).then(() => done("Autres sessions fermées."), fail)}>
              Fermer les autres
            </button>
          </div>
        )}
      </section>
    </div>
  );
}

function App() {
  const [state, setState] = useState<"loading" | "in" | "login" | "setup" | "closed">("loading");
  const [setupCode, setSetupCode] = useState("");

  useEffect(() => {
    void (async () => {
      const ticket = location.hash.match(/^#t=([\w-]+)/)?.[1];
      const setup = location.hash.match(/^#setup=([\w-]+)/)?.[1];
      if (ticket || setup) history.replaceState(null, "", "/admin");
      if (setup) {
        setSetupCode(setup);
        return setState("setup");
      }
      if (await api("overview").then(() => true, () => false)) return setState("in");
      if (ticket && (await api("login", { ticket }).then(() => true, () => false))) return setState("in");
      const { configured } = await api<{ configured: boolean }>("auth");
      setState(configured ? "login" : "closed");
    })();
  }, []);

  if (state === "loading") return null;
  if (state === "in") return <Panel />;
  if (state === "setup") return <Setup code={setupCode} onDone={() => setState("in")} />;
  if (state === "login") return <Login onDone={() => setState("in")} />;
  return (
    <main class="login">
      <ShieldCheck size={28} />
      <h1>Panneau d'administration</h1>
      <p class="muted">L'accès n'a pas encore été créé.</p>
    </main>
  );
}

render(<App />, document.getElementById("root")!);
