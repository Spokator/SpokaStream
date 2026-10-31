import path from "node:path";
import { startServer } from "./index.ts";
import { JsonStore } from "./store.ts";

const env = process.env;
const store = new JsonStore(path.resolve(env.DATA_FILE ?? "data/rooms.json"));
const running = await startServer({
  port: Number(env.PORT ?? 8787),
  host: env.HOST ?? "127.0.0.1",
  store,
  serverName: env.SERVER_NAME,
  turnHost: env.TURN_HOST,
  turnSecret: env.TURN_SECRET,
  trustProxy: env.TRUST_PROXY === "1",
  downloadUrl: env.DOWNLOAD_URL,
});
console.log(`SpokaStream : serveur prêt sur le port ${running.port}${env.TURN_HOST ? `, relais ${env.TURN_HOST}` : ", sans relais TURN"}`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => void running.close().then(() => process.exit(0)));
}
