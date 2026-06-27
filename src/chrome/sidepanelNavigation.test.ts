// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createInitialAssistantState, type BackgroundAssistantState } from "./assistantState";

function loadSidePanelHtml(): void {
  const html = readFileSync(resolve(process.cwd(), "src/chrome/sidepanel.html"), "utf8");
  document.documentElement.innerHTML = html;
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

type PortListener = (message: unknown) => void;

type MockPort = {
  postMessage: ReturnType<typeof vi.fn>;
  emit(message: unknown): void;
};

type MockChromeRuntime = {
  port: MockPort;
  tabsQuery: ReturnType<typeof vi.fn>;
  sendMessage: ReturnType<typeof vi.fn>;
};

function createTarget(overrides: Partial<BackgroundAssistantState["targets"][number]> = {}): BackgroundAssistantState["targets"][number] {
  return {
    targetId: "target-1",
    alias: "Alpha",
    cwd: "/tmp/pi-alpha",
    gitBranch: "main",
    pid: 101,
    sessionName: "session-a",
    connectedAt: 1_710_000_000_000,
    lastSeenAt: 1_710_000_000_100,
    ...overrides,
  };
}

function createReadySnapshot(overrides: Partial<BackgroundAssistantState> = {}): BackgroundAssistantState {
  const base = createInitialAssistantState();
  const targets = overrides.targets ?? [createTarget()];
  return {
    ...base,
    epoch: overrides.epoch ?? base.epoch,
    connection: {
      ...base.connection,
      brokerOnline: true,
      bridgeOnline: true,
      connecting: false,
      tokenConfigured: true,
      browserAuthorized: true,
      ...overrides.connection,
    },
    targets,
    selectedTargetId: overrides.selectedTargetId ?? targets[0]?.targetId,
    chat: {
      ...base.chat,
      ...overrides.chat,
    },
    auth: {
      ...base.auth,
      tokenConfigured: true,
      browserToken: "token-1",
      ...overrides.auth,
    },
    diagnostics: overrides.diagnostics ?? base.diagnostics,
  };
}

function mockChromeRuntime(): MockChromeRuntime {
  const listeners: PortListener[] = [];
  const port: MockPort = {
    postMessage: vi.fn(),
    emit(message: unknown) {
      for (const listener of listeners) {
        listener(message);
      }
    },
  };
  const tabsQuery = vi.fn(async () => [{ id: 1 }]);
  const sendMessage = vi.fn(async () => ({ ok: true }));

  vi.stubGlobal("chrome", {
    runtime: {
      connect: vi.fn(() => ({
        name: "sidepanel",
        postMessage: port.postMessage,
        onMessage: {
          addListener: vi.fn((listener: PortListener) => {
            listeners.push(listener);
          }),
        },
        onDisconnect: {
          addListener: vi.fn(),
        },
      })),
      sendMessage,
    },
    storage: {
      local: {
        get: vi.fn(async () => ({})),
        set: vi.fn(async () => undefined),
      },
    },
    tabs: {
      query: tabsQuery,
    },
  });

  return { port, tabsQuery, sendMessage };
}

async function importInitializedSidePanel(): Promise<void> {
  vi.resetModules();
  await import("./sidepanel");
  await flush();
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

  it("posts target selection without mutating selected UI before next snapshot", async () => {
    loadSidePanelHtml();
    const { port } = mockChromeRuntime();
    await importInitializedSidePanel();

    port.emit({
      type: "assistant.snapshot",
      state: createReadySnapshot({
        targets: [createTarget({ targetId: "target-1", alias: "Alpha" }), createTarget({ targetId: "target-2", alias: "Beta" })],
        selectedTargetId: "target-1",
      }),
    });
    await flush();

    document.querySelector<HTMLButtonElement>('[data-target-id="target-2"]')?.click();

    expect(port.postMessage).toHaveBeenCalledWith({ type: "assistant.selectTarget", targetId: "target-2" });
    expect(document.querySelector<HTMLButtonElement>('[data-target-id="target-1"]')?.className).toContain("target-option--selected");
    expect(document.querySelector<HTMLButtonElement>('[data-target-id="target-2"]')?.className).not.toContain("target-option--selected");
  });

  it("posts chat send command instead of sending through a sidepanel broker", async () => {
    loadSidePanelHtml();
    const { port } = mockChromeRuntime();
    await importInitializedSidePanel();

    port.emit({ type: "assistant.snapshot", state: createReadySnapshot() });
    await flush();

    const input = document.querySelector<HTMLTextAreaElement>("#chat-input");
    if (input) {
      input.value = "  Привет Pi  ";
      input.dispatchEvent(new Event("input"));
    }

    document.querySelector<HTMLButtonElement>("#chat-send-button")?.click();

    expect(port.postMessage).toHaveBeenCalledWith({ type: "assistant.sendChatMessage", message: "Привет Pi" });
    expect(input?.value).toBe("");
  });

  it("keeps known targets rendered while broker is temporarily offline", async () => {
    loadSidePanelHtml();
    const { port } = mockChromeRuntime();
    await importInitializedSidePanel();

    port.emit({
      type: "assistant.snapshot",
      state: createReadySnapshot({
        targets: [createTarget({ targetId: "target-1", alias: "Alpha" }), createTarget({ targetId: "target-2", alias: "Beta" })],
        selectedTargetId: "target-1",
        connection: {
          brokerOnline: false,
          bridgeOnline: false,
          connecting: false,
          tokenConfigured: true,
          browserAuthorized: undefined,
          lastError: "Pi недоступен",
        },
      }),
    });
    await flush();

    expect(document.querySelector<HTMLButtonElement>('[data-target-id="target-1"]')?.textContent).toContain("Alpha");
    expect(document.querySelector<HTMLButtonElement>('[data-target-id="target-2"]')?.textContent).toContain("Beta");
    expect(document.querySelector("#target-container")?.textContent).not.toContain("Pi не подключён");
  });

  it("posts DOM picker command through assistant port with active tab id", async () => {
    loadSidePanelHtml();
    const { port, tabsQuery, sendMessage } = mockChromeRuntime();
    await importInitializedSidePanel();

    port.emit({ type: "assistant.snapshot", state: createReadySnapshot() });
    await flush();

    document.querySelector<HTMLButtonElement>("#send-button")?.click();
    await flush();

    expect(tabsQuery).toHaveBeenCalledWith({ active: true, currentWindow: true });
    expect(port.postMessage).toHaveBeenCalledWith({ type: "assistant.startDomPicker", tabId: 1 });
    expect(sendMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: "startDomPicker" }));
  });
});
