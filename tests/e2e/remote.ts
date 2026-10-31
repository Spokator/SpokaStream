// Le PC diffuse, le téléphone le pilote, l'administrateur surveille : une vraie application, un téléphone émulé et le vrai panneau.
//   npm run test:remote
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { _electron as electron, chromium, devices } from "playwright";
import type { Browser, ElectronApplication, Page } from "playwright";
import type { AdminAuth } from "../../server/adminAuth.ts";
import { totpCode } from "../../server/adminAuth.ts";
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

    return "billet à usage unique, journal, retour reçu, annonce, stream coupé";
  });

  await step("identifiant et mot de passe, sans l'application, puis code à 6 chiffres", async () => {
    const auth = (server as any).admin.auth as AdminAuth;
    const setup = await context.browser()!.newContext({ viewport: { width: 1360, height: 860 } });
    const page = await setup.newPage();
    await page.goto(`${base}/admin`);
    await page.getByText("L'accès n'a pas encore été créé").waitFor();

    await page.goto(`${base}/admin#setup=${auth.ownerInvite()}`);
    await page.reload();
    await page.getByRole("heading", { name: "Crée ton accès" }).waitFor();
    assert.equal(page.url().includes("setup="), false, "le lien ne reste pas dans l'adresse");
    await shot(page, "71-admin-creer-acces");
    await page.getByLabel("Identifiant").fill("spoka");
    await page.getByLabel("Mot de passe (12 caractères ou plus)").fill("un-long-mot-de-passe");
    await page.getByLabel("Encore une fois").fill("un-long-mot-de-passe");
    await page.getByRole("button", { name: "Créer mon accès" }).click();
    await page.getByRole("heading", { name: "Vue d'ensemble" }).waitFor();

    await page.getByRole("button", { name: "Sécurité" }).click();
    await page.locator(".card", { hasText: "Conseillé" }).getByRole("button", { name: "Activer" }).click();
    const secret = (await page.locator(".enrol code").textContent())!.trim();
    await shot(page, "72-admin-code-6-chiffres");
    const counter = Math.floor(Date.now() / 30_000);
    await page.getByLabel("Le code affiché par l'application").fill(totpCode(secret, counter));
    await page.getByRole("button", { name: "Activer" }).click();
    await page.locator(".recovery").waitFor();
    await shot(page, "73-admin-codes-de-secours");
    await page.getByRole("button", { name: "C'est noté" }).click();

    await page.getByRole("button", { name: "Se déconnecter" }).click();
    await page.getByLabel("Identifiant").waitFor();
    await shot(page, "74-admin-connexion");
    await page.getByLabel("Identifiant").fill("spoka");
    await page.getByLabel("Mot de passe").fill("mauvais-mot-de-passe");
    await page.getByRole("button", { name: "Se connecter" }).click();
    await page.getByRole("alert").waitFor();
    await page.getByLabel("Mot de passe").fill("un-long-mot-de-passe");
    await page.getByRole("button", { name: "Se connecter" }).click();
    await page.getByLabel("Code à 6 chiffres, ou code de secours").fill(totpCode(secret, counter + 1));
    await page.getByRole("button", { name: "Se connecter" }).click();
    await page.getByRole("heading", { name: "Vue d'ensemble" }).waitFor();

    await page.getByRole("button", { name: "Administrateurs" }).click();
    await page.getByLabel("Identifiant du nouvel accès").fill("modo");
    await page.getByRole("button", { name: "Créer le lien" }).click();
    const invite = await page.getByLabel("Lien à usage unique").inputValue();
    await shot(page, "75-admin-acces");
    const modContext = await context.browser()!.newContext({ viewport: { width: 1360, height: 860 } });
    const modo = await modContext.newPage();
    await modo.goto(invite);
    await modo.getByRole("heading", { name: "Crée ton accès" }).waitFor();
    assert.equal(await modo.getByLabel("Identifiant").inputValue(), "modo");
    await modo.getByLabel("Mot de passe (12 caractères ou plus)").fill("un-mot-de-passe-modo");
    await modo.getByLabel("Encore une fois").fill("un-mot-de-passe-modo");
    await modo.getByRole("button", { name: "Créer mon accès" }).click();
    await modo.getByRole("heading", { name: "Vue d'ensemble" }).waitFor();
    assert.equal(await modo.getByRole("button", { name: "Administrateurs" }).count(), 0, "un modérateur ne voit pas les accès");
    assert.equal(await modo.getByRole("button", { name: "Serveur" }).count(), 0);

    await page.getByRole("button", { name: "Comptes" }).click();
    await page.getByRole("button", { name: "Gérer" }).first().click();
    await page.getByLabel("Nouveau pseudo de Spoka").fill("Patron");
    await page.getByRole("button", { name: "Renommer" }).click();
    await page.getByText("Pseudo changé partout.").waitFor();
    await poll("le PC suit", () => pc.evaluate(() => (window as any).__store.useApp.getState().settings.profile.name), name => name === "Patron");
    await page.getByLabel("Message pour Patron").fill("Coucou de l'admin");
    await page.getByRole("button", { name: "Envoyer" }).click();
    await pc.getByText("Coucou de l'admin").first().waitFor({ timeout: 8000 });
    await shot(page, "76-admin-gerer-un-compte");

    await page.getByRole("button", { name: "Journal" }).click();
    await page.getByText("spoka : renomme").first().waitFor();

    const linked = await context.newPage();
    await linked.goto(`${base}/admin`);
    await linked.getByLabel("Identifiant").waitFor();
    return "création, double facteur, reconnexion, invitation d'un modérateur limité par son rôle, compte renommé partout, message, journal";
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
