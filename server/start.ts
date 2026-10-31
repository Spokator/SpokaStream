import path from "node:path";
import { Accounts } from "./accounts.ts";
import { AdminAuth } from "./adminAuth.ts";
import { applyPendingRestore } from "./backups.ts";
import { startServer } from "./index.ts";
import { PushService } from "./push.ts";
import { JsonStore } from "./store.ts";

const env = process.env;
const dataFile = path.resolve(env.DATA_FILE ?? "data/rooms.json");
// Avant toute lecture : une restauration demandée depuis le panneau remet les fichiers ici.
const restored = applyPendingRestore(path.dirname(dataFile));
if (restored) console.log(`SpokaStream : sauvegarde ${restored} restaurée`);
const store = new JsonStore(dataFile);
const admins = (env.ADMIN_ACCOUNTS ?? "").split(",").map(id => id.trim()).filter(Boolean);
const adminAuth = new AdminAuth(path.join(path.dirname(dataFile), "admin-auth.json"));

// La porte de secours : un lien à usage unique pour créer ou remplacer l'accès au panneau, sans toucher au serveur qui tourne.
if (process.argv.includes("--admin-setup")) {
  console.log(`/admin#setup=${adminAuth.ownerInvite(admins[0])}`);
  process.exit(0);
}

const running = await startServer({
  port: Number(env.PORT ?? 8787),
  host: env.HOST ?? "127.0.0.1",
  store,
  serverName: env.SERVER_NAME,
  turnHost: env.TURN_HOST,
  turnSecret: env.TURN_SECRET,
  trustProxy: env.TRUST_PROXY === "1",
  downloadUrl: env.DOWNLOAD_URL,
  push: new PushService({ file: path.join(path.dirname(dataFile), "push.json") }),
  accounts: new Accounts(path.join(path.dirname(dataFile), "accounts.json")),
  admins,
  dataDir: path.dirname(dataFile),
  canRestart: !!env.INVOCATION_ID,
  adminAuth,
  serviceName: env.INVOCATION_ID ? "spokastream-server" : undefined,
});
console.log(`SpokaStream : serveur prêt sur le port ${running.port}${env.TURN_HOST ? `, relais ${env.TURN_HOST}` : ", sans relais TURN"}`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => void running.close().then(() => process.exit(0)));
}
