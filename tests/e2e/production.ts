// Essai sur le vrai serveur, vidéo forcée par le relais TURN : PC → VPS → PC, le chemin de deux amis derrière leurs box.
//   npm run build && npm run test:production
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { _electron as electron } from "playwright";
import type { ElectronApplication, Page } from "playwright";

const root = path.resolve(import.meta.dirname, "../..");
const temp = mkdtempSync(path.join(tmpdir(), "spokastream-prod-"));
const electronPath = createRequire(import.meta.url)("electron") as unknown as string;
const serverUrl = process.env.SPOKASTREAM_SERVER ?? "wss://stream.chretieno.fr/ws";
const wait = (ms: number) => new Promise(r => setTimeout(r, ms));

async function launch(name: string): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electron.launch({
    executablePath: electronPath,
    args: [root],
    env: { ...process.env, SPOKASTREAM_USER_DATA: path.join(temp, name), SPOKASTREAM_SERVER: serverUrl, SPOKASTREAM_FORCE_RELAY: "1" },
  });
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

const pattern = spawn(electronPath, [path.join(root, "tests", "e2e", "pattern", "main.cjs")], { env: { ...process.env, SPOKASTREAM_PATTERN_DATA: temp }, stdio: "ignore" });
await wait(1500);
const a = await launch("Essai A");
const b = await launch("Essai B");
let failed = false;

try {
  await a.page.locator(".home-card-primary").click();
  await a.page.getByPlaceholder("La soirée film, Les potes…").fill("Essai automatique");
  await a.page.getByRole("button", { name: "Créer le salon" }).click();
  await a.page.locator(".stage-empty").waitFor();
  const code = (await a.page.locator(".room-code").textContent())!.trim();
  const ice: string = await a.page.evaluate(() => JSON.stringify((window as any).__store.useApp.getState().iceServers.map((s: any) => s.urls)));
  assert.match(ice, /turn:/, "le serveur doit donner un relais");
  await b.page.getByLabel("Code du salon").fill(code);
  await b.page.getByRole("button", { name: "Rejoindre", exact: true }).click();
  await b.page.locator(".room-head h1").waitFor();
  console.log(`salon ${code} sur ${serverUrl}`);

  await a.page.getByRole("button", { name: "Diffuser", exact: true }).click();
  await a.page.getByRole("tab", { name: "Fenêtres" }).click();
  await a.page.locator(".source-card", { hasText: "Mire SpokaStream" }).click();
  await a.page.getByRole("button", { name: "Lancer le stream" }).click();
  await a.page.locator(".titlebar-live").waitFor({ timeout: 60_000 });

  const stats: any = await poll(
    "image par le relais",
    () => b.page.evaluate(() => Object.values<any>((window as any).__store.useApp.getState().subs)[0]?.stats ?? null),
    s => !!s && s.fps > 30 && s.kbps > 100 && !!s.path,
    45_000,
  );
  assert.equal(stats.path.relay, true, `la vidéo doit passer par le relais : ${JSON.stringify(stats.path)}`);
  await wait(6000);
  const settled: any = await b.page.evaluate(() => Object.values<any>((window as any).__store.useApp.getState().subs)[0]?.stats);
  const level: number = await b.page.evaluate(() => {
    const w = window as any;
    return w.__core.streamLevel(Object.keys(w.__store.useApp.getState().subs)[0]);
  });
  assert.ok(level > 0.1, `le son doit arriver, niveau ${level}`);
  console.log(`par le relais ${settled.path.protocol} : ${settled.width}x${settled.height}, ${settled.fps} i/s, ${settled.kbps} kb/s, ${settled.codec}, aller-retour ${settled.path.rttMs} ms, pertes ${settled.lostPct} %, gels ${settled.freezes}, son ${Math.round(level * 100)} %`);

  await b.page.getByRole("textbox", { name: "Message", exact: true }).fill("Reçu par le vrai serveur");
  await b.page.keyboard.press("Enter");
  await poll(
    "message reçu",
    () => a.page.evaluate(() => (window as any).__store.useApp.getState().room.history.some((m: { text: string }) => m.text === "Reçu par le vrai serveur") as boolean),
    Boolean,
    10_000,
  );
  // Le lecteur YouTube vit sur le vrai serveur : c'est ici que son origine compte.
  await a.page.evaluate(() => (window as any).__core.togetherAdd("https://www.youtube.com/watch?v=aqz-KE-bpKQ"));
  await b.page.locator(".tile-together").waitFor({ timeout: 15_000 });
  const position = (peer: typeof a) => peer.page.locator(".together-seek").evaluate((i: HTMLInputElement) => Number(i.value));
  await poll("lecture YouTube", () => position(b), t => t > 3, 40_000);
  console.log(`YouTube ensemble : positions ${await position(a)} et ${await position(b)}`);

  await a.page.evaluate(() => (window as any).__core.deleteRoom());
  await wait(500);
  console.log("salon d'essai supprimé");
} catch (e) {
  failed = true;
  console.error(e);
} finally {
  await a.app.close().catch(() => {});
  await b.app.close().catch(() => {});
  pattern.kill();
  await wait(500);
  rmSync(temp, { recursive: true, force: true, maxRetries: 3 });
}
console.log(failed ? "ÉCHEC" : "RÉUSSI");
process.exit(failed ? 1 : 0);
