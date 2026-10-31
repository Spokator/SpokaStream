// Notifications sur téléphone quand un ami passe en direct, sans dépendance : Web Push tient en deux recettes de chiffrement.
//   RFC 8291 pour le contenu, que seul le téléphone peut lire, RFC 8292 pour prouver au service de push qui parle.
import { createCipheriv, createECDH, createPrivateKey, generateKeyPairSync, hkdfSync, randomBytes, sign } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

const MAX_SUBSCRIPTIONS = 5000;
const PER_USER = 6;
const TTL_SECONDS = 1800;
/** Un stream relancé plusieurs fois de suite ne doit pas faire vibrer les téléphones à chaque essai. */
const SAME_EVENT_MS = 10 * 60_000;
/** Le serveur n'envoie qu'aux services de push des navigateurs : l'adresse vient du client, il ne faut pas s'en servir pour joindre autre chose. */
const PUSH_HOSTS = [/(^|\.)googleapis\.com$/, /(^|\.)push\.apple\.com$/, /(^|\.)notify\.windows\.com$/, /(^|\.)mozilla\.com$/];

export interface PushRecord {
  endpoint: string;
  p256dh: string;
  auth: string;
  userId: string;
  rooms: string[];
}

interface PushData {
  publicKey: string;
  privateKey: string;
  subscriptions: PushRecord[];
}

export interface PushMessage {
  title: string;
  body: string;
  url: string;
  tag: string;
}

export interface PushOptions {
  /** Absent : rien n'est gardé sur disque. */
  file?: string;
  contact?: string;
  /** Pour les essais : un faux service de push local. */
  allowHost?: (host: string) => boolean;
}

const hkdf = (salt: Buffer, secret: Buffer, info: string | Buffer, length: number) => Buffer.from(hkdfSync("sha256", secret, salt, info, length));

/** Le contenu en aes128gcm : le service de push le transporte sans pouvoir le lire. */
export function encryptPush(payload: Buffer, p256dh: string, auth: string) {
  const receiver = Buffer.from(p256dh, "base64url");
  const ecdh = createECDH("prime256v1");
  const sender = ecdh.generateKeys();
  const salt = randomBytes(16);
  const secret = hkdf(Buffer.from(auth, "base64url"), ecdh.computeSecret(receiver), Buffer.concat([Buffer.from("WebPush: info\0"), receiver, sender]), 32);
  const key = hkdf(salt, secret, "Content-Encoding: aes128gcm\0", 16);
  const nonce = hkdf(salt, secret, "Content-Encoding: nonce\0", 12);
  const cipher = createCipheriv("aes-128-gcm", key, nonce);
  const sealed = Buffer.concat([cipher.update(payload), cipher.update(Buffer.from([2])), cipher.final(), cipher.getAuthTag()]);
  const header = Buffer.alloc(21);
  salt.copy(header);
  header.writeUInt32BE(4096, 16);
  header[20] = sender.length;
  return Buffer.concat([header, sender, sealed]);
}

function createKeys() {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const jwk = publicKey.export({ format: "jwk" });
  return {
    publicKey: Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x!, "base64url"), Buffer.from(jwk.y!, "base64url")]).toString("base64url"),
    privateKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  };
}

export class PushService {
  private readonly data: PushData;
  private readonly file?: string;
  private readonly contact: string;
  private readonly allowHost: (host: string) => boolean;
  private readonly recent = new Map<string, number>();

  constructor(options: PushOptions = {}) {
    this.file = options.file;
    this.contact = options.contact ?? "https://github.com/Spokator/SpokaStream";
    this.allowHost = options.allowHost ?? (host => PUSH_HOSTS.some(pattern => pattern.test(host)));
    this.data = this.read() ?? { ...createKeys(), subscriptions: [] };
    this.persist();
  }

  private read(): PushData | null {
    if (!this.file) return null;
    try {
      return JSON.parse(readFileSync(this.file, "utf8")) as PushData;
    } catch {
      return null;
    }
  }

  private persist() {
    if (!this.file) return;
    mkdirSync(path.dirname(this.file), { recursive: true });
    const temporary = `${this.file}.tmp`;
    writeFileSync(temporary, JSON.stringify(this.data), { mode: 0o600 });
    renameSync(temporary, this.file);
  }

  get publicKey() {
    return this.data.publicKey;
  }

  /** Rend false pour une adresse qui n'est pas celle d'un service de push. */
  subscribe(record: PushRecord) {
    let host = "";
    try {
      const url = new URL(record.endpoint);
      host = url.protocol === "https:" || this.file === undefined ? url.hostname : "";
    } catch {
      return false;
    }
    if (!host || !this.allowHost(host) || !record.p256dh || !record.auth) return false;
    const list = this.data.subscriptions.filter(s => s.endpoint !== record.endpoint);
    const mine = list.filter(s => s.userId === record.userId);
    const dropped = mine.length >= PER_USER ? mine[0] : null;
    this.data.subscriptions = [...list.filter(s => s !== dropped), record].slice(-MAX_SUBSCRIPTIONS);
    this.persist();
    return true;
  }

  unsubscribe(endpoint: string) {
    const before = this.data.subscriptions.length;
    this.data.subscriptions = this.data.subscriptions.filter(s => s.endpoint !== endpoint);
    if (this.data.subscriptions.length !== before) this.persist();
  }

  /** Prévient chaque téléphone abonné à ce salon, sauf ceux qui y sont déjà et l'auteur de l'événement. */
  notify(roomId: string, except: Set<string>, event: string, message: PushMessage, now = Date.now()) {
    const key = `${roomId}:${event}`;
    const last = this.recent.get(key);
    if (last !== undefined && now - last < SAME_EVENT_MS) return Promise.resolve(0);
    if (this.recent.size > 2000) this.recent.clear();
    this.recent.set(key, now);
    const targets = this.data.subscriptions.filter(s => s.rooms.includes(roomId) && !except.has(s.userId));
    return Promise.all(targets.map(target => this.send(target, message))).then(() => targets.length);
  }

  private authorization(endpoint: string) {
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const body = `${encode({ typ: "JWT", alg: "ES256" })}.${encode({ aud: new URL(endpoint).origin, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: this.contact })}`;
    const signature = sign("sha256", Buffer.from(body), { key: createPrivateKey(this.data.privateKey), dsaEncoding: "ieee-p1363" });
    return `vapid t=${body}.${signature.toString("base64url")}, k=${this.data.publicKey}`;
  }

  private async send(target: PushRecord, message: PushMessage) {
    const response = await fetch(target.endpoint, {
      method: "POST",
      headers: { authorization: this.authorization(target.endpoint), ttl: String(TTL_SECONDS), urgency: "high", "content-encoding": "aes128gcm", "content-type": "application/octet-stream" },
      body: encryptPush(Buffer.from(JSON.stringify(message)), target.p256dh, target.auth),
      signal: AbortSignal.timeout(8000),
    }).catch(() => null);
    // 404 et 410 : le téléphone a retiré l'autorisation.
    if (response?.status === 404 || response?.status === 410) this.unsubscribe(target.endpoint);
  }
}
