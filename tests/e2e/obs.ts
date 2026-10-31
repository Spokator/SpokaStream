// Le vrai OBS, dans une copie isolée : ni sa configuration ni ses scènes ne sont touchées.
//   npm run test:obs
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { _electron as electron } from "playwright";
import type { ElectronApplication, Page } from "playwright";
import { startServer } from "../../server/index.ts";
import { MemoryStore } from "../../server/store.ts";

const root = path.resolve(import.meta.dirname, "../..");
const installed = process.env.OBS_DIR ?? "C:\\Program Files\\obs-studio";
if (!existsSync(installed)) {
  console.log("OBS n'est pas installé : essai ignoré.");
  process.exit(0);
}

const OBS_ARGS = ["--portable", "--multi", "--minimize-to-tray", "--disable-updater", "--disable-shutdown-check"];
const temp = mkdtempSync(path.join(tmpdir(), "spokastream-obs-"));
const electronPath = createRequire(import.meta.url)("electron") as unknown as string;
const wait = (ms: number) => new Promise(r => setTimeout(r, ms));
const server = await startServer({ port: 0, host: "127.0.0.1", store: new MemoryStore() });
const serverUrl = `ws://127.0.0.1:${server.port}/ws`;

async function launch(name: string): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electron.launch({ executablePath: electronPath, args: [root], env: { ...process.env, SPOKASTREAM_USER_DATA: path.join(temp, name), SPOKASTREAM_SERVER: serverUrl } });
  const page = await app.firstWindow();
  await page.getByPlaceholder("Comment tes amis te voient").fill(name);
  await page.getByRole("button", { name: "C'est parti" }).click();
  await page.getByText("Connecté à").waitFor({ timeout: 15_000 });
  return { app, page };
}

async function poll<T>(label: string, read: () => Promise<T>, ok: (v: T) => boolean, timeoutMs = 30_000) {
  const end = Date.now() + timeoutMs;
  let last: T | undefined;
  while (Date.now() < end) {
    last = await read();
    if (ok(last)) return last;
    await wait(300);
  }
  throw new Error(`${label} : délai dépassé, dernière valeur ${JSON.stringify(last)}`);
}

/** Une copie portable d'OBS, réglée sur l'entrée WHIP de l'application. */
async function prepareObs(url: string, key: string) {
  const dir = path.join(temp, "obs");
  cpSync(installed, dir, { recursive: true });
  writeFileSync(path.join(dir, "portable_mode.txt"), "");
  const bin = path.join(dir, "bin", "64bit");
  const basic = path.join(dir, "config", "obs-studio", "basic");
  // Une configuration écrite à la main bloque OBS au démarrage : il crée la sienne, on n'y change que le service.
  const first = spawn(path.join(bin, "obs64.exe"), OBS_ARGS, { cwd: bin, stdio: "ignore" });
  await poll("configuration d'OBS", async () => existsSync(path.join(basic, "scenes")) && readdirSync(path.join(basic, "scenes")).length > 0, Boolean, 30_000);
  await wait(3000);
  first.kill();
  await wait(1500);
  const profile = path.join(basic, "profiles", readdirSync(path.join(basic, "profiles"))[0]!);
  writeFileSync(path.join(profile, "service.json"), JSON.stringify({ type: "whip_custom", settings: { server: url, bearer_token: key } }));
  // Sans ça, l'essai capterait le micro et le son du PC.
  for (const file of readdirSync(path.join(basic, "scenes")).filter(f => f.endsWith(".json"))) {
    const scenes = JSON.parse(readFileSync(path.join(basic, "scenes", file), "utf8").replace(/^\ufeff/, "")) as Record<string, unknown>;
    for (const key of Object.keys(scenes)) if (/^(Desktop|Aux)AudioDevice\d$/.test(key)) delete scenes[key];
    writeFileSync(path.join(basic, "scenes", file), JSON.stringify(scenes));
  }
  return bin;
}

let failed = false;
const a = await launch("Diffuseur");
const b = await launch("Spectateur");
let obs: ReturnType<typeof spawn> | undefined;

try {
  await a.page.locator(".home-card-primary").click();
  await a.page.getByPlaceholder("La soirée film, Les potes…").fill("Essai OBS");
  await a.page.getByRole("button", { name: "Créer le salon" }).click();
  await a.page.locator(".stage-empty").waitFor();
  const code = (await a.page.locator(".room-code").textContent())!.trim();
  await b.page.getByLabel("Code du salon").fill(code);
  await b.page.getByRole("button", { name: "Rejoindre", exact: true }).click();
  await b.page.locator(".room-head h1").waitFor();

  const info: { url: string; key: string } = await a.page.evaluate(() => (window as any).spoka.obsInfo());
  assert.ok(info.url, "l'entrée OBS doit écouter");
  assert.equal((await fetch(info.url, { method: "POST", body: "v=0" })).status, 401, "sans la clé, l'entrée refuse");

  const bin = await prepareObs(info.url, info.key);
  obs = spawn(path.join(bin, "obs64.exe"), [...OBS_ARGS, "--startstreaming"], { cwd: bin, stdio: "ignore" });

  await poll("OBS connecté", () => a.page.evaluate(() => (window as any).__store.useApp.getState().obs.connected as boolean), Boolean, 60_000);
  console.log("OBS a démarré le streaming et s'est connecté");
  await a.page.locator(".toast-action", { hasText: "Diffuser" }).click();
  await a.page.locator(".obs-state.is-on").waitFor();
  await a.page.getByRole("button", { name: "Lancer le stream" }).click();
  await a.page.locator(".titlebar-live").waitFor({ timeout: 60_000 });

  const height = await poll("image d'OBS chez le spectateur", () => b.page.evaluate(() => document.querySelector<HTMLVideoElement>(".tile-video")?.videoHeight ?? 0), h => h > 0, 30_000);
  const stats: any = await poll("mesures", () => b.page.evaluate(() => Object.values<any>((window as any).__store.useApp.getState().subs)[0]?.stats ?? null), s => !!s && s.fps > 20, 20_000);
  const mix: string[] = await a.page.evaluate(() => (window as any).__store.useApp.getState().publish.mix.map((m: { label: string }) => m.label));
  assert.ok(mix.includes("OBS"), `le son d'OBS doit être dans la table de mixage : ${mix}`);
  await a.page.screenshot({ path: path.join(root, "tests", "captures", "26-obs-en-direct.png") }).catch(() => {});
  console.log(`image d'OBS reçue : ${stats.width}x${height}, ${stats.fps} i/s, ${stats.codec}, son dans le mixeur`);
} catch (e) {
  failed = true;
  console.error(e);
  await a.page.screenshot({ path: path.join(root, "tests", "captures", "echec-obs.png") }).catch(() => {});
} finally {
  if (obs?.pid) spawnSync("taskkill", ["/PID", String(obs.pid), "/T", "/F"]);
  if (failed) {
    const logs = path.join(temp, "obs", "config", "obs-studio", "logs");
    for (const file of existsSync(logs) ? readdirSync(logs) : []) console.log(readFileSync(path.join(logs, file), "utf8").split(/\r?\n/).filter(l => !/nvenc|^.{14}	|Plugin|.dll|settings|encoder/.test(l)).slice(-30).join(String.fromCharCode(10)));
  }
  await a.app.close().catch(() => {});
  await b.app.close().catch(() => {});
  await server.close();
  await wait(1500);
  rmSync(temp, { recursive: true, force: true, maxRetries: 5 });
}
console.log(failed ? "ÉCHEC" : "RÉUSSI");
process.exit(failed ? 1 : 0);
