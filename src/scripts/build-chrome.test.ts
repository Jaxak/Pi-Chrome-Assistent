import { execFile } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "../..");
const buildScriptPath = path.join(projectRoot, "scripts", "build-chrome.mjs");
const chromeDistDir = path.join(projectRoot, "dist", "chrome");

describe("build:chrome", () => {
  it("creates the unpacked Chrome extension shell", async () => {
    await execFileAsync(process.execPath, [buildScriptPath], {
      cwd: projectRoot,
    });

    await Promise.all([
      access(path.join(chromeDistDir, "manifest.json")),
      access(path.join(chromeDistDir, "popup.html")),
      access(path.join(chromeDistDir, "popup.css")),
      access(path.join(chromeDistDir, "popup.js")),
      access(path.join(chromeDistDir, "background.js")),
      access(path.join(chromeDistDir, "contentScript.js")),
    ]);

    const manifest = JSON.parse(await readFile(path.join(chromeDistDir, "manifest.json"), "utf8"));
    const popupHtml = await readFile(path.join(chromeDistDir, "popup.html"), "utf8");
    const popupScript = await readFile(path.join(chromeDistDir, "popup.js"), "utf8");
    const backgroundScript = await readFile(path.join(chromeDistDir, "background.js"), "utf8");
    const contentScript = await readFile(path.join(chromeDistDir, "contentScript.js"), "utf8");

    expect(manifest.background.service_worker).toBe("background.js");
    expect(manifest.action.default_popup).toBe("popup.html");
    expect(popupHtml).toContain('href="./popup.css"');
    expect(popupHtml).toContain('src="./popup.js"');
    expect(popupScript).toContain('type: "startDomPicker"');
    expect(backgroundScript).toContain("executeScript");
    expect(backgroundScript).toContain('files: ["contentScript.js"]');
    expect(contentScript).toContain("startDomPicker");
    expect(contentScript).toContain("__PI_CONTENT_SCRIPT_PLACEHOLDER_LISTENER_REGISTERED__");
  });

  it("declares the MV3 permissions needed for scripted injection", async () => {
    await execFileAsync(process.execPath, [buildScriptPath], {
      cwd: projectRoot,
    });

    const manifest = JSON.parse(await readFile(path.join(chromeDistDir, "manifest.json"), "utf8"));

    expect(manifest.permissions).toEqual(expect.arrayContaining(["activeTab", "scripting"]));
  });
});
