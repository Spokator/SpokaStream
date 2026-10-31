// La capture sans WGC, directement sur le moteur natif : une mire qui bouge, un écran entier, puis une fenêtre découpée.
//   npm run test:capture-compat
// Passer par l'application ferait mesurer Playwright plutôt que la capture : il reçoit chaque image par DevTools.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { _electron as electron } from "playwright";
import { startServer } from "../../server/index.ts";
import { MemoryStore } from "../../server/store.ts";

const root = path.resolve(import.meta.dirname, "../..");
const temp = mkdtempSync(path.join(tmpdir(), "spokastream-compat-"));
const electronPath = createRequire(import.meta.url)("electron") as unknown as string;
const output = process.env.CAPTURE_DUMP;
const wait = (ms: number) => new Promise(r => setTimeout(r, ms));

const powershell = (script: string) => execFileSync("powershell.exe", ["-NoProfile", "-Command", script], { encoding: "utf8" }).trim();
const position = () => powershell("Add-Type -AssemblyName System.Windows.Forms; $p=[System.Windows.Forms.Cursor]::Position; \"$($p.X) $($p.Y)\"");
const cursor = position().split(" ").map(Number) as [number, number];

const engine = spawn(process.env.SPOKASTREAM_ENGINE ?? path.join(root, "native", "publish", "SpokaAudio.exe"), { stdio: ["pipe", "pipe", "inherit"] });
let pending = Buffer.alloc(0);
const answers = new Map<number, (value: { result?: unknown; error?: string }) => void>();
engine.stdout.on("data", (chunk: Buffer) => {
  pending = Buffer.concat([pending, chunk]);
  while (pending.length >= 5) {
    const length = pending.readUInt32LE(1);
    if (pending.length < 5 + length) return;
    if (pending[0] === 1) {
      const message = JSON.parse(pending.subarray(5, 5 + length).toString()) as { id?: number; result?: unknown; error?: string };
      if (message.id !== undefined) answers.get(message.id)?.(message);
    }
    pending = pending.subarray(5 + length);
  }
});
let nextId = 1;
const request = (cmd: string, fields: object) =>
  new Promise<{ result?: unknown; error?: string }>(resolve => {
    const id = nextId++;
    answers.set(id, resolve);
    engine.stdin.write(`${JSON.stringify({ id, cmd, ...fields })}\n`);
  });

interface Started {
  url: string;
  width: number;
  height: number;
  compatFailed: boolean;
}

/** Lit la capture quelques secondes : cadence réelle, images différentes, et une image gardée pour la regarder. */
async function measure(label: string, target: object, seconds = 4, dump?: string) {
  const { result, error } = await request("video.start", { ...target, fps: 60, maxHeight: 0, compat: true });
  assert.equal(error, undefined, `${label} : ${error}`);
  const started = result as Started;
  assert.equal(started.compatFailed, false, `${label} : Windows a refusé la duplication`);
  const socket = new WebSocket(started.url);
  socket.binaryType = "arraybuffer";
  let frames = 0;
  let changed = 0;
  let previous = 0;
  let width = 0;
  let height = 0;
  let last: ArrayBuffer | null = null;
  socket.onmessage = event => {
    const data = event.data as ArrayBuffer;
    const view = new DataView(data);
    width = view.getInt32(0, true);
    height = view.getInt32(4, true);
    frames++;
    last = data;
    // Une empreinte d'un échantillon de lignes : le serveur répète la dernière image quand l'écran ne bouge pas.
    const bytes = new Uint8Array(data, 16);
    let sum = 0;
    for (let i = 0; i < width * height; i += 61) sum = (Math.imul(sum, 31) + bytes[i]!) | 0;
    if (sum !== previous) changed++;
    previous = sum;
  };
  await wait(seconds * 1000);
  socket.close();
  if (dump && last) {
    writeFileSync(dump, Buffer.from(last));
    writeFileSync(`${dump}.cursor`, position());
  }
  await request("video.stop", { url: started.url });
  console.log(`✔ ${label} : ${width}×${height}, ${Math.round(frames / seconds)} images/s dont ${Math.round(changed / seconds)} différentes par seconde`);
  return { width, height, frames, changed };
}

const pattern = spawn(electronPath, [path.join(root, "tests", "e2e", "pattern", "main.cjs")], { env: { ...process.env, SPOKASTREAM_PATTERN_DATA: temp, SPOKASTREAM_PATTERN_TOP: "1" }, stdio: "ignore" });
let failed = false;
try {
  await wait(2500);
  const screen = await measure("écran entier", { x: cursor[0], y: cursor[1] }, 4, output && path.join(output, "ecran.bin"));
  assert.ok(screen.width >= 640, "une image de la bonne taille");
  assert.ok(screen.changed >= 4, "l'image doit suivre ce qui bouge à l'écran");

  const hwnd = Number(powershell(`(Get-Process -Id ${pattern.pid} -ErrorAction SilentlyContinue | Select-Object -First 1).MainWindowHandle; Get-CimInstance Win32_Process -Filter "ParentProcessId=${pattern.pid}" | ForEach-Object { (Get-Process -Id $_.ProcessId).MainWindowHandle }`).split(/\s+/).map(Number).find(n => n > 0));
  assert.ok(hwnd > 0, "la fenêtre de la mire");
  const window = await measure("fenêtre découpée", { hwnd }, 4, output && path.join(output, "fenetre.bin"));
  assert.ok(window.width < screen.width || window.height < screen.height, "seule la fenêtre doit partir");
  assert.ok(window.changed >= 4, "la mire bouge");

  // Le même chemin depuis la vraie application, réglage activé. Bref exprès : Playwright sature vite sur la capture native.
  const server = await startServer({ port: 0, host: "127.0.0.1", store: new MemoryStore() });
  const app = await electron.launch({ executablePath: electronPath, args: [root], env: { ...process.env, SPOKASTREAM_USER_DATA: path.join(temp, "app"), SPOKASTREAM_SERVER: `ws://127.0.0.1:${server.port}/ws` } });
  const child = app.process();
  try {
    const page = await app.firstWindow();
    await page.getByPlaceholder("Comment tes amis te voient").fill("Essai");
    await page.getByRole("button", { name: "C'est parti" }).click();
    await page.getByText("Connecté à").waitFor();
    await page.evaluate(() => (window as any).__store.useApp.setState({ view: "settings", settingsSection: "stream" }));
    await page.getByRole("switch", { name: "Capture compatible avec les jeux" }).click();
    await page.evaluate(() => (window as any).__store.useApp.setState({ view: "home" }));
    await page.locator(".home-card-primary").click();
    await page.getByPlaceholder("La soirée film, Les potes…").fill("Essai");
    await page.getByRole("button", { name: "Créer le salon" }).click();
    await page.locator(".room-code").waitFor();
    await page.getByRole("button", { name: "Diffuser", exact: true }).click();
    await page.getByRole("tab", { name: "Fenêtres" }).click();
    await page.locator(".source-card", { hasText: "Mire SpokaStream" }).click();
    await page.getByRole("button", { name: "Lancer le stream" }).click();
    await page.locator(".titlebar-live").waitFor({ timeout: 30_000 });
    const state = await page.evaluate(() => {
      const { publish, settings } = (window as any).__store.useApp.getState();
      return { native: publish.nativeCapture, compat: settings.stream.compatCapture };
    });
    assert.deepEqual(state, { native: true, compat: true });
    assert.equal(await page.getByText("capture compatible n'est pas disponible").count(), 0);
    console.log("✔ application : réglage activé, direct lancé par la capture compatible");
  } finally {
    await Promise.race([app.close().catch(() => {}), wait(8000)]);
    child.kill();
    await server.close();
  }
  console.log("RÉUSSI");
} catch (e) {
  failed = true;
  console.log(`✖ ${e}`);
} finally {
  pattern.kill();
  engine.stdin.end();
  await wait(500);
  engine.kill();
  rmSync(temp, { recursive: true, force: true, maxRetries: 4 });
}
process.exit(failed ? 1 : 0);
