// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createInitialAssistantState, type BackgroundAssistantState } from "./assistantState";

const brokerMock = vi.hoisted(() => ({
  constructed: 0,
}));

vi.mock("./sidepanelBrokerClient", () => ({
  SidePanelBrokerClient: class MockSidePanelBrokerClient {
    constructor() {
      brokerMock.constructed += 1;
      throw new Error("Sidepanel не должен создавать broker client");
    }
  },
}));

type PortListener = (message: unknown) => void;

type DisconnectListener = () => void;

type MockPort = {
  postMessage: ReturnType<typeof vi.fn>;
  emit(message: unknown): void;
  disconnect(): void;
};

function loadSidePanelHtml(): void {
  const html = readFileSync(resolve(process.cwd(), "src/chrome/sidepanel.html"), "utf8");
  document.documentElement.innerHTML = html;
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

type TargetMetadataLike = BackgroundAssistantState["targets"][number];

function createTarget(overrides: Partial<TargetMetadataLike> = {}): TargetMetadataLike {
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

function createSnapshot(overrides: Partial<BackgroundAssistantState> = {}): BackgroundAssistantState {
  const base = createInitialAssistantState();
  return {
    ...base,
    connection: {
      ...base.connection,
      brokerOnline: true,
      bridgeOnline: true,
      connecting: false,
      tokenConfigured: true,
      browserAuthorized: true,
      ...overrides.connection,
    },
    targets: overrides.targets ?? base.targets,
    selectedTargetId: overrides.selectedTargetId,
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
    epoch: overrides.epoch ?? base.epoch,
  };
}

function mockChrome(): { connect: ReturnType<typeof vi.fn>; port: MockPort } {
  const listeners: PortListener[] = [];
  const disconnectListeners: DisconnectListener[] = [];
  const port: MockPort = {
    postMessage: vi.fn(),
    emit(message: unknown) {
      for (const listener of listeners) {
        listener(message);
      }
    },
    disconnect() {
      for (const listener of disconnectListeners) {
        listener();
      }
    },
  };
  const connect = vi.fn(() => ({
    name: "sidepanel",
    postMessage: port.postMessage,
    onMessage: {
      addListener: vi.fn((listener: PortListener) => {
        listeners.push(listener);
      }),
    },
    onDisconnect: {
      addListener: vi.fn((listener: DisconnectListener) => {
        disconnectListeners.push(listener);
      }),
    },
  }));

  vi.stubGlobal("chrome", {
    runtime: {
      connect,
      sendMessage: vi.fn(async () => ({ ok: true })),
    },
    storage: {
      local: {
        get: vi.fn(async () => ({})),
        set: vi.fn(async () => undefined),
      },
    },
    tabs: {
      query: vi.fn(async () => [{ id: 1 }]),
    },
  });

  return { connect, port };
}

async function importInitializedSidePanel(): Promise<void> {
  vi.resetModules();
  await import("./sidepanel");
  await flush();
}

describe("sidepanel auth lifecycle", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
    brokerMock.constructed = 0;
    document.documentElement.innerHTML = "";
  });

  it("opens exactly one sidepanel port and never constructs a broker client", async () => {
    loadSidePanelHtml();
    const { connect } = mockChrome();

    await importInitializedSidePanel();

    expect(connect).toHaveBeenCalledTimes(1);
    expect(connect).toHaveBeenCalledWith({ name: "sidepanel" });
    expect(brokerMock.constructed).toBe(0);
  });

  it("renders targets and auth token from assistant snapshots", async () => {
    loadSidePanelHtml();
    const { port } = mockChrome();
    await importInitializedSidePanel();

    port.emit({
      type: "assistant.snapshot",
      state: createSnapshot({ targets: [createTarget()], selectedTargetId: "target-1" }),
    });
    await flush();

    expect(document.querySelector("#status-text")?.textContent).toBe("Pi подключён · целей: 1");
    expect(document.querySelector("#target-container")?.textContent).toContain("Alpha");
    expect(document.querySelector("#target-container")?.textContent).toContain("/tmp/pi-alpha");
    expect(document.querySelector("#browser-token-output")?.textContent).toBe("token-1");
  });

  it("posts auth commands from auth controls and keeps token copy local", async () => {
    loadSidePanelHtml();
    const { port } = mockChrome();
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });

    await importInitializedSidePanel();
    port.emit({ type: "assistant.snapshot", state: createSnapshot() });
    await flush();

    document.querySelector<HTMLButtonElement>("#header-auth-button")?.click();
    document.querySelector<HTMLButtonElement>("#copy-browser-token-button")?.click();
    document.querySelector<HTMLButtonElement>("#regenerate-browser-token-button")?.click();
    document.querySelector<HTMLButtonElement>("#clear-browser-token-button")?.click();
    await flush();

    expect(port.postMessage).toHaveBeenCalledWith({ type: "assistant.auth.refresh" });
    expect(writeText).toHaveBeenCalledWith("token-1");
    expect(port.postMessage).toHaveBeenCalledWith({ type: "assistant.auth.regenerateToken" });
    expect(port.postMessage).toHaveBeenCalledWith({ type: "assistant.auth.clearToken" });
  });

  it("renders unavailable state and keeps commands safe after assistant port disconnects", async () => {
    loadSidePanelHtml();
    const { port } = mockChrome();
    await importInitializedSidePanel();
    port.emit({ type: "assistant.snapshot", state: createSnapshot({ targets: [createTarget()], selectedTargetId: "target-1" }) });
    await flush();
    const staleTargetButton = document.querySelector<HTMLButtonElement>('[data-target-id="target-1"]');

    port.disconnect();
    await flush();

    expect(document.querySelector("#status-text")?.textContent).toContain("Состояние боковой панели недоступно");
    expect(document.querySelector("#target-container")?.textContent).toContain("Состояние боковой панели недоступно");
    expect(document.querySelector<HTMLButtonElement>("#send-button")?.disabled).toBe(true);
    expect(document.querySelector<HTMLButtonElement>("#chat-send-button")?.disabled).toBe(true);
    expect(document.querySelector<HTMLButtonElement>("#copy-browser-token-button")?.disabled).toBe(true);
    expect(document.querySelector<HTMLButtonElement>("#regenerate-browser-token-button")?.disabled).toBe(true);
    expect(document.querySelector<HTMLButtonElement>("#clear-browser-token-button")?.disabled).toBe(true);

    expect(() => {
      const input = document.querySelector<HTMLTextAreaElement>("#chat-input");
      if (input) {
        input.value = "Привет";
        input.dispatchEvent(new Event("input"));
      }
      document.querySelector<HTMLButtonElement>("#chat-send-button")?.click();
      document.querySelector<HTMLButtonElement>("#regenerate-browser-token-button")?.click();
      document.querySelector<HTMLButtonElement>("#clear-browser-token-button")?.click();
      staleTargetButton?.click();
    }).not.toThrow();
  });
});
