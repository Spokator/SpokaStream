/** Seau à jetons : rafales courtes permises, débit moyen plafonné. */
export class Bucket {
  private tokens: number;
  private last: number;
  private readonly rate: number;
  private readonly burst: number;
  constructor(rate: number, burst: number, now: number) {
    this.rate = rate;
    this.burst = burst;
    this.tokens = burst;
    this.last = now;
  }
  take(now: number, cost = 1) {
    this.tokens = Math.min(this.burst, this.tokens + ((now - this.last) / 1000) * this.rate);
    this.last = now;
    if (this.tokens < cost) return false;
    this.tokens -= cost;
    return true;
  }
}

/**
 * Le service est bridé à 256 Mo : ces plafonds gardent une marge. Une adresse peut cacher plusieurs personnes
 * (un foyer, un réseau mobile partagé) : ils visent ce qu'une soirée entre amis n'atteint jamais, pas l'usage courant.
 */
export const GUARD = {
  connections: 1000,
  connectionsPerIp: 32,
  /** Reconnexions par seconde et par adresse. */
  opensPerSecond: 2,
  opensBurst: 30,
  /** Un compte toutes les 3 minutes par adresse, et 2 par minute pour tout le serveur. */
  accountsPerSecondByIp: 1 / 180,
  accountsBurstByIp: 8,
  accountsPerSecond: 1 / 30,
  accountsBurst: 60,
  roomsPerSecondByIp: 1 / 60,
  roomsBurstByIp: 10,
  rooms: 3000,
  /** Par connexion : large pour une image collée, trop étroit pour noyer le serveur. */
  bytesPerSecond: 2_000_000,
  bytesBurst: 8_000_000,
  messagesPerSecond: 500,
  messagesBurst: 1500,
  /** Une connexion qui ne se présente pas libère sa place. */
  helloMs: 20_000,
} as const;

const WARN_EVERY_MS = 10 * 60_000;
const FORGET_IP_MS = 60 * 60_000;
const SWEEP_ABOVE = 5000;

interface PerIp {
  open: number;
  opens: Bucket;
  accounts: Bucket;
  rooms: Bucket;
  seen: number;
}

/** Les essais et nginx sans vraie adresse arrivent par la boucle locale : rien à protéger là. */
const isLocal = (ip: string) => ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";

/** Ce qu'une seule machine a le droit de coûter au serveur. Tout est en mémoire : un redémarrage remet les compteurs à zéro. */
export class Guard {
  private readonly perIp = new Map<string, PerIp>();
  private readonly warned = new Map<string, number>();
  private readonly accounts: Bucket;
  private open = 0;

  constructor(now = Date.now()) {
    this.accounts = new Bucket(GUARD.accountsPerSecond, GUARD.accountsBurst, now);
  }

  private of(ip: string, now: number) {
    let row = this.perIp.get(ip);
    if (!row) {
      row = {
        open: 0,
        opens: new Bucket(GUARD.opensPerSecond, GUARD.opensBurst, now),
        accounts: new Bucket(GUARD.accountsPerSecondByIp, GUARD.accountsBurstByIp, now),
        rooms: new Bucket(GUARD.roomsPerSecondByIp, GUARD.roomsBurstByIp, now),
        seen: now,
      };
      this.perIp.set(ip, row);
      if (this.perIp.size > SWEEP_ABOVE) this.sweep(now);
    }
    row.seen = now;
    return row;
  }

  private sweep(now: number) {
    for (const [ip, row] of this.perIp) if (!row.open && now - row.seen > FORGET_IP_MS) this.perIp.delete(ip);
  }

  /** À chaque connexion acceptée doit répondre un release. */
  admit(ip: string, now = Date.now()) {
    if (this.open >= GUARD.connections) return false;
    const row = this.of(ip, now);
    if (!isLocal(ip) && (row.open >= GUARD.connectionsPerIp || !row.opens.take(now))) return false;
    row.open++;
    this.open++;
    return true;
  }

  release(ip: string) {
    const row = this.perIp.get(ip);
    if (row) row.open = Math.max(0, row.open - 1);
    this.open = Math.max(0, this.open - 1);
  }

  allowAccount(ip: string, now = Date.now()) {
    if (isLocal(ip)) return true;
    return this.of(ip, now).accounts.take(now) && this.accounts.take(now);
  }

  allowRoom(ip: string, now = Date.now()) {
    return isLocal(ip) || this.of(ip, now).rooms.take(now);
  }

  /** Vrai une fois toutes les 10 minutes par sujet : un abus ne doit pas noyer le journal qui le signale. */
  shouldWarn(topic: string, now = Date.now()) {
    if (now - (this.warned.get(topic) ?? -Infinity) < WARN_EVERY_MS) return false;
    this.warned.set(topic, now);
    return true;
  }
}
