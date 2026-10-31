// Plusieurs diffuseurs dans un salon, et la Watch Party de n'importe quelle vidéo : deux vraies applications et un téléphone émulé.
//   npm run test:party
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createReadStream, mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
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
const temp = mkdtempSync(path.join(tmpdir(), "spokastream-party-"));
const electronPath = createRequire(import.meta.url)("electron") as unknown as string;

const server = await startServer({ port: 0, host: "127.0.0.1", store: new MemoryStore() });
const serverUrl = `ws://127.0.0.1:${server.port}/ws`;

const movie = path.join(temp, "film-de-test.mp4");
execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=30:duration=40", "-f", "lavfi", "-i", "sine=frequency=440:duration=40", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-movflags", "+faststart", movie]);

/** Le son et l'image de cette page viennent d'elle seule : si le spectateur les reçoit, c'est que la page a bien été capturée. */
const SHARED_PAGE = `<!doctype html><title>Page partagée</title><body style="margin:0;background:#123"><canvas id=c width=640 height=360 style="width:100vw;height:100vh"></canvas><script>
const x = c.getContext("2d");
let n = 0;
setInterval(() => { x.fillStyle = "hsl(" + (n++ * 7 % 360) + " 80% 50%)"; x.fillRect(0, 0, 640, 360); }, 33);
const a = new AudioContext();
const o = a.createOscillator();
o.frequency.value = 500;
o.connect(a.destination);
o.start();
</script></body>`;

const media = http.createServer((req, res) => {
  const url = req.url ?? "/";
  if (url.startsWith("/page")) {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    return res.end(SHARED_PAGE);
  }
  if (url.startsWith("/article")) {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    return res.end(`<!doctype html><title>Un article</title><meta property="og:title" content="Le film du samedi"><video src="/film-de-test.mp4"></video>`);
  }
  if (!url.startsWith("/film-de-test.mp4")) return res.writeHead(404).end();
  const size = statSync(movie).size;
  const range = req.headers.range?.match(/bytes=(\d+)-(\d*)/);
  const start = Number(range?.[1] ?? 0);
  const end = range?.[2] ? Number(range[2]) : size - 1;
  res.writeHead(range ? 206 : 200, { "content-type": "video/mp4", "accept-ranges": "bytes", "content-length": end - start + 1, ...(range ? { "content-range": `bytes ${start}-${end}/${size}` } : {}) });
  createReadStream(movie, { start, end }).pipe(res);
});
await new Promise<void>(resolve => media.listen(0, "127.0.0.1", resolve));
const mediaUrl = `http://127.0.0.1:${(media.address() as AddressInfo).port}`;

interface Peer {
  name: string;
  app: ElectronApplication;
  page: Page;
}

const wait = (ms: number) => new Promise(r => setTimeout(r, ms));

async function launch(name: string): Promise<Peer> {
  const app = await electron.launch({
    executablePath: electronPath,
    args: [root, "--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"],
    env: { ...process.env, SPOKASTREAM_USER_DATA: path.join(temp, name), SPOKASTREAM_SERVER: serverUrl },
  });
  const page = await app.firstWindow();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(1360, 860));
  return { name, app, page };
}

async function poll<T>(label: string, read: () => Promise<T>, ok: (v: T) => boolean, timeoutMs = 20_000) {
  const end = Date.now() + timeoutMs;
  let last: T | undefined;
  while (Date.now() < end) {
    last = await read();
    if (ok(last)) return last;
    await wait(250);
  }
  throw new Error(`${label} : délai dépassé, dernière valeur ${JSON.stringify(last)}`);
}

let passed = 0;
async function step(name: string, fn: () => Promise<string | void>) {
  console.log(`… ${name}`);
  const detail = await fn();
  passed++;
  console.log(`  ✔ ${detail ?? ""}`);
}

const shot = (peer: { page: Page }, name: string) => peer.page.screenshot({ path: path.join(captures, `${name}.png`), timeout: 12_000 });
const only = (process.env.ONLY ?? "").split(",").filter(Boolean);
const wanted = (name: string) => !only.length || only.includes(name);

async function goLiveCamera(peer: Peer) {
  await peer.page.getByRole("button", { name: "Diffuser", exact: true }).click();
  await peer.page.getByRole("tab", { name: "Caméra" }).click();
  await peer.page.locator(".device-row").first().click();
  await peer.page.getByRole("button", { name: "Lancer le stream" }).click();
  await peer.page.locator(".tile-own").waitFor({ timeout: 30_000 });
}

const wallOf = (peer: Peer) =>
  peer.page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>(".wall-item")].map(item => {
      const r = item.getBoundingClientRect();
      return { place: item.dataset.wall!, x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
    }),
  );

let a: Peer | undefined;
let b: Peer | undefined;
let edge: Browser | undefined;
let failed = false;

try {
  a = await launch("alice");
  b = await launch("bob");
  const alice = a;
  const bob = b;
  for (const peer of [alice, bob]) {
    await peer.page.getByPlaceholder("Comment tes amis te voient").fill(peer.name === "alice" ? "Spoka" : "Pinoy");
    await peer.page.getByRole("button", { name: "C'est parti" }).click();
    await peer.page.getByText("Connecté à").waitFor();
  }
  await alice.page.locator(".home-card-primary").click();
  await alice.page.getByPlaceholder("La soirée film, Les potes…").fill("Soirée film");
  await alice.page.getByRole("button", { name: "Créer le salon" }).click();
  await alice.page.locator(".room-code").waitFor();
  const code = (await alice.page.locator(".stage-empty-code b").textContent())!.trim();
  await bob.page.getByPlaceholder("ABCD2345").fill(code);
  await bob.page.getByRole("button", { name: "Rejoindre", exact: true }).click();
  await bob.page.locator(".room-code").waitFor();

  edge = await chromium.launch({ channel: "msedge", args: ["--autoplay-policy=no-user-gesture-required"] });
  const phone = await (await edge.newContext({ ...devices["Pixel 7"] })).newPage();
  phone.on("pageerror", e => console.log(`  téléphone : ${e}`));
  await phone.goto(`http://127.0.0.1:${server.port}/w/${code}`);
  await phone.getByPlaceholder("Comment tes amis te voient").fill("Tel");
  await phone.locator("button.primary").click();
  await phone.locator(".stage").waitFor();

  if (wanted("wall")) {
    await step("deux diffuseurs : chacun regarde l'autre pendant qu'il diffuse", async () => {
      await goLiveCamera(alice);
      await goLiveCamera(bob);
      for (const peer of [alice, bob]) {
        const count = await peer.page.locator(".stream-card-cta").count();
        if (count) await peer.page.locator(".stream-card").first().click();
      }
      for (const peer of [alice, bob]) {
        await poll(`image reçue par ${peer.name}`, () => peer.page.evaluate(() => Object.values((window as any).__store.useApp.getState().subs).filter((s: any) => s.stats?.fps > 0).length), n => n === 1, 30_000);
      }
      await poll("deux images chez Alice", () => wallOf(alice), list => list.length === 2);
      await shot(alice, "40-deux-diffuseurs");
      return "chacun voit son retour et le stream de l'autre";
    });

    await step("les dispositions rangent les images sans recréer les lecteurs", async () => {
      await alice.page.evaluate(() => {
        (document.querySelector(".tile-video") as any).__same = true;
      });
      const menu = () => alice.page.getByRole("button", { name: "Disposition des images" }).click();
      for (const [mode, name] of [["Grille", "grid"], ["Un grand, colonne à droite", "side"], ["Incrustation", "pip"]] as const) {
        await menu();
        await alice.page.locator(".wall-menu .menu-item", { hasText: mode }).click();
        await alice.page.locator(`.stage-wall.is-${name}`).waitFor();
        await wait(350);
        const rects = await wallOf(alice);
        if (name === "grid") assert.equal(rects[0]!.w, rects[1]!.w, "en grille, deux images de même taille");
        if (name === "side") assert.ok(rects[0]!.y === rects[1]!.y || rects[0]!.x !== rects[1]!.x, "côte à côte");
        await shot(alice, `41-disposition-${name}`);
      }
      assert.equal(await alice.page.evaluate(() => [...document.querySelectorAll(".tile-video")].some(v => (v as any).__same)), true, "le lecteur a été recréé");
    });

    await step("disposition libre : glisser, agrandir, retrouver au retour", async () => {
      await alice.page.getByRole("button", { name: "Disposition des images" }).click();
      await alice.page.locator(".wall-menu .menu-item", { hasText: "Libre" }).click();
      await alice.page.locator(".stage-wall.is-free").waitFor();
      await wait(350);
      const before = await wallOf(alice);
      // On vient de l'incrustation : la petite image est celle qu'on peut déplacer librement.
      const target = before.reduce((small, rect) => (rect.w < small.w ? rect : small));
      await alice.page.mouse.move(target.x + target.w / 2, target.y + target.h / 2);
      const grip = (await alice.page.locator(`.wall-item[data-wall="${target.place}"] .wall-grip`).boundingBox())!;
      await alice.page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
      await alice.page.mouse.down();
      await alice.page.mouse.move(grip.x - 120, grip.y + 60, { steps: 6 });
      await alice.page.mouse.up();
      const moved = (await wallOf(alice)).find(r => r.place === target.place)!;
      assert.ok(Math.abs(moved.x - target.x) > 60, `déplacée de ${moved.x - target.x}`);
      const corner = (await alice.page.locator(`.wall-item[data-wall="${target.place}"] .wall-size`).boundingBox())!;
      await alice.page.mouse.move(corner.x + 10, corner.y + 10);
      await alice.page.mouse.down();
      await alice.page.mouse.move(corner.x + 90, corner.y + 50, { steps: 6 });
      await alice.page.mouse.up();
      const resized = (await wallOf(alice)).find(r => r.place === target.place)!;
      assert.ok(resized.w > moved.w, `largeur ${moved.w} -> ${resized.w}`);
      await poll("disposition enregistrée", () => alice.page.evaluate(() => Object.keys((window as any).__store.useApp.getState().settings.wall.free).length), n => n === 2);
      await shot(alice, "42-disposition-libre");
      return `déplacée puis agrandie à ${resized.w} × ${resized.h}`;
    });

    await step("n'écouter qu'un stream, masquer son retour, petite image en petite qualité", async () => {
      const subId = await alice.page.evaluate(() => Object.keys((window as any).__store.useApp.getState().subs)[0]);
      const tile = alice.page.locator(".wall-item:has(.tile:not(.tile-own))");
      await tile.hover();
      await tile.getByRole("button", { name: "N'écouter que ce stream" }).click();
      assert.equal(await alice.page.evaluate(() => (window as any).__store.useApp.getState().solo), subId);
      await tile.getByRole("button", { name: "Écouter tous les streams" }).click();
      await alice.page.getByRole("button", { name: "Disposition des images" }).click();
      await alice.page.getByRole("switch", { name: "Voir mon retour" }).click();
      await alice.page.keyboard.press("Escape");
      await poll("retour masqué", () => wallOf(alice), list => list.length === 1);
      assert.equal(await alice.page.evaluate(() => !!(window as any).__store.useApp.getState().publish), true, "le stream continue");
      await alice.page.getByRole("button", { name: "Disposition des images" }).click();
      await alice.page.getByRole("switch", { name: "Voir mon retour" }).click();
      await alice.page.keyboard.press("Escape");
      await poll("retour affiché", () => wallOf(alice), list => list.length === 2);
    });

    await step("arrêter les deux streams", async () => {
      for (const peer of [alice, bob]) {
        await peer.page.getByRole("button", { name: "Arrêter le stream" }).click();
        await peer.page.locator(".tile-own").waitFor({ state: "detached" });
        await peer.page.getByRole("button", { name: "Confirmer" }).click({ timeout: 800 }).catch(() => {});
      }
      await poll("salon vide", () => bob.page.evaluate(() => (window as any).__store.useApp.getState().room.streams.length), n => n === 0);
    });
  }

  const position = (peer: { page: Page }) => peer.page.locator(".together-seek").evaluate((i: HTMLInputElement) => Number(i.value));

  if (wanted("party")) {
    await step("Watch Party : une vidéo d'une URL quelconque, synchronisée", async () => {
      await alice.page.getByRole("button", { name: "Lancer une Watch Party" }).first().click();
      await alice.page.getByPlaceholder("https://…").first().fill(`${mediaUrl}/film-de-test.mp4`);
      await alice.page.getByRole("button", { name: "Lancer pour tout le salon" }).click();
      await bob.page.locator(".tile-together").waitFor({ timeout: 15_000 });
      await poll("lecture chez Alice", () => position(alice), t => t >= 3, 30_000);
      await poll("lecture chez Bob", () => position(bob), t => t >= 3, 30_000);
      await poll("lecture sur le téléphone", () => phone.locator("#together").count(), n => n === 1);
      await shot(bob, "43-watch-party-url");
      const [ta, tb] = [await position(alice), await position(bob)];
      assert.ok(Math.abs(ta - tb) <= 2, `dérive ${ta} / ${tb}`);

      await bob.page.locator(".tile-together").hover();
      await bob.page.getByRole("button", { name: "Avancer de 10 secondes" }).click();
      await poll("saut chez Alice", () => position(alice), t => t >= ta + 8, 12_000);
      await bob.page.getByRole("button", { name: "Mettre en pause pour tout le salon" }).click();
      await alice.page.locator(".tile-together").hover();
      await alice.page.getByRole("button", { name: "Reprendre pour tout le salon" }).waitFor();
      await wait(2000);
      const paused = await position(alice);
      await wait(1500);
      assert.equal(await position(alice), paused, "la pause s'applique à un fichier");
      await alice.page.getByRole("button", { name: "Reprendre pour tout le salon" }).click();
      return `positions ${ta} et ${tb}, saut puis pause à ${paused}`;
    });

    await step("une page qui contient une vidéo : le titre et la vidéo sont trouvés", async () => {
      await alice.page.getByRole("button", { name: "Lancer une Watch Party" }).first().click();
      await alice.page.getByPlaceholder("https://…").first().fill(`${mediaUrl}/article`);
      await alice.page.getByRole("button", { name: "Ajouter à la file" }).click();
      await poll("file d'attente", () => alice.page.evaluate(() => (window as any).__store.useApp.getState().room.together.queue.map((i: any) => i.title)), q => q.includes("Le film du samedi"), 20_000);
      await alice.page.getByRole("button", { name: "Lancer une Watch Party" }).first().click();
      await alice.page.locator(".queue-row").first().waitFor();
      await shot(alice, "44-file-attente");
      await alice.page.locator(".queue-row").getByRole("button", { name: "Retirer de la file" }).click();
      await alice.page.locator(".queue-row").waitFor({ state: "detached" });
      await alice.page.keyboard.press("Escape");
    });

    await step("un site sans vidéo accessible : proposer de diffuser la page", async () => {
      await alice.page.getByRole("button", { name: "Lancer une Watch Party" }).first().click();
      await alice.page.getByPlaceholder("https://…").first().fill(`${mediaUrl}/page`);
      await alice.page.getByRole("button", { name: "Ajouter à la file" }).click();
      await alice.page.locator(".party-page").waitFor({ timeout: 15_000 });
      await shot(alice, "45-site-a-diffuser");
      await alice.page.locator(".tile-together").waitFor();
      await alice.page.locator(".modal-close, [aria-label='Fermer']").first().click();
      await alice.page.locator(".tile-together").hover();
      await alice.page.getByRole("button", { name: "Arrêter pour tout le salon" }).click();
      await bob.page.locator(".tile-together").waitFor({ state: "detached" });
    });
  }

  if (wanted("web")) {
    await step("diffuser une page web : son image et son son arrivent", async () => {
      await alice.page.getByRole("button", { name: "Diffuser", exact: true }).click();
      await alice.page.getByRole("tab", { name: "Page web" }).click();
      await alice.page.getByLabel("Adresse de la page").fill(`${mediaUrl}/page`);
      await alice.page.getByRole("button", { name: "Lancer le stream" }).click();
      await alice.page.locator(".tile-own").waitFor({ timeout: 30_000 });
      await poll("regarder", () => bob.page.locator(".stream-card, .tile").count(), n => n > 0);
      if (await bob.page.locator(".stream-card").count()) await bob.page.locator(".stream-card").first().click();
      const fps = await poll("image reçue", () => bob.page.evaluate(() => Object.values((window as any).__store.useApp.getState().subs).map((s: any) => s.stats?.fps ?? 0)[0] ?? 0), n => n > 5, 30_000);
      const streamId = await bob.page.evaluate(() => Object.keys((window as any).__store.useApp.getState().subs)[0]);
      const level = await poll("son reçu", () => bob.page.evaluate(id => (window as any).__core.streamLevel(id), streamId), n => n > 0.01, 20_000);
      await shot(bob, "46-page-diffusee");
      await alice.page.getByRole("button", { name: "Arrêter le stream" }).click();
      await alice.page.locator(".tile-own").waitFor({ state: "detached" });
      await poll("fenêtre refermée", () => alice.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), n => n === 1);
      return `${fps} i/s, niveau du son ${level.toFixed(3)}`;
    });
  }

  if (wanted("file")) {
    await step("un film du PC : pause et position restent au diffuseur", async () => {
      await alice.page.getByRole("button", { name: "Diffuser", exact: true }).click();
      await alice.page.getByRole("tab", { name: "Fichier vidéo" }).click();
      await alice.page.locator(".file-pick input[type=file]").setInputFiles(movie);
      await alice.page.getByRole("button", { name: "Lancer le stream" }).click();
      await alice.page.locator(".tile-own").waitFor({ timeout: 30_000 });
      await poll("le film avance", () => alice.page.evaluate(() => (window as any).__store.useApp.getState().publish.file?.time ?? 0), t => t > 1, 15_000);
      await alice.page.evaluate(() => (window as any).__core.updateWall({ mode: "focus" }));
      await alice.page.locator(".tile-own").hover();
      await alice.page.getByRole("button", { name: "Mettre le fichier en pause" }).first().click();
      const paused = await alice.page.evaluate(() => (window as any).__store.useApp.getState().publish.file);
      assert.equal(paused.playing, false);
      await alice.page.evaluate(() => (window as any).__core.fileControl({ time: 20, playing: true }));
      await poll("reprise à 20 s", () => alice.page.evaluate(() => (window as any).__store.useApp.getState().publish.file.time), t => t >= 20, 8000);
      await shot(alice, "47-film-du-pc");
      await alice.page.evaluate(() => (window as any).__core.fileControl({ time: 39 }));
      await poll("fin du fichier", () => alice.page.evaluate(() => (window as any).__store.useApp.getState().publish.file.playing), playing => !playing, 8000);
      assert.equal(await alice.page.evaluate(() => (window as any).__store.useApp.getState().publish.paused), false, "la fin du fichier n'arrête pas le stream");
      console.log(`  page vivante : ${await Promise.race([alice.page.evaluate(() => performance.now()), wait(10_000).then(() => "NON")])}`);
      await alice.page.getByRole("button", { name: "Arrêter le stream" }).click({ timeout: 10_000 });
      await alice.page.locator(".tile-own").waitFor({ state: "detached" });
    });
  }

  if (wanted("phone")) {
    await step("téléphone : on quitte le pointeur", async () => {
      await goLiveCamera(alice);
      await poll("stream ouvert sur le téléphone", () => phone.getByRole("button", { name: /Pointeur laser/ }).count(), n => n > 0, 20_000);
      await poll("commandes visibles", async () => {
        if (!(await phone.locator(".stage.shows-controls").count())) await phone.locator(".stage").click({ position: { x: 100, y: 60 } });
        return phone.locator(".stage.shows-controls").count();
      }, n => n > 0);
      await phone.getByRole("button", { name: /Pointeur laser/ }).click();
      await phone.locator(".laser-bar").waitFor();
      const stage = (await phone.locator(".stage").boundingBox())!;
      await wait(4500);
      await phone.mouse.click(stage.x + stage.width / 2, stage.y + stage.height / 2);
      await phone.getByRole("button", { name: "Terminer" }).click({ timeout: 3000 });
      await phone.locator(".laser-bar").waitFor({ state: "detached" });
      await phone.locator(".stage.shows-controls").waitFor();
      await shot({ page: phone }, "48-telephone-pointeur");
      await alice.page.getByRole("button", { name: "Arrêter le stream" }).click();
      await alice.page.locator(".tile-own").waitFor({ state: "detached" });
    });

    await step("téléphone : deux diffuseurs, glisser pour changer, mini-vue", async () => {
      await goLiveCamera(alice);
      await goLiveCamera(bob);
      const shown = () => phone.evaluate(() => document.querySelector(".top-title b")?.textContent ?? "");
      const first = await poll("premier stream", shown, name => !!name, 20_000);
      const stage = (await phone.locator(".stage").boundingBox())!;
      const swipe = async () => {
        await phone.mouse.move(stage.x + stage.width * 0.8, stage.y + stage.height / 2);
        await phone.mouse.down();
        await phone.mouse.move(stage.x + stage.width * 0.2, stage.y + stage.height / 2, { steps: 4 });
        await phone.mouse.up();
      };
      await swipe();
      const second = await poll("stream voisin", shown, name => !!name && name !== first, 8000);
      assert.equal(await phone.locator(".live-dots i").count(), 2);

      if (!(await phone.locator(".panes").isVisible())) await phone.getByRole("button", { name: "Afficher le chat" }).click();
      await phone.getByRole("tab", { name: /En direct/ }).click();
      await phone.getByRole("button", { name: `Garder ${first} en petit par-dessus` }).click();
      await phone.locator(".mini-view").waitFor();
      await poll("image de la mini-vue", () => phone.evaluate(() => (document.getElementById("mini-video") as HTMLVideoElement).videoWidth), w => w > 0, 20_000);
      await shot({ page: phone }, "49-telephone-mini-vue");
      await phone.getByRole("button", { name: "Mettre ce stream en grand" }).click();
      await poll("échange", shown, name => name === first, 8000);
      await phone.locator(".mini-view").waitFor();
      await phone.getByRole("button", { name: "Fermer la mini-vue" }).first().click();
      await phone.locator(".mini-view").waitFor({ state: "detached" });
      for (const peer of [alice, bob]) await peer.page.getByRole("button", { name: "Arrêter le stream" }).click();
      return `${first} puis ${second}`;
    });
  }
  if (wanted("settings")) {
    await step("paramètres : chaque onglet s'ouvre, les réglages agissent et se rétablissent", async () => {
      const errors: string[] = [];
      alice.page.on("pageerror", e => errors.push(String(e)));
      await alice.page.evaluate(() => (window as any).__store.useApp.setState({ view: "settings" }));
      const tabs = await alice.page.locator(".settings-nav button").allTextContents();
      assert.equal(tabs.length, 10);
      for (const [index, tab] of tabs.entries()) {
        await alice.page.locator(".settings-nav button").nth(index).click();
        await alice.page.locator(".settings-inner h1").first().waitFor();
        await shot(alice, `50-parametres-${index}-${tab.replace(/[^a-zà-ÿ]/gi, "").toLowerCase()}`);
      }
      const nav = alice.page.locator(".settings-nav");
      const data = () => alice.page.evaluate(() => ({ ...document.documentElement.dataset }));
      await nav.getByRole("button", { name: "Apparence" }).click();
      await alice.page.getByRole("radio", { name: "Noir pur" }).click().catch(() => alice.page.getByRole("button", { name: "Noir pur" }).click());
      await poll("thème", data, d => d.theme === "black");
      assert.equal(await alice.page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--bg").trim()), "#000");
      await alice.page.getByRole("switch", { name: "Réduire les animations" }).click();
      await poll("animations", data, d => d.motion === "off");
      await shot(alice, "51-theme-noir");

      await nav.getByRole("button", { name: "Son et voix" }).click();
      await alice.page.getByRole("button", { name: "Tester la sortie" }).click();
      await nav.getByRole("button", { name: "Overlay en jeu" }).click();
      await alice.page.getByRole("button", { name: "Tester l'overlay" }).click();
      await poll("overlay ouvert", () => alice.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), n => n === 2, 5000);
      await poll("overlay refermé", () => alice.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), n => n === 1, 10_000);

      await nav.getByRole("button", { name: "Raccourcis" }).click();
      await alice.page.evaluate(() => (window as any).__core.updateSettings({ hotkeys: { ...(window as any).__store.useApp.getState().settings.hotkeys, marker: "Ctrl+Alt+M" } }));
      await alice.page.getByText(/Déjà pris par/).first().waitFor();
      await alice.page.getByRole("button", { name: "Rétablir les raccourcis d'origine" }).click();
      await alice.page.getByText(/Déjà pris par/).first().waitFor({ state: "detached" });

      await nav.getByRole("button", { name: "Serveur" }).click();
      const address = alice.page.locator(".settings-inner input.input").first();
      assert.equal(await address.inputValue(), serverUrl);

      await nav.getByRole("button", { name: "À propos" }).click();
      await alice.page.getByRole("button", { name: "Rétablir les réglages d'origine" }).click();
      await alice.page.getByRole("button", { name: "Oui, tout rétablir" }).click();
      await poll("réglages rétablis", data, d => d.theme === "dark" && d.motion === "on");
      const name = await alice.page.evaluate(() => (window as any).__store.useApp.getState().settings.profile.name);
      assert.equal(name, "Spoka", "le profil reste");
      assert.deepEqual(errors, []);
      await alice.page.evaluate(() => (window as any).__store.useApp.setState({ view: "room" }));
      return `${tabs.length} onglets`;
    });
  }
  console.log(`${passed} étapes réussies`);
} catch (e) {
  failed = true;
  console.log(`  ✖ ${e}`);
  await a?.page.screenshot({ path: path.join(captures, "party-echec-alice.png"), timeout: 8000 }).catch(() => {});
  await b?.page.screenshot({ path: path.join(captures, "party-echec-bob.png"), timeout: 8000 }).catch(() => {});
} finally {
  await a?.app.close().catch(() => {});
  await b?.app.close().catch(() => {});
  await edge?.close().catch(() => {});
  media.close();
  await server.close();
  rmSync(temp, { recursive: true, force: true, maxRetries: 4 });
}
process.exit(failed ? 1 : 0);
