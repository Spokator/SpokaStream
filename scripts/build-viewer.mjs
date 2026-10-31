// Le lecteur web tient dans le serveur : un seul fichier à déployer, et l'application peut l'héberger sur le réseau local.
import { build } from "esbuild";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const web = path.join(root, "web");

const bundle = await build({
  entryPoints: [path.join(web, "main.tsx")],
  bundle: true,
  minify: true,
  write: false,
  format: "iife",
  target: ["es2020", "safari15"],
  alias: { "@shared": path.join(root, "src", "shared") },
  jsx: "automatic",
  jsxImportSource: "preact",
  logLevel: "warning",
});

const css = readFileSync(path.join(web, "style.css"), "utf8");
const html = readFileSync(path.join(web, "page.html"), "utf8").replace("/*STYLE*/", () => css);
const js = bundle.outputFiles[0].text;

const icon = size => readFileSync(path.join(web, `icon-${size}.png`)).toString("base64");

writeFileSync(
  path.join(root, "server", "viewer.gen.ts"),
  `// Généré par scripts/build-viewer.mjs : modifier web/, pas ce fichier.
export const VIEWER_HTML = ${JSON.stringify(html)};
export const VIEWER_JS = ${JSON.stringify(js)};
export const ICON_192 = ${JSON.stringify(icon(192))};
export const ICON_512 = ${JSON.stringify(icon(512))};
`,
);
console.log(`lecteur web : ${Math.round(js.length / 1024)} ko de script`);
