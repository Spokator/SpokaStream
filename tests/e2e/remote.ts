// Le PC diffuse, le téléphone le pilote, l'administrateur surveille : une vraie application, un téléphone émulé et le vrai panneau.
//   npm run test:remote
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { _electron as electron, chromium, devices } from "playwright";
import type { Browser, ElectronApplication, Page } from "playwright";
import { startServer } from "../../server/index.ts";
import { MemoryStore } from "../../server/store.ts";

const root = path.resolve(import.meta.dirname, "../..");
const captures = path.join(root, "tests", "captures");
mkdirSync(captures, { recursive: true });
const temp = mkdtempSync(path.join(tmpdir(), "spokastream-remote-"));
const electronPath = createRequire(import.meta.url)("electron") as unknown as string;
const STEP_LIMIT_MS = 120_000;

const server = await startServer({ port: 0, host: "127.0.0.1", store: new MemoryStore() });
const base = `http://127.0.0.1:${server.port}`;
const wait = (ms: number) => new Promise(r => setTimeout(r, ms));

async function poll<T>(label: string, read: () => Promise<T>, ok: (v: T) => boolean, timeoutMs = 15_000) {
  const end = Date.now() + timeoutMs;
  let last: T | undefined;
  while (Date.now() < end) {
    last = await read();
    if (ok(last)) return last;
    await wait(200);
  }
  throw new Error(`${label} : délai dépassé, dernière valeur ${JSON.stringify(last)}`);
}

let passed = 0;
async function step(name: string, fn: () => Promise<string | void>) {
  console.log(`… ${name}`);
  let limit: ReturnType<typeof setTimeout> | undefined;
  const detail = await Promise.race([fn(), new Promise<never>((_, reject) => (limit = setTimeout(() => reject(new Error("étape bloquée")), STEP_LIMIT_MS)))]).finally(() => clearTimeout(limit));
  passed++;
  console.log(`  ✔ ${detail ?? ""}`);
}

const shot = (page: Page, name: string) => page.screenshot({ path: path.join(captures, `${name}.png`), timeout: 12_000 });

let app: ElectronApplication | undefined;
let edge: Browser | undefined;
let failed = false;

try {
  app = await electron.launch({
    executablePath: electronPath,
    args: [root, "--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"],
    env: { ...process.env, SPOKASTREAM_USER_DATA: path.join(temp, "pc"), SPOKASTREAM_SERVER: `ws://127.0.0.1:${server.port}/ws`, SPOKASTREAM_NO_NATIVE: "1" },
  });
  const child = app.process();
  const pc = await app.firstWindow();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(1360, 860));
  await pc.getByPlaceholder("Comment tes amis te voient").fill("Spoka");
  await pc.getByRole("button", { name: "C'est parti" }).click();
  await pc.getByText("Connecté à").waitFor();

  edge = await chromium.launch({ channel: "msedge", args: ["--autoplay-policy=no-user-gesture-required"] });
  const context = await edge.newContext({ ...devices["Pixel 7"] });
  const phone = await context.newPage();
  const remote = () => phone.evaluate(() => (document.querySelector(".regie") ? "ouverte" : ""));
  const publish = () => pc.evaluate(() => (window as any).__store.useApp.getState().publish);

  await step("lier le téléphone : QR code, même profil, salons conservés", async () => {
    await pc.evaluate(() => (window as any).__store.useApp.setState({ view: "settings", settingsSection: "account" }));
    await pc.getByRole("button", { name: "Lier mon téléphone" }).click();
    const code = (await pc.locator(".link-panel code").textContent())!.trim();
    await shot(pc, "60-lier-un-telephone");
    await phone.goto(`${base}/link/${code}`);
    await phone.getByText("Ce téléphone est lié").or(phone.locator(".notice")).first().waitFor({ state: "attached", timeout: 10_000 }).catch(() => {});
    const accounts = async () => [await pc.evaluate(() => (window as any).__store.useApp.getState().accountId), await phone.evaluate(() => localStorage.getItem("spoka-name"))];
    const [, name] = await poll("profil repris", accounts, ([, n]) => n === "Spoka");
    await poll("appareil listé", () => pc.locator(".device-line").count(), n => n === 2, 8000);
    await shot(pc, "61-mes-appareils");
    return `téléphone devenu ${name}`;
  });

  await step("le PC diffuse : le téléphone voit la régie dès l'accueil", async () => {
    await pc.evaluate(() => (window as any).__store.useApp.setState({ view: "home" }));
    await pc.locator(".home-card-primary").click();
    await pc.getByPlaceholder("La soirée film, Les potes…").fill("Soirée");
    await pc.getByRole("button", { name: "Créer le salon" }).click();
    await pc.locator(".room-code").waitFor();
    await pc.getByRole("button", { name: "Diffuser", exact: true }).click();
    await pc.getByRole("tab", { name: "Caméra" }).click();
    await pc.locator(".device-row").first().click();
    await pc.getByRole("button", { name: "Lancer le stream" }).click();
    await pc.locator(".tile-own").waitFor({ timeout: 30_000 });
    await phone.locator(".remote-card").waitFor({ timeout: 10_000 });
    await shot(phone, "62-telephone-accueil-regie");
    await phone.locator(".remote-card").click();
    await poll("régie ouverte", remote, v => v === "ouverte");
    assert.equal(await pc.locator(".tile-own").count(), 1, "le PC reste dans son salon");
    await wait(1200);
    assert.equal(await phone.locator("#video").evaluate((v: HTMLVideoElement) => (v.srcObject as MediaStream | null)?.getTracks().length ?? 0), 0, "le téléphone n'ouvre pas son propre stream tout seul");
    await shot(phone, "63-telephone-regie");
  });

  await step("chaque geste du téléphone agit sur le PC", async () => {
    await phone.getByRole("button", { name: "Pause", exact: true }).click();
    await poll("pause", publish, p => p.paused === true);
    await phone.getByRole("button", { name: "Reprendre", exact: true }).click();
    await poll("reprise", publish, p => p.paused === false);

    await phone.locator(".regie-chips button").first().click();
    await poll("écran d'attente", publish, p => p.paused === true && !!p.screen);
    await phone.getByRole("button", { name: "Reprendre", exact: true }).click();
    await poll("fin de l'écran", publish, p => p.paused === false);

    await phone.getByLabel("Titre du stream").fill("Depuis le téléphone");
    await phone.getByLabel("Bandeau à l'image").click();
    await poll("titre", publish, p => p.title === "Depuis le téléphone");
    await phone.getByLabel("Bandeau à l'image").fill("Pause dans 5 minutes");
    await phone.getByLabel("Titre du stream").click();
    await poll("bandeau", publish, p => p.banner === "Pause dans 5 minutes");

    await phone.getByRole("button", { name: "Marqueur" }).click();
    await poll("marqueur", () => pc.evaluate(() => (window as any).__store.useApp.getState().activity.some((a: any) => a.kind === "marker")), v => v);
    await phone.getByRole("button", { name: "Micro", exact: true }).click();
    await poll("micro", () => pc.evaluate(() => (window as any).__store.useApp.getState().muted), v => v === true);
    await phone.getByRole("button", { name: "Micro coupé" }).click();
    return "pause, écran d'attente, titre, bandeau, marqueur, micro";
  });

  await step("le panneau admin : billet, chiffres réels, actions", async () => {
    const accountId = await pc.evaluate(() => (window as any).__store.useApp.getState().accountId);
    (server.hub as any).admins.add(accountId);
    const ticket = await pc.evaluate(() => (window as any).__core.signal.request({ t: "admin.ticket" }).then((r: { ticket: string }) => r.ticket));
    const browser = await edge!.newContext({ viewport: { width: 1360, height: 860 } });
    const admin = await browser.newPage();
    const errors: string[] = [];
    admin.on("pageerror", e => errors.push(String(e)));
    // Le 401 est attendu : la page demande d'abord si une session existe déjà.
    admin.on("console", m => m.type() === "error" && !m.text().includes("401") && errors.push(m.text()));
    await admin.goto(`${base}/admin#t=${ticket}`);
    await admin.getByRole("heading", { name: "Vue d'ensemble" }).waitFor();
    assert.equal(admin.url().includes("#t="), false, "le billet ne reste pas dans l'adresse");
    await admin.locator(".stat", { hasText: "En direct" }).locator("b").filter({ hasText: "1" }).waitFor();
    await shot(admin, "64-admin-vue-ensemble");

    await admin.getByRole("button", { name: "Salons" }).click();
    await admin.getByRole("heading", { name: "Soirée" }).waitFor();
    await shot(admin, "65-admin-salons");
    await admin.getByRole("button", { name: "Comptes" }).click();
    await admin.getByText("Spoka").first().waitFor();
    await shot(admin, "66-admin-comptes");
    await admin.getByRole("button", { name: "Journal" }).click();
    await admin.getByText("lance un stream").first().waitFor();
    await shot(admin, "67-admin-journal");

    await pc.evaluate(() => (window as any).__core.sendFeedback("Le son coupe parfois"));
    await admin.getByRole("button", { name: "Retours" }).click();
    await admin.getByText("Le son coupe parfois").waitFor({ timeout: 8000 });
    await shot(admin, "68-admin-retours");

    await admin.getByRole("button", { name: "Serveur" }).click();
    await admin.getByLabel("Texte de l'annonce").fill("Mise à jour dans 5 minutes");
    await admin.getByRole("button", { name: "Envoyer" }).click();
    await pc.getByText("Mise à jour dans 5 minutes").first().waitFor({ timeout: 8000 });
    await phone.locator(".notice", { hasText: "Mise à jour dans 5 minutes" }).waitFor({ timeout: 8000 });
    await shot(admin, "69-admin-serveur");

    await admin.getByRole("button", { name: "Salons" }).click();
    await admin.getByRole("button", { name: "Arrêter le stream de Spoka" }).click();
    await poll("stream coupé par l'admin", () => phone.locator(".regie").count().then(async () => (await server.hub.stats).streams), n => n === 0, 10_000);
    assert.deepEqual(errors, []);

    const mobile = await browser.newPage();
    await mobile.setViewportSize({ width: 390, height: 800 });
    await mobile.goto(`${base}/admin`);
    await mobile.getByRole("heading", { name: "Vue d'ensemble" }).waitFor();
    assert.ok(await mobile.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "le panneau déborde sur un téléphone");
    await shot(mobile, "70-admin-telephone");

    await admin.getByRole("button", { name: "Se déconnecter" }).click();
    await admin.getByRole("heading", { name: "Panneau d'administration" }).waitFor();
    return "billet à usage unique, journal, retour reçu, annonce, stream coupé";
  });

  await step("un téléphone lié à l'administrateur ouvre le panneau sans billet", async () => {
    const page = await context.newPage();
    await page.goto(`${base}/admin`);
    await page.getByRole("heading", { name: "Vue d'ensemble" }).waitFor();
  });

  console.log(`${passed} étapes réussies`);
  await Promise.race([app.close().catch(() => {}), wait(10_000)]);
  child.kill();
} catch (e) {
  failed = true;
  console.log(`  ✖ ${e}`);
  if (app) {
    const child = app.process();
    await Promise.race([app.close().catch(() => {}), wait(8000)]);
    child.kill();
  }
} finally {
  await edge?.close().catch(() => {});
  await server.close();
  rmSync(temp, { recursive: true, force: true, maxRetries: 4 });
}
process.exit(failed ? 1 : 0);
