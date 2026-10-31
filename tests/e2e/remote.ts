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

const server = await startServer({ port: 0, host: "127.0.0.1", store: new MemoryStore(), dataDir: path.join(temp, "data") });
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
  const publish = () => pc.evaluate(() => (window as any).__store.useApp.getState().publish);

  await step("lier le téléphone : le code va dans le seul champ de l'accueil, les salons et le PC suivent", async () => {
    await pc.locator(".home-card-primary").click();
    await pc.getByPlaceholder("La soirée film, Les potes…").fill("Soirée");
    await pc.getByRole("button", { name: "Créer le salon" }).click();
    await pc.locator(".room-code").waitFor();

    await phone.goto(base);
    const field = phone.getByLabel("Code du salon, ou code de liaison de ton PC");
    await field.fill("ZZZZZZZZ");
    await phone.getByLabel("Ton nom").fill("Moi");
    await phone.getByRole("button", { name: "Continuer" }).click();
    await phone.getByRole("alert").waitFor();
    assert.match((await phone.getByRole("alert").textContent())!, /n'existe pas/);
    await shot(phone, "60-telephone-accueil");

    await pc.evaluate(() => (window as any).__store.useApp.setState({ view: "settings", settingsSection: "account" }));
    await pc.getByRole("button", { name: "Lier mon téléphone" }).click();
    const code = (await pc.locator(".link-panel code").textContent())!.trim();
    await shot(pc, "61-lier-un-telephone");

    // Le cas d'un iPhone : l'icône de l'écran d'accueil ne partage rien avec Safari, le code s'entre à la main.
    await phone.getByLabel("Code du salon, ou code de liaison de ton PC").fill(code);
    await phone.getByRole("button", { name: "Continuer" }).click();
    await phone.locator(".account-head").waitFor();
    await phone.locator(".recent", { hasText: "Soirée" }).waitFor();
    await phone.getByText("Ton PC est en ligne").first().waitFor();
    assert.equal(await phone.evaluate(() => localStorage.getItem("spoka-name")), "Spoka");
    await pc.locator(".link-panel").waitFor({ state: "detached", timeout: 5000 });
    await poll("appareil listé", () => pc.locator(".device-line").count(), n => n === 2, 8000);
    await shot(phone, "62-telephone-lie");
    await shot(pc, "63-mes-appareils");

    const second = await edge!.newContext({ ...devices["Pixel 7"] });
    const viaQr = await second.newPage();
    await pc.getByRole("button", { name: "Lier mon téléphone" }).click();
    const qr = (await pc.locator(".link-panel code").textContent())!.trim();
    await viaQr.goto(`${base}/link/${qr}`);
    await viaQr.locator(".recent", { hasText: "Soirée" }).waitFor();
    await second.close();
    return "le code entré à la main et le QR code mènent au même endroit : salons, nom, PC visible";
  });

  await step("le PC diffuse : la régie s'ouvre en grille de touches, 3×5 debout et 5×3 tourné", async () => {
    await pc.evaluate(() => (window as any).__store.useApp.setState({ view: "room" }));
    await pc.getByRole("button", { name: "Diffuser", exact: true }).click();
    await pc.getByRole("tab", { name: "Caméra" }).click();
    await pc.locator(".device-row").first().click();
    await pc.getByRole("button", { name: "Lancer le stream" }).click();
    await pc.locator(".tile-own").waitFor({ timeout: 30_000 });
    await pc.evaluate(() => (window as any).__core.saveScene("Jeu"));
    await phone.locator(".remote-card:not(.is-idle)").waitFor({ timeout: 10_000 });
    await phone.locator(".remote-card").click();
    await phone.locator(".deck-grid").waitFor();
    await phone.locator(".deck-clock").waitFor();
    assert.equal(await pc.locator(".tile-own").count(), 1, "le PC reste dans son salon");
    await wait(1200);
    assert.equal(await phone.locator("#video").evaluate((v: HTMLVideoElement) => (v.srcObject as MediaStream | null)?.getTracks().length ?? 0), 0, "le téléphone n'ouvre pas son propre stream tout seul");
    const grid = () => phone.evaluate(() => {
      const style = getComputedStyle(document.querySelector(".deck-grid")!);
      const keys = [...document.querySelectorAll(".deck-grid > *")].map(k => k.getBoundingClientRect());
      return { cols: style.gridTemplateColumns.split(" ").length, rows: style.gridTemplateRows.split(" ").length, keys: keys.length, minWidth: Math.min(...keys.map(k => k.width)), minHeight: Math.min(...keys.map(k => k.height)), bottom: Math.max(...keys.map(k => k.bottom)), height: innerHeight, overflow: document.documentElement.scrollWidth > innerWidth };
    });
    const portrait = await grid();
    assert.deepEqual([portrait.cols, portrait.rows, portrait.keys], [3, 5, 15]);
    assert.ok(portrait.minHeight >= 64 && portrait.bottom <= portrait.height, JSON.stringify(portrait));
    await shot(phone, "64-regie-portrait");
    await phone.setViewportSize({ width: 915, height: 412 });
    await wait(300);
    const landscape = await grid();
    assert.deepEqual([landscape.cols, landscape.rows, landscape.keys], [5, 3, 15]);
    assert.ok(landscape.minHeight >= 64 && landscape.minWidth >= 100 && landscape.bottom <= landscape.height && !landscape.overflow, JSON.stringify(landscape));
    await shot(phone, "65-regie-paysage");
    await phone.setViewportSize({ width: 740, height: 360 });
    await wait(300);
    const small = await grid();
    assert.ok(small.minHeight >= 54 && small.bottom <= small.height, JSON.stringify(small));
    await shot(phone, "66-regie-petit-paysage");
    await phone.setViewportSize({ width: 915, height: 412 });
    return `portrait ${Math.round(portrait.minWidth)}×${Math.round(portrait.minHeight)}, paysage ${Math.round(landscape.minWidth)}×${Math.round(landscape.minHeight)} px par touche`;
  });

  await step("chaque touche agit sur le PC et n'affiche que ce qu'il renvoie", async () => {
    const key = (name: string) => phone.getByRole("button", { name, exact: true });
    await key("Pause").click();
    await poll("pause", publish, p => p.paused === true);
    await key("Reprendre").waitFor();
    await key("Reprendre").click();
    await poll("reprise", publish, p => p.paused === false);
    await key("Pause").waitFor();

    await key("Marqueur").click();
    await poll("marqueur", () => pc.evaluate(() => (window as any).__store.useApp.getState().activity.some((a: any) => a.kind === "marker")), v => v);
    await phone.getByRole("button", { name: "Marqueur : 1" }).waitFor();
    await key("Micro").click();
    await poll("micro", () => pc.evaluate(() => (window as any).__store.useApp.getState().muted), v => v === true);
    await key("Micro coupé").waitFor();
    await key("Micro coupé").click();
    await key("Dessin").click();
    await poll("dessin", publish, p => p.allowDraw === false);
    await key("Dessin coupé").waitFor();
    await key("Pause dans 5 minutes").click();
    await poll("bandeau", publish, p => p.banner === "Pause dans 5 minutes");

    // Un appui court sur Arrêter ne fait rien : il faut tenir.
    await phone.getByRole("button", { name: "Arrêter, appui long" }).click();
    await wait(400);
    assert.ok(await publish(), "un toucher ne coupe pas le direct");

    await phone.getByRole("tab", { name: "Scènes" }).click();
    await key("Jeu").waitFor();
    await shot(phone, "67-regie-scenes");
    const screen = phone.locator(".deck-grid .key").nth(1);
    await screen.click();
    await poll("écran d'attente", publish, p => p.paused === true && !!p.screen);
    await poll("la touche s'allume", () => screen.getAttribute("aria-pressed"), v => v === "true", 3000);
    await screen.click();
    await poll("fin de l'écran", publish, p => p.paused === false);

    await phone.getByRole("tab", { name: "Son" }).click();
    await phone.getByRole("tab", { name: "Touches" }).click();
    await phone.getByRole("tab", { name: "Infos" }).click();
    await phone.getByLabel("Titre du stream").fill("Depuis le téléphone");
    await phone.getByLabel("Bandeau à l'image").click();
    await poll("titre", publish, p => p.title === "Depuis le téléphone");
    await shot(phone, "68-regie-details");
    await phone.getByRole("tab", { name: "Touches" }).click();

    // La page Salon : un message tout prêt part dans le chat, sous le nom de la personne.
    await phone.locator(".deck-pages").getByRole("tab", { name: "Salon" }).click();
    await key("Merci d'être là !").click();
    await poll("message dans le salon", () => pc.evaluate(() => (window as any).__store.useApp.getState().room.history.at(-1)?.text), text => text === "Merci d'être là !", 8000);
    await phone.locator(".deck-ticker", { hasText: "Merci d'être là !" }).waitFor({ timeout: 4000 });
    await shot(phone, "69-regie-salon");
    return "pause, marqueur compté, micro, dessin, bandeau, appui long, scène, écran d'attente, titre, message";
  });

  await step("les touches se personnalisent et le restent après un rechargement", async () => {
    await phone.getByRole("button", { name: "Modifier les touches" }).click();
    await shot(phone, "70-regie-modifier");
    await phone.getByRole("button", { name: "Ajouter une touche, emplacement 14" }).click();
    await phone.getByRole("dialog", { name: "Choisir une touche" }).waitFor();
    await shot(phone, "71-regie-choisir");
    await phone.getByRole("dialog").getByRole("button", { name: "Caméra" }).click();
    await phone.locator('.key[data-slot="13"]').waitFor();
    const from = await phone.locator('.key[data-slot="13"]').boundingBox();
    const to = await phone.locator('.key[data-slot="0"]').boundingBox();
    await phone.mouse.move(from!.x + 20, from!.y + 20);
    await phone.mouse.down();
    await phone.mouse.move(to!.x + 20, to!.y + 20, { steps: 8 });
    await phone.mouse.up();
    await phone.getByRole("button", { name: "Terminé" }).click();
    assert.match((await phone.locator('.key[data-slot="0"]').textContent())!, /Caméra/);
    await phone.reload();
    await phone.locator(".remote-card").or(phone.locator(".tab-regie")).first().waitFor();
    await phone.locator(".remote-card").or(phone.locator(".tab-regie")).first().click();
    await phone.locator(".deck-pages").getByRole("tab", { name: "Salon" }).click();
    assert.match((await phone.locator('.key[data-slot="0"]').textContent())!, /Caméra/);
  });

  await step("la table de mixage : le curseur suit le doigt et le PC suit le curseur", async () => {
    await pc.evaluate(() => (window as any).__core.setMixVolume?.("__aucun__", 1));
    const mixed = await pc.evaluate(async () => {
      const core = (window as any).__core;
      await core.addAudio({ type: "device", deviceId: "default", label: "Micro de test" });
      return (window as any).__store.useApp.getState().publish.mix.length;
    });
    await phone.getByRole("tab", { name: "Son" }).click();
    if (!mixed) return "pas de source de son dans ce test : la vue affiche son message";
    await phone.locator(".fader").first().waitFor({ timeout: 6000 });
    const track = await phone.locator(".fader-track").first().boundingBox();
    await phone.mouse.move(track!.x + track!.width / 2, track!.y + track!.height * 0.1);
    await phone.mouse.down();
    await phone.mouse.move(track!.x + track!.width / 2, track!.y + track!.height * 0.75, { steps: 6 });
    await phone.mouse.up();
    await shot(phone, "72-regie-son");
    const level = await poll("volume", publish, p => Math.abs(p.mix[0].volume - 0.38) < 0.08);
    await phone.locator(".fader > button").first().click();
    await poll("coupé", publish, p => p.mix[0].muted === true);
    return `volume ${level.mix[0].volume}`;
  });

  await step("appui long : le direct s'arrête, le téléphone propose alors de le relancer", async () => {
    await phone.getByRole("tab", { name: "Touches" }).click();
    await phone.locator(".deck-pages").getByRole("tab", { name: "Direct" }).click();
    const stop = await phone.getByRole("button", { name: "Arrêter, appui long" }).boundingBox();
    await phone.mouse.move(stop!.x + 20, stop!.y + 20);
    await phone.mouse.down();
    await wait(1400);
    await phone.mouse.up();
    await poll("direct arrêté", publish, p => !p);
    await phone.getByRole("heading", { name: "La régie s'ouvre dès que ton PC diffuse" }).waitFor();
    await shot(phone, "73-regie-pc-en-ligne");

    await pc.evaluate(() => (window as any).__core.updateSettings({ allowRemoteStart: true }));
    await phone.getByRole("heading", { name: "Lancer le direct" }).waitFor({ timeout: 6000 });
    await shot(phone, "74-regie-lancer");
    await phone.locator(".deck-launch .primary").click();
    await poll("direct relancé", publish, p => !!p, 25_000);
    await phone.locator(".deck-grid").waitFor({ timeout: 8000 });
    return "stop par appui long, puis relance depuis le téléphone sur la même source";
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

    await admin.getByRole("button", { name: "Réglages" }).click();
    await admin.getByLabel("Texte de l'annonce").fill("Mise à jour dans 5 minutes");
    await admin.getByRole("button", { name: "Envoyer" }).click();
    await pc.getByText("Mise à jour dans 5 minutes").first().waitFor({ timeout: 8000 });
    await phone.locator(".notice", { hasText: "Mise à jour dans 5 minutes" }).waitFor({ timeout: 8000 });
    await shot(admin, "69-admin-serveur");

    // Un vrai spectateur : c'est lui qui donne des mesures de qualité au panneau.
    const watcher = await (await edge!.newContext({ ...devices["Pixel 7"] })).newPage();
    const code = await pc.evaluate(() => (window as any).__store.useApp.getState().room.code);
    await watcher.goto(`${base}/w/${code}`);
    await watcher.getByLabel("Ton nom").fill("Léa");
    await watcher.getByRole("button", { name: "Regarder" }).click();
    await admin.getByRole("button", { name: "Diffusions" }).click();
    await admin.getByRole("heading", { name: "Spoka", exact: true }).waitFor();
    await admin.getByRole("cell", { name: "Directe" }).waitFor({ timeout: 25_000 });
    await shot(admin, "80-admin-diffusions");

    await admin.getByRole("button", { name: "Système" }).click();
    await admin.getByRole("heading", { name: "Le serveur SpokaStream" }).waitFor();
    await admin.locator(".chart", { hasText: "Mémoire du serveur" }).locator("svg").waitFor({ timeout: 25_000 });
    await shot(admin, "81-admin-systeme");
    await admin.getByRole("button", { name: "Statistiques" }).click();
    await admin.locator(".stat", { hasText: "Diffusions" }).waitFor();
    await shot(admin, "82-admin-statistiques");
    await admin.getByRole("button", { name: "Alertes" }).click();
    await admin.getByText("Le relais coturn est arrêté").waitFor();
    await shot(admin, "83-admin-alertes");

    await admin.getByRole("button", { name: "Modération" }).click();
    await admin.getByLabel("Mots interdits, séparés par des virgules").fill("vilainmot");
    await admin.getByRole("button", { name: "Enregistrer" }).click();
    await admin.getByText("Enregistré.").waitFor();
    await watcher.getByLabel("Écrire un message").or(watcher.getByPlaceholder(/message/i)).first().fill("Quel vilainmot");
    await watcher.keyboard.press("Enter");
    await poll("message filtré", () => pc.evaluate(() => (window as any).__store.useApp.getState().room.history.at(-1)?.text), text => text === "Quel •••••••••", 8000);
    await admin.locator(".row-line, tr", { hasText: "Léa" }).first().waitFor();
    await shot(admin, "84-admin-moderation");

    await admin.getByRole("button", { name: "Salons" }).click();
    await admin.getByRole("button", { name: "Gérer" }).first().click();
    await admin.getByText(/^Chat, /).click();
    await admin.getByRole("button", { name: "Supprimer le message de Léa" }).first().click();
    await admin.getByText("Message supprimé.").waitFor();
    await shot(admin, "85-admin-salon-gerer");

    await admin.getByRole("button", { name: "Comptes" }).click();
    await admin.locator(".card", { hasText: "Léa" }).getByRole("button", { name: "Gérer" }).click();
    await admin.getByLabel("Motif pour Léa").fill("Langage");
    await admin.getByRole("button", { name: "Rendre muet" }).click();
    await admin.getByText("Cette personne ne peut plus écrire.").waitFor();
    await admin.getByText("Sanctions et notes").click();
    await admin.getByText("Rendu muet : Langage").waitFor();
    await shot(admin, "86-admin-fiche-compte");

    await admin.getByRole("button", { name: "Sauvegardes" }).click();
    await admin.getByRole("button", { name: "Créer maintenant" }).click();
    await admin.getByText("Sauvegarde créée.").waitFor();
    await shot(admin, "87-admin-sauvegardes");

    await admin.getByRole("button", { name: "Réglages" }).click();
    await admin.getByText("Serveur fermé").click();
    await admin.getByText("Réglage enregistré.").waitFor();
    const stranger = await (await edge!.newContext({ ...devices["Pixel 7"] })).newPage();
    await stranger.goto(`${base}/w/${code}`);
    await stranger.getByLabel("Ton nom").fill("Inconnu");
    await stranger.getByRole("button", { name: "Regarder" }).click();
    await stranger.getByRole("alert").waitFor({ timeout: 8000 });
    assert.match((await stranger.getByRole("alert").textContent())!, /n'accepte plus/);
    await admin.getByText("Serveur fermé").click();
    await admin.getByRole("button", { name: "Vue d'ensemble" }).click();
    await admin.locator(".verdict").waitFor();
    await shot(admin, "88-admin-vue-ensemble");

    await admin.getByRole("button", { name: "Salons" }).click();
    await admin.getByRole("button", { name: "Arrêter le stream de Spoka" }).click();
    await poll("stream coupé par l'admin", async () => server.hub.stats.streams, n => n === 0, 10_000);
    await admin.getByRole("button", { name: "Diffusions" }).click();
    await admin.getByRole("heading", { name: "Diffusions terminées" }).waitFor();
    await admin.getByRole("cell", { name: "Spoka" }).first().waitFor();
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
    // On revient sur la page qu'on avait quittée : elle est dans l'adresse.
    await page.getByRole("heading", { name: "Sécurité", level: 1 }).waitFor();

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
    assert.equal(await modo.getByRole("button", { name: "Réglages" }).count(), 0);
    assert.equal(await modo.getByRole("button", { name: "Sauvegardes" }).count(), 0);
    await modo.getByRole("button", { name: "Modération" }).click();
    await modo.getByRole("heading", { name: "Sanctions en cours" }).waitFor();
    assert.equal(await modo.getByLabel("Mots interdits, séparés par des virgules").count(), 0, "un modérateur ne change pas les réglages");
    assert.equal(await modo.evaluate(() => fetch("/admin/api/action", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "setConfig", patch: { closed: true } }) }).then(r => r.status)), 403, "le serveur refuse, l'écran ne fait que masquer");

    await page.getByRole("button", { name: "Comptes" }).click();
    await page.locator(".card", { hasText: "Spoka" }).getByRole("button", { name: "Gérer" }).click();
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
