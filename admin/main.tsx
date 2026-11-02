/** @jsxImportSource preact */
import { Activity, ArrowDownUp, BarChart3, Bell, DatabaseBackup, Download, Gauge as GaugeIcon, Inbox, KeyRound, LayoutDashboard, LogOut, Menu, MessagesSquare, Radio, RefreshCw, ScrollText, ServerCog, Share, ShieldAlert, ShieldCheck, SlidersHorizontal, UserCog, Users, WifiOff, X } from "lucide-preact";
import { render } from "preact";
import type { FunctionComponent } from "preact";
import { useEffect, useState } from "preact/hooks";
import { AdminsPage, SecurityPage } from "./access.tsx";
import { BandwidthPage } from "./bandwidth.tsx";
import { api, can, Field, ROLE_NAMES, setMyRole, usePolled } from "./lib.tsx";
import type { Role } from "./lib.tsx";
import { LogsPage, ModerationPage, ReportsPage, RoomsPage, UsersPage } from "./manage.tsx";
import { AlertsPage, OverviewPage, StreamsPage, SystemPage, UsagePage } from "./monitor.tsx";
import { BackupsPage, SettingsPage } from "./settings.tsx";

type Page = "overview" | "alerts" | "bandwidth" | "streams" | "rooms" | "users" | "moderation" | "system" | "usage" | "logs" | "reports" | "settings" | "backups" | "admins" | "security";

const GROUPS: { label: string; pages: { id: Page; label: string; icon: typeof Activity; need?: Role }[] }[] = [
  {
    label: "Pilotage",
    pages: [
      { id: "overview", label: "Vue d'ensemble", icon: LayoutDashboard },
      { id: "alerts", label: "Alertes", icon: Bell },
      { id: "system", label: "Système", icon: GaugeIcon },
      { id: "usage", label: "Statistiques", icon: BarChart3 },
      { id: "bandwidth", label: "Bande passante", icon: ArrowDownUp },
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

const TABS: { id: Page; label: string; icon: typeof Activity }[] = [
  { id: "overview", label: "Accueil", icon: LayoutDashboard },
  { id: "alerts", label: "Alertes", icon: Bell },
  { id: "streams", label: "Direct", icon: Radio },
  { id: "users", label: "Comptes", icon: Users },
];

const pageFromHash = () => ALL_PAGES.find(item => location.hash === `#${item.id}`)?.id ?? "overview";
const installed = () => matchMedia("(display-mode: standalone)").matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
const isIos = /iPhone|iPad|iPod/i.test(navigator.userAgent);

let installEvent: (Event & { prompt(): Promise<void> }) | null = null;
addEventListener("beforeinstallprompt", event => {
  event.preventDefault();
  installEvent = event as typeof installEvent;
});

function InstallHint() {
  const [, redraw] = useState(0);
  if (installed()) return null;
  if (installEvent) {
    return (
      <button
        type="button"
        class="more-install"
        onClick={() =>
          void installEvent?.prompt().finally(() => {
            installEvent = null;
            redraw(n => n + 1);
          })
        }
      >
        <Download size={18} />
        <span>Installer sur cet appareil</span>
      </button>
    );
  }
  if (!isIos) return null;
  return (
    <p class="more-hint">
      <Share size={16} />
      <span>Pour l'avoir comme une application : dans Safari, touche Partager, puis « Sur l'écran d'accueil ».</span>
    </p>
  );
}

function Panel() {
  const [page, setPage] = useState<Page>(pageFromHash);
  const [more, setMore] = useState(false);
  const [me, setMe] = useState<{ name: string; role: Role; hasLogin: boolean } | null>(null);
  const [online, setOnline] = useState(navigator.onLine);
  const { data: alerts } = usePolled<{ active: unknown[] }>("alerts", 30_000);
  useEffect(() => {
    void api<{ name: string; role: Role; hasLogin: boolean }>("me").then(value => {
      setMyRole(value.role);
      setMe(value);
    });
    // Chaque page entre dans l'historique : sur un téléphone, le bouton retour revient à la page d'avant au lieu de quitter l'application.
    const onPop = (e: PopStateEvent) => {
      const state = e.state as { page?: Page; more?: boolean } | null;
      setMore(!!state?.more);
      setPage(state?.page ?? pageFromHash());
    };
    const onNetwork = () => setOnline(navigator.onLine);
    addEventListener("popstate", onPop);
    addEventListener("online", onNetwork);
    addEventListener("offline", onNetwork);
    return () => {
      removeEventListener("popstate", onPop);
      removeEventListener("online", onNetwork);
      removeEventListener("offline", onNetwork);
    };
  }, []);
  if (!me) return null;
  const allowed = (item: (typeof ALL_PAGES)[number]) => (!item.need || can(item.need)) && (item.id !== "security" || me.hasLogin);
  const shown = ALL_PAGES.find(item => item.id === page && allowed(item))?.id ?? "overview";
  const go = (next: Page) => {
    history.pushState({ page: next }, "", `#${next}`);
    setPage(next);
    setMore(false);
    scrollTo(0, 0);
  };
  const openMore = () => {
    history.pushState({ page: shown, more: true }, "", `#${shown}`);
    setMore(true);
  };
  const logout = () => void api("logout", {}).finally(() => location.reload());
  const alertCount = alerts?.active.length ?? 0;
  const groups = GROUPS.map(group => ({ ...group, pages: group.pages.filter(allowed) })).filter(group => group.pages.length);
  const Current = { overview: OverviewPage, alerts: AlertsPage, streams: StreamsPage, rooms: RoomsPage, users: UsersPage, moderation: ModerationPage, system: SystemPage, usage: UsagePage, bandwidth: BandwidthPage, logs: LogsPage, reports: ReportsPage, settings: SettingsPage, backups: BackupsPage, admins: AdminsPage, security: SecurityPage }[shown] as FunctionComponent<{ open: (next: string) => void }>;
  return (
    <div class="panel">
      <nav class="side" aria-label="Administration">
        <h1>
          <ServerCog size={17} /> SpokaStream
        </h1>
        <p class="me">
          {me.name}
          <small>{ROLE_NAMES[me.role]}</small>
        </p>
        {groups.map(group => (
          <div key={group.label} class="nav-group">
            <h2>{group.label}</h2>
            {group.pages.map(item => (
              <button key={item.id} type="button" class={shown === item.id ? "is-on" : ""} onClick={() => go(item.id)}>
                <item.icon size={17} />
                <span>{item.label}</span>
                {item.id === "alerts" && alertCount > 0 && <em class="count">{alertCount}</em>}
              </button>
            ))}
          </div>
        ))}
        <span class="grow" />
        <InstallHint />
        <button type="button" onClick={logout}>
          <LogOut size={17} />
          <span>Se déconnecter</span>
        </button>
      </nav>
      <main>
        {!online && (
          <p class="offline" role="status">
            Pas de connexion : ces chiffres peuvent dater.
          </p>
        )}
        <h1>{ALL_PAGES.find(item => item.id === shown)!.label}</h1>
        <Current open={go as (next: string) => void} />
      </main>
      <nav class="tabbar" aria-label="Pages principales">
        {TABS.map(tab => (
          <button key={tab.id} type="button" class={shown === tab.id && !more ? "is-on" : ""} aria-current={shown === tab.id && !more ? "page" : undefined} onClick={() => go(tab.id)}>
            <tab.icon size={21} />
            <span>{tab.label}</span>
            {tab.id === "alerts" && alertCount > 0 && <em class="count">{alertCount}</em>}
          </button>
        ))}
        <button type="button" class={more || !TABS.some(tab => tab.id === shown) ? "is-on" : ""} aria-expanded={more} onClick={openMore}>
          <Menu size={21} />
          <span>Plus</span>
        </button>
      </nav>
      {more && (
        <div class="more" role="dialog" aria-label="Toutes les pages">
          <header>
            <p class="me">
              {me.name}
              <small>{ROLE_NAMES[me.role]}</small>
            </p>
            <button type="button" class="icon" aria-label="Fermer" onClick={() => history.back()}>
              <X size={18} />
            </button>
          </header>
          {groups.map(group => (
            <section key={group.label}>
              <h2>{group.label}</h2>
              <div class="more-grid">
                {group.pages.map(item => (
                  <button key={item.id} type="button" class={shown === item.id ? "is-on" : ""} onClick={() => go(item.id)}>
                    <item.icon size={20} />
                    <span>{item.label}</span>
                  </button>
                ))}
              </div>
            </section>
          ))}
          <InstallHint />
          <button type="button" class="more-logout" onClick={logout}>
            <LogOut size={18} />
            <span>Se déconnecter</span>
          </button>
        </div>
      )}
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
  const [state, setState] = useState<"loading" | "in" | "login" | "setup" | "closed" | "offline">("loading");
  const [setupCode, setSetupCode] = useState("");

  useEffect(() => {
    void navigator.serviceWorker?.register("/admin/sw.js", { scope: "/admin" }).catch(() => {});
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
    })().catch(() => setState("offline"));
  }, []);

  if (state === "loading") return null;
  if (state === "offline") {
    return (
      <main class="login">
        <WifiOff size={28} />
        <h1>Pas de connexion</h1>
        <p class="muted">Le panneau a besoin du serveur : rien n'est gardé sur cet appareil.</p>
        <button type="button" class="primary" onClick={() => location.reload()}>
          <RefreshCw size={15} /> Réessayer
        </button>
      </main>
    );
  }
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
