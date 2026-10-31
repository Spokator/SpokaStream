import path from "node:path";
import { Accounts } from "./accounts.ts";
import { startServer } from "./index.ts";
import { PushService } from "./push.ts";
import { JsonStore } from "./store.ts";

const env = process.env;
const dataFile = path.resolve(env.DATA_FILE ?? "data/rooms.json");
const store = new JsonStore(dataFile);
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
  admins: (env.ADMIN_ACCOUNTS ?? "").split(",").map(id => id.trim()).filter(Boolean),
  dataDir: path.dirname(dataFile),
  canRestart: !!env.INVOCATION_ID,
});
console.log(`SpokaStream : serveur prêt sur le port ${running.port}${env.TURN_HOST ? `, relais ${env.TURN_HOST}` : ", sans relais TURN"}`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => void running.close().then(() => process.exit(0)));
}
