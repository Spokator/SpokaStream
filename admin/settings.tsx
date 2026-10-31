/** @jsxImportSource preact */
import { CalendarClock, DatabaseBackup, DoorClosed, Download, Megaphone, RefreshCw, RotateCcw, SlidersHorizontal, Trash2, Wrench } from "lucide-preact";
import { useState } from "preact/hooks";
import { act, ArmedButton, bytes, can, date, Note, useAction, usePolled } from "./lib.tsx";
import type { Overview } from "./monitor.tsx";

interface ConfigData {
  closed: boolean;
  roomCreation: "everyone" | "admins";
  webViewers: boolean;
  watchParty: boolean;
  maxMembers: number;
  maxRooms: number;
  motd: string;
  minVersion: string;
  plan: { at: number; text: string; restart: boolean } | null;
  maintenance: string;
}

function Switch({ label, hint, checked, onChange }: { label: string; hint: string; checked: boolean; onChange: (checked: boolean) => void }) {
  return (
    <label class="setting">
      <input type="checkbox" checked={checked} onChange={e => onChange(e.currentTarget.checked)} />
      <span>
        <b>{label}</b>
        <small>{hint}</small>
      </span>
    </label>
  );
}

/** Un champ qui s'enregistre en le quittant : pas besoin de chercher un bouton pour chaque réglage. */
function Saved({ label, value, onSave, type = "text", placeholder = "" }: { label: string; value: string; onSave: (value: string) => void; type?: "text" | "number"; placeholder?: string }) {
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <label class="form-field">
      <span>{label}</span>
      <input
        type={type as "text"}
        value={draft ?? value}
        placeholder={placeholder}
        onInput={e => setDraft(e.currentTarget.value)}
        onBlur={() => {
          if (draft !== null && draft !== value) onSave(draft);
          setDraft(null);
        }}
      />
    </label>
  );
}

const localInput = (at: number) => new Date(at - new Date(at).getTimezoneOffset() * 60_000).toISOString().slice(0, 16);

export function SettingsPage() {
  const { data, refresh } = usePolled<ConfigData>("config");
  const { data: overview, refresh: refreshOverview } = usePolled<Overview>("overview");
  const { note, problem, run } = useAction(() => {
    void refresh();
    void refreshOverview();
  });
  const [announce, setAnnounce] = useState("");
  const [maintenance, setMaintenance] = useState("");
  const [planAt, setPlanAt] = useState(() => localInput(Date.now() + 3600_000));
  const [planText, setPlanText] = useState("");
  const [planRestart, setPlanRestart] = useState(false);
  if (!data) return <p class="empty">Chargement…</p>;
  const save = (patch: Partial<ConfigData>, done = "Réglage enregistré.") => run("setConfig", { patch }, done);
  return (
    <div class="list">
      <Note note={note} problem={problem} />
      <section class="card">
        <h2>
          <DoorClosed size={16} /> Accès
        </h2>
        <Switch label="Serveur fermé" hint="Les appareils déjà connus entrent normalement. Un inconnu ne peut que se lier à un compte existant avec un code." checked={data.closed} onChange={closed => save({ closed })} />
        <Switch label="Spectateurs sur le site" hint="Décoché : un nouvel appareil ne peut plus entrer depuis un navigateur sans être lié." checked={data.webViewers} onChange={webViewers => save({ webViewers })} />
        <Switch label="Watch Party" hint="Décoché : plus personne ne peut en lancer. Celles en cours continuent." checked={data.watchParty} onChange={watchParty => save({ watchParty })} />
        <div class="tool-row">
          <span>Qui peut créer un salon</span>
          <select value={data.roomCreation} aria-label="Qui peut créer un salon" onChange={e => save({ roomCreation: e.currentTarget.value as ConfigData["roomCreation"] })}>
            <option value="everyone">Tout le monde</option>
            <option value="admins">Les administrateurs seulement</option>
          </select>
        </div>
      </section>
      <section class="card">
        <h2>
          <SlidersHorizontal size={16} /> Limites
        </h2>
        <div class="form-grid">
          <Saved label="Personnes par salon (32 au plus)" type="number" value={String(data.maxMembers)} onSave={value => save({ maxMembers: Number(value) })} />
          <Saved label="Salons par compte (50 au plus)" type="number" value={String(data.maxRooms)} onSave={value => save({ maxRooms: Number(value) })} />
          <Saved label="Version minimale de l'application" value={data.minVersion} placeholder="Aucune, par exemple 1.5.0" onSave={minVersion => save({ minVersion })} />
        </div>
        <Saved label="Message affiché à chaque connexion" value={data.motd} placeholder="Aucun" onSave={motd => save({ motd })} />
      </section>
      <section class="card">
        <h2>
          <Megaphone size={16} /> Annonce à tout le monde
        </h2>
        <p class="muted">Elle s'affiche tout de suite dans chaque application et sur chaque téléphone connecté.</p>
        <textarea value={announce} maxLength={300} rows={2} aria-label="Texte de l'annonce" placeholder="La mise à jour arrive dans 5 minutes" onInput={e => setAnnounce(e.currentTarget.value)} />
        <div class="actions">
          <button type="button" class="primary" disabled={!announce.trim()} onClick={() => (run("announce", { text: announce, level: "info" }, "Annonce envoyée."), setAnnounce(""))}>
            Envoyer
          </button>
        </div>
      </section>
      <section class="card">
        <h2>
          <Wrench size={16} /> Maintenance
        </h2>
        <p class="muted">Personne ne peut créer de salon ni entrer dans celui d'un autre. Les streams en cours continuent.</p>
        {data.maintenance ? (
          <div class="actions">
            <span>En cours : {data.maintenance}</span>
            <button type="button" onClick={() => run("maintenance", { text: "" }, "Maintenance terminée.")}>
              Terminer
            </button>
          </div>
        ) : (
          <>
            <input value={maintenance} maxLength={300} aria-label="Message de maintenance" placeholder="Maintenance, retour dans 10 minutes" onInput={e => setMaintenance(e.currentTarget.value)} />
            <div class="actions">
              <button type="button" disabled={!maintenance.trim()} onClick={() => (run("maintenance", { text: maintenance }, "Maintenance activée."), setMaintenance(""))}>
                Activer maintenant
              </button>
            </div>
          </>
        )}
      </section>
      <section class="card">
        <h2>
          <CalendarClock size={16} /> Maintenance prévue
        </h2>
        {data.plan ? (
          <div class="actions">
            <span>
              Le {date(data.plan.at)} : {data.plan.text}
              {data.plan.restart ? ", puis redémarrage quand plus personne ne diffuse" : ""}
            </span>
            <button type="button" onClick={() => run("setPlan", { at: 0 }, "Maintenance annulée.")}>
              Annuler
            </button>
          </div>
        ) : (
          <>
            <p class="muted">Tout le monde est prévenu 10, 5 et 1 minute avant. Le serveur applique la maintenance tout seul.</p>
            <div class="tool-row">
              <input type="datetime-local" value={planAt} aria-label="Date de la maintenance" onInput={e => setPlanAt(e.currentTarget.value)} />
              <input value={planText} maxLength={300} placeholder="Ce que verront les gens" aria-label="Message de la maintenance prévue" onInput={e => setPlanText(e.currentTarget.value)} />
            </div>
            {overview?.canRestart && can("owner") && (
              <label class="tool-check">
                <input type="checkbox" checked={planRestart} onChange={e => setPlanRestart(e.currentTarget.checked)} /> Redémarrer ensuite, quand plus personne ne diffuse
              </label>
            )}
            <div class="actions">
              <button type="button" disabled={!planText.trim()} onClick={() => run("setPlan", { at: new Date(planAt).getTime(), text: planText, restart: planRestart }, "Maintenance prévue.")}>
                Prévoir
              </button>
            </div>
          </>
        )}
      </section>
      {overview?.canRestart && can("owner") && (
        <section class="card">
          <h2>
            <RefreshCw size={16} /> Redémarrer le serveur
          </h2>
          <p class="muted">Les streams continuent de PC à PC et les applications se reconnectent seules, en quelques secondes. {overview.stats.streams > 0 ? `${overview.stats.streams} streams sont en cours.` : "Personne ne diffuse."}</p>
          <div class="actions">
            {overview.restartIdle ? (
              <button type="button" onClick={() => run("restartIdle", { on: false }, "Redémarrage annulé.")}>
                Annuler le redémarrage différé
              </button>
            ) : (
              <button type="button" onClick={() => run("restartIdle", { on: true }, "Le serveur redémarrera dès que plus personne ne diffusera.")}>
                Dès que plus personne ne diffuse
              </button>
            )}
            <ArmedButton label="Maintenant" confirm="Confirmer le redémarrage" onConfirm={() => run("restart", {}, "Redémarrage en cours…")} />
          </div>
        </section>
      )}
    </div>
  );
}

interface BackupRow {
  id: string;
  at: number;
  auto: boolean;
  label: string;
  bytes: number;
  files: number;
}

export function BackupsPage() {
  const { data, error, refresh } = usePolled<{ list: BackupRow[]; canRestore: boolean }>("backups", 15_000);
  const { note, problem, run } = useAction(refresh);
  const [label, setLabel] = useState("");
  if (!data) return <p class="empty">{error || "Chargement…"}</p>;
  return (
    <div class="list">
      <Note note={note} problem={problem} />
      <section class="card">
        <h2>
          <DatabaseBackup size={16} /> Sauvegardes
        </h2>
        <p class="muted">Une copie des salons, des comptes, des notifications, des réglages et des statistiques. Une par jour se fait toute seule, les 7 dernières sont gardées. Elles restent sur ce serveur : télécharge-en une de temps en temps pour la garder ailleurs. Les accès au panneau n'y sont pas, ils ne risquent donc pas d'être écrasés.</p>
        <div class="tool-row">
          <input value={label} maxLength={80} placeholder="Avant la mise à jour, facultatif" aria-label="Nom de la sauvegarde" onInput={e => setLabel(e.currentTarget.value)} />
          <button type="button" class="primary" onClick={() => (run("backupCreate", { label }, "Sauvegarde créée."), setLabel(""))}>
            Créer maintenant
          </button>
        </div>
      </section>
      {data.list.length === 0 && <p class="empty">Aucune sauvegarde pour l'instant.</p>}
      {data.list.map(backup => (
        <article key={backup.id} class="card">
          <header>
            <div>
              <h2>{backup.label}</h2>
              <small>
                {date(backup.at)} · {bytes(backup.bytes)} · {backup.files} fichiers
              </small>
            </div>
            <a class="button icon" href={`/admin/api/backups/download?id=${encodeURIComponent(backup.id)}`} title="Télécharger" aria-label={`Télécharger ${backup.label}`}>
              <Download size={15} />
            </a>
            <button type="button" class="icon" title="Supprimer" aria-label={`Supprimer ${backup.label}`} onClick={() => void act("backupDelete", { id: backup.id }).then(refresh)}>
              <Trash2 size={15} />
            </button>
          </header>
          {data.canRestore && (
            <div class="actions">
              <RotateCcw size={14} />
              <ArmedButton label="Restaurer" confirm="Confirmer : tout revient à cet instant, le serveur redémarre" onConfirm={() => run("backupRestore", { id: backup.id }, "Restauration : le serveur redémarre.")} />
            </div>
          )}
        </article>
      ))}
    </div>
  );
}
