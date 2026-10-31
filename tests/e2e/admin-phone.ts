// Le panneau tenu dans une main : chaque page sur quatre écrans, puis ce que Chromium pense de l'installation.
//   npm run test:admin-phone
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import type { Browser, Page } from "playwright";
import type { AdminAuth } from "../../server/adminAuth.ts";
import { startServer } from "../../server/index.ts";
import { MemoryStore } from "../../server/store.ts";
import { PROTOCOL_VERSION } from "../../src/shared/protocol.ts";

const root = path.resolve(import.meta.dirname, "../..");
const captures = path.join(root, "tests", "captures");
mkdirSync(captures, { recursive: true });
const temp = mkdtempSync(path.join(tmpdir(), "spokastream-admin-phone-"));
const server = await startServer({ port: 0, host: "127.0.0.1", store: new MemoryStore(), dataDir: path.join(temp, "data") });
const base = `http://127.0.0.1:${server.port}`;
const hub = server.hub;

function device(n: number, name: string, web = false) {
  const conn = hub.connect({ ip: `203.0.113.${n}`, send: () => {}, close: () => {} });
  const send = (message: object) => hub.handle(conn, JSON.stringify(message));
  send({ t: "hello", protocol: PROTOCOL_VERSION, token: String(n).repeat(64).slice(0, 64), client: web ? "web" : "app", version: web ? "site" : "1.6.0", device: web ? "Téléphone Android" : "PC Windows", profile: { name, color: "#34d399", avatar: null } });
  return { conn, send };
}

// Des noms longs exprès : c'est sur eux qu'une mise en page casse.
const streamer = device(1, "Un pseudo vraiment très long pour voir");
streamer.send({ t: "room.create", name: "La grande soirée film du samedi soir" });
const code = hub.adminRooms()[0]!.code;
const viewers = [device(2, "Léa", true), device(3, "Sam"), device(4, "Quelqu'un avec un nom interminable aussi", true)];
for (const viewer of viewers) viewer.send({ t: "room.join", code });
streamer.send({ t: "stream.start", id: "s1", stream: { title: "Un titre de stream qui ne tient pas sur une ligne de téléphone", kind: "screen", width: 1920, height: 1080, fps: 60 } });
for (const viewer of viewers) viewer.send({ t: "stream.watch", id: "s1", on: true });
for (const [index, viewer] of viewers.entries()) {
  viewer.send({ t: "chat.send", text: `Message ${index}, avec une adresse https://exemple.fr/une/adresse/tres/longue/qui/ne/se/coupe/pas/toute/seule` });
  viewer.send({ t: "telemetry", watch: [{ streamId: "s1", fps: 59, kbps: 7800 - index * 900, height: 1080, lostPct: index * 3, jitterMs: 4, freezes: index, relay: index === 1, protocol: "udp", rttMs: 40 + index * 150 }] });
}
streamer.send({ t: "telemetry", publish: { streamId: "s1", fps: 60, kbps: 8200, height: 1080, codec: "AV1", encoder: "NVIDIA", hardware: true, encMs: 4, limit: "bandwidth", viewers: [] } });
streamer.send({ t: "report", kind: "feedback", text: "Le son coupe parfois", details: "diagnostic ".repeat(40) });
hub.log("error", "serveur", "Une erreur assez longue pour voir comment une ligne de journal se comporte sur un petit écran");
hub.adminMute(viewers[0]!.conn.accountId!, Date.now() + 3600_000, "Langage", "spoka");
server.admin.auth.ownerInvite();
const stop = device(5, "Court");
stop.send({ t: "room.create", name: "Fini" });
stop.send({ t: "stream.start", id: "s2", stream: { title: "Terminé", kind: "window", width: 1280, height: 720, fps: 30 } });
hub.adminStopAll(hub.adminRooms()[1]!.id);

const SCREENS = [
  { name: "390", width: 390, height: 844 },
  { name: "360", width: 360, height: 640 },
  { name: "320", width: 320, height: 568 },
  { name: "paysage", width: 844, height: 390 },
];
const PAGES = ["Vue d'ensemble", "Alertes", "Système", "Statistiques", "Diffusions", "Salons", "Comptes", "Modération", "Retours", "Journal", "Réglages", "Sauvegardes", "Administrateurs", "Sécurité"];

/** Ce qui est trop petit pour un doigt, ou qui sort de l'écran, avec de quoi le retrouver. */
const inspect = (page: Page) =>
  page.evaluate(() => {
    const visible = (el: Element) => {
      const r = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && style.visibility !== "hidden" && style.display !== "none";
    };
    const scroller = (el: Element) => {
      for (let p = el.parentElement; p; p = p.parentElement) if (/auto|scroll/.test(getComputedStyle(p).overflowX)) return true;
      return false;
    };
    const describe = (el: Element) => `${el.tagName.toLowerCase()}.${el.className} « ${(el.textContent || el.getAttribute("aria-label") || "").trim().slice(0, 30)} »`;
    const small = [...document.querySelectorAll("button, a.button, input:not([type=checkbox]), select, summary, textarea")].filter(visible).filter(el => el.getBoundingClientRect().height < 40).map(el => `${describe(el)} ${Math.round(el.getBoundingClientRect().height)}px`);
    const wide = [...document.querySelectorAll("main *, .tabbar *")].filter(visible).filter(el => !scroller(el) && el.getBoundingClientRect().right > innerWidth + 1).map(describe).slice(0, 5);
    const zoom = [...document.querySelectorAll("input:not([type=checkbox]), select, textarea")].filter(visible).filter(el => parseFloat(getComputedStyle(el).fontSize) < 16).map(describe);
    return { overflow: document.documentElement.scrollWidth - innerWidth, small: [...new Set(small)], wide, zoom };
  });

let edge: Browser | undefined;
let failed = false;
try {
  edge = await chromium.launch({ channel: "msedge" });
  const context = await edge.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, userAgent: "Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36" });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", e => errors.push(String(e)));
  page.on("console", m => m.type() === "error" && !/40[13]/.test(m.text()) && errors.push(m.text()));

  await page.goto(`${base}/admin`);
  await page.getByLabel("Identifiant").waitFor({ state: "attached", timeout: 3000 }).catch(() => {});
  const invite = (server.admin.auth as AdminAuth).ownerInvite();
  await page.goto(`${base}/admin#setup=${invite}`);
  await page.reload();
  await page.getByRole("heading", { name: "Crée ton accès" }).waitFor();
  assert.deepEqual((await inspect(page)).zoom, [], "les champs de connexion ne doivent pas déclencher le zoom de l'iPhone");
  await page.screenshot({ path: path.join(captures, "90-admin-tel-acces.png") });
  await page.getByLabel("Identifiant").fill("spoka");
  await page.getByLabel("Mot de passe (12 caractères ou plus)").fill("un-long-mot-de-passe");
  await page.getByLabel("Encore une fois").fill("un-long-mot-de-passe");
  await page.getByRole("button", { name: "Créer mon accès" }).click();
  await page.getByRole("heading", { name: "Vue d'ensemble", level: 1 }).waitFor();

  const open = async (name: string) => {
    if (await page.getByRole("heading", { name, level: 1 }).isVisible()) return;
    await page.locator(".tabbar").getByRole("button", { name: "Plus" }).click();
    await page.getByRole("dialog", { name: "Toutes les pages" }).getByRole("button", { name }).click();
    await page.getByRole("heading", { name, level: 1 }).waitFor();
  };

  let problems = 0;
  for (const screen of SCREENS) {
    await page.setViewportSize({ width: screen.width, height: screen.height });
    for (const name of PAGES) {
      await open(name);
      await page.waitForTimeout(250);
      const report = await inspect(page);
      if (report.overflow > 1 || report.small.length || report.wide.length || report.zoom.length) {
        problems++;
        console.log(`✖ ${screen.name} ${name} : ${JSON.stringify(report).slice(0, 700)}`);
      }
      const end = await page.evaluate(() => {
        scrollTo(0, document.documentElement.scrollHeight);
        const last = document.querySelector("main")!.lastElementChild!.getBoundingClientRect().bottom;
        return { last, bar: document.querySelector(".tabbar")!.getBoundingClientRect().top };
      });
      if (end.last > end.bar + 1) {
        problems++;
        console.log(`✖ ${screen.name} ${name} : la barre du bas cache la fin de la page`);
      }
      await page.evaluate(() => scrollTo(0, 0));
      if (screen.name === "390" || screen.name === "320") await page.screenshot({ path: path.join(captures, `91-admin-tel-${screen.name}-${PAGES.indexOf(name)}.png`), fullPage: true });
    }
  }
  assert.equal(problems, 0, `${problems} problèmes de mise en page`);
  console.log(`✔ ${PAGES.length} pages sur ${SCREENS.length} écrans : rien ne déborde, rien sous 40 px, aucun champ qui zoome`);

  await page.setViewportSize({ width: 390, height: 844 });
  await open("Vue d'ensemble");
  await page.locator(".gauges").waitFor();
  await page.evaluate(() => document.querySelector(".gauges")!.setAttribute("data-kept", "1"));
  // Le badge des alertes se relit toutes les 30 secondes : il ne doit pas recharger la page qu'on est en train de lire.
  await page.waitForTimeout(31_000);
  assert.equal(await page.locator(".gauges").getAttribute("data-kept"), "1", "la page ne doit pas se recharger toute seule");
  await page.locator(".tabbar").getByRole("button", { name: "Comptes" }).click();
  await page.getByRole("heading", { name: "Comptes", level: 1 }).waitFor();
  await page.locator(".tabbar").getByRole("button", { name: "Plus" }).click();
  await page.getByRole("dialog").waitFor();
  await page.screenshot({ path: path.join(captures, "92-admin-tel-plus.png") });
  await page.goBack();
  await page.getByRole("dialog").waitFor({ state: "detached" });
  await page.getByRole("heading", { name: "Comptes", level: 1 }).waitFor();
  await page.goBack();
  await page.getByRole("heading", { name: "Vue d'ensemble", level: 1 }).waitFor();
  await page.reload();
  await page.getByRole("heading", { name: "Vue d'ensemble", level: 1 }).waitFor();
  console.log("✔ le bouton retour referme le menu, revient à la page d'avant, et rien ne se perd au rechargement");

  await page.locator(".tabbar").getByRole("button", { name: "Direct" }).click();
  await page.getByText("Pertes").first().waitFor();
  const stacked = await page.evaluate(() => getComputedStyle(document.querySelector("table.stack tr")!).display);
  assert.equal(stacked, "block", "un tableau de six colonnes devient des fiches");

  // La navigation privée refuse toute installation : la question se pose dans un vrai profil.
  const profile = await chromium.launchPersistentContext(path.join(temp, "profil"), { channel: "msedge", viewport: { width: 390, height: 844 } });
  const installPage = profile.pages()[0] ?? (await profile.newPage());
  await installPage.goto(`${base}/admin`);
  await installPage.waitForFunction(() => navigator.serviceWorker.getRegistration("/admin").then(r => !!r?.active));
  await installPage.reload();
  await installPage.getByLabel("Identifiant").waitFor();
  const cdp = await profile.newCDPSession(installPage);
  await cdp.send("Page.enable");
  const manifest = (await cdp.send("Page.getAppManifest")) as { url: string; errors: { message: string }[]; data?: string };
  assert.deepEqual(manifest.errors, [], "le navigateur ne trouve rien à redire au manifeste");
  const parsed = JSON.parse(manifest.data!) as { id: string; scope: string; start_url: string; short_name: string; display: string };
  assert.deepEqual([parsed.scope, parsed.start_url, parsed.short_name, parsed.display], ["/admin", "/admin", "Spoka Admin", "standalone"]);
  const { installabilityErrors } = (await cdp.send("Page.getInstallabilityErrors" as never)) as unknown as { installabilityErrors: { errorId: string }[] };
  assert.deepEqual(installabilityErrors.map(e => e.errorId), [], "le navigateur doit accepter d'installer le panneau");
  await profile.close();
  console.log("✔ installable : manifeste valide, aucun refus du navigateur");

  // Le réseau coupé pendant que la page est ouverte : c'est le cas d'un téléphone dans un tunnel.
  await context.setOffline(true);
  await page.locator(".offline").waitFor({ timeout: 4000 });
  await page.screenshot({ path: path.join(captures, "93-admin-tel-hors-ligne.png") });
  await context.setOffline(false);
  await page.locator(".offline").waitFor({ state: "detached", timeout: 4000 });
  console.log("✔ sans réseau, le panneau le dit et reprend tout seul");

  assert.deepEqual(errors.filter(text => !/ERR_INTERNET_DISCONNECTED|Failed to fetch/.test(text)), []);
  console.log("RÉUSSI");
} catch (e) {
  failed = true;
  console.log(`✖ ${e}`);
} finally {
  await edge?.close().catch(() => {});
  await server.close();
  rmSync(temp, { recursive: true, force: true, maxRetries: 4 });
}
process.exit(failed ? 1 : 0);
