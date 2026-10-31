/** @jsxImportSource preact */
import { Activity, BarChart3, Bell, DatabaseBackup, Gauge as GaugeIcon, Inbox, KeyRound, LayoutDashboard, LogOut, MessagesSquare, Radio, ScrollText, ServerCog, ShieldAlert, ShieldCheck, SlidersHorizontal, UserCog, Users } from "lucide-preact";
import { render } from "preact";
import { useEffect, useState } from "preact/hooks";
import { AdminsPage, SecurityPage } from "./access.tsx";
import { api, can, Field, ROLE_NAMES, setMyRole } from "./lib.tsx";
import type { Role } from "./lib.tsx";
import { LogsPage, ModerationPage, ReportsPage, RoomsPage, UsersPage } from "./manage.tsx";
import { AlertsPage, OverviewPage, StreamsPage, SystemPage, UsagePage } from "./monitor.tsx";
import { BackupsPage, SettingsPage } from "./settings.tsx";

type Page = "overview" | "alerts" | "streams" | "rooms" | "users" | "moderation" | "system" | "usage" | "logs" | "reports" | "settings" | "backups" | "admins" | "security";

const GROUPS: { label: string; pages: { id: Page; label: string; icon: typeof Activity; need?: Role }[] }[] = [
  {
    label: "Pilotage",
    pages: [
      { id: "overview", label: "Vue d'ensemble", icon: LayoutDashboard },
      { id: "alerts", label: "Alertes", icon: Bell },
      { id: "system", label: "Système", icon: GaugeIcon },
      { id: "usage", label: "Statistiques", icon: BarChart3 },
    ],
  },
  {
    label: "En direct",
    pages: [
      { id: "streams", label: "Diffusions", icon: Radio },
      { id: "rooms", label: "Salons", icon: MessagesSquare },
    ],
  },
  {
    label: "Personnes",
    pages: [
      { id: "users", label: "Comptes", icon: Users },
      { id: "moderation", label: "Modération", icon: ShieldAlert },
      { id: "reports", label: "Retours", icon: Inbox },
    ],
  },
  {
    label: "Serveur",
    pages: [
      { id: "logs", label: "Journal", icon: ScrollText },
      { id: "settings", label: "Réglages", icon: SlidersHorizontal, need: "admin" },
      { id: "backups", label: "Sauvegardes", icon: DatabaseBackup, need: "owner" },
      { id: "admins", label: "Administrateurs", icon: UserCog, need: "owner" },
      { id: "security", label: "Sécurité", icon: ShieldCheck },
    ],
  },
];

const ALL_PAGES = GROUPS.flatMap(group => group.pages);

function Panel() {
  const [page, setPage] = useState<Page>("overview");
  const [me, setMe] = useState<{ name: string; role: Role; hasLogin: boolean } | null>(null);
  useEffect(() => {
    void api<{ name: string; role: Role; hasLogin: boolean }>("me").then(value => {
      setMyRole(value.role);
      setMe(value);
    });
  }, []);
  if (!me) return null;
  const allowed = (item: (typeof ALL_PAGES)[number]) => (!item.need || can(item.need)) && (item.id !== "security" || me.hasLogin);
  const Current = { overview: () => <OverviewPage open={next => setPage(next as Page)} />, alerts: AlertsPage, streams: StreamsPage, rooms: RoomsPage, users: UsersPage, moderation: ModerationPage, system: SystemPage, usage: UsagePage, logs: LogsPage, reports: ReportsPage, settings: SettingsPage, backups: BackupsPage, admins: AdminsPage, security: SecurityPage }[page];
  return (
    <div class="panel">
      <nav aria-label="Administration">
        <h1>
          <ServerCog size={17} /> SpokaStream
        </h1>
        <p class="me">
          {me.name}
          <small>{ROLE_NAMES[me.role]}</small>
        </p>
        {GROUPS.map(group => {
          const items = group.pages.filter(allowed);
          if (!items.length) return null;
          return (
            <div key={group.label} class="nav-group">
              <h2>{group.label}</h2>
              {items.map(item => (
                <button key={item.id} type="button" class={page === item.id ? "is-on" : ""} onClick={() => setPage(item.id)}>
                  <item.icon size={17} />
                  <span>{item.label}</span>
                </button>
              ))}
            </div>
          );
        })}
        <span class="grow" />
        <button type="button" onClick={() => void api("logout", {}).finally(() => location.reload())}>
          <LogOut size={17} />
          <span>Se déconnecter</span>
        </button>
      </nav>
      <main>
        <h1>{ALL_PAGES.find(p => p.id === page)!.label}</h1>
        <Current />
      </main>
    </div>
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
