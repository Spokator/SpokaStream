// Mire de test : une fenêtre animée qui joue un son. C'est elle qu'on diffuse, jamais l'écran de la personne qui lance les tests.
const { app, BrowserWindow } = require("electron");
const path = require("node:path");

app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");
app.setPath("userData", path.join(process.env.SPOKASTREAM_PATTERN_DATA, "pattern"));
app.whenReady().then(() => {
  const win = new BrowserWindow({ width: 960, height: 540, x: 40, y: 40, title: "Mire SpokaStream", backgroundColor: "#000", webPreferences: { backgroundThrottling: false } });
  win.removeMenu();
  win.loadFile(path.join(__dirname, "page.html"));
});
app.on("window-all-closed", () => app.quit());
