// Parcours complet avec deux vraies instances de l'application, un vrai serveur et une vraie connexion WebRTC.
//   npm run test:e2e
import assert from "node:assert/strict";
import { execFile, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
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
const temp = mkdtempSync(path.join(tmpdir(), "spokastream-e2e-"));
const electronPath = createRequire(import.meta.url)("electron") as unknown as string;
// npm run test:e2e -- --packaged : le même parcours sur l'application empaquetée, avec ses vrais chemins.
const packaged = process.argv.includes("--packaged");
const packagedExe = process.env.SPOKASTREAM_EXE ?? path.join(root, "dist", "win-unpacked", "SpokaStream.exe");

const store = new MemoryStore();
let server = await startServer({ port: 0, host: "127.0.0.1", store });
const serverPort = server.port;
const serverUrl = `ws://127.0.0.1:${serverPort}/ws`;

interface Peer {
  name: string;
  app: ElectronApplication;
  page: Page;
  errors: string[];
}

const wait = (ms: number) => new Promise(r => setTimeout(r, ms));

async function launch(name: string, extraArgs: string[] = []): Promise<Peer> {
  const app = await electron.launch({
    executablePath: packaged ? packagedExe : electronPath,
    args: [...(packaged ? [] : [root]), ...extraArgs],
    env: { ...process.env, SPOKASTREAM_USER_DATA: path.join(temp, name), SPOKASTREAM_SERVER: serverUrl },
  });
  const page = await app.firstWindow();
  const errors: string[] = [];
  page.on("console", m => {
    if (m.type() === "error") errors.push(m.text());
  });
  page.on("pageerror", e => errors.push(String(e)));
  await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0]!;
    w.setSize(1360, 860);
  });
  return { name, app, page, errors };
}

const steps: { name: string; ms: number; ok: boolean; detail?: string }[] = [];
async function step(name: string, fn: () => Promise<string | void>) {
  const started = Date.now();
  process.stdout.write(`… ${name}\n`);
  try {
    const detail = (await fn()) ?? undefined;
    steps.push({ name, ms: Date.now() - started, ok: true, detail });
    console.log(`  ✔ ${detail ?? ""}`);
  } catch (e) {
    steps.push({ name, ms: Date.now() - started, ok: false, detail: String(e) });
    console.log(`  ✖ ${e}`);
    throw e;
  }
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

/** Déplie un panneau du Studio ou de la régie s'il est replié. */
async function openPanel(peer: Peer, id: string) {
  const title = peer.page.locator(`[data-panel="${id}"] .regie-panel-title`);
  if ((await title.getAttribute("aria-expanded")) === "false") await title.click();
  await peer.page.locator(`[data-panel="${id}"] .regie-panel-body`).waitFor();
}

const shot = (peer: Peer, name: string) => peer.page.screenshot({ path: path.join(captures, `${name}.png`), timeout: 12_000 });

const pattern = spawn(electronPath, [path.join(root, "tests", "e2e", "pattern", "main.cjs")], {
  env: { ...process.env, SPOKASTREAM_PATTERN_DATA: temp },
  stdio: "ignore",
});

let a: Peer | undefined;
let b: Peer | undefined;
let edge: Browser | undefined;
let failed = false;

try {
  await wait(1500);
  // Les faux périphériques donnent aussi une caméra à Alice, pour la bulle du stream.
  a = await launch("alice", ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"]);
  // Bob a un faux micro qui bipe : on peut mesurer que sa voix arrive vraiment chez Alice.
  b = await launch("bob", ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"]);
  const alice = a;
  const bob = b;
  if (packaged) {
    const info = await alice.app.evaluate(({ app }) => ({ packaged: app.isPackaged, version: app.getVersion(), path: app.getPath("exe") }));
    assert.equal(info.packaged, true);
    console.log(`Application empaquetée : ${info.version}, ${info.path}`);
  }

  await step("première ouverture : profil", async () => {
    await alice.page.locator(".onboarding-card").waitFor();
    await shot(alice, "01-accueil-premiere-ouverture");
    for (const peer of [alice, bob]) {
      await peer.page.getByPlaceholder("Comment tes amis te voient").fill(peer.name === "alice" ? "Spoka" : "Pinoy");
      await peer.page.getByRole("button", { name: "C'est parti" }).click();
      await peer.page.getByText(`Salut ${peer.name === "alice" ? "Spoka" : "Pinoy"}`).waitFor();
    }
    await alice.page.getByText("Connecté à").waitFor();
    await poll("moteur audio", () => alice.page.getByText("Capture du son par application prête").count(), n => n > 0);
    await shot(alice, "02-accueil");
  });

  let code = "";
  await step("créer un salon et le rejoindre avec le code", async () => {
    await alice.page.locator(".home-card-primary").click();
    await alice.page.getByPlaceholder("La soirée film, Les potes…").fill("Soirée test");
    await alice.page.getByRole("button", { name: "Créer le salon" }).click();
    await alice.page.locator(".stage-empty").waitFor();
    code = (await alice.page.locator(".room-code").textContent())!.trim();
    assert.equal(code.length, 8);
    const [first, second] = await alice.page.locator(".stage-empty-actions .btn").evaluateAll(buttons => buttons.map(b => b.getBoundingClientRect()).map(r => ({ top: r.top, height: r.height })));
    assert.deepEqual(first, second, "les deux boutons de l'écran vide doivent être alignés");
    await bob.page.getByLabel("Code du salon").fill(code.toLowerCase());
    await bob.page.getByRole("button", { name: "Rejoindre", exact: true }).click();
    await bob.page.locator(".room-head h1").getByText("Soirée test").waitFor();
    await alice.page.getByRole("tab", { name: /Membres/ }).click();
    await alice.page.locator(".member", { hasText: "Pinoy" }).waitFor();
    await shot(alice, "03-salon-vide");
    await alice.page.getByRole("tab", { name: /Chat/ }).click();
    return `code ${code}`;
  });

  await step("chat dans les deux sens", async () => {
    await alice.page.getByRole("textbox", { name: "Message", exact: true }).fill("Salut Pinoy, tu me vois ?");
    await alice.page.keyboard.press("Enter");
    await bob.page.locator(".chat-text", { hasText: "Salut Pinoy" }).waitFor();
    await bob.page.getByRole("textbox", { name: "Message", exact: true }).fill("Pas encore, lance le stream 🔥");
    await bob.page.keyboard.press("Enter");
    await alice.page.locator(".chat-text", { hasText: "lance le stream" }).waitFor();
  });

  await step("choisir une fenêtre sélectionne le son de cette application", async () => {
    await alice.page.getByRole("button", { name: "Diffuser", exact: true }).click();
    await alice.page.locator(".modal").waitFor();
    await alice.page.getByRole("tab", { name: "Fenêtres" }).click();
    const card = alice.page.locator(".source-card", { hasText: "Mire SpokaStream" });
    await card.waitFor({ timeout: 15_000 });
    await card.click();
    await alice.page.locator(".audio-chip").first().waitFor();
    const chip = (await alice.page.locator(".audio-chip").first().textContent())!.trim();
    assert.ok(!/Tout le PC/.test(chip), `son attendu sur l'application, reçu : ${chip}`);
    await alice.page.getByRole("button", { name: "Son", exact: true }).click();
    const menu = alice.page.locator(".popover");
    await menu.locator(".menu-item").first().waitFor();
    await wait(300);
    const box = (await menu.boundingBox())!;
    const page = alice.page.viewportSize() ?? (await alice.page.evaluate(() => ({ width: innerWidth, height: innerHeight })));
    assert.ok(box.x >= 0 && box.y >= 0 && box.x + box.width <= page.width && box.y + box.height <= page.height, `menu hors de la fenêtre : ${JSON.stringify(box)}`);
    const covered = await menu.evaluate((el: HTMLElement) => {
      const r = el.getBoundingClientRect();
      return document.elementFromPoint(r.left + r.width / 2, r.top + 12)?.closest(".popover") === el && document.elementFromPoint(r.right - 8, r.bottom - 8)?.closest(".popover") === el;
    });
    assert.ok(covered, "rien ne doit recouvrir ni couper le menu des sons");
    await shot(alice, "04-menu-des-sons");
    await alice.page.keyboard.press("Escape");
    await alice.page.locator(".popover").waitFor({ state: "detached" });
    await alice.page.locator(".modal").waitFor();
    await shot(alice, "04-lancer-un-stream");
    return `son choisi : ${chip}`;
  });

  await step("lancer le stream : mesure des encodeurs puis direct", async () => {
    await alice.page.getByRole("button", { name: "Lancer le stream" }).click();
    await alice.page.locator(".titlebar-live").waitFor({ timeout: 60_000 });
    const report: string = await alice.page.evaluate(() => (window as any).__core.diagnostics());
    return report.split("\n").filter(l => l.startsWith("Encodeur")).join(" | ");
  });

  await step("le spectateur reçoit automatiquement image et son", async () => {
    const stats = await poll(
      "image reçue",
      () => bob.page.evaluate(() => {
        const video = document.querySelector<HTMLVideoElement>(".tile-video");
        const sub = Object.values<any>((window as any).__store.useApp.getState().subs)[0];
        return { width: video?.videoWidth ?? 0, height: video?.videoHeight ?? 0, state: sub?.state, stats: sub?.stats ?? null, hasAudio: sub?.hasAudio ?? false };
      }),
      v => v.width > 0 && (v.stats?.fps ?? 0) > 10 && v.hasAudio,
      30_000,
    );
    assert.equal(stats.state, "connected");
    return `${stats.width}x${stats.height}, ${stats.stats!.fps} i/s, ${stats.stats!.kbps} kb/s, ${stats.stats!.codec} (${stats.stats!.decoder}), son ${stats.stats!.audioKbps} kb/s`;
  });

  await step("le son de l'application arrive bien chez le spectateur", async () => {
    const level = await poll(
      "niveau audio",
      () =>
        bob.page.evaluate(() => {
          const w = window as any;
          return w.__core.streamLevel(Object.keys(w.__store.useApp.getState().subs)[0]) as number;
        }),
      v => v > 0.15,
    );
    return `niveau mesuré ${(level * 100).toFixed(0)} %`;
  });

  await step("côté diffuseur : encodeur matériel et mesures", async () => {
    const stats = await poll(
      "mesures d'envoi",
      () => alice.page.evaluate(() => (window as any).__store.useApp.getState().publish.stats as { fps: number; kbps: number } | null),
      v => !!v && v.fps > 15 && v.kbps > 100,
    );
    const settled = await poll(
      "pleine définition",
      () => bob.page.evaluate(() => document.querySelector<HTMLVideoElement>(".tile-video")?.videoHeight ?? 0),
      h => h >= 530,
      20_000,
    ).catch(e => String(e));
    await wait(4000);
    const after: any = await alice.page.evaluate(() => (window as any).__store.useApp.getState().publish);
    const fluidity = await alice.page.evaluate(
      () =>
        new Promise<{ raf: number; shown: number }>(resolve => {
          const video = document.querySelector<HTMLVideoElement>(".tile-video")!;
          let raf = 0;
          let shown = 0;
          const tick = () => (raf++, requestAnimationFrame(tick));
          tick();
          const onFrame = () => (shown++, video.requestVideoFrameCallback(onFrame));
          video.requestVideoFrameCallback(onFrame);
          setTimeout(() => resolve({ raf: raf / 2, shown: shown / 2 }), 2000);
        }),
    );
    console.log(`  interface du diffuseur : ${JSON.stringify(fluidity)}`);
    await shot(alice, "05-en-direct-studio");
    await shot(bob, "06-spectateur");
    assert.equal(typeof settled, "number", String(settled));
    assert.equal(after.nativeCapture, true, "la capture native doit être active");
    assert.ok(after.stats.fps >= 48, `cadence trop basse : ${after.stats.fps} i/s`);
    assert.equal(after.stats.hardware, true);
    return `capture native, ${after.stats.width}x${after.stats.height}, ${after.stats.fps} i/s, ${after.stats.codec}, ${after.stats.encMs} ms/img`;
  });

  await step("une fenêtre redimensionnée change la taille du stream sans couper", async () => {
    const resized = spawnSync("powershell", ["-NoProfile", "-Command", `
      Add-Type -Name W -Namespace N -MemberDefinition '[DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern System.IntPtr FindWindow(string c, string t); [DllImport("user32.dll")] public static extern bool SetWindowPos(System.IntPtr h, System.IntPtr a, int x, int y, int w, int cy, uint f);'
      [N.W]::SetWindowPos([N.W]::FindWindow([NullString]::Value, 'Mire SpokaStream'), [System.IntPtr]::Zero, 40, 40, 1280, 720, 0x0040)`]);
    assert.equal(resized.status, 0);
    const height = await poll("nouvelle taille", () => bob.page.evaluate(() => document.querySelector<HTMLVideoElement>(".tile-video")?.videoHeight ?? 0), h => h > 600, 15_000);
    const state = await bob.page.evaluate(() => Object.values<any>((window as any).__store.useApp.getState().subs)[0]?.state);
    assert.equal(state, "connected");
    // Régression : redimensionner la fenêtre de l'overlay figeait la page du diffuseur.
    for (const [width, tall] of [[1000, 800], [1500, 900], [800, 450], [960, 540]]) {
      const moved = spawnSync("powershell", ["-NoProfile", "-Command", `
        Add-Type -Name W -Namespace N -MemberDefinition '[DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern System.IntPtr FindWindow(string c, string t); [DllImport("user32.dll")] public static extern bool SetWindowPos(System.IntPtr h, System.IntPtr a, int x, int y, int w, int cy, uint f);'
        [N.W]::SetWindowPos([N.W]::FindWindow([NullString]::Value, 'Mire SpokaStream'), [System.IntPtr]::Zero, 40, 40, ${width}, ${tall}, 0x0040)`], { timeout: 20_000 });
      assert.equal(moved.status, 0);
      await wait(1200);
      // L'encodeur se réinitialise à chaque nouvelle taille : la page du diffuseur s'arrête, de 1 à plus de 25 s selon ce qui
      // occupe la carte graphique. Ce garde-fou ne vise que le blocage définitif.
      const stalledAt = Date.now();
      const alive = await Promise.race([alice.page.evaluate(() => new Promise(r => requestAnimationFrame(() => r(true)))), wait(60_000).then(() => false)]);
      console.log(`  ${width}x${tall} : page de retour en ${Date.now() - stalledAt} ms`);
      assert.equal(alive, true, `la page du diffuseur ne répond plus après ${width}x${tall}`);
    }
    await alice.page.evaluate(() => new Promise(r => requestAnimationFrame(r)));
    return `hauteur reçue ${height}, 4 redimensionnements de plus sans gel`;
  });

  await step("le port des images refuse qui n'a pas le jeton", async () => {
    const ports = spawnSync("powershell", ["-NoProfile", "-Command", `(Get-Process SpokaAudio | ForEach-Object { Get-NetTCPConnection -State Listen -LocalAddress 127.0.0.1 -OwningProcess $_.Id -ErrorAction SilentlyContinue }).LocalPort`], { timeout: 20_000 });
    const port = String(ports.stdout).trim().split(/\s+/)[0];
    assert.ok(port, "port du moteur introuvable");
    const refused = await bob.page.evaluate(
      p =>
        new Promise<string>(resolve => {
          const socket = new WebSocket(`ws://127.0.0.1:${p}/mauvais-jeton`);
          socket.onopen = () => resolve("accepté");
          socket.onerror = () => resolve("refusé");
          setTimeout(() => resolve("sans réponse"), 5000);
        }),
      port,
    );
    assert.equal(refused, "refusé");
    const state = await bob.page.evaluate(() => Object.values<any>((window as any).__store.useApp.getState().subs)[0]?.state);
    assert.equal(state, "connected");
  });

  await step("réactions et dessin arrivent chez le diffuseur", async () => {
    const tile = bob.page.locator(".tile").first();
    await tile.hover();
    await bob.page.getByRole("button", { name: "Réagir" }).click();
    await bob.page.locator(".reaction-grid button").first().click();
    // Une réaction ne vit que 3 s : si le gel de redimensionnement dure encore, la suivante sera vue.
    await poll(
      "réaction chez le diffuseur",
      async () => {
        await bob.page.evaluate(() => {
          const w = window as any;
          w.__core.react(Object.keys(w.__store.useApp.getState().subs)[0], "🔥");
        });
        return alice.page.locator(".reaction").count();
      },
      n => n > 0,
      20_000,
    );
    await bob.page.getByRole("button", { name: /Dessiner/ }).click();
    const box = (await bob.page.locator(".draw-layer").boundingBox())!;
    await bob.page.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.3);
    await bob.page.mouse.down();
    await bob.page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.5, { steps: 12 });
    await bob.page.mouse.up();
    await wait(400);
    const painted = await alice.page.locator(".draw-layer").first().evaluate((c: HTMLCanvasElement) => {
      const data = c.getContext("2d")!.getImageData(0, 0, c.width, c.height).data;
      for (let i = 3; i < data.length; i += 4) if (data[i]) return true;
      return false;
    });
    assert.ok(painted, "le trait doit apparaître chez le diffuseur");
    await bob.page.getByRole("button", { name: /Dessiner/ }).click();
    await shot(bob, "07-dessin");
  });

  await step("le spectateur baisse sa qualité, le diffuseur s'adapte pour lui seul", async () => {
    await bob.page.locator(".tile").first().hover();
    await bob.page.getByRole("button", { name: "Qualité et latence" }).click();
    await bob.page.getByRole("button", { name: /480p économe/ }).click();
    await poll(
      "image réduite",
      () => bob.page.evaluate(() => document.querySelector<HTMLVideoElement>(".tile-video")?.videoHeight ?? 0),
      h => h > 0 && h <= 480,
      15_000,
    );
  });

  await step("son seul : le diffuseur cesse d'encoder l'image", async () => {
    await bob.page.locator(".tile").first().hover();
    await bob.page.getByRole("button", { name: "Qualité et latence" }).click();
    await bob.page.getByRole("button", { name: /Son seul/ }).click();
    await bob.page.locator(".tile-audio-only").waitFor();
    await bob.page.locator(".tile").first().hover();
    await bob.page.getByRole("button", { name: "Qualité et latence" }).click();
    await bob.page.getByRole("button", { name: /Son seul/ }).click();
    await bob.page.locator(".tile").first().hover();
    await bob.page.getByRole("button", { name: "Qualité et latence" }).click();
    await bob.page.getByRole("button", { name: /Maximum/ }).click();
    await poll("image revenue", () => bob.page.evaluate(() => document.querySelector<HTMLVideoElement>(".tile-video")?.videoHeight ?? 0), h => h > 480, 15_000);
  });

  await step("pause : l'image réelle n'est plus envoyée", async () => {
    await alice.page.getByRole("button", { name: "Pause", exact: true }).click();
    await bob.page.locator(".tile .live-pill", { hasText: "Pause" }).waitFor();
    await poll("carte de pause", () => bob.page.evaluate(() => document.querySelector<HTMLVideoElement>(".tile-video")?.videoWidth ?? 0), w => w === 1280, 10_000);
    await alice.page.getByRole("button", { name: "Reprendre", exact: true }).click();
    await bob.page.locator(".tile .live-pill", { hasText: "En direct" }).waitFor();
  });

  await step("le débit change en direct, sans couper", async () => {
    await openPanel(alice, "quality");
    await alice.page.getByLabel("Débit", { exact: true }).selectOption({ label: "30 Mb/s" });
    await wait(2000);
    const state = await bob.page.evaluate(() => Object.values<any>((window as any).__store.useApp.getState().subs)[0]?.state);
    assert.equal(state, "connected");
  });

  await step("une coupure du serveur ne coupe pas le stream", async () => {
    const framesBefore = await bob.page.evaluate(() => document.querySelector<HTMLVideoElement>(".tile-video")!.getVideoPlaybackQuality().totalVideoFrames);
    await server.close();
    await alice.page.locator(".titlebar-status").waitFor();
    await wait(4000);
    const framesDown = await bob.page.evaluate(() => document.querySelector<HTMLVideoElement>(".tile-video")!.getVideoPlaybackQuality().totalVideoFrames);
    assert.ok(framesDown > framesBefore + 30, `la vidéo doit continuer pendant la coupure (${framesBefore} → ${framesDown})`);
    server = await startServer({ port: serverPort, host: "127.0.0.1", store });
    await poll("retour en ligne", () => alice.page.locator(".titlebar-status").count(), n => n === 0, 20_000);
    await bob.page.locator(".tile .live-pill", { hasText: "En direct" }).waitFor({ timeout: 15_000 });
    await wait(9000);
    const state = await bob.page.evaluate(() => Object.values<any>((window as any).__store.useApp.getState().subs)[0]?.state);
    assert.equal(state, "connected");
    return `${framesDown - framesBefore} images reçues serveur coupé`;
  });

  await step("l'overlay existe, ne prend aucun clic et n'apparaît pas dans la capture", async () => {
    const overlay = await alice.app.evaluate(({ BrowserWindow, screen }) =>
      BrowserWindow.getAllWindows()
        .filter(w => w.isAlwaysOnTop())
        .map(w => ({ focusable: w.isFocusable(), protected: w.isContentProtected(), visible: w.isVisible(), bounds: w.getBounds(), display: screen.getDisplayMatching(w.getBounds()).bounds })),
    );
    assert.equal(overlay.length, 1, JSON.stringify(overlay));
    assert.equal(overlay[0]!.protected, true);
    assert.equal(overlay[0]!.focusable, false);
    assert.deepEqual(overlay[0]!.bounds, overlay[0]!.display, "l'overlay doit couvrir tout l'écran et ne jamais suivre la taille de la fenêtre");
    return JSON.stringify(overlay[0]!.bounds);
  });

  await step("enregistrement sur disque, lisible par ffprobe", async () => {
    await alice.page.evaluate(dir => (window as any).__core.updateSettings({ recordingsDir: dir }), path.join(temp, "enregistrements"));
    await alice.page.getByRole("button", { name: "Enregistrer", exact: true }).click();
    await alice.page.getByRole("button", { name: "Arrêter l'enregistrement" }).waitFor();
    await wait(4000);
    const file: string = await alice.page.evaluate(() => (window as any).__store.useApp.getState().recording.path);
    await alice.page.getByRole("button", { name: "Arrêter l'enregistrement" }).click();
    await poll("fin de l'enregistrement", () => alice.page.evaluate(() => (window as any).__store.useApp.getState().recording), v => v === null);
    const probe = await new Promise<string>((resolve, reject) =>
      execFile("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type,codec_name,width,height", "-of", "csv=p=0", file], (e, out) => (e ? reject(e) : resolve(out))),
    );
    assert.match(probe, /video/);
    assert.match(probe, /audio/);
    return `${path.basename(file)}, ${(statSync(file).size / 2 ** 20).toFixed(1)} Mo : ${probe.trim().replace(/\r?\n/g, " | ")}`;
  });

  await step("clip des dernières secondes, chez le diffuseur et le spectateur", async () => {
    await bob.page.evaluate(dir => (window as any).__core.updateSettings({ recordingsDir: dir }), path.join(temp, "clips-bob"));
    const buffered = (peer: Peer) => peer.page.evaluate(() => (window as any).__core.clipBuffer?.bufferedSeconds as number | undefined);
    await poll("mémoire du diffuseur", () => buffered(alice), v => (v ?? 0) >= 8, 30_000);
    await poll("mémoire du spectateur", () => buffered(bob), v => (v ?? 0) >= 8, 30_000);
    const probe = (file: string) =>
      new Promise<string>((resolve, reject) =>
        execFile("ffprobe", ["-v", "error", "-show_entries", "stream=codec_name,start_time:format=duration,start_time", "-of", "default=nw=1", file], (e, out) => (e ? reject(e) : resolve(out.replace(/\r?\n/g, " ")))),
      );
    const frames = (file: string) =>
      new Promise<number>((resolve, reject) =>
        execFile("ffprobe", ["-v", "error", "-count_frames", "-select_streams", "v", "-show_entries", "stream=nb_read_frames", "-of", "csv=p=0", file], (e, out) => (e ? reject(e) : resolve(Number.parseInt(out)))),
      );
    const clip = async (peer: Peer) => {
      await peer.page.keyboard.press("c");
      const button = peer.page.locator(".toast-action", { hasText: "Revoir" });
      await button.waitFor({ timeout: 8000 });
      const dir = await peer.page.evaluate(() => (window as any).__store.useApp.getState().settings.recordingsDir as string);
      const file = readdirSync(dir).map(f => path.join(dir, f)).filter(f => /Clip .*\.mp4$/.test(f)).sort().at(-1)!;
      await peer.page.evaluate(() => (window as any).__store.useApp.setState({ toasts: [] }));
      const info = await probe(file);
      assert.match(info, /h264/, info);
      assert.match(info, /aac/, info);
      const seconds = Number(info.match(/duration=([\d.]+)/)?.[1]);
      const start = Number(info.match(/start_time=([\d.]+)/)?.[1]);
      const count = await frames(file);
      assert.ok(seconds >= 6, `clip trop court : ${info}`);
      assert.ok(start < 1, `le clip doit repartir de zéro : ${info}`);
      assert.ok(count > seconds * 15, `images manquantes : ${count} pour ${seconds} s`);
      return `${path.basename(file).slice(0, 24)}… ${seconds.toFixed(1)} s, ${count} images, ${(statSync(file).size / 2 ** 20).toFixed(1)} Mo`;
    };
    return `${await clip(alice)} | ${await clip(bob)}`;
  });

  let clipBytes = 0;
  await step("revoir, couper et envoyer : le clip part de PC à PC", async () => {
    await alice.page.getByRole("tab", { name: /Chat/ }).click();
    await bob.page.locator("body").click({ position: { x: 300, y: 8 } });
    await bob.page.keyboard.press("r");
    const player = bob.page.locator(".clip-video");
    await player.waitFor({ timeout: 8000 });
    await poll("clip lisible", () => player.evaluate((v: HTMLVideoElement) => v.readyState), s => s >= 2, 10_000);
    const full = await player.evaluate((v: HTMLVideoElement) => v.duration);
    const steps = Number(await bob.page.getByLabel("Fin du clip").getAttribute("max"));
    assert.ok(steps >= 6, `fragments disponibles : ${steps}`);
    await bob.page.getByLabel("Début du clip").fill("2");
    await bob.page.getByLabel("Fin du clip").fill(String(steps - 1));
    await shot(bob, "21-revoir-et-couper");
    await bob.page.getByRole("button", { name: "Envoyer au salon" }).click();
    await bob.page.getByRole("button", { name: "Envoyé" }).waitFor();
    await bob.page.getByRole("button", { name: "Fermer" }).click();

    const card = alice.page.locator(".chat-clip");
    await card.waitFor({ timeout: 8000 });
    clipBytes = await alice.page.evaluate(() => (window as any).__store.useApp.getState().room.history.at(-1).clip.bytes as number);
    await card.click();
    const received = alice.page.locator(".clip-video");
    await received.waitFor({ timeout: 20_000 });
    await poll("clip reçu lisible", () => received.evaluate((v: HTMLVideoElement) => v.readyState), s => s >= 2, 10_000);
    const seconds = await received.evaluate((v: HTMLVideoElement) => v.duration);
    assert.ok(seconds > 2 && seconds < full - 1.5, `la coupe doit se voir : ${seconds} s sur ${full} s`);
    await shot(alice, "22-clip-recu");

    await alice.page.getByRole("button", { name: "Garder le fichier" }).click();
    await alice.page.getByRole("button", { name: "Voir le fichier" }).waitFor();
    const dir = await alice.page.evaluate(() => (window as any).__store.useApp.getState().settings.recordingsDir as string);
    const file = readdirSync(dir).map(f => path.join(dir, f)).filter(f => /Clip .*\.mp4$/.test(f)).sort((x, y) => statSync(x).mtimeMs - statSync(y).mtimeMs).at(-1)!;
    assert.equal(statSync(file).size, clipBytes, "le fichier reçu doit être identique octet pour octet");
    await alice.page.getByRole("button", { name: "Fermer" }).click();
    await alice.page.evaluate(() => (window as any).__store.useApp.setState({ toasts: [] }));
    return `${seconds.toFixed(1)} s sur ${full.toFixed(1)} s, ${(clipBytes / 2 ** 20).toFixed(1)} Mo transférés de Pinoy à Spoka`;
  });

  let phone: Page | undefined;
  await step("lecteur web : le lien d'invitation s'ouvre sur un téléphone, sans rien installer", async () => {
    edge = await chromium.launch({ channel: "msedge", headless: true, args: ["--autoplay-policy=no-user-gesture-required", "--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"] });
    const context = await edge.newContext({ ...devices["Pixel 7"], permissions: ["microphone"] });
    phone = await context.newPage();
    const webErrors: string[] = [];
    phone.on("pageerror", e => webErrors.push(String(e)));
    await phone.goto(`http://127.0.0.1:${serverPort}/j/${code}`);
    await phone.waitForURL(/\/w\//);
    await phone.getByLabel("Ton nom").fill("Téléphone");
    await phone.getByRole("button", { name: "Regarder" }).click();
    const seen = await poll("image sur le téléphone", () => phone!.evaluate(() => (document.getElementById("video") as HTMLVideoElement).videoHeight), h => h > 0, 30_000);
    await alice.page.getByRole("tab", { name: /Membres/ }).click();
    await alice.page.locator(".member", { hasText: "Téléphone" }).getByLabel("Dans un navigateur").waitFor();
    await alice.page.getByRole("tab", { name: /Chat/ }).click();
    assert.ok(seen <= 720, `un téléphone reçoit 720p au plus par défaut : ${seen}`);
    await poll("son sur le téléphone", () => phone!.evaluate(() => (document.getElementById("video") as HTMLVideoElement).srcObject && !(document.getElementById("video") as HTMLVideoElement).paused), Boolean, 10_000);
    assert.equal(await phone.evaluate(() => (document.getElementById("video") as HTMLVideoElement).muted), false, "le son doit rester actif après le clic sur Regarder");
    assert.equal(await phone.locator(".tap-button").isVisible(), false);

    await phone.getByRole("textbox", { name: "Message" }).fill("Je regarde depuis mon téléphone");
    await phone.keyboard.press("Enter");
    await alice.page.locator(".chat-text", { hasText: "depuis mon téléphone" }).waitFor();
    await bob.page.getByRole("textbox", { name: "Message", exact: true }).fill("Bien reçu sur le téléphone ?");
    await bob.page.keyboard.press("Enter");
    await phone.locator(".message", { hasText: "Bien reçu" }).waitFor();
    await phone.getByRole("button", { name: "Réactions" }).click();
    await phone.getByRole("button", { name: "Réagir 🔥", exact: true }).click();
    await alice.page.locator(".reaction").first().waitFor({ timeout: 5000 });

    await phone.locator("button.clip").first().scrollIntoViewIfNeeded();
    await phone.locator("button.clip").first().click();
    const player = phone.locator("#clip-video");
    await player.waitFor({ timeout: 20_000 });
    await poll("clip sur le téléphone", () => player.evaluate((v: HTMLVideoElement) => v.readyState), s => s >= 2, 10_000);
    await phone.locator(".clip-view button").click();

    await phone.screenshot({ path: path.join(captures, "23-lecteur-web.png") });
    assert.deepEqual(webErrors, []);
    return `image ${seen}p dans Edge en téléphone, chat, réaction et clip reçus`;
  });

  await step("interface mobile : tous les formats, volets, qualité, laser, retour à l'accueil", async () => {
    const page = phone!;
    const noOverflow = async (label: string) => {
      const extra = await page.evaluate(() => {
        const width = innerWidth;
        const wide = [...document.querySelectorAll<HTMLElement>("#root *")].filter(e => {
          const r = e.getBoundingClientRect();
          return r.width > 0 && r.right > width + 1 && !e.closest(".panes") && getComputedStyle(e).position !== "absolute";
        });
        return { scroll: document.documentElement.scrollWidth - width, wide: wide.slice(0, 3).map(e => `${e.tagName}.${e.className}`) };
      });
      assert.ok(extra.scroll <= 0 && extra.wide.length === 0, `${label} déborde : ${JSON.stringify(extra)}`);
    };
    const reveal = async () => {
      const shown = await page.locator(".stage.shows-controls").count();
      if (!shown) await page.locator(".stage").click({ position: { x: 60, y: 60 } });
      await page.locator(".stage.shows-controls").waitFor();
    };

    for (const [label, width, height] of [["petit téléphone", 320, 568], ["grand téléphone", 430, 932], ["tablette", 820, 1180], ["ordinateur", 1280, 800]] as const) {
      await page.setViewportSize({ width, height });
      await wait(300);
      await noOverflow(label);
      const stage = (await page.locator(".stage").boundingBox())!;
      assert.ok(stage.width > 200 && stage.height > 100, `${label} : image trop petite ${JSON.stringify(stage)}`);
    }
    await page.screenshot({ path: path.join(captures, "31-web-ordinateur.png") });

    // Paysage : l'image prend tout, et le chat vient en volet par-dessus.
    await page.setViewportSize({ width: 915, height: 412 });
    await wait(300);
    await noOverflow("téléphone en paysage");
    const landscape = (await page.locator(".stage").boundingBox())!;
    assert.ok(landscape.height >= 400 && landscape.width >= 900, `l'image doit remplir l'écran en paysage : ${JSON.stringify(landscape)}`);
    await reveal();
    await page.getByRole("button", { name: "Afficher le chat" }).click();
    await page.locator(".room.chat-open").waitFor();
    await wait(350);
    const drawer = (await page.locator(".panes").boundingBox())!;
    assert.ok(drawer.x > 400 && drawer.x + drawer.width <= 916, `volet mal placé : ${JSON.stringify(drawer)}`);
    await page.screenshot({ path: path.join(captures, "32-web-paysage.png") });
    await page.getByRole("button", { name: "Fermer le panneau" }).click();
    await page.locator(".room.chat-open").waitFor({ state: "detached" });

    await page.setViewportSize({ width: 412, height: 915 });
    await wait(300);

    // Le plein écran ne doit jamais mettre l'image en pause, et en sortir non plus.
    await reveal();
    await page.getByRole("button", { name: "Plein écran" }).click();
    await page.locator(".room.is-full").waitFor();
    await reveal();
    await page.getByRole("button", { name: "Quitter le plein écran" }).click();
    await page.locator(".room.is-full").waitFor({ state: "detached" });
    await wait(500);
    assert.equal(await page.evaluate(() => (document.getElementById("video") as HTMLVideoElement).paused), false, "l'image doit continuer après le plein écran");

    // Qualité : un choix demandé pour ce téléphone seul.
    await reveal();
    await page.getByRole("button", { name: "Qualité" }).click();
    await page.getByRole("dialog", { name: "Qualité" }).waitFor();
    await wait(350);
    await page.screenshot({ path: path.join(captures, "33-web-qualite.png") });
    await page.getByRole("button", { name: /^480p/ }).click();
    await page.getByRole("dialog", { name: "Qualité" }).waitFor({ state: "detached" });

    // Pointeur laser au doigt : il arrive sur l'image du diffuseur.
    await reveal();
    await page.getByRole("button", { name: /Pointeur laser/ }).click();
    const box = (await page.locator(".strokes").boundingBox())!;
    await page.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.3);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.7, box.y + box.height * 0.6, { steps: 8 });
    const painted = await poll(
      "laser chez le diffuseur",
      () => alice.page.locator(".tile-own .draw-layer").first().evaluate((c: HTMLCanvasElement) => {
        const data = c.getContext("2d")!.getImageData(0, 0, c.width, c.height).data;
        for (let i = 3; i < data.length; i += 4) if (data[i]) return true;
        return false;
      }),
      Boolean,
      5000,
    );
    await page.mouse.up();
    assert.ok(painted);
    await page.getByRole("button", { name: /Pointeur laser/ }).click();

    // Répondre à un message, et le salon côté personnes.
    await bob.page.getByRole("textbox", { name: "Message", exact: true }).fill("Tu me réponds ?");
    await bob.page.keyboard.press("Enter");
    await page.locator(".message", { hasText: "Tu me réponds" }).click();
    await page.getByRole("button", { name: "Répondre" }).click();
    await page.getByRole("textbox", { name: "Message" }).fill("Oui, depuis le téléphone");
    await page.keyboard.press("Enter");
    await alice.page.locator(".chat-reply", { hasText: "Tu me réponds" }).waitFor({ state: "attached", timeout: 5000 });
    await page.getByRole("tab", { name: /Salon/ }).click();
    await page.locator(".member", { hasText: "Spoka" }).waitFor();
    await page.screenshot({ path: path.join(captures, "34-web-salon.png") });
    await page.getByRole("tab", { name: /Chat/ }).click();

    // L'accueil retient le salon, avec qui est en direct.
    await page.getByRole("button", { name: "Revenir à mes salons" }).click();
    await page.locator(".recent", { hasText: "Spoka en direct" }).waitFor({ timeout: 8000 });
    await page.screenshot({ path: path.join(captures, "35-web-accueil.png") });
    await page.locator(".recent-open").first().click();
    await page.locator(".stage").waitFor();
    await poll("image après le retour", () => page.evaluate(() => (document.getElementById("video") as HTMLVideoElement).videoHeight), h => h > 0, 20_000);
    return "320 à 1280 px sans débordement, paysage, plein écran, qualité, laser, réponse, salons retenus";
  });

  // SKIP_CONTROL : une boîte de sécurité Windows peut garder le premier plan pour un binaire tout juste extrait.
  await (process.env.SKIP_CONTROL ? (async () => {}) as typeof step : step)("prendre la main : le diffuseur accepte, les gestes arrivent, et seulement là où il faut", async () => {
    const log = path.join(temp, "input.log");
    const inputs = () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as { type: string; code: string; button: number; x: number; y: number }) : []);
    const focus = async (peer: Peer | null) => {
      const hwnd = peer ? await peer.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.getNativeWindowHandle().readBigInt64LE().toString()) : null;
      const target = hwnd ? `[System.IntPtr]::new(${hwnd})` : `[N.F]::FindWindow([NullString]::Value, 'Mire SpokaStream')`;
      const run = spawnSync("powershell", ["-NoProfile", "-Command", `
        Add-Type -Name F -Namespace N -MemberDefinition '[DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern System.IntPtr FindWindow(string c, string t); [DllImport("user32.dll")] public static extern bool SetForegroundWindow(System.IntPtr h); [DllImport("user32.dll")] public static extern void SwitchToThisWindow(System.IntPtr h, bool a); [DllImport("user32.dll")] public static extern void keybd_event(byte k, byte s, uint f, System.UIntPtr e);'
        # Windows refuse parfois le premier plan quand quelqu'un se sert du PC pendant le test : Alt seul ne suffit pas toujours.
        $w = ${target}; [N.F]::keybd_event(0x12, 0, 0, [System.UIntPtr]::Zero); [void][N.F]::SetForegroundWindow($w); [N.F]::SwitchToThisWindow($w, $true); [N.F]::keybd_event(0x12, 0, 2, [System.UIntPtr]::Zero)`], { timeout: 20_000 });
      assert.equal(run.status, 0, String(run.stderr));
    };

    await bob.page.locator(".tile").first().hover();
    await bob.page.getByRole("button", { name: /Demander la main/ }).click();
    await alice.page.getByRole("dialog", { name: "Pinoy demande la main" }).waitFor({ timeout: 8000 });
    await shot(alice, "24-demande-de-main");
    assert.equal(inputs().length, 0, "rien ne doit passer avant l'accord");
    await alice.page.getByRole("button", { name: "Donner la main" }).click();
    await bob.page.locator(".hand-bar").waitFor({ timeout: 8000 });
    await poll("la mire au premier plan", async () => {
      await focus(null);
      await bob.page.keyboard.press("F1");
      await wait(300);
      return inputs().some(i => i.type === "keydown" && i.code === "F1");
    }, Boolean, 10_000).catch(e => {
      // Quand Windows garde le premier plan ailleurs, savoir qui le tient évite de chercher au mauvais endroit.
      const held = spawnSync("powershell", ["-NoProfile", "-Command", `
        Add-Type -Name G -Namespace N -MemberDefinition '[DllImport("user32.dll")] public static extern System.IntPtr GetForegroundWindow(); [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(System.IntPtr h, out uint p);'
        $p = 0; [void][N.G]::GetWindowThreadProcessId([N.G]::GetForegroundWindow(), [ref]$p); $g = Get-Process -Id $p; "$($g.ProcessName) : $($g.MainWindowTitle)"`], { timeout: 20_000 });
      throw new Error(`${e.message} ; premier plan tenu par ${String(held.stdout).trim()}`);
    });
    await shot(bob, "25-la-main");

    const layer = (await bob.page.locator(".hand-layer").boundingBox())!;
    await bob.page.mouse.move(layer.x + layer.width * 0.25, layer.y + layer.height * 0.6);
    await bob.page.mouse.down();
    await bob.page.mouse.up();
    await bob.page.mouse.click(layer.x + layer.width * 0.7, layer.y + layer.height * 0.4, { button: "right" });
    await bob.page.mouse.wheel(0, 100);
    await bob.page.keyboard.press("w");
    await bob.page.keyboard.press("ArrowLeft");
    const click = await poll("clic reçu", async () => inputs().find(i => i.type === "mousedown" && i.button === 0), Boolean, 8000);
    assert.ok(Math.abs(click!.x - 0.25) < 0.03, `clic à ${click!.x} au lieu de 0,25`);
    assert.ok(Math.abs(click!.y - 0.6) < 0.1, `clic à ${click!.y} au lieu de 0,6`);
    await poll("clic droit, molette et touches reçus", async () => inputs().map(i => (i.type === "mousedown" ? `b${i.button}` : i.type === "keydown" ? i.code : i.type)), got => ["b2", "wheel", "KeyW", "ArrowLeft"].every(g => got.includes(g)), 8000);

    // Alt+F4 fermerait le jeu, et la touche Windows n'existe pas dans le moteur.
    await bob.page.keyboard.down("Alt");
    await bob.page.keyboard.press("F4");
    await bob.page.keyboard.up("Alt");
    await bob.page.keyboard.press("Meta");
    await bob.page.keyboard.press("Control+Alt+s");
    await bob.page.keyboard.press("F2");
    await poll("touche témoin", async () => inputs().some(i => i.code === "F2"), Boolean, 8000);
    const passed = inputs().map(i => i.code);
    assert.ok(!passed.includes("F4") && !passed.includes("MetaLeft") && !passed.includes("KeyS"), `touche interdite reçue : ${passed.join(" ")}`);
    assert.ok(await alice.page.locator(".titlebar-live").isVisible(), "un raccourci envoyé par le spectateur ne doit pas couper le stream");

    // Le diffuseur quitte la fenêtre : plus rien ne passe, et l'ami le voit.
    await focus(alice);
    await bob.page.keyboard.press("F3");
    await bob.page.locator(".hand-bar .is-blocked").waitFor({ timeout: 6000 });
    await bob.page.keyboard.press("F6");
    await wait(600);
    assert.ok(!inputs().some(i => i.code === "F3" || i.code === "F6"), "une autre fenêtre ne doit rien recevoir");

    await focus(null);
    await poll("retour sur la fenêtre", async () => {
      await bob.page.keyboard.press("F7");
      await wait(300);
      return inputs().some(i => i.code === "F7");
    }, Boolean, 8000);

    // Reprendre la main relâche ce que l'ami tenait enfoncé.
    await poll("touche tenue", async () => {
      await focus(null);
      await bob.page.keyboard.down("d");
      await wait(300);
      return inputs().some(i => i.type === "keydown" && i.code === "KeyD");
    }, Boolean, 10_000);
    const hotkey = spawnSync("powershell", ["-NoProfile", "-Command", `
      Add-Type -Name K -Namespace N -MemberDefinition '[DllImport("user32.dll")] public static extern void keybd_event(byte k, byte s, uint f, System.UIntPtr e);'
      foreach ($k in 0x11, 0x12, 0x41) { [N.K]::keybd_event($k, 0, 0, [System.UIntPtr]::Zero) }
      foreach ($k in 0x41, 0x12, 0x11) { [N.K]::keybd_event($k, 0, 2, [System.UIntPtr]::Zero) }`], { timeout: 20_000 });
    assert.equal(hotkey.status, 0);
    await bob.page.locator(".hand-bar").waitFor({ state: "detached", timeout: 6000 });
    await poll("touche relâchée", async () => inputs().some(i => i.type === "keyup" && i.code === "KeyD"), Boolean, 5000);
    await bob.page.keyboard.up("d");
    const count = inputs().length;
    await bob.page.keyboard.press("F9");
    await wait(500);
    assert.equal(inputs().length, count, "plus rien ne passe après la reprise");

    // Refuser une fois, puis insister tout de suite : la seconde demande ne dérange même pas le diffuseur.
    const ask = async () => {
      await bob.page.locator(".tile").first().hover();
      await bob.page.getByRole("button", { name: /Demander la main/ }).click();
    };
    await wait(10_500);
    await ask();
    await alice.page.getByRole("dialog", { name: "Pinoy demande la main" }).waitFor({ timeout: 8000 });
    await alice.page.getByRole("button", { name: "Refuser" }).click();
    await bob.page.locator(".toast", { hasText: "Demande refusée" }).waitFor({ timeout: 5000 });
    await bob.page.evaluate(() => (window as any).__store.useApp.setState({ toasts: [] }));
    await ask();
    await bob.page.locator(".toast", { hasText: "Demande refusée" }).waitFor({ timeout: 5000 });
    assert.equal(await alice.page.getByRole("dialog", { name: "Pinoy demande la main" }).count(), 0, "insister ne doit pas rouvrir la demande");
    await bob.page.evaluate(() => (window as any).__store.useApp.setState({ toasts: [] }));
    return `${inputs().length} gestes reçus par la mire, aucun geste interdit`;
  });

  await step("le chat : réactions, mentions, écrit…, épingle, image", async () => {
    await bob.page.getByRole("textbox", { name: "Message", exact: true }).focus();
    await bob.page.keyboard.type("@Sp");
    await bob.page.locator(".chat-suggestions button", { hasText: "@Spoka" }).waitFor();
    await alice.page.locator(".chat-typing", { hasText: "Pinoy écrit" }).first().waitFor({ state: "attached", timeout: 5000 }).catch(() => alice.page.getByRole("tab", { name: /Chat/ }).click());
    await bob.page.keyboard.press("Tab");
    await bob.page.keyboard.type("regarde ça");
    await bob.page.keyboard.press("Enter");
    await alice.page.getByRole("tab", { name: /Chat/ }).click();
    const mention = alice.page.locator(".chat-message.is-mentioned", { hasText: "regarde ça" });
    await mention.waitFor();
    await mention.locator(".mention").waitFor();

    await mention.hover();
    await mention.getByRole("button", { name: "Réagir au message" }).click();
    await alice.page.locator(".popover .reaction-grid button").first().click();
    await bob.page.locator(".chat-reactions button", { hasText: "1" }).waitFor();

    await mention.hover();
    await mention.getByRole("button", { name: "Épingler" }).click();
    await bob.page.locator(".chat-pinned", { hasText: "regarde ça" }).waitFor();

    const picture = path.join(temp, "image.png");
    await new Promise<void>((resolve, reject) => execFile("ffmpeg", ["-y", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=size=1920x1080:duration=1", "-frames:v", "1", picture], e => (e ? reject(e) : resolve())));
    await bob.page.locator(".chat-input input[type=file]").setInputFiles(picture);
    await bob.page.locator(".chat-attachment img").waitFor();
    await bob.page.getByLabel("Envoyer").click();
    await alice.page.locator(".chat-image img").waitFor();
    const width = await alice.page.locator(".chat-image img").evaluate((i: HTMLImageElement) => i.naturalWidth);
    assert.ok(width > 0 && width <= 1280, `image réduite attendue : ${width}`);
    await shot(alice, "12-chat");
    await alice.page.locator(".chat-image").click();
    await alice.page.locator(".lightbox img").waitFor();
    await alice.page.keyboard.press("Escape");
    return `image reçue en ${width} px`;
  });

  await step("sondage : création, vote en direct, résultat", async () => {
    await alice.page.getByRole("button", { name: "Ajouter", exact: true }).click();
    await alice.page.getByRole("button", { name: "Lancer un sondage" }).click();
    await alice.page.getByPlaceholder("On regarde quoi ce soir ?").fill("On regarde quoi ?");
    await alice.page.getByLabel("Choix 1").fill("Un film");
    await alice.page.getByLabel("Choix 2").fill("Une série");
    await alice.page.getByRole("button", { name: "Lancer le sondage" }).click();
    await bob.page.locator(".poll-option", { hasText: "Une série" }).click();
    await alice.page.locator(".poll-option", { hasText: "Une série" }).getByText("100 %").waitFor();
    await alice.page.locator(".poll").getByRole("button", { name: "Terminer" }).click();
    await bob.page.locator(".poll.is-closed").waitFor();
    await shot(bob, "13-sondage");
    await alice.page.getByRole("button", { name: "Retirer le sondage" }).click();
    await bob.page.locator(".poll").waitFor({ state: "detached" });
  });

  await step("lecteur : mode cinéma, chat sur l'image, zoom, raccourcis, aide", async () => {
    await bob.page.locator("body").click({ position: { x: 300, y: 8 } });
    await bob.page.keyboard.press("t");
    await bob.page.locator(".room.is-cinema").waitFor();
    assert.equal(await bob.page.locator(".room-head").isVisible(), false);
    assert.equal(await bob.page.locator(".panel").count(), 0);
    await alice.page.getByRole("textbox", { name: "Message", exact: true }).fill("Tu me lis en plein film ?");
    await alice.page.keyboard.press("Enter");
    await bob.page.locator(".floating-line", { hasText: "Tu me lis" }).waitFor();
    await bob.page.locator("body").click({ position: { x: 300, y: 8 } });
    await bob.page.keyboard.press("Enter");
    await bob.page.locator(".floating-input").fill("Oui !");
    await bob.page.keyboard.press("Enter");
    await alice.page.locator(".chat-text", { hasText: "Oui !" }).waitFor();
    await shot(bob, "14-mode-cinema");

    const tile = (await bob.page.locator(".tile").first().boundingBox())!;
    await bob.page.mouse.move(tile.x + tile.width * 0.3, tile.y + tile.height * 0.3);
    await bob.page.keyboard.down("Control");
    for (let i = 0; i < 5; i++) await bob.page.mouse.wheel(0, -120);
    await bob.page.keyboard.up("Control");
    await bob.page.locator(".tile-chip.is-button", { hasText: "Zoom" }).waitFor();
    const zoomed = await bob.page.locator(".tile-canvas").first().evaluate((c: HTMLElement) => c.style.transform);
    assert.match(zoomed, /scale\(2\.\d+\)/, zoomed);
    await bob.page.keyboard.press("0");
    await bob.page.locator(".tile-chip.is-button").waitFor({ state: "detached" });

    const muted = () => bob.page.evaluate(() => Object.values<any>((window as any).__store.useApp.getState().subs)[0].muted as boolean);
    await bob.page.keyboard.press("m");
    assert.equal(await muted(), true);
    await bob.page.keyboard.press("m");
    assert.equal(await muted(), false);
    await bob.page.keyboard.press("Escape");
    await bob.page.locator(".room.is-cinema").waitFor({ state: "detached" });
    await bob.page.keyboard.press("?");
    await bob.page.getByRole("dialog", { name: "Raccourcis clavier" }).waitFor();
    await shot(bob, "15-raccourcis");
    await bob.page.keyboard.press("Escape");
  });

  await step("palette : tout se trouve au clavier", async () => {
    await bob.page.keyboard.press("Control+k");
    await bob.page.getByLabel("Rechercher").fill("cinema");
    await shot(bob, "16-palette");
    await bob.page.keyboard.press("Enter");
    await bob.page.locator(".room.is-cinema").waitFor();
    await bob.page.keyboard.press("Escape");
  });

  await step("bulle caméra : envoyée à côté de l'image, sans la toucher", async () => {
    await alice.page.getByRole("tab", { name: "Studio" }).click();
    await alice.page.getByRole("button", { name: "Ajouter ma caméra" }).click();
    const width = await poll("caméra reçue", () => bob.page.evaluate(() => document.querySelector<HTMLVideoElement>(".tile-cam video")?.videoWidth ?? 0), w => w > 0, 20_000);
    const main = await bob.page.evaluate(() => document.querySelector<HTMLVideoElement>(".tile-video")?.videoWidth ?? 0);
    const state = await bob.page.evaluate(() => Object.values<any>((window as any).__store.useApp.getState().subs)[0]?.state);
    assert.equal(state, "connected");
    assert.ok(main > width, `l'image principale doit rester celle du stream : ${main}, caméra ${width}`);
    await shot(bob, "17-bulle-camera");
    return `caméra ${width} px, image ${main} px`;
  });

  await step("caméra : on la place et on la redimensionne, tout le monde suit", async () => {
    const camera = alice.page.locator(".tile-cam.is-editable");
    const from = (await camera.boundingBox())!;
    const tile = (await alice.page.locator(".tile-own").boundingBox())!;
    await alice.page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await alice.page.mouse.down();
    await alice.page.mouse.move(tile.x + tile.width * 0.2, tile.y + tile.height * 0.25, { steps: 12 });
    await alice.page.mouse.up();
    const handle = (await alice.page.locator(".tile-cam-handle").boundingBox())!;
    await alice.page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
    await alice.page.mouse.down();
    await alice.page.mouse.move(handle.x + 90, handle.y + 50, { steps: 8 });
    await alice.page.mouse.up();
    await alice.page.getByRole("radio", { name: "Ronde" }).click();
    await bob.page.locator(".tile-cam.is-circle").waitFor({ timeout: 5000 });
    const layout = await alice.page.evaluate(() => (window as any).__store.useApp.getState().publish.cameraLayout as { x: number; y: number; width: number });
    assert.ok(layout.x < 0.35 && layout.y < 0.4, `caméra mal placée : ${JSON.stringify(layout)}`);
    assert.ok(layout.width > 0.2, `caméra pas agrandie : ${layout.width}`);
    // Mesuré dans l'image, pas dans la fenêtre : les bandes noires ne sont pas les mêmes chez chacun.
    const placed = await bob.page.evaluate(() => {
      const video = document.querySelector<HTMLVideoElement>(".tile-video")!;
      const box = video.getBoundingClientRect();
      const scale = Math.min(box.width / video.videoWidth, box.height / video.videoHeight);
      const left = box.left + (box.width - video.videoWidth * scale) / 2;
      const top = box.top + (box.height - video.videoHeight * scale) / 2;
      const cam = document.querySelector(".tile-cam")!.getBoundingClientRect();
      return { x: (cam.left - left) / (video.videoWidth * scale), y: (cam.top - top) / (video.videoHeight * scale), width: cam.width / (video.videoWidth * scale) };
    });
    for (const key of ["x", "y", "width"] as const) assert.ok(Math.abs(placed[key] - layout[key]) < 0.02, `${key} : ${placed[key]} chez le spectateur, ${layout[key]} chez le diffuseur`);
    await poll("caméra sur le téléphone", () => phone!.evaluate(() => document.querySelector(".camera-host")!.className), c => c.includes("is-circle"), 6000);
    const overflow = await alice.page.locator(".studio").evaluate((s: HTMLElement) => {
      const right = s.getBoundingClientRect().left + s.clientWidth;
      const wide = [...s.querySelectorAll("*")].filter(e => e.getBoundingClientRect().right > right + 1).slice(0, 4);
      return { px: s.scrollWidth - s.clientWidth, wide: wide.map(e => `${e.tagName}.${e.className}`) };
    });
    assert.ok(overflow.px <= 0, `le Studio déborde de ${overflow.px} px avec la caméra allumée : ${overflow.wide.join(", ")}`);
    await shot(alice, "26-camera-placee");
    await shot(bob, "27-camera-chez-le-spectateur");
    return `x ${layout.x.toFixed(2)}, y ${layout.y.toFixed(2)}, largeur ${layout.width.toFixed(2)}, identique chez le spectateur`;
  });

  await step("scènes : bandeau, enregistrement, et OBS comme source avec reprise automatique", async () => {
    const saveScene = async (name: string) => {
      await alice.page.getByRole("button", { name: "Enregistrer cette scène" }).click();
      await alice.page.getByLabel("Nom de la nouvelle scène").fill(name);
      await alice.page.keyboard.press("Enter");
      await alice.page.locator(".scene.is-on", { hasText: name }).waitFor();
    };
    await openPanel(alice, "info");
    await alice.page.getByLabel("Bandeau sur l'image").fill("Partie classée");
    await alice.page.keyboard.press("Enter");
    await bob.page.locator(".tile-banner", { hasText: "Partie classée" }).waitFor({ timeout: 5000 });
    await phone!.locator("#banner", { hasText: "Partie classée" }).waitFor({ timeout: 5000 });
    await saveScene("Jeu");

    const info: { url: string; key: string } = await alice.page.evaluate(() => (window as any).spoka.obsInfo());
    assert.equal((await fetch(info.url, { method: "POST", body: "v=0" })).status, 401);
    // ffmpeg parle WHIP comme OBS : tests/e2e/obs.ts fait le même chemin avec le vrai logiciel.
    const push = () =>
      spawn("ffmpeg", ["-hide_banner", "-loglevel", "error", "-re", "-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=30", "-f", "lavfi", "-i", "sine=frequency=520", "-c:v", "libx264", "-preset", "ultrafast", "-tune", "zerolatency", "-profile:v", "baseline", "-pix_fmt", "yuv420p", "-bf", "0", "-g", "30", "-b:v", "4M", "-c:a", "libopus", "-ar", "48000", "-ac", "2", "-b:a", "128k", "-f", "whip", "-whip_flags", "dtls_active", "-authorization", info.key, info.url], { stdio: ["pipe", "ignore", "inherit"] });
    const obsConnected = () => alice.page.evaluate(() => (window as any).__store.useApp.getState().obs.connected as boolean);
    const received = () => bob.page.evaluate(() => document.querySelector<HTMLVideoElement>(".tile-video")?.videoWidth ?? 0);
    let sender = push();
    try {
      await poll("OBS connecté", obsConnected, Boolean, 20_000);
      await alice.page.getByRole("button", { name: "Changer" }).click();
      await alice.page.getByRole("tab", { name: "OBS" }).click();
      await alice.page.locator(".obs-state.is-on").waitFor();
      await shot(alice, "28-obs-connecte");
      await alice.page.locator(".modal").getByRole("button", { name: "Changer", exact: true }).click();
      await poll("image d'OBS", received, w => w === 1280, 20_000);
      await alice.page.locator(".mix-row", { hasText: "OBS" }).waitFor();
      const level = await poll(
        "son d'OBS",
        () => alice.page.evaluate(() => {
          const w = window as any;
          const mix = w.__store.useApp.getState().publish.mix.find((m: { label: string }) => m.label === "OBS");
          return (mix ? w.__core.mixLevels()[mix.id] : 0) as number;
        }),
        v => v > 0.2,
        10_000,
      );
      await saveScene("Depuis OBS");

      await alice.page.locator(".scene", { hasText: "Jeu" }).getByRole("button", { name: "Jeu", exact: true }).click();
      await poll("retour sur la fenêtre", received, w => w > 0 && w !== 1280, 15_000);
      await bob.page.locator(".tile-banner", { hasText: "Partie classée" }).waitFor();
      // Une scène retrouve son son : celui du jeu revient, celui d'OBS s'en va.
      await alice.page.locator(".mix-row").first().waitFor({ timeout: 6000 });
      assert.equal(await alice.page.locator(".mix-row", { hasText: "OBS" }).count(), 0, "le son d'OBS ne doit pas rester sur la scène du jeu");
      await alice.page.locator(".scene", { hasText: "Depuis OBS" }).getByRole("button", { name: "Depuis OBS", exact: true }).click();
      await poll("retour sur OBS", received, w => w === 1280, 15_000);
      const state = await bob.page.evaluate(() => Object.values<any>((window as any).__store.useApp.getState().subs)[0]?.state);
      assert.equal(state, "connected", "changer de scène ne doit pas couper le stream");

      // OBS s'arrête en plein direct : pause, puis reprise toute seule quand il revient.
      sender.stdin!.write("q");
      await bob.page.locator(".tile .live-pill", { hasText: "Pause" }).waitFor({ timeout: 15_000 });
      await alice.page.evaluate(() => (window as any).__store.useApp.setState({ toasts: [] }));
      sender = push();
      await bob.page.locator(".tile .live-pill", { hasText: "En direct" }).waitFor({ timeout: 20_000 });
      await poll("image d'OBS revenue", received, w => w === 1280, 15_000);

      await alice.page.locator(".scene", { hasText: "Jeu" }).getByRole("button", { name: "Jeu", exact: true }).click();
      await poll("fin de l'essai sur la mire", received, w => w > 0 && w !== 1280, 15_000);
      await alice.page.getByRole("button", { name: "Couper la caméra" }).click();
      await bob.page.locator(".tile-cam").waitFor({ state: "detached" });
      await alice.page.getByLabel("Bandeau sur l'image").fill("");
      await alice.page.keyboard.press("Enter");
      return `image 1280x720 et son ${(level * 100).toFixed(0)} %, passages de scène sans coupure, reprise après un arrêt d'OBS`;
    } finally {
      sender.kill();
    }
  });

  await step("régie : tout sous les yeux, panneaux déplaçables, fenêtre détachée", async () => {
    await alice.page.locator(".live-bar").getByRole("button", { name: "Régie", exact: true }).click();
    await alice.page.locator(".regie-board").waitFor();
    assert.equal(await alice.page.locator(".panel").count(), 0, "le panneau étroit laisse la place à la régie");
    await alice.page.locator('[data-panel="chat"] .chat').waitFor();
    await alice.page.locator(".tile-own").waitFor();
    await shot(alice, "29-regie");

    // Glisser un panneau d'une colonne à l'autre, et le retrouver après une relance.
    await alice.page.locator('[data-panel="notes"] > header').dragTo(alice.page.locator('[data-panel="scenes"] > header'));
    await poll("panneau déplacé", () => alice.page.evaluate(() => (window as any).__store.useApp.getState().settings.regie.left as string[]), left => left.indexOf("notes") >= 0 && left.indexOf("notes") < left.indexOf("scenes"), 5000);
    await openPanel(alice, "notes");
    await alice.page.getByRole("textbox", { name: "Bloc-notes" }).fill("Ne pas oublier le vainqueur");
    await alice.page.locator(".regie-board").click({ position: { x: 300, y: 4 } });
    await poll("notes gardées", () => alice.page.evaluate(() => (window as any).__store.useApp.getState().settings.regie.notes as string), n => n.includes("vainqueur"), 5000);

    // Choisir ses actions rapides.
    await alice.page.getByRole("button", { name: "Choisir les actions rapides" }).click();
    await alice.page.locator(".menu-check", { hasText: "Inviter" }).locator("input").check();
    await alice.page.keyboard.press("Escape");
    await alice.page.locator(".quick-action", { hasText: "Inviter" }).waitFor();

    // Santé : un conseil et un graphique, pas seulement un chiffre.
    await alice.page.locator('[data-panel="health"] .health-graph polyline').first().waitFor();

    // Marqueur et fil d'activité.
    await alice.page.locator(".quick-action", { hasText: "Marqueur" }).click();
    await openPanel(alice, "activity");
    await alice.page.locator(".activity-item.is-marker").waitFor();
    await alice.page.locator(".activity-item", { hasText: "regarde" }).first().waitFor();

    // Un écran d'attente remplace vraiment l'image, avec son titre.
    await openPanel(alice, "screens");
    await alice.page.locator(".wait-screen", { hasText: "Je reviens" }).getByRole("button", { name: "Je reviens", exact: true }).click();
    await bob.page.locator(".tile .live-pill", { hasText: "Pause" }).waitFor({ timeout: 6000 });
    await poll("écran d'attente", () => bob.page.evaluate(() => document.querySelector<HTMLVideoElement>(".tile-video")?.videoWidth ?? 0), w => w === 1280, 10_000);
    await alice.page.locator(".live-bar-state", { hasText: "Je reviens" }).waitFor();
    await alice.page.locator(".wait-screen", { hasText: "Je reviens" }).getByRole("button", { name: "Je reviens", exact: true }).click();
    await bob.page.locator(".tile .live-pill", { hasText: "En direct" }).waitFor({ timeout: 6000 });

    // Réglages d'une source : décalage et baisse automatique.
    const source = alice.page.locator(".mix-row").first();
    await source.getByRole("button", { name: /^Réglages de/ }).click();
    await alice.page.locator(".popover").getByLabel("Décalage du son").selectOption({ label: "200 ms" });
    await alice.page.locator(".popover .menu-check input").check();
    await alice.page.keyboard.press("Escape");
    const mix = await alice.page.evaluate(() => (window as any).__store.useApp.getState().publish.mix[0] as { offsetMs: number; duck: boolean });
    assert.deepEqual([mix.offsetMs, mix.duck], [200, true]);

    // Fenêtre détachée, invisible dans les captures, et qui agit vraiment sur le direct.
    const popup = alice.app.waitForEvent("window");
    await alice.page.getByRole("button", { name: "Détacher la régie dans sa fenêtre" }).click();
    const detached = await popup;
    await detached.locator(".regie-board.is-detached").waitFor({ timeout: 8000 });
    const styled = await detached.locator(".quick-action").first().evaluate(b => getComputedStyle(b).display);
    assert.equal(styled, "flex", "la fenêtre détachée doit avoir ses styles");
    const windows = await alice.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().filter(w => w.getTitle().includes("Régie")).map(w => w.isContentProtected()));
    assert.deepEqual(windows, [true], "la régie détachée doit rester hors des captures");
    await detached.locator(".quick-action", { hasText: "Pause" }).click();
    await bob.page.locator(".tile .live-pill", { hasText: "Pause" }).waitFor({ timeout: 6000 });
    await detached.locator(".quick-action", { hasText: "Reprendre" }).click();
    await bob.page.locator(".tile .live-pill", { hasText: "En direct" }).waitFor({ timeout: 6000 });
    await detached.getByRole("button", { name: "Choisir les actions rapides" }).click();
    await detached.locator(".popover .menu-check").first().waitFor();
    await detached.screenshot({ path: path.join(captures, "30-regie-detachee.png") });
    await detached.keyboard.press("Escape");
    await alice.page.getByRole("button", { name: "Rattacher la régie" }).click();
    await poll("fenêtre refermée", () => alice.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().filter(w => w.getTitle().includes("Régie")).length), n => n === 0, 6000);

    // Un raccourci par scène, même en plein jeu.
    await alice.page.evaluate(() => {
      const w = window as any;
      const scene = w.__store.useApp.getState().settings.scenes.find((s: { name: string }) => s.name === "Jeu");
      w.__core.updateScene(scene.id, { hotkey: "Ctrl+Alt+J" });
      w.__store.useApp.setState((s: any) => ({ publish: { ...s.publish, scene: null } }));
    });
    await wait(600);
    const pressed = spawnSync("powershell", ["-NoProfile", "-Command", `
      Add-Type -Name K -Namespace N -MemberDefinition '[DllImport("user32.dll")] public static extern void keybd_event(byte k, byte s, uint f, System.UIntPtr e);'
      foreach ($k in 0x11, 0x12, 0x4A) { [N.K]::keybd_event($k, 0, 0, [System.UIntPtr]::Zero) }
      foreach ($k in 0x4A, 0x12, 0x11) { [N.K]::keybd_event($k, 0, 2, [System.UIntPtr]::Zero) }`], { timeout: 20_000 });
    assert.equal(pressed.status, 0);
    await alice.page.locator(".scene.is-on", { hasText: "Jeu" }).waitFor({ timeout: 6000 });

    await alice.page.getByRole("button", { name: "Fermer la régie" }).click();
    await alice.page.locator(".panel").waitFor();
    return "panneaux déplacés, fenêtre détachée hors capture, écran d'attente, réglages de source, raccourci de scène";
  });

  await step("regarder YouTube ensemble : même position, même pause", async () => {
    await alice.page.getByRole("button", { name: "Regarder une vidéo YouTube ensemble" }).click();
    await alice.page.getByPlaceholder(/youtube/).fill("https://www.youtube.com/watch?v=aqz-KE-bpKQ");
    await alice.page.getByRole("button", { name: "Lancer pour tout le salon" }).click();
    await bob.page.locator(".tile-together").waitFor({ timeout: 15_000 });
    const position = (peer: Peer) => peer.page.locator(".together-seek").evaluate((i: HTMLInputElement) => Number(i.value));
    await poll("lecture chez Alice", () => position(alice), t => t > 3, 40_000);
    await poll("lecture chez Bob", () => position(bob), t => t > 3, 40_000);
    await wait(3000);
    const [ta, tb] = [await position(alice), await position(bob)];
    assert.ok(Math.abs(ta - tb) <= 2, `dérive ${ta} / ${tb}`);
    await shot(bob, "18-ensemble");

    await bob.page.locator(".tile-together").hover();
    await bob.page.getByRole("button", { name: "Mettre en pause pour tout le salon" }).click();
    await alice.page.locator(".tile-together").hover();
    await alice.page.getByRole("button", { name: "Reprendre pour tout le salon" }).waitFor();
    await wait(2000);
    const [pa, pb] = [await position(alice), await position(bob)];
    await wait(2000);
    assert.equal(await position(alice), pa, "la pause doit s'appliquer chez Alice");
    assert.equal(await position(bob), pb, "la pause doit s'appliquer chez Bob");
    assert.ok(Math.abs(pa - pb) <= 2, `dérive en pause ${pa} / ${pb}`);

    // Quelqu'un qui arrive en cours de route reprend au même endroit : le second Bob, c'est Bob qui revient.
    await alice.page.getByRole("button", { name: "Reprendre pour tout le salon" }).click();
    await alice.page.getByRole("button", { name: "Arrêter pour tout le salon" }).click();
    await bob.page.locator(".tile-together").waitFor({ state: "detached" });
    return `positions ${ta} et ${tb}, pause à ${pa} et ${pb}`;
  });

  await step("l'accueil montre qui est en direct", async () => {
    await bob.page.evaluate(() => (window as any).__store.useApp.setState({ view: "home" }));
    await poll("vignette du stream", () => bob.page.locator(".live-card img").count(), n => n > 0, 45_000);
    await shot(bob, "19-accueil-en-direct");
    await bob.page.locator(".live-card").first().click();
    await bob.page.locator(".room-head h1").waitFor();
  });

  await step("apparence : accent et taille s'appliquent tout de suite", async () => {
    await bob.page.getByRole("button", { name: "Paramètres" }).click();
    await bob.page.getByRole("button", { name: "Apparence" }).click();
    await bob.page.getByRole("radio", { name: "#f4638d" }).click();
    await poll("accent", () => bob.page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--accent")), v => v.trim() === "#f4638d");
    await bob.page.getByRole("radio", { name: "Grande", exact: true }).click();
    await poll("taille", () => bob.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.webContents.getZoomFactor()), z => Math.abs(z - 1.1) < 0.01);
    await shot(bob, "20-apparence");
    await bob.page.getByRole("radio", { name: "Normale" }).click();
    await bob.page.evaluate(() => (window as any).__store.useApp.setState({ view: "room" }));
  });

  await step("fenêtre flottante toujours au-dessus", async () => {
    await bob.page.locator(".tile").first().hover();
    const popup = bob.app.waitForEvent("window");
    await bob.page.getByRole("button", { name: /Fenêtre flottante/ }).click();
    const child = await popup;
    await poll("image dans la fenêtre", () => child.evaluate(() => document.querySelector("video")?.videoWidth ?? 0), w => w > 0);
    const onTop = await bob.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().filter(w => w.isAlwaysOnTop()).length);
    assert.equal(onTop, 1);
    await child.close();
  });

  await step("le son « tout le PC » exclut SpokaStream", async () => {
    await alice.page.getByRole("button", { name: "Ajouter une source de son" }).click();
    await alice.page.locator(".menu-item", { hasText: "Tout le PC" }).click();
    await alice.page.locator(".mix-row", { hasText: "Tout le PC" }).waitFor();
    await poll(
      "niveau de la capture",
      () => alice.page.evaluate(() => {
        const w = window as any;
        const mix = w.__store.useApp.getState().publish.mix.find((m: { label: string }) => m.label === "Tout le PC");
        return w.__core.mixLevels()[mix.id] as number;
      }),
      v => v > 0.05,
    );
    await alice.page.locator(".mix-row", { hasText: "Tout le PC" }).getByRole("button", { name: "Retirer" }).click();
  });

  await step("vocal entre les deux", async () => {
    await alice.page.getByRole("button", { name: "Rejoindre le vocal" }).click();
    await bob.page.getByRole("button", { name: "Rejoindre le vocal" }).click();
    await alice.page.getByRole("button", { name: "Quitter le vocal" }).waitFor();
    await bob.page.getByRole("button", { name: "Quitter le vocal" }).waitFor();
    await bob.page.getByRole("tab", { name: /Membres/ }).click();
    await bob.page.locator(".member", { hasText: "Spoka" }).getByLabel("Micro actif").waitFor();
    await shot(bob, "08-membres-vocal");
    const bobId: string = await bob.page.evaluate(() => (window as any).__store.useApp.getState().userId);
    const level = await poll("voix reçue", () => alice.page.evaluate(id => (window as any).__core.voiceLevel(id) as number, bobId), v => v > 0.1, 20_000);
    // Le téléphone parle aussi : le vocal du lecteur web est le même que celui de l'application.
    await phone!.getByRole("button", { name: "Rejoindre le vocal" }).click();
    await phone!.getByRole("button", { name: "Quitter le vocal" }).waitFor({ timeout: 8000 });
    const phoneId = await alice.page.evaluate(() => (window as any).__store.useApp.getState().room.members.find((m: { name: string }) => m.name === "Téléphone").id as string);
    const phoneLevel = await poll("voix du téléphone", () => alice.page.evaluate(id => (window as any).__core.voiceLevel(id) as number, phoneId), v => v > 0.05, 20_000);
    return `niveau de la voix reçue ${(level * 100).toFixed(0)} %, téléphone ${(phoneLevel * 100).toFixed(0)} %`;
  });

  await step("raccourcis globaux et appuyer pour parler, sans le focus", async () => {
    const keys = (script: string) => {
      const run = spawnSync("powershell", ["-NoProfile", "-Command", `
        Add-Type -Name K -Namespace N -MemberDefinition '[DllImport("user32.dll")] public static extern void keybd_event(byte k, byte s, uint f, System.UIntPtr e);'
        function Down($k) { [N.K]::keybd_event($k, 0, 0, [System.UIntPtr]::Zero) }
        function Up($k) { [N.K]::keybd_event($k, 0, 2, [System.UIntPtr]::Zero) }
        ${script}`], { timeout: 20_000 });
      assert.equal(run.status, 0, String(run.stderr));
    };
    const muted = () => alice.page.evaluate(() => (window as any).__store.useApp.getState().muted as boolean);
    const combo = "Down 0x11; Down 0x12; Down 0x4D; Up 0x4D; Up 0x12; Up 0x11";
    assert.equal(await muted(), false);
    keys(combo);
    await poll("micro coupé par le raccourci", muted, m => m === true, 5000);
    keys(combo);
    await poll("micro rétabli par le raccourci", muted, m => m === false, 5000);

    // F24 : une touche qui n'écrit rien dans l'application au premier plan.
    await alice.page.evaluate(() => (window as any).__core.updateSettings({ voiceMode: "ptt", pttKey: 0x87, pttKeyName: "F24" }));
    await wait(500);
    const transmitting = () => alice.page.evaluate(() => (window as any).__core.voice.stream.getAudioTracks()[0].enabled as boolean);
    await poll("micro fermé en attendant la touche", transmitting, on => on === false, 5000);
    keys("Down 0x87");
    await poll("micro ouvert touche enfoncée", transmitting, on => on === true, 5000);
    keys("Up 0x87");
    await poll("micro refermé touche relâchée", transmitting, on => on === false, 5000);
    await alice.page.evaluate(() => (window as any).__core.updateSettings({ voiceMode: "open" }));
  });

  await step("changer de source en direct, vers un fichier vidéo avec son", async () => {
    const file = path.join(temp, "extrait.mp4");
    await new Promise<void>((resolve, reject) =>
      execFile(
        "ffmpeg",
        ["-y", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=30:duration=20", "-f", "lavfi", "-i", "sine=frequency=330:duration=20", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", file],
        e => (e ? reject(e) : resolve()),
      ),
    );
    await alice.page.getByRole("tab", { name: "Studio" }).click();
    await alice.page.getByRole("button", { name: "Changer" }).click();
    await alice.page.getByRole("tab", { name: "Fichier vidéo" }).click();
    await alice.page.locator(".file-pick input").setInputFiles(file);
    await alice.page.locator(".modal").getByRole("button", { name: "Changer", exact: true }).click();
    await poll("image du fichier", () => bob.page.evaluate(() => document.querySelector<HTMLVideoElement>(".tile-video")?.videoWidth ?? 0), w => w === 640, 15_000);
    await alice.page.locator(".mix-row", { hasText: "extrait.mp4" }).waitFor();
    const level = await poll(
      "son du fichier",
      () => alice.page.evaluate(() => {
        const w = window as any;
        const mix = w.__store.useApp.getState().publish.mix.find((m: { label: string }) => m.label === "extrait.mp4");
        return (mix ? w.__core.mixLevels()[mix.id] : 0) as number;
      }),
      v => v > 0.3,
    );
    const state = await bob.page.evaluate(() => Object.values<any>((window as any).__store.useApp.getState().subs)[0]?.state);
    assert.equal(state, "connected");
    return `image 640x360 reçue sans reconnexion, son du fichier ${(level * 100).toFixed(0)} %`;
  });

  await step("arrêter le stream prévient le spectateur", async () => {
    await alice.page.getByRole("button", { name: "Arrêter le stream" }).click();
    await bob.page.locator(".stage-empty").waitFor({ timeout: 8000 });
  });

  await step("paramètres", async () => {
    await alice.page.getByRole("button", { name: "Paramètres" }).click();
    await alice.page.locator(".settings").waitFor();
    await shot(alice, "09-parametres");
    await alice.page.getByRole("button", { name: "Diffusion" }).click();
    await shot(alice, "10-parametres-diffusion");
  });

  await step("sans serveur, l'accueil dit quoi faire", async () => {
    await alice.page.evaluate(() => (window as any).__core.leaveRoom());
    await alice.page.evaluate(() => (window as any).__store.useApp.setState({ view: "home" }));
    await server.close();
    await alice.page.locator(".home-alert").waitFor({ timeout: 20_000 });
    await shot(alice, "11-serveur-injoignable");
    await alice.page.getByRole("button", { name: "Régler le serveur" }).click();
    await alice.page.getByRole("button", { name: "Héberger sur ce PC" }).waitFor();
  });

  const unexpected = [...alice.errors.map(e => `alice: ${e}`), ...bob.errors.map(e => `bob: ${e}`)].filter(e => !/Autofill|favicon|Electron Security Warning/.test(e));
  if (unexpected.length) {
    console.log("\nErreurs de console :");
    for (const e of unexpected.slice(0, 20)) console.log(`  ${e}`);
  }
} catch (e) {
  failed = true;
  console.error(e);
  for (const peer of [a, b]) {
    if (!peer) continue;
    // Une page peut répondre au JavaScript sans plus rien afficher : on veut savoir laquelle des deux choses s'est arrêtée.
    const windows = await peer.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(w => ({ title: w.getTitle(), visible: w.isVisible(), minimized: w.isMinimized(), focused: w.isFocused(), bounds: w.getBounds() }))).catch(e => String(e));
    const paint = await Promise.race([peer.page.evaluate(() => new Promise(r => requestAnimationFrame(() => r("rendu actif")))), wait(4000).then(() => "rendu arrêté")]).catch(e => String(e));
    const hidden = await Promise.race([peer.page.evaluate(() => `${document.visibilityState}`), wait(4000).then(() => "pas de réponse")]).catch(e => String(e));
    console.log(`État ${peer.name} : ${paint}, page ${hidden}, fenêtres ${JSON.stringify(windows)}`);
    await shot(peer, `echec-${peer.name}`).catch(() => {});
    console.log(`Diagnostic ${peer.name} :\n${await peer.page.evaluate(() => (window as any).__core.diagnostics()).catch(() => "indisponible")}`);
    if (peer.errors.length) console.log(`Erreurs ${peer.name} :\n  ${peer.errors.slice(0, 15).join("\n  ")}`);
  }
} finally {
  await a?.app.close().catch(() => {});
  await b?.app.close().catch(() => {});
  await edge?.close().catch(() => {});
  pattern.kill();
  await server.close();
  await wait(500);
  rmSync(temp, { recursive: true, force: true, maxRetries: 3 });
}

console.log(`\n${steps.filter(s => s.ok).length}/${steps.length} étapes réussies`);
process.exit(failed ? 1 : 0);
