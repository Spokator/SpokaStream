/** @jsxImportSource preact */
import { useState } from "preact/hooks";
import { askedUser, Bars, bytes, Chart, count, number, Stat, usePolled } from "./lib.tsx";

interface Timeline {
  at: number[];
  up: number[];
  down: number[];
  relay: number[];
}

interface DayRow {
  day: string;
  up: number;
  down: number;
  relay: number;
}

interface AccountRow {
  id: string;
  name: string;
  color: string;
  limited: boolean;
  up: number;
  down: number;
  relayUp: number;
  relayDown: number;
  peakMbps: number;
  live: { up: number; down: number; relay: number } | null;
}

interface BandwidthData {
  accounts: AccountRow[];
  timeline: Timeline;
  daily: DayRow[];
  now: { relayed: number; relayKbps: number };
}

interface MachineData {
  at: number[];
  series: Record<string, (number | null)[]>;
}

const PERIODS = [
  { days: 1, label: "24 heures" },
  { days: 7, label: "7 jours" },
  { days: 30, label: "30 jours" },
];

/** Le serveur compte en kilobits. */
const size = (kilobits: number) => bytes(kilobits * 125);
const gigabytes = (kilobits: number) => +(kilobits / 8e6).toFixed(2);
const dayLabel = (day: string) => new Date(`${day}T12:00:00Z`).toLocaleDateString("fr-FR", { day: "2-digit", month: "2-digit" });
const lastKnown = (values: (number | null)[] | undefined) => [...(values ?? [])].reverse().find(value => value !== null) ?? null;

/** La courbe et les jours d'un compte, ici et sur sa fiche. */
export function AccountBandwidth({ id, name }: { id: string; name: string }) {
  const { data, error } = usePolled<{ timeline: Timeline; daily: DayRow[] }>(`bandwidth?id=${id}`, 60_000);
  if (!data) return <p class="muted">{error || "Chargement…"}</p>;
  const { timeline, daily } = data;
  const idle = !timeline.up.concat(timeline.down).some(Boolean);
  const labels = daily.map(row => dayLabel(row.day));
  return (
    <section class="trends">
      <Chart title={`Débit de ${name}, 24 h`} unit="Mb/s" at={timeline.at} series={[{ label: "Envoyé", values: idle ? [] : timeline.up }, { label: "Reçu", values: idle ? [] : timeline.down }, { label: "Par le relais", values: idle ? [] : timeline.relay }]} />
      <Bars title="Envoyé et reçu, par jour" unit="Go" digits={2} labels={labels} values={daily.map(row => gigabytes(row.up + row.down))} />
      <Bars title="Par le relais, par jour" unit="Go" digits={2} labels={labels} values={daily.map(row => gigabytes(row.relay))} />
    </section>
  );
}

export function BandwidthPage({ open }: { open: (page: string) => void }) {
  const [days, setDays] = useState(1);
  const [opened, setOpened] = useState("");
  const { data, error } = usePolled<BandwidthData>(`bandwidth?days=${days}`, 15_000);
  const { data: machine } = usePolled<MachineData>("metrics?range=24h", 60_000);
  if (!data) return <p class="empty">{error || "Chargement…"}</p>;
  const { accounts, timeline, daily, now } = data;
  const period = PERIODS.find(row => row.days === days)!.label;
  const sent = accounts.reduce((total, row) => total + row.up, 0);
  const relayed = accounts.reduce((total, row) => total + row.relayUp, 0);
  const idle = !timeline.up.some(Boolean);
  const netTx = machine?.series.netTx;
  const declared = machine?.series.relayKbps?.map(value => (value === null ? null : value / 1000));
  const manage = (row: AccountRow) => {
    askedUser.id = row.id;
    askedUser.name = row.name;
    open("users");
  };
  return (
    <>
      <div class="filters" role="group" aria-label="Période">
        {PERIODS.map(row => (
          <button key={row.days} type="button" class={days === row.days ? "is-on" : ""} aria-pressed={days === row.days} onClick={() => setDays(row.days)}>
            {row.label}
          </button>
        ))}
      </div>
      <section class="stats">
        <Stat label="Relais, maintenant" value={`${number(now.relayKbps / 1000, 1)} Mb/s`} hint={count(now.relayed, "spectateur relayé", "spectateurs relayés")} />
        <Stat label={`Relais, ${period}`} value={size(relayed)} hint={sent ? `${Math.round((relayed / sent) * 100)} % de ce qui est envoyé` : "Rien d'envoyé"} />
        <Stat label={`Envoyé, ${period}`} value={size(sent)} hint={count(accounts.length, "compte actif", "comptes actifs")} />
        <Stat label="La machine envoie" value={`${number(lastKnown(netTx), 1)} Mb/s`} hint="Mesure réelle, PinoyBot compris" />
      </section>
      <section class="trends is-wide">
        <Chart title="Débit de tous les comptes, 24 h" unit="Mb/s" at={timeline.at} series={[{ label: "Envoyé", values: idle ? [] : timeline.up }, { label: "Par le relais", values: idle ? [] : timeline.relay }]} />
        <Chart title="Relais déclaré et sortie réelle, 24 h" unit="Mb/s" at={machine?.at ?? []} series={[{ label: "Déclaré par les applications", values: declared ?? [] }, { label: "Envoyé par la machine", values: netTx ?? [] }]} />
        <Bars title="Par le relais, par jour" unit="Go" digits={2} labels={daily.map(row => dayLabel(row.day))} values={daily.map(row => gigabytes(row.relay))} />
      </section>
      <p class="muted">Ces débits sont déclarés par les applications : si la sortie réelle s'écarte nettement du relais déclaré, quelque chose échappe à ces chiffres. Sur un compte, un flux relayé compte pour celui qui l'envoie et pour celui qui le reçoit. Les totaux ne le comptent qu'une fois.</p>
      {accounts.length === 0 && <p class="empty">Aucun débit déclaré sur cette période.</p>}
      <div class="list">
        {accounts.map(row => (
          <article key={row.id} class="card">
            <div class="user">
              <i class="dot is-large" style={{ background: row.color }} />
              <div>
                <h2>
                  {row.name || "Sans nom"} {row.limited && <em>Limité</em>}
                </h2>
                <small>
                  Relais {size(row.relayUp + row.relayDown)} · envoyé {size(row.up)} · reçu {size(row.down)}
                  {days === 1 && row.peakMbps ? ` · pointe ${number(row.peakMbps, 1)} Mb/s` : ""}
                  {row.live ? ` · ${number((row.live.up + row.live.down) / 1000, 1)} Mb/s en ce moment` : ""}
                </small>
              </div>
              <button type="button" class="manage" aria-expanded={opened === row.id} onClick={() => setOpened(opened === row.id ? "" : row.id)}>
                Détails
              </button>
            </div>
            {opened === row.id && (
              <>
                <AccountBandwidth id={row.id} name={row.name} />
                <div class="tool-row">
                  <button type="button" onClick={() => manage(row)}>
                    Gérer ce compte
                  </button>
                </div>
              </>
            )}
          </article>
        ))}
      </div>
    </>
  );
}
