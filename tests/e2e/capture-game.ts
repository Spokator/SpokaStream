// La capture de jeu sur une vraie fenêtre OpenGL : la DLL entre dans le jeu, les images en sortent à l'endroit.
//   npm run test:capture-game
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "../..");
const temp = mkdtempSync(path.join(tmpdir(), "spokastream-game-"));
const output = process.env.CAPTURE_DUMP;
const wait = (ms: number) => new Promise(r => setTimeout(r, ms));

const vswhere = path.join(process.env["ProgramFiles(x86)"]!, "Microsoft Visual Studio", "Installer", "vswhere.exe");
const vs = execFileSync(vswhere, ["-latest", "-products", "*", "-requires", "Microsoft.VisualStudio.Component.VC.Tools.x86.x64", "-property", "installationPath"], { encoding: "utf8" }).trim();
const game = path.join(temp, "jeu.exe");
const script = path.join(temp, "build.cmd");
const sdk = process.env.SPOKA_WINSDK;
const include = sdk ? path.join(sdk, "cpp", "c", "Include", readdirSync(path.join(sdk, "cpp", "c", "Include"))[0]!) : "";
const msvc = path.join(vs, "VC", "Tools", "MSVC");
const tools = path.join(msvc, readdirSync(msvc).sort().at(-1)!);
const paths = sdk ? `@set "INCLUDE=${tools}\\include;${include}\\um;${include}\\shared;${include}\\ucrt"\r\n@set "LIB=${tools}\\lib\\x64;${sdk}\\x64\\c\\um\\x64;${sdk}\\x64\\c\\ucrt\\x64"\r\n` : "";
writeFileSync(script, `@call "${vs}\\VC\\Auxiliary\\Build\\vcvars64.bat" >nul\r\n${paths}@cd /d "${temp}"\r\n@cl /nologo /O2 /DUNICODE /D_UNICODE "${path.join(root, "tests", "e2e", "glwindow.cpp")}" /Fe:jeu.exe opengl32.lib gdi32.lib user32.lib /link /SUBSYSTEM:WINDOWS\r\n`);
execFileSync("cmd", ["/c", script], { stdio: "pipe" });

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
  gameFailed: boolean;
}

const window = spawn(game, { stdio: "ignore" });
let failed = false;
try {
  await wait(1200);
  const list = (await request("windows.list", {})).result as { hwnd: number; title: string }[];
  const hwnd = list.find(w => w.title === "Jeu OpenGL d'essai")?.hwnd;
  assert.ok(hwnd, "la fenêtre du jeu doit être listée");
  const { result, error } = await request("video.start", { hwnd, fps: 60, maxHeight: 0, compat: false, game: true });
  assert.equal(error, undefined, error);
  const started = result as Started;
  assert.equal(started.gameFailed, false, "la capture de jeu doit prendre");

  const socket = new WebSocket(started.url);
  socket.binaryType = "arraybuffer";
  let frames = 0;
  let changed = 0;
  let previous = -1;
  let last: ArrayBuffer | null = null;
  socket.onmessage = event => {
    const data = event.data as ArrayBuffer;
    const view = new DataView(data);
    const width = view.getInt32(0, true);
    const height = view.getInt32(4, true);
    frames++;
    last = data;
    const pixels = new Uint8Array(data, 16);
    let sample = 0;
    for (let y = 0; y < height; y += 37) for (let x = 0; x < width; x += 41) sample = (Math.imul(sample, 31) + pixels[y * width + x]!) | 0;
    if (sample !== previous) changed++;
    previous = sample;
  };
  await wait(4000);
  socket.close();
  assert.ok(last, "des images doivent arriver");
  const frame = last as ArrayBuffer;
  const view = new DataView(frame);
  const [width, height] = [view.getInt32(0, true), view.getInt32(4, true)];
  const luma = new Uint8Array(frame, 16);
  const at = (x: number, y: number) => luma[y * width + x]!;
  console.log(`✔ ${width}×${height}, ${Math.round(frames / 4)} images/s dont ${Math.round(changed / 4)} différentes par seconde`);
  assert.ok(changed / 4 >= 45, "l'image doit suivre le jeu");
  assert.ok(at(30, height - 30) > 200, `le carré blanc doit être en bas à gauche : ${at(30, height - 30)}`);
  assert.ok(at(30, 30) < 200, `et pas en haut : ${at(30, 30)}`);
  console.log("✔ l'image arrive à l'endroit, le jeu tourne toujours");
  if (output) writeFileSync(output, Buffer.from(frame));
  await request("video.stop", { url: started.url });
  await wait(600);
  assert.equal(window.exitCode, null, "le jeu ne doit pas avoir planté");

  const again = (await request("video.start", { hwnd, fps: 30, maxHeight: 360, compat: false, game: true })).result as Started;
  assert.equal(again.gameFailed, false, "une seconde capture doit reprendre");
  const second = new WebSocket(again.url);
  second.binaryType = "arraybuffer";
  let size = 0;
  second.onmessage = event => (size = new DataView(event.data as ArrayBuffer).getInt32(4, true));
  await wait(1500);
  second.close();
  assert.equal(size, 360, "la définition demandée s'applique");
  await request("video.stop", { url: again.url });
  console.log("✔ on peut arrêter et relancer sans redémarrer le jeu");
  console.log("RÉUSSI");
} catch (e) {
  failed = true;
  console.log(`✖ ${e}`);
} finally {
  window.kill();
  engine.stdin.end();
  await wait(400);
  engine.kill();
  await wait(300);
  rmSync(temp, { recursive: true, force: true, maxRetries: 4 });
}
process.exit(failed ? 1 : 0);
