// Parcours complet avec deux vraies instances de l'application, un vrai serveur et une vraie connexion WebRTC.
//   npm run test:e2e
import assert from "node:assert/strict";
import { execFile, spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { _electron as electron } from "playwright";
import type { ElectronApplication, Page } from "playwright";
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

const shot = (peer: Peer, name: string) => peer.page.screenshot({ path: path.join(captures, `${name}.png`), timeout: 12_000 });

const pattern = spawn(electronPath, [path.join(root, "tests", "e2e", "pattern", "main.cjs")], {
  env: { ...process.env, SPOKASTREAM_PATTERN_DATA: temp },
  stdio: "ignore",
});

let a: Peer | undefined;
let b: Peer | undefined;
let failed = false;

try {
  await wait(1500);
  a = await launch("alice");
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
    await alice.page.getByLabel("Message").fill("Salut Pinoy, tu me vois ?");
    await alice.page.keyboard.press("Enter");
    await bob.page.locator(".chat-text", { hasText: "Salut Pinoy" }).waitFor();
    await bob.page.getByLabel("Message").fill("Pas encore, lance le stream 🔥");
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
    assert.ok(after.stats.fps >= 52, `cadence trop basse : ${after.stats.fps} i/s`);
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
      const alive = await Promise.race([alice.page.evaluate(() => new Promise(r => requestAnimationFrame(() => r(true)))), wait(5000).then(() => false)]);
      assert.equal(alive, true, `la page du diffuseur ne répond plus après ${width}x${tall}`);
    }
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
    await alice.page.locator(".reaction").first().waitFor({ timeout: 5000 });
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
    await alice.page.getByRole("button", { name: "Pause" }).click();
    await bob.page.locator(".tile .live-pill", { hasText: "Pause" }).waitFor();
    await poll("carte de pause", () => bob.page.evaluate(() => document.querySelector<HTMLVideoElement>(".tile-video")?.videoWidth ?? 0), w => w === 1280, 10_000);
    await alice.page.getByRole("button", { name: "Reprendre" }).click();
    await bob.page.locator(".tile .live-pill", { hasText: "En direct" }).waitFor();
  });

  await step("le débit change en direct, sans couper", async () => {
    await alice.page.getByLabel("Débit").selectOption({ label: "30 Mb/s" });
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
    await alice.page.getByRole("button", { name: "Enregistrer" }).click();
    await alice.page.locator(".is-recording").waitFor();
    await wait(4000);
    const file: string = await alice.page.evaluate(() => (window as any).__store.useApp.getState().recording.path);
    await alice.page.locator(".is-recording").click();
    await poll("fin de l'enregistrement", () => alice.page.evaluate(() => (window as any).__store.useApp.getState().recording), v => v === null);
    const probe = await new Promise<string>((resolve, reject) =>
      execFile("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type,codec_name,width,height", "-of", "csv=p=0", file], (e, out) => (e ? reject(e) : resolve(out))),
    );
    assert.match(probe, /video/);
    assert.match(probe, /audio/);
    return `${path.basename(file)}, ${(statSync(file).size / 2 ** 20).toFixed(1)} Mo : ${probe.trim().replace(/\r?\n/g, " | ")}`;
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
    return `niveau de la voix reçue ${(level * 100).toFixed(0)} %`;
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
    await shot(peer, `echec-${peer.name}`).catch(() => {});
    console.log(`Diagnostic ${peer.name} :\n${await peer.page.evaluate(() => (window as any).__core.diagnostics()).catch(() => "indisponible")}`);
    if (peer.errors.length) console.log(`Erreurs ${peer.name} :\n  ${peer.errors.slice(0, 15).join("\n  ")}`);
  }
} finally {
  await a?.app.close().catch(() => {});
  await b?.app.close().catch(() => {});
  pattern.kill();
  await server.close();
  await wait(500);
  rmSync(temp, { recursive: true, force: true, maxRetries: 3 });
}

console.log(`\n${steps.filter(s => s.ok).length}/${steps.length} étapes réussies`);
process.exit(failed ? 1 : 0);
