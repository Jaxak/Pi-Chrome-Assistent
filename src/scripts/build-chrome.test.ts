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
      access(path.join(chromeDistDir, "sidepanel.html")),
      access(path.join(chromeDistDir, "sidepanel.css")),
      access(path.join(chromeDistDir, "sidepanel.js")),
      access(path.join(chromeDistDir, "background.js")),
      access(path.join(chromeDistDir, "contentScript.js")),
    ]);

    const manifest = JSON.parse(await readFile(path.join(chromeDistDir, "manifest.json"), "utf8"));
    const sidePanelHtml = await readFile(path.join(chromeDistDir, "sidepanel.html"), "utf8");
    const sidePanelSource = await readFile(path.join(projectRoot, "src", "chrome", "sidepanel.ts"), "utf8");
    const sidePanelScript = await readFile(path.join(chromeDistDir, "sidepanel.js"), "utf8");
    const backgroundScript = await readFile(path.join(chromeDistDir, "background.js"), "utf8");
    const contentScript = await readFile(path.join(chromeDistDir, "contentScript.js"), "utf8");

    expect(manifest.background.service_worker).toBe("background.js");
    expect(manifest.action.default_popup).toBeUndefined();
    expect(manifest.side_panel.default_path).toBe("sidepanel.html");
    expect(sidePanelHtml).toContain('href="./sidepanel.css"');
    expect(sidePanelHtml).toContain('src="./sidepanel.js"');
    expect(sidePanelHtml).toContain('id="composer-menu"');
    expect(sidePanelHtml).toContain('id="send-button"');
    expect(sidePanelHtml).toContain('DOM picker');
    expect(sidePanelHtml).toContain('Настройки');
    expect(sidePanelHtml).not.toContain('Авторизация');
    expect(sidePanelHtml).toContain('Dev-журнал');
    expect(sidePanelSource).not.toContain('chrome.runtime.sendMessage({ type: "listTargets" })');
    expect(sidePanelSource).not.toContain('chrome.runtime.sendMessage({ type: "getBrowserAuthState" })');
    expect(sidePanelSource).not.toContain("refreshSidePanelState");
    expect(sidePanelSource).not.toContain("SidePanelBrokerClient");
    expect(sidePanelScript).toContain('type: "assistant.startDomPicker"');
    expect(sidePanelScript).not.toContain('type: "listTargets"');
    expect(sidePanelScript).not.toContain('type: "getBrowserAuthState"');
    expect(sidePanelScript).not.toContain("refreshSidePanelState");
    expect(sidePanelScript).not.toContain("SidePanelBrokerClient");
    expect(sidePanelScript).not.toContain("window.close()");
    expect(backgroundScript).toContain("startDomPicker");
    expect(backgroundScript).toContain('type: "startDomPicker"');
    expect(backgroundScript).not.toContain("executeScript");
    expect(contentScript).toContain("startDomPicker");
    expect(contentScript).toContain("__PI_CONTENT_SCRIPT_PLACEHOLDER_LISTENER_REGISTERED__");
  });

  it("uses persistent content script with no scripting permission", async () => {
    await execFileAsync(process.execPath, [buildScriptPath], {
      cwd: projectRoot,
    });

    const manifest = JSON.parse(await readFile(path.join(chromeDistDir, "manifest.json"), "utf8"));

    expect(manifest.content_scripts).toEqual([
      {
        matches: ["https://*/*", "http://*/*"],
        js: ["contentScript.js"],
        run_at: "document_idle",
      },
    ]);
    expect(manifest.permissions).toEqual(expect.not.arrayContaining(["scripting"]));
  });

  it("allows the sidepanel page to open a persistent local broker WebSocket", async () => {
    await execFileAsync(process.execPath, [buildScriptPath], {
      cwd: projectRoot,
    });

    const manifest = JSON.parse(await readFile(path.join(chromeDistDir, "manifest.json"), "utf8"));

    expect(manifest.content_security_policy?.extension_pages).toContain("connect-src 'self' ws://127.0.0.1:* http://127.0.0.1:*");
  });

  describe("icon generation shell safety", () => {
    it("should use execFileSync instead of execSync for shell safety", async () => {
      // This test verifies the code uses execFileSync by checking
      // the build script source doesn't contain execSync with string interpolation
      const buildScript = await readFile(buildScriptPath, "utf-8");

      // Should not have execSync with template literals containing paths
      expect(buildScript).not.toMatch(/execSync\s*\(`[^`]*\$\{/);

      // Should use execFileSync
      expect(buildScript).toMatch(/execFileSync/);
    });
  });
});
