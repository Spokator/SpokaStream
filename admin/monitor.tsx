/** @jsxImportSource preact */
import { AlertTriangle, ArrowDownUp, Bell, Radio, Square } from "lucide-preact";
import { useMemo, useState } from "preact/hooks";
import { Bars, bytes, can, Chart, count, date, Gauge, levelOf, LevelIcon, Note, number, span, Stat, time, useAction, usePolled } from "./lib.tsx";
import type { Level, Series } from "./lib.tsx";

interface ServiceInfo {
  state: string;
  since: string;
  restarts: number;
}

interface ServiceRow {
  id: string;
  name: string;
  kind: "service" | "container";
  cpuPct: number;
  memMb: number;
}

interface Limits {
  memMaxMb: number | null;
  cpuMaxPct: number | null;
  oomKills: number;
  throttledPct: number;
}

interface AlertRow {
  id: string;
  rule: string;
  label: string;
  value: number | null;
  limit: number;
  unit: string;
  startedAt: number;
  endedAt: number | null;
}

type Point = Record<string, number | null>;

export interface Overview {
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
  restartIdle: boolean;
  plan: { at: number; text: string; restart: boolean } | null;
  system: { load: number; cpus: number; memTotalMb: number; memFreeMb: number; processMb: number; uptime: number; disk: { totalGb: number; freeGb: number; usedPct: number } | null };
  services: Record<string, ServiceInfo>;
  certificate: string | null;
  release: { tag: string; publishedAt: string; downloads: number } | null;
  errors: number;
  reports: number;
  point: Point;
  limits: Limits;
  alerts: AlertRow[];
  serviceRows: ServiceRow[];
  dataFiles: { name: string; bytes: number }[];
}

interface MetricsData {
  at: number[];
  series: Record<string, (number | null)[]>;
  services: { rows: ServiceRow[]; limits: Limits };
  messages: { type: string; count: number; bytes: number }[];
  traffic: Record<string, number>;
  os: { cpus: number; memTotalMb: number; node: string };
  dataFiles: { name: string; bytes: number }[];
  disk: { totalGb: number; freeGb: number; usedPct: number } | null;
}

const SERVICE_LABELS: Record<string, string> = { "spokastream-server": "SpokaStream", nginx: "nginx (site)", coturn: "coturn (relais)" };

function RangePicker({ value, onChange }: { value: string; onChange: (range: string) => void }) {
  return (
    <div class="filters" role="group" aria-label="Période">
      {[
        ["1h", "1 heure"],
        ["6h", "6 heures"],
        ["24h", "24 heures"],
        ["7d", "7 jours"],
        ["30d", "30 jours"],
      ].map(([id, label]) => (
        <button key={id} type="button" class={value === id ? "is-on" : ""} aria-pressed={value === id} onClick={() => onChange(id!)}>
          {label}
        </button>
      ))}
    </div>
  );
}

function ServiceTable({ rows, limit }: { rows: ServiceRow[]; limit?: number }) {
  const total = rows.reduce((sum, row) => sum + row.memMb, 0);
  return (
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Service</th>
            <th class="num">Processeur</th>
            <th class="num">Mémoire</th>
            <th aria-hidden="true" />
          </tr>
        </thead>
        <tbody>
          {rows.slice(0, limit).map(row => (
            <tr key={row.id} class={row.id.startsWith("spokastream") ? "is-ours" : ""}>
              <td>
                {SERVICE_LABELS[row.name] ?? row.name}
                {row.kind === "container" && <small> conteneur</small>}
              </td>
              <td class="num">{number(row.cpuPct, 1)} %</td>
              <td class="num">{number(row.memMb)} Mo</td>
              <td class="spark-cell">
                <i style={{ width: `${total ? (row.memMb / rows[0]!.memMb) * 100 : 0}%` }} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function ServiceStatus({ services }: { services: Record<string, ServiceInfo> }) {
  return (
    <>
      {Object.entries(services).map(([name, info]) => {
        const ok = info.state === "active";
        const unknown = info.state === "inconnu";
        const level: Level = ok ? "good" : unknown ? "warning" : "critical";
        return (
          <div key={name} class={`service is-${level}`}>
            <LevelIcon level={level} size={16} />
            <span>{SERVICE_LABELS[name] ?? name}</span>
            <small>
              {ok ? (info.since ? `Depuis le ${date(Date.parse(info.since))}` : "En marche") : unknown ? "Non vérifiable ici" : info.state}
              {info.restarts > 0 ? ` · ${count(info.restarts, "redémarrage", "redémarrages")}` : ""}
            </small>
          </div>
        );
      })}
    </>
  );
}

export function OverviewPage({ open }: { open: (page: string) => void }) {
  const { data, error } = usePolled<Overview>("overview");
  const { data: metrics } = usePolled<MetricsData>("metrics?range=1h", 10_000);
  if (!data) return <p class="empty">{error || "Chargement…"}</p>;
  const { point, system, stats, limits } = data;
  const relayShare = (point.relayed ?? 0) + (point.direct ?? 0) ? Math.round(((point.relayed ?? 0) / ((point.relayed ?? 0) + (point.direct ?? 0))) * 100) : null;
  const memoryOfLimit = limits.memMaxMb && point.procMb ? Math.round((point.procMb / limits.memMaxMb) * 100) : null;
  const down = Object.entries(data.services).filter(([, info]) => info.state !== "active" && info.state !== "inconnu");
  const diskPct = system.disk?.usedPct ?? 0;
  const level: Level = data.alerts.length || down.length ? "critical" : (point.cpu ?? 0) > 75 || (point.mem ?? 0) > 85 || diskPct >= 80 ? "warning" : "good";
  const verdict = level === "critical" ? `${count(data.alerts.length + down.length, "problème en cours", "problèmes en cours")}` : level === "warning" ? (diskPct >= 80 ? `Le disque est plein à ${diskPct} %` : "La machine commence à être chargée") : "Tout fonctionne normalement";
  const series = (key: string) => metrics?.series[key] ?? [];
  const at = metrics?.at ?? [];
  return (
    <>
      <button type="button" class={`verdict is-${level}`} onClick={() => open("alerts")}>
        <LevelIcon level={level} size={20} />
        <span>
          <b>{verdict}</b>
          <small>
            Serveur {data.version}, lancé depuis {span(data.uptime)}
            {data.maintenance ? ` · maintenance en cours : ${data.maintenance}` : ""}
            {data.plan ? ` · maintenance prévue le ${date(data.plan.at)}` : ""}
            {data.restartIdle ? " · redémarrage dès que plus personne ne diffuse" : ""}
          </small>
        </span>
      </button>
      {data.alerts.length > 0 && (
        <section class="alerts" role="status">
          {data.alerts.map(alert => (
            <p key={alert.id}>
              <AlertTriangle size={16} /> {alert.label}
              {alert.unit ? ` : ${number(alert.value, 1)} ${alert.unit}` : ""} · depuis {time(alert.startedAt)}
            </p>
          ))}
        </section>
      )}
      <section class="stats">
        <Stat label="En ligne" value={stats.connections} hint={`${stats.members} dans un salon`} />
        <Stat label="En direct" value={stats.streams} hint={count(data.viewers, "spectateur", "spectateurs")} />
        <Stat label="Par le relais" value={relayShare === null ? "—" : `${relayShare} %`} hint={point.relayKbps ? `${number((point.relayKbps ?? 0) / 1000, 1)} Mb/s sur coturn` : "Aucun flux mesuré"} />
        <Stat label="Watch Party" value={data.parties} />
        <Stat label="Comptes" value={data.accounts} hint={count(stats.rooms, "salon", "salons")} />
        <Stat label="Erreurs, 24 h" value={data.errors} hint={count(data.reports, "retour reçu", "retours reçus")} />
      </section>
      <section class="gauges">
        <Gauge label="Processeur" value={number(point.cpu)} pct={point.cpu ?? null} level={levelOf(point.cpu, 75, 90)} hint={`Charge ${number(point.load, 2)} sur ${system.cpus} cœurs`} />
        <Gauge label="Mémoire" value={number(point.mem)} pct={point.mem ?? null} level={levelOf(point.mem, 85, 92)} hint={`${Math.round(system.memTotalMb / 1024)} Go, échange ${number(point.swap)} %`} />
        <Gauge label="Disque" value={number(system.disk?.usedPct)} pct={system.disk?.usedPct ?? null} level={levelOf(system.disk?.usedPct, 80, 90)} hint={system.disk ? `${system.disk.freeGb} Go libres` : "Inconnu"} />
        <Gauge label="Réseau" value={number((point.netRx ?? 0) + (point.netTx ?? 0), 1)} unit="Mb/s" pct={null} level="good" hint={`Reçu ${number(point.netRx, 1)}, envoyé ${number(point.netTx, 1)}`} />
        <Gauge label="SpokaStream" value={number(point.procMb)} unit="Mo" pct={memoryOfLimit} level={levelOf(memoryOfLimit, 70, 85)} hint={limits.memMaxMb ? `Limite ${limits.memMaxMb} Mo, processeur ${number(point.procCpu, 1)} %` : `Processeur ${number(point.procCpu, 1)} %`} />
        <Gauge label="Réactivité" value={number(point.loopP99, 1)} unit="ms" pct={point.loopP99 == null ? null : Math.min(100, (point.loopP99 / 200) * 100)} level={levelOf(point.loopP99, 50, 200)} hint="Délai du serveur, 99 % du temps" />
      </section>
      <section class="trends">
        <Chart title="Connexions" unit="" digits={0} at={at} series={[{ label: "Connexions", values: series("connections") }]} />
        <Chart title="Processeur de la machine" unit="%" max={100} digits={0} at={at} series={[{ label: "Occupé", values: series("cpu") }]} />
        <Chart title="Réseau de la machine" unit="Mb/s" at={at} series={[{ label: "Reçu", values: series("netRx") }, { label: "Envoyé", values: series("netTx") }]} />
      </section>
      <section class="columns">
        <div class="card">
          <h2>Services</h2>
          <ServiceStatus services={data.services} />
          <dl>
            <dt>Certificat HTTPS</dt>
            <dd>{data.certificate ? `Encore ${Math.round((Date.parse(data.certificate) - Date.now()) / 86_400_000)} jours` : "Inconnu"}</dd>
            <dt>Machine allumée depuis</dt>
            <dd>{span(system.uptime)}</dd>
          </dl>
        </div>
        <div class="card">
          <h2>Ce qui consomme</h2>
          {data.serviceRows.length ? <ServiceTable rows={data.serviceRows} /> : <p class="muted">Lisible uniquement sur le serveur Linux.</p>}
          <button type="button" class="link" onClick={() => open("system")}>
            Tout le détail
          </button>
        </div>
        <div class="card">
          <h2>Application</h2>
          <dl>
            <dt>Dernière version publiée</dt>
            <dd>{data.release ? `${data.release.tag}, ${new Date(data.release.publishedAt).toLocaleDateString("fr-FR")}` : "Inconnue"}</dd>
            <dt>Téléchargements sur GitHub</dt>
            <dd>{data.release?.downloads ?? "Inconnu"}</dd>
            <dt>Téléphones abonnés</dt>
            <dd>{data.pushSubscriptions}</dd>
          </dl>
          <h3>Versions connectées</h3>
          {Object.keys(data.versions).length === 0 && <p class="muted">Personne en ligne.</p>}
          {Object.entries(data.versions).map(([version, total]) => (
            <div key={version} class="row-line">
              <span>{version}</span>
              <b>{total}</b>
            </div>
          ))}
        </div>
      </section>
    </>
  );
}

export function SystemPage() {
  const [range, setRange] = useState("1h");
  const { data, error } = usePolled<MetricsData>(`metrics?range=${range}`, 10_000);
  if (!data) return <p class="empty">{error || "Chargement…"}</p>;
  const { at } = data;
  const s = (label: string, key: string): Series => ({ label, values: data.series[key] ?? [] });
  const { limits } = data.services;
  return (
    <>
      <RangePicker value={range} onChange={setRange} />
      <h2 class="section-title">La machine</h2>
      <section class="trends is-wide">
        <Chart title="Processeur" unit="%" max={100} at={at} series={[s("Occupé", "cpu"), s("Attente du disque", "iowait"), s("Repris par l'hébergeur", "steal")]} />
        <Chart title="Mémoire" unit="%" max={100} at={at} series={[s("Mémoire", "mem"), s("Échange sur disque", "swap")]} />
        <Chart title="Tâches qui attendent" unit="%" at={at} series={[s("Processeur", "pressureCpu"), s("Mémoire", "pressureMem"), s("Disque", "pressureIo")]} />
        <Chart title="Réseau" unit="Mb/s" at={at} series={[s("Reçu", "netRx"), s("Envoyé", "netTx")]} />
        <Chart title="Disque, débit" unit="Mo/s" digits={2} at={at} series={[s("Lecture", "diskRead"), s("Écriture", "diskWrite")]} />
        <Chart title="Disque, temps de réponse" unit="ms" at={at} series={[s("Par opération", "diskAwait")]} />
      </section>
      <h2 class="section-title">Le serveur SpokaStream</h2>
      <section class="stats">
        <Stat label="Limite de mémoire" value={limits.memMaxMb ? `${limits.memMaxMb} Mo` : "—"} hint={count(limits.oomKills, "arrêt forcé", "arrêts forcés")} />
        <Stat label="Limite de processeur" value={limits.cpuMaxPct ? `${limits.cpuMaxPct} %` : "—"} hint={`Bridé ${number(limits.throttledPct, 1)} % du temps`} />
        <Stat label="Node" value={data.os.node} hint={`${data.os.cpus} cœurs`} />
      </section>
      <section class="trends is-wide">
        <Chart title="Processeur du serveur" unit="% d'un cœur" at={at} series={[s("SpokaStream", "procCpu")]} />
        <Chart title="Mémoire du serveur" unit="Mo" digits={0} at={at} series={[s("Totale", "procMb"), s("Tas JavaScript", "heapMb")]} />
        <Chart title="Délai de réaction" unit="ms" at={at} series={[s("Médian", "loopP50"), s("99 % du temps", "loopP99"), s("Pire cas", "loopMax")]} />
        <Chart title="Occupation du serveur" unit="%" max={100} at={at} series={[s("Temps de travail", "loopUse")]} />
        <Chart title="Salons, débit" unit="kb/s" at={at} series={[s("Reçu", "wsIn"), s("Envoyé", "wsOut")]} />
        <Chart title="Messages" unit="/s" at={at} series={[s("Reçus", "msgIn"), s("Envoyés", "msgOut")]} />
        <Chart title="Requêtes web" unit="/s" digits={2} at={at} series={[s("Requêtes", "httpRate"), s("Erreurs", "httpErrors"), s("Refusées (limites)", "rejected")]} />
        <Chart title="Temps de réponse web" unit="ms" at={at} series={[s("Moyen", "httpMs")]} />
      </section>
      <h2 class="section-title">Le relais et l'extérieur</h2>
      <section class="trends is-wide">
        <Chart title="Spectateurs" unit="" digits={0} at={at} series={[s("Connexion directe", "direct"), s("Par le relais", "relayed")]} />
        <Chart title="Débit sur le relais" unit="kb/s" digits={0} at={at} series={[s("Déclaré par les applications", "relayKbps")]} />
        <Chart title="coturn, processeur" unit="%" at={at} series={[s("coturn", "turnCpu")]} />
        <Chart title="coturn, mémoire" unit="Mo" digits={0} at={at} series={[s("coturn", "turnMb")]} />
        <Chart title="Sondes" unit="ms" at={at} series={[s("Site, depuis l'adresse publique", "probeHttps"), s("Relais, réponse STUN", "probeStun")]} />
        <Chart title="Qualité reçue" unit="" at={at} series={[s("Pertes, %", "lossPct")]} />
      </section>
      <section class="columns">
        <div class="card is-span">
          <h2>Consommation par service</h2>
          {data.services.rows.length ? <ServiceTable rows={data.services.rows} limit={14} /> : <p class="muted">Lisible uniquement sur le serveur Linux.</p>}
        </div>
        <div class="card">
          <h2>Messages les plus lourds</h2>
          {data.messages.map(row => (
            <div key={row.type} class="row-line">
              <span>{row.type}</span>
              <small>
                {number(row.count)} · {bytes(row.bytes)}
              </small>
            </div>
          ))}
          <h3>Depuis le démarrage</h3>
          <dl>
            <dt>Connexions ouvertes</dt>
            <dd>{number(data.traffic.wsOpen)}</dd>
            <dt>Reçu des appareils</dt>
            <dd>{bytes(data.traffic.wsIn ?? 0)}</dd>
            <dt>Envoyé aux appareils</dt>
            <dd>{bytes(data.traffic.wsOut ?? 0)}</dd>
          </dl>
        </div>
        <div class="card">
          <h2>Données sur le disque</h2>
          {data.dataFiles.map(file => (
            <div key={file.name} class="row-line">
              <span>{file.name}</span>
              <small>{bytes(file.bytes)}</small>
            </div>
          ))}
          {!data.dataFiles.length && <p class="muted">Rien d'écrit pour l'instant.</p>}
        </div>
      </section>
    </>
  );
}

interface HealthViewer {
  id: string;
  name: string;
  web: boolean;
  kbps: number | null;
  fps: number | null;
  height: number | null;
  lostPct: number | null;
  jitterMs: number | null;
  freezes: number | null;
  relay: boolean | null;
  protocol: string;
  rttMs: number | null;
}

interface HealthStream {
  id: string;
  roomId: string;
  room: string;
  ownerId: string;
  owner: string;
  title: string;
  kind: string;
  startedAt: number;
  paused: boolean;
  announced: { width: number; height: number; fps: number };
  publish: { fps: number; kbps: number; height: number; codec: string; encoder: string; hardware: boolean; encMs: number | null; limit: string } | null;
  viewers: HealthViewer[];
}

interface SessionRow {
  id: string;
  startedAt: number;
  endedAt: number;
  name: string;
  room: string;
  title: string;
  height: number;
  fps: number;
  peakViewers: number;
  kbps: number;
  relayShare: number;
  lossPct: number;
}

const LIMIT_TEXT: Record<string, string> = { bandwidth: "Limité par le réseau", cpu: "Limité par le processeur", none: "Sans limite", other: "Limité" };

function viewerLevel(viewer: HealthViewer): Level {
  const loss = levelOf(viewer.lostPct, 2, 5);
  const rtt = levelOf(viewer.rttMs, 150, 300);
  return loss === "critical" || rtt === "critical" ? "critical" : loss === "warning" || rtt === "warning" ? "warning" : "good";
}

export function StreamsPage() {
  const { data, error, refresh } = usePolled<{ streams: HealthStream[]; sessions: SessionRow[]; summary: { relayed: number; direct: number; relayKbps: number; streamKbps: number; lossPct: number | null; rttMs: number | null } }>("health");
  const { note, problem, run } = useAction(refresh);
  if (!data) return <p class="empty">{error || "Chargement…"}</p>;
  const { summary } = data;
  return (
    <div class="list">
      <Note note={note} problem={problem} />
      <section class="stats">
        <Stat label="En direct" value={data.streams.length} />
        <Stat label="Connexion directe" value={summary.direct} hint="Ne coûtent rien au serveur" />
        <Stat label="Par le relais" value={summary.relayed} hint={`${number(summary.relayKbps / 1000, 1)} Mb/s sur coturn`} />
        <Stat label="Pertes moyennes" value={summary.lossPct === null ? "—" : `${number(summary.lossPct, 1)} %`} hint={summary.rttMs === null ? "" : `${summary.rttMs} ms aller-retour`} />
      </section>
      {data.streams.length === 0 && <p class="empty">Personne ne diffuse pour l'instant.</p>}
      {data.streams.map(stream => (
        <article key={stream.id} class="card">
          <header>
            <div>
              <h2>
                <Radio size={15} /> {stream.owner} {stream.paused && <em>En pause</em>}
              </h2>
              <small>
                {stream.title || stream.kind} · {stream.room} · depuis {span((Date.now() - stream.startedAt) / 1000)}
              </small>
            </div>
            <button type="button" class="icon" title="Arrêter ce stream" aria-label={`Arrêter le stream de ${stream.owner}`} onClick={() => run("stopStream", { roomId: stream.roomId, ownerId: stream.ownerId }, "Stream arrêté.")}>
              <Square size={15} />
            </button>
          </header>
          {stream.publish ? (
            <dl class="inline">
              <dt>Image</dt>
              <dd>
                {stream.publish.height}p, {stream.publish.fps} i/s
              </dd>
              <dt>Débit</dt>
              <dd>{number(stream.publish.kbps / 1000, 1)} Mb/s</dd>
              <dt>Encodeur</dt>
              <dd>
                {stream.publish.codec} {stream.publish.hardware ? "matériel" : "logiciel"}
                {stream.publish.encMs !== null ? `, ${stream.publish.encMs} ms` : ""}
              </dd>
              <dt>État</dt>
              <dd>{LIMIT_TEXT[stream.publish.limit] ?? stream.publish.limit}</dd>
            </dl>
          ) : (
            <p class="muted">
              Annoncé en {stream.announced.height}p, {stream.announced.fps} i/s. Pas de mesure : aucun spectateur, ou application antérieure à la 1.6.
            </p>
          )}
          {stream.viewers.length > 0 && (
            <div class="table-wrap">
              <table class="stack">
                <thead>
                  <tr>
                    <th>Spectateur</th>
                    <th>Route</th>
                    <th class="num">Reçoit</th>
                    <th class="num">Pertes</th>
                    <th class="num">Aller-retour</th>
                    <th class="num">Gels</th>
                  </tr>
                </thead>
                <tbody>
                  {stream.viewers.map(viewer => {
                    const level = viewerLevel(viewer);
                    return (
                      <tr key={viewer.id}>
                        <td class={`is-${level} is-title`}>
                          <LevelIcon level={level} size={14} /> {viewer.name}
                          {viewer.web && <small> site</small>}
                        </td>
                        <td data-label="Route">{viewer.relay === null ? "—" : viewer.relay ? `Relais ${viewer.protocol.toUpperCase()}` : "Directe"}</td>
                        <td class="num" data-label="Reçoit">
                          {viewer.height ? `${viewer.height}p · ` : ""}
                          {viewer.kbps === null ? "—" : `${number(viewer.kbps / 1000, 1)} Mb/s`}
                        </td>
                        <td class="num" data-label="Pertes">{viewer.lostPct === null ? "—" : `${number(viewer.lostPct, 1)} %`}</td>
                        <td class="num" data-label="Aller-retour">{viewer.rttMs === null ? "—" : `${viewer.rttMs} ms`}</td>
                        <td class="num" data-label="Gels">{number(viewer.freezes)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </article>
      ))}
      <section class="card">
        <h2>Diffusions terminées</h2>
        {data.sessions.length === 0 ? (
          <p class="muted">Elles s'afficheront ici.</p>
        ) : (
          <div class="table-wrap">
            <table class="stack">
              <thead>
                <tr>
                  <th>Début</th>
                  <th>Diffuseur</th>
                  <th>Salon</th>
                  <th class="num">Durée</th>
                  <th class="num">Pic</th>
                  <th class="num">Débit</th>
                  <th class="num">Relais</th>
                  <th class="num">Pertes</th>
                </tr>
              </thead>
              <tbody>
                {data.sessions.map(session => (
                  <tr key={session.id}>
                    <td data-label="Début">{date(session.startedAt)}</td>
                    <td class="is-title">{session.name}</td>
                    <td data-label="Salon">{session.room}</td>
                    <td class="num" data-label="Durée">{span((session.endedAt - session.startedAt) / 1000)}</td>
                    <td class="num" data-label="Pic">{session.peakViewers}</td>
                    <td class="num" data-label="Débit">{session.kbps ? `${number(session.kbps / 1000, 1)} Mb/s` : "—"}</td>
                    <td class="num" data-label="Relais">{session.relayShare} %</td>
                    <td class="num" data-label="Pertes">{number(session.lossPct, 1)} %</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

interface DayRow {
  day: string;
  streams: number;
  streamMinutes: number;
  watchMinutes: number;
  relayMinutes: number;
  directMinutes: number;
  partyMinutes: number;
  parties: number;
  messages: number;
  roomsCreated: number;
  newAccounts: number;
  activeAccounts: number;
  peakConnections: number;
  peakStreams: number;
  peakViewers: number;
  webConnections: number;
  appConnections: number;
  hours: number[];
}

interface UsageData {
  days: DayRow[];
  sessions: number;
  topStreamers: { id: string; name: string; streamMinutes: number; streams: number }[];
  topViewers: { id: string; name: string; watchMinutes: number }[];
  topRooms: { id: string; name: string; liveMinutes: number; messages: number }[];
}

const hours = (minutes: number) => (minutes >= 60 ? `${number(minutes / 60, 1)} h` : `${minutes} min`);

export function UsagePage() {
  const { data, error } = usePolled<UsageData>("usage", 30_000);
  const [span_, setSpan] = useState(30);
  const days = useMemo(() => (data?.days ?? []).slice(-span_), [data, span_]);
  if (!data) return <p class="empty">{error || "Chargement…"}</p>;
  const labels = days.map(d => new Date(`${d.day}T12:00:00Z`).toLocaleDateString("fr-FR", { day: "2-digit", month: "2-digit" }));
  const sum = (key: keyof DayRow) => days.reduce((total, day) => total + (day[key] as number), 0);
  const routed = sum("relayMinutes") + sum("directMinutes");
  const web = sum("webConnections");
  const app = sum("appConnections");
  const hourly = Array.from({ length: 24 }, (_, hour) => Math.max(0, ...days.map(day => day.hours[hour] ?? 0)));
  const list = (rows: { id: string; name: string; value: string }[], empty: string) =>
    rows.length ? (
      rows.map((row, i) => (
        <div key={row.id} class="row-line">
          <span>
            {i + 1}. {row.name}
          </span>
          <small>{row.value}</small>
        </div>
      ))
    ) : (
      <p class="muted">{empty}</p>
    );
  return (
    <>
      <div class="filters" role="group" aria-label="Période">
        {[7, 30, 90].map(n => (
          <button key={n} type="button" class={span_ === n ? "is-on" : ""} aria-pressed={span_ === n} onClick={() => setSpan(n)}>
            {n} jours
          </button>
        ))}
      </div>
      <section class="stats">
        <Stat label="Diffusions" value={number(sum("streams"))} hint={hours(sum("streamMinutes"))} />
        <Stat label="Temps regardé" value={hours(sum("watchMinutes"))} hint={`Pic ${Math.max(0, ...days.map(d => d.peakViewers))} spectateurs`} />
        <Stat label="Messages" value={number(sum("messages"))} />
        <Stat label="Watch Party" value={number(sum("parties"))} hint={hours(sum("partyMinutes"))} />
        <Stat label="Nouveaux comptes" value={number(sum("newAccounts"))} hint={`${sum("roomsCreated")} salons créés`} />
        <Stat label="Par le relais" value={routed ? `${Math.round((sum("relayMinutes") / routed) * 100)} %` : "—"} hint="Du temps regardé" />
      </section>
      <section class="trends is-wide">
        <Bars title="Comptes actifs" unit="" labels={labels} values={days.map(d => d.activeAccounts)} />
        <Bars title="Temps de diffusion" unit="min" labels={labels} values={days.map(d => d.streamMinutes)} />
        <Bars title="Temps regardé" unit="min" labels={labels} values={days.map(d => d.watchMinutes)} />
        <Bars title="Pic de connexions" unit="" labels={labels} values={days.map(d => d.peakConnections)} />
        <Bars title="Messages" unit="" labels={labels} values={days.map(d => d.messages)} />
        <Bars title="Heures de pointe (UTC)" unit="connexions" labels={hourly.map((_, hour) => `${hour} h`)} values={hourly} />
      </section>
      <section class="columns">
        <div class="card">
          <h2>Diffuseurs</h2>
          {list(data.topStreamers.map(row => ({ id: row.id, name: row.name, value: `${hours(row.streamMinutes)} · ${row.streams}` })), "Personne pour l'instant.")}
        </div>
        <div class="card">
          <h2>Spectateurs</h2>
          {list(data.topViewers.map(row => ({ id: row.id, name: row.name, value: hours(row.watchMinutes) })), "Personne pour l'instant.")}
        </div>
        <div class="card">
          <h2>Salons</h2>
          {list(data.topRooms.map(row => ({ id: row.id, name: row.name, value: hours(row.liveMinutes) })), "Aucun direct pour l'instant.")}
          <h3>Appareils</h3>
          <div class="row-line">
            <span>
              <ArrowDownUp size={13} /> Application
            </span>
            <small>{app + web ? `${Math.round((app / (app + web)) * 100)} %` : "—"}</small>
          </div>
          <div class="row-line">
            <span>
              <ArrowDownUp size={13} /> Site
            </span>
            <small>{app + web ? `${Math.round((web / (app + web)) * 100)} %` : "—"}</small>
          </div>
        </div>
      </section>
    </>
  );
}

interface RuleRow {
  id: string;
  label: string;
  unit: string;
  minutes: number;
  below: boolean;
  limit: number;
  on: boolean;
}

function RuleLine({ rule, onSave }: { rule: RuleRow; onSave: (fields: Record<string, unknown>) => void }) {
  const [limit, setLimit] = useState(String(rule.limit));
  return (
    <div class="row-line rule">
      <label class="tool-check">
        <input type="checkbox" checked={rule.on} onChange={e => onSave({ on: e.currentTarget.checked, limit: rule.limit })} /> {rule.label}
      </label>
      {rule.unit ? (
        <span class="rule-limit">
          <small>{rule.below ? "sous" : "au-dessus de"}</small>
          <input type="number" value={limit} aria-label={`Limite : ${rule.label}`} onInput={e => setLimit(e.currentTarget.value)} onBlur={() => limit !== String(rule.limit) && onSave({ on: rule.on, limit: Number(limit) })} />
          <small>
            {rule.unit}
            {rule.minutes ? `, ${rule.minutes} min` : ""}
          </small>
        </span>
      ) : (
        <small>{rule.minutes ? `après ${rule.minutes} min` : "tout de suite"}</small>
      )}
    </div>
  );
}

export function AlertsPage() {
  const { data, error, refresh } = usePolled<{ active: AlertRow[]; history: AlertRow[]; rules: RuleRow[]; discord: boolean }>("alerts");
  const { note, problem, run } = useAction(refresh);
  const [url, setUrl] = useState("");
  if (!data) return <p class="empty">{error || "Chargement…"}</p>;
  return (
    <div class="list">
      <Note note={note} problem={problem} />
      <section class="card">
        <h2>
          <Bell size={16} /> En cours
        </h2>
        {data.active.length === 0 ? (
          <p class="muted">Aucune alerte.</p>
        ) : (
          data.active.map(alert => (
            <div key={alert.id} class="row-line is-critical">
              <span>
                <AlertTriangle size={14} /> {alert.label}
                {alert.unit ? ` : ${number(alert.value, 1)} ${alert.unit} (limite ${alert.limit})` : ""}
              </span>
              <small>depuis {date(alert.startedAt)}</small>
            </div>
          ))
        )}
      </section>
      {can("owner") && (
        <section class="card">
          <h2>Prévenir sur Discord</h2>
          <p class="muted">
            {data.discord ? "Branché : chaque alerte et chaque retour à la normale y arrivent." : "Colle l'adresse d'un webhook : Modifier le salon, Intégrations, Webhooks."} Rien d'autre que le texte de l'alerte n'est envoyé.
          </p>
          <div class="tool-row">
            <input value={url} placeholder="https://discord.com/api/webhooks/…" aria-label="Adresse du webhook Discord" onInput={e => setUrl(e.currentTarget.value)} />
            <button type="button" disabled={!url.trim()} onClick={() => (run("setDiscord", { url: url.trim() }, "Discord branché."), setUrl(""))}>
              Enregistrer
            </button>
            {data.discord && (
              <>
                <button type="button" onClick={() => run("testDiscord", {}, "Essai envoyé.")}>
                  Envoyer un essai
                </button>
                <button type="button" onClick={() => run("setDiscord", { url: "" }, "Discord débranché.")}>
                  Débrancher
                </button>
              </>
            )}
          </div>
        </section>
      )}
      <section class="card">
        <h2>Règles</h2>
        <p class="muted">Une alerte ne part qu'après avoir tenu le temps indiqué : un pic d'une seconde n'est pas un incident.</p>
        {data.rules.map(rule => (
          <RuleLine key={`${rule.id}${rule.limit}${rule.on}`} rule={rule} onSave={fields => can("admin") && run("setRule", { rule: rule.id, ...fields }, "Règle enregistrée.")} />
        ))}
      </section>
      <section class="card">
        <h2>Historique</h2>
        {data.history.length === 0 && <p class="muted">Rien pour l'instant.</p>}
        {data.history.slice(0, 60).map(alert => (
          <div key={alert.id} class="row-line">
            <span>{alert.label}</span>
            <small>
              {date(alert.startedAt)} {alert.endedAt ? `· ${span((alert.endedAt - alert.startedAt) / 1000)}` : "· en cours"}
            </small>
          </div>
        ))}
      </section>
    </div>
  );
}
