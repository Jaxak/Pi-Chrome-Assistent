import { cp, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

import { build } from "vite";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");
const chromeSrcDir = path.join(projectRoot, "src", "chrome");
const chromeDistDir = path.join(projectRoot, "dist", "chrome");

const staticFiles = ["manifest.json", "sidepanel.html", "sidepanel.css", "crosshair.js", "icon.svg"];
const scriptEntries = [
  { fileName: "background", globalName: "PiChromeBackground" },
  { fileName: "sidepanel", globalName: "PiChromeSidePanel" },
  { fileName: "contentScript", globalName: "PiChromeContentScript" },
];

await rm(chromeDistDir, { recursive: true, force: true });
await mkdir(chromeDistDir, { recursive: true });

for (const file of staticFiles) {
  await cp(path.join(chromeSrcDir, file), path.join(chromeDistDir, file));
}

// Generate PNG icons from SVG (sizes required by Chrome manifest "icons")
const iconSizes = [16, 32, 48, 128];
const svgIcon = path.join(chromeSrcDir, "icon.svg");
for (const size of iconSizes) {
  const pngName = `icon${size}.png`;
  const outputPath = path.join(chromeDistDir, pngName);
  execFileSync("rsvg-convert", [
    "-w", String(size),
    "-h", String(size),
    svgIcon,
    "-o", outputPath,
  ]);
}

for (const entry of scriptEntries) {
  await build({
    configFile: false,
    publicDir: false,
    build: {
      emptyOutDir: false,
      lib: {
        entry: path.join(chromeSrcDir, `${entry.fileName}.ts`),
        formats: ["iife"],
        name: entry.globalName,
        fileName: () => `${entry.fileName}.js`,
      },
      minify: false,
      outDir: chromeDistDir,
      reportCompressedSize: false,
      sourcemap: false,
    },
  });
}

console.log(`Chrome extension shell written to ${path.relative(projectRoot, chromeDistDir)}`);
