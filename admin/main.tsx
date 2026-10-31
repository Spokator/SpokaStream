/** @jsxImportSource preact */
import { Activity, AlertTriangle, Ban, Bell, CheckCircle2, Download, Inbox, LayoutDashboard, Lock, LogOut, Megaphone, MessagesSquare, RefreshCw, ScrollText, Server, Square, Trash2, Unlock, UserMinus, Users, Wrench, XCircle } from "lucide-preact";
import { render } from "preact";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";

type Page = "overview" | "rooms" | "users" | "logs" | "reports" | "server";

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
  ownerName: string;
  locked: boolean;
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
  if (response.status === 401) throw new Error("login");
  const data = (await response.json()) as T & { error?: string };
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

function RoomsPage() {
  const { data, error, refresh } = usePolled<RoomRow[]>("rooms");
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
              <button type="button" class={`icon ${armed === room.id ? "is-armed" : ""}`} title={armed === room.id ? "Toucher encore pour supprimer" : "Supprimer le salon"} aria-label="Supprimer le salon" onClick={() => (armed === room.id ? (setArmed(""), run("deleteRoom", { roomId: room.id })) : setArmed(room.id))}>
                <Trash2 size={16} />
              </button>
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
          </article>
        ))}
    </div>
  );
}

function UsersPage() {
  const { data, error, refresh } = usePolled<UserRow[]>("users");
  const [search, setSearch] = useState("");
  const shown = useMemo(() => (data ?? []).filter(u => u.name.toLowerCase().includes(search.toLowerCase())).sort((a, b) => Number(b.online) - Number(a.online) || b.lastSeen - a.lastSeen), [data, search]);
  if (!data) return <p class="empty">{error || "Chargement…"}</p>;
  return (
    <>
      <input class="search" value={search} placeholder="Chercher un pseudo" aria-label="Chercher un pseudo" onInput={e => setSearch(e.currentTarget.value)} />
      <div class="list">
        {shown.map(user => (
          <article key={user.id} class={`card user ${user.banned ? "is-banned" : ""}`}>
            <i class="dot is-large" style={{ background: user.color }} />
            <div>
              <h2>
                {user.name || "Sans nom"} {user.admin && <em>Administrateur</em>} {user.banned && <em class="is-bad">Banni</em>}
              </h2>
              <small>
                {user.online ? "En ligne" : `Vu le ${date(user.lastSeen)}`} · arrivé le {date(user.firstSeen)} · {user.rooms} salons
              </small>
              {user.devices.map(device => (
                <small key={device.id} class="device">
                  {device.client === "web" ? "Site" : "Application"} {device.version} {device.label && `· ${device.label}`} · vu le {date(device.lastSeen)}
                </small>
              ))}
            </div>
            {!user.admin && (
              <button type="button" class="icon" title={user.banned ? "Lever le bannissement" : "Bannir de tout le serveur"} aria-label={user.banned ? `Lever le bannissement de ${user.name}` : `Bannir ${user.name}`} onClick={() => void act("ban", { accountId: user.id, banned: !user.banned }).then(refresh, (e: Error) => alert(e.message))}>
                <Ban size={16} />
              </button>
            )}
          </article>
        ))}
      </div>
    </>
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
      {data?.canRestart && (
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
];

function Panel() {
  const [page, setPage] = useState<Page>("overview");
  const Current = { overview: OverviewPage, rooms: RoomsPage, users: UsersPage, logs: LogsPage, reports: ReportsPage, server: ServerPage }[page];
  return (
    <div class="panel">
      <nav aria-label="Administration">
        <h1>SpokaStream</h1>
        {PAGES.map(item => (
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

function Login({ message }: { message: string }) {
  return (
    <main class="login">
      <Bell size={26} />
      <h1>Panneau d'administration</h1>
      <p>{message}</p>
      <p class="muted">Dans l'application : Paramètres, Compte, Ouvrir le panneau d'administration. Sur un téléphone rattaché à ton compte, cette page s'ouvre directement.</p>
    </main>
  );
}

function App() {
  const [state, setState] = useState<"loading" | "in" | "out">("loading");
  const [message, setMessage] = useState("Ouvre cette page depuis ton compte.");

  useEffect(() => {
    void (async () => {
      const ticket = location.hash.match(/^#t=([\w-]+)/)?.[1];
      if (ticket) history.replaceState(null, "", "/admin");
      const token = localStorage.getItem("spoka-token");
      const already = await api("overview").then(() => true, () => false);
      if (already) return setState("in");
      if (!ticket && !token) return setState("out");
      await api("login", ticket ? { ticket } : { token }).then(
        () => setState("in"),
        (e: Error) => {
          setMessage(e.message);
          setState("out");
        },
      );
    })();
  }, []);

  if (state === "loading") return null;
  return state === "in" ? <Panel /> : <Login message={message} />;
}

render(<App />, document.getElementById("root")!);
