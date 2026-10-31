/** @jsxImportSource preact */
import { KeyRound, LogOut, ShieldCheck, Unlock, UserPlus, XCircle } from "lucide-preact";
import qrcode from "qrcode-generator";
import { useMemo, useState } from "preact/hooks";
import { api, can, count, date, Field, ROLE_HINTS, ROLE_NAMES, usePolled } from "./lib.tsx";
import type { Role } from "./lib.tsx";

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

export function AdminsPage() {
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

interface AccessData {
  sessions: { id: string; name: string; ip: string; agent: string; createdAt: number; seenAt: number; self: boolean }[];
  locks: { ip: string; count: number; since: number; locked: boolean }[];
}

interface Security {
  username: string;
  role: Role;
  changedAt: number;
  totp: boolean;
  recoveryLeft: number;
  sessions: number;
}

export function SecurityPage() {
  const { data, refresh } = usePolled<Security>("security");
  const { data: access, refresh: refreshAccess } = usePolled<AccessData | null>(can("owner") ? "sessions" : "security");
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
        <p class="muted">{count(data.sessions, "session ouverte", "sessions ouvertes")}. Une session dure 12 heures et se ferme quand le serveur redémarre.</p>
        {data.sessions > 1 && (
          <div class="actions">
            <button type="button" onClick={() => void api("sessions/revoke", {}).then(() => done("Autres sessions fermées."), fail)}>
              Fermer les autres
            </button>
          </div>
        )}
      </section>

      {can("owner") && access?.sessions && (
        <section class="card">
          <h2>
            <ShieldCheck size={16} /> Tous les accès ouverts
          </h2>
          {access.sessions.map(session => (
            <div key={session.id} class="row-line">
              <span>
                <b>{session.name}</b> {session.self && <em>toi</em>} <code>{session.ip}</code> · vu le {date(session.seenAt)}
                <small> {session.agent.slice(0, 70)}</small>
              </span>
              {!session.self && (
                <button type="button" onClick={() => void api("sessions/close", { id: session.id }).then(() => (done("Session fermée."), void refreshAccess()), fail)}>
                  Fermer
                </button>
              )}
            </div>
          ))}
          <h3>Essais de connexion ratés</h3>
          {access.locks.length === 0 && <p class="muted">Aucun depuis 15 minutes.</p>}
          {access.locks.map(lock => (
            <div key={lock.ip} class="row-line">
              <span>
                <code>{lock.ip}</code> · {count(lock.count, "essai", "essais")} {lock.locked ? "· bloquée 15 minutes" : ""}
              </span>
              <button type="button" onClick={() => void api("locks/clear", { ip: lock.ip }).then(() => (done("Adresse débloquée."), void refreshAccess()), fail)}>
                <Unlock size={14} /> Débloquer
              </button>
            </div>
          ))}
        </section>
      )}
    </div>
  );
}

