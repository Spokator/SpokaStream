/** @jsxImportSource preact */
import { AlertTriangle, CheckCircle2, XCircle } from "lucide-preact";
import type { ComponentChildren } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";

export type Role = "owner" | "admin" | "moderator";

export const RANK: Record<Role, number> = { moderator: 1, admin: 2, owner: 3 };
export const ROLE_NAMES: Record<Role, string> = { owner: "Propriétaire", admin: "Administrateur", moderator: "Modérateur" };
export const ROLE_HINTS: Record<Role, string> = {
  owner: "Tout, y compris les accès au panneau, les sauvegardes et le redémarrage",
  admin: "Tout gérer sauf les accès au panneau, les sauvegardes et Discord",
  moderator: "Surveiller, modérer les salons et les comptes, sanctionner",
};

/** Le rôle connecté : il masque ce que le serveur refuserait de toute façon. */
let myRole: Role = "moderator";
export const setMyRole = (role: Role) => (myRole = role);
export const can = (role: Role) => RANK[myRole] >= RANK[role];

const REFRESH_MS = 5000;

export const api = async <T,>(path: string, body?: unknown): Promise<T> => {
  const response = await fetch(`/admin/api/${path}`, body === undefined ? undefined : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const data = (await response.json()) as T & { error?: string; needCode?: boolean };
  if (response.status === 401) throw new Error(data.needCode ? "code" : "login");
  if (!response.ok) throw new Error(data.error ?? "Action refusée.");
  return data;
};

export const act = (action: string, fields: Record<string, unknown> = {}) => api("action", { action, ...fields });
export const date = (at: number) => new Date(at).toLocaleString("fr-FR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
export const count = (n: number, one: string, many: string) => `${n} ${n > 1 ? many : one}`;
export const time = (at: number) => new Date(at).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
export const bytes = (n: number) => (n >= 1e9 ? `${(n / 1e9).toFixed(1)} Go` : n >= 1e6 ? `${(n / 1e6).toFixed(1)} Mo` : n >= 1e3 ? `${Math.round(n / 1e3)} ko` : `${n} o`);
export const number = (value: number | null | undefined, digits = 0) => (value === null || value === undefined ? "—" : value.toLocaleString("fr-FR", { maximumFractionDigits: digits }));

export function span(seconds: number) {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return days ? `${days} j ${hours} h` : hours ? `${hours} h ${minutes} min` : `${minutes} min`;
}

export function usePolled<T>(path: string, every = REFRESH_MS) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState("");
  const refresh = () => api<T>(path).then(value => (setData(value), setError("")), (e: Error) => (e.message === "login" ? location.reload() : setError(e.message)));
  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), every);
    return () => clearInterval(timer);
  }, [path]);
  return { data, error, refresh };
}

/** Trois teintes au plus par courbe : au-delà, on ne distingue plus rien. Palette vérifiée sur ce fond, y compris pour les daltoniens. */
const SERIES = ["#3987e5", "#d95926", "#199e70"];

export interface Series {
  label: string;
  values: (number | null)[];
}

const niceMax = (value: number) => {
  if (value <= 0) return 1;
  const power = 10 ** Math.floor(Math.log10(value));
  const step = [1, 2, 2.5, 5, 10].find(s => s * power >= value)!;
  return step * power;
};

const axisTime = (at: number, wide: boolean) => new Date(at).toLocaleString("fr-FR", wide ? { day: "2-digit", month: "2-digit" } : { hour: "2-digit", minute: "2-digit" });

/** Une courbe par mesure. Une seule échelle : deux unités différentes font deux graphiques. */
export function Chart({ title, unit, at, series, max, digits = 1 }: { title: string; unit: string; at: number[]; series: Series[]; max?: number; digits?: number }) {
  const box = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<number | null>(null);
  const width = 600;
  const height = 120;
  const known = series.flatMap(s => s.values.filter((v): v is number => v !== null));
  const top = max ?? niceMax(Math.max(0, ...known));
  const x = (i: number) => (at.length < 2 ? 0 : (i / (at.length - 1)) * width);
  const y = (value: number) => height - 1 - (Math.min(value, top) / top) * (height - 6);
  const path = (values: (number | null)[]) => {
    let d = "";
    let pen = false;
    values.forEach((value, i) => {
      if (value === null) {
        pen = false;
        return;
      }
      d += `${pen ? "L" : "M"}${x(i).toFixed(1)} ${y(value).toFixed(1)}`;
      pen = true;
    });
    return d;
  };
  const latest = (s: Series) => [...s.values].reverse().find(v => v !== null) ?? null;
  const shown = hover ?? at.length - 1;
  const wide = at.length > 1 && at.at(-1)! - at[0]! > 36 * 3600_000;
  const left = at.length > 1 ? (shown / (at.length - 1)) * 100 : 0;
  return (
    <figure class="chart">
      <figcaption>
        <span>{title}</span>
        {series.length === 1 && (
          <b>
            {number(hover !== null ? series[0]!.values[hover] : latest(series[0]!), digits)} {unit}
          </b>
        )}
      </figcaption>
      {series.length > 1 && (
        <div class="chart-legend">
          {series.map((s, i) => (
            <span key={s.label}>
              <i style={{ background: SERIES[i] }} /> {s.label} <b>{number(hover !== null ? s.values[hover] : latest(s), digits)}</b> {unit}
            </span>
          ))}
        </div>
      )}
      {known.length === 0 ? (
        <p class="chart-empty">Pas encore de mesure sur cette période.</p>
      ) : (
        <>
          <div
            class="chart-plot"
            ref={box}
            onPointerMove={e => {
              const rect = box.current!.getBoundingClientRect();
              setHover(Math.max(0, Math.min(at.length - 1, Math.round(((e.clientX - rect.left) / rect.width) * (at.length - 1)))));
            }}
            onPointerLeave={() => setHover(null)}
          >
            <small class="chart-tick" style={{ top: "0" }}>
              {number(top, 1)}
            </small>
            <small class="chart-tick" style={{ top: "50%" }}>
              {number(top / 2, 1)}
            </small>
            <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" role="img" aria-label={`${title} : dernière valeur ${series.map(s => `${s.label} ${number(latest(s), digits)} ${unit}`).join(", ")}`}>
              <line x1="0" x2={width} y1={y(top)} y2={y(top)} class="chart-grid" vector-effect="non-scaling-stroke" />
              <line x1="0" x2={width} y1={y(top / 2)} y2={y(top / 2)} class="chart-grid" vector-effect="non-scaling-stroke" />
              <line x1="0" x2={width} y1={y(0)} y2={y(0)} class="chart-base" vector-effect="non-scaling-stroke" />
              {series.map((s, i) => (
                <path key={s.label} d={path(s.values)} fill="none" stroke={SERIES[i]} stroke-width="2" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke" />
              ))}
              {hover !== null && <line x1={x(hover)} x2={x(hover)} y1="0" y2={height} class="chart-cross" vector-effect="non-scaling-stroke" />}
            </svg>
            {hover !== null && (
              <div class={`chart-tip ${left > 60 ? "is-left" : ""}`} style={{ left: `${left}%` }}>
                {date(at[hover]!)}
              </div>
            )}
          </div>
          <div class="chart-axis">
            <small>{at[0] ? axisTime(at[0], wide) : ""}</small>
            <small>{at.length > 2 ? axisTime(at[Math.floor(at.length / 2)]!, wide) : ""}</small>
            <small>{at.length > 1 ? axisTime(at.at(-1)!, wide) : ""}</small>
          </div>
        </>
      )}
    </figure>
  );
}

/** Des barres par jour ou par heure. Une seule mesure, une seule échelle. */
export function Bars({ title, unit, labels, values, digits = 0 }: { title: string; unit: string; labels: string[]; values: number[]; digits?: number }) {
  const [hover, setHover] = useState<number | null>(null);
  const top = Math.max(0, ...values);
  const total = values.reduce((sum, value) => sum + value, 0);
  return (
    <figure class="chart">
      <figcaption>
        <span>{title}</span>
        <b>
          {hover !== null ? `${labels[hover]} : ${number(values[hover], digits)} ${unit}` : `${number(values.at(-1), digits)} ${unit}`}
        </b>
      </figcaption>
      {total === 0 ? (
        <p class="chart-empty">Rien sur cette période.</p>
      ) : (
        <div class="bars" role="img" aria-label={`${title} : maximum ${number(top, digits)} ${unit}`} onPointerLeave={() => setHover(null)}>
          {values.map((value, i) => (
            <span key={labels[i]} class="bar-slot" onPointerEnter={() => setHover(i)}>
              <i class={hover === i ? "is-on" : ""} style={{ height: `${top ? Math.max(value ? 3 : 0, (value / top) * 100) : 0}%` }} />
            </span>
          ))}
        </div>
      )}
      <div class="chart-axis">
        <small>{labels[0]}</small>
        <small>{labels.at(-1)}</small>
      </div>
    </figure>
  );
}

export type Level = "good" | "warning" | "critical";

const LEVEL_NAMES: Record<Level, string> = { good: "Normal", warning: "À surveiller", critical: "Critique" };

export const levelOf = (value: number | null | undefined, warn: number, bad: number): Level => (value === null || value === undefined || value < warn ? "good" : value < bad ? "warning" : "critical");

export function LevelIcon({ level, size = 15 }: { level: Level; size?: number }) {
  return level === "good" ? <CheckCircle2 size={size} /> : level === "warning" ? <AlertTriangle size={size} /> : <XCircle size={size} />;
}

/** Une ressource et sa jauge : l'état se lit au mot et à l'icône, pas seulement à la couleur. */
export function Gauge({ label, value, unit = "%", pct, hint, level }: { label: string; value: string; unit?: string; pct: number | null; hint?: string; level: Level }) {
  return (
    <div class={`gauge is-${level}`}>
      <div class="gauge-head">
        <span>{label}</span>
        <em title={LEVEL_NAMES[level]}>
          <LevelIcon level={level} size={14} />
        </em>
      </div>
      <b>
        {value} <small>{unit}</small>
      </b>
      <div class="gauge-track" role="meter" aria-label={label} aria-valuenow={pct ?? 0} aria-valuemin={0} aria-valuemax={100}>
        <i style={{ width: `${Math.min(100, Math.max(0, pct ?? 0))}%` }} />
      </div>
      {hint && <small>{hint}</small>}
    </div>
  );
}

export function Stat({ label, value, hint }: { label: string; value: string | number; hint?: string }) {
  return (
    <div class="stat">
      <span>{label}</span>
      <b>{value}</b>
      {hint && <small>{hint}</small>}
    </div>
  );
}

export function Field({ label, children }: { label: string; children: ComponentChildren }) {
  return (
    <label class="form-field">
      <span>{label}</span>
      {children}
    </label>
  );
}

export function Note({ note, problem }: { note: string; problem: string }) {
  return (
    <>
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
    </>
  );
}

/** Une action et son retour : chaque page dit ce qui s'est passé, succès ou refus. */
export function useAction(refresh?: () => unknown) {
  const [note, setNote] = useState("");
  const [problem, setProblem] = useState("");
  const run = (action: string, fields: Record<string, unknown>, done: string) =>
    void act(action, fields).then(
      () => {
        setNote(done);
        setProblem("");
        void refresh?.();
      },
      (e: Error) => {
        setProblem(e.message);
        setNote("");
      },
    );
  return { note, problem, run, setNote, setProblem };
}

/** Un bouton qui demande une seconde pression : les gestes qui ne se rattrapent pas ne partent pas sur un clic égaré. */
export function ArmedButton({ label, confirm, onConfirm, class: className = "" }: { label: string; confirm: string; onConfirm: () => void; class?: string }) {
  const [armed, setArmed] = useState(false);
  return (
    <button
      type="button"
      class={`${className} ${armed ? "is-danger" : ""}`}
      onClick={() => {
        if (!armed) return setArmed(true);
        setArmed(false);
        onConfirm();
      }}
      onBlur={() => setArmed(false)}
    >
      {armed ? confirm : label}
    </button>
  );
}

export const DURATIONS: { label: string; hours: number }[] = [
  { label: "1 heure", hours: 1 },
  { label: "24 heures", hours: 24 },
  { label: "7 jours", hours: 168 },
  { label: "30 jours", hours: 720 },
];
