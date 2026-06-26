// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

function loadSidePanelHtml(): void {
  const html = readFileSync(resolve(process.cwd(), "src/chrome/sidepanel.html"), "utf8");
  document.documentElement.innerHTML = html;
}

function mockChromeRuntime(): void {
  vi.stubGlobal("chrome", {
    runtime: {
      sendMessage: vi.fn(async (message: { type: string }) => {
        if (message.type === "getBrowserAuthState") {
          return { ok: true, tokenConfigured: false };
        }

        if (message.type === "listTargets") {
          return { ok: true, targets: [], tokenConfigured: false };
        }

        if (message.type === "getDiagnostics") {
          return { ok: true, diagnostics: [] };
        }

        return { ok: false, error: "Неизвестный запрос" };
      }),
    },
    storage: {
      local: {
        get: vi.fn(async () => ({})),
        set: vi.fn(async () => undefined),
      },
    },
  });
}

async function importInitializedSidePanel(): Promise<void> {
  vi.resetModules();
  await import("./sidepanel");
}

describe("sidepanel navigation", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
    document.documentElement.innerHTML = "";
  });

  it("returns from Dev-журнал to assistant panel when the back button is clicked", async () => {
    loadSidePanelHtml();
    mockChromeRuntime();
    await importInitializedSidePanel();

    const assistantPanel = document.querySelector<HTMLElement>("#panel-assistant");
    const sessionsPanel = document.querySelector<HTMLElement>("#panel-sessions");

    expect(assistantPanel?.hidden).toBe(false);
    expect(sessionsPanel?.hidden).toBe(true);

    document.querySelector<HTMLButtonElement>("#header-menu-button")?.click();
    document.querySelector<HTMLButtonElement>("#header-devlog-button")?.click();

    expect(assistantPanel?.hidden).toBe(true);
    expect(sessionsPanel?.hidden).toBe(false);

    document.querySelector<HTMLButtonElement>("#devlog-back-button")?.click();

    expect(assistantPanel?.hidden).toBe(false);
    expect(sessionsPanel?.hidden).toBe(true);
  });
});
