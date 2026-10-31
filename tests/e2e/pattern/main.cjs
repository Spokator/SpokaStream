// Mire de test : une fenêtre animée qui joue un son. C'est elle qu'on diffuse, jamais l'écran de la personne qui lance les tests.
const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");
app.setPath("userData", path.join(process.env.SPOKASTREAM_PATTERN_DATA, "pattern"));
app.whenReady().then(() => {
  const win = new BrowserWindow({ width: 960, height: 540, x: 40, y: 40, title: "Mire SpokaStream", backgroundColor: "#000", webPreferences: { backgroundThrottling: false } });
  win.removeMenu();
  // La capture compatible découpe l'écran : la mire doit rester devant, sinon c'est ce qui la recouvre qui partirait.
  if (process.env.SPOKASTREAM_PATTERN_TOP) win.setAlwaysOnTop(true, "screen-saver");
  // Ce que la mire reçoit au clavier et à la souris : c'est la preuve qu'un geste est bien arrivé, et qu'un autre n'est pas passé.
  const inputs = path.join(process.env.SPOKASTREAM_PATTERN_DATA, "input.log");
  win.webContents.on("console-message", event => {
    if (event.message.startsWith("{")) fs.appendFileSync(inputs, `${event.message}\n`);
  });
  win.loadFile(path.join(__dirname, "page.html"));
});
app.on("window-all-closed", () => app.quit());
