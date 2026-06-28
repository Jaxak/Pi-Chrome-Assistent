// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createInitialAssistantState,
  reduceAssistantState,
  type BackgroundAssistantState,
} from "./assistantState";
import type { DirectSessionSnapshot } from "../shared/protocol";

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

function createDirectSnapshot(overrides: Partial<DirectSessionSnapshot> = {}): DirectSessionSnapshot {
  return {
    session: {
      cwd: "/repo",
      gitBranch: "main",
      pid: 1234,
      sessionName: "test-session",
      alias: "frontend",
      connectedAt: 1_710_000_000_000,
    },
    chat: {
      entries: [],
      agentBusy: false,
      busyLabel: "Агент работает в фоне…",
    },
    runtime: {
      model: { provider: "anthropic", id: "claude-sonnet", label: "Claude Sonnet" },
      availableModels: [
        { provider: "anthropic", id: "claude-sonnet", label: "Claude Sonnet" },
        { provider: "openai", id: "gpt-4.1", label: "GPT 4.1" },
      ],
      contextUsage: { tokens: 12340, maxTokens: 200000, percent: 6 },
      isIdle: true,
      updatedAt: 1_710_000_000_500,
    },
    ...overrides,
  };
}

type ConnectedStateOverrides = Omit<Partial<BackgroundAssistantState>, "connection" | "snapshot"> & {
  snapshot?: DirectSessionSnapshot;
  connection?: Partial<BackgroundAssistantState["connection"]>;
};

function createConnectedState(overrides: ConnectedStateOverrides = {}): BackgroundAssistantState {
  const base = createInitialAssistantState();
  let state = reduceAssistantState(base, {
    kind: "connection_updated",
    connection: { configuredPort: overrides.connection?.configuredPort ?? 31415 },
  });
  state = reduceAssistantState(state, {
    kind: "session_snapshot",
    snapshot: overrides.snapshot ?? createDirectSnapshot(),
  });
  return {
    ...state,
    epoch: overrides.epoch ?? state.epoch + 1,
    connection: { ...state.connection, ...(overrides.connection ?? {}) },
    chat: { ...state.chat, ...(overrides.chat ?? {}) },
    runtime: { ...state.runtime, ...(overrides.runtime ?? {}) },
    diagnostics: overrides.diagnostics ?? state.diagnostics,
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

describe("sidepanel lifecycle", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
    document.documentElement.innerHTML = "";
  });

  it("opens exactly one sidepanel port", async () => {
    loadSidePanelHtml();
    const { connect } = mockChrome();

    await importInitializedSidePanel();

    expect(connect).toHaveBeenCalledTimes(1);
    expect(connect).toHaveBeenCalledWith({ name: "sidepanel" });
  });

  it("does not render connection status in the header", async () => {
    loadSidePanelHtml();
    mockChrome();

    await importInitializedSidePanel();

    expect(document.querySelector("#status-text")).toBeNull();
    expect(document.querySelector(".ant-badge-status")).toBeNull();
    expect(document.querySelector(".brand-title")?.textContent).toBe("Ассистент");
  });

  it("renders connected state from assistant snapshots", async () => {
    loadSidePanelHtml();
    const { port } = mockChrome();
    await importInitializedSidePanel();

    port.emit({
      type: "assistant.snapshot",
      state: createConnectedState(),
    });
    await flush();

    // Session info should show with success emoji
    const statusEl = document.querySelector("#session-heading-status");
    expect(statusEl?.textContent).toContain("✅");
    expect(statusEl?.textContent).toContain("Подключено");
    // Model info should render
    expect(document.querySelector("#model-button")?.textContent).toContain("Claude Sonnet");
  });

  it("renders unavailable state and keeps commands safe after assistant port disconnects", async () => {
    loadSidePanelHtml();
    const { port } = mockChrome();
    await importInitializedSidePanel();
    port.emit({ type: "assistant.snapshot", state: createConnectedState() });
    await flush();

    port.disconnect();
    await flush();

    expect(document.querySelector("#status-text")).toBeNull();
    expect(document.querySelector("#diagnostics-output")?.textContent).toContain("Переподключаем боковую панель…");
    expect(document.querySelector<HTMLButtonElement>("#send-button")?.disabled).toBe(true);
    expect(document.querySelector<HTMLButtonElement>("#chat-send-button")?.disabled).toBe(true);

    // Commands should not throw when disconnected
    expect(() => {
      const input = document.querySelector<HTMLTextAreaElement>("#chat-input");
      if (input) {
        input.value = "Привет";
        input.dispatchEvent(new Event("input"));
      }
      document.querySelector<HTMLButtonElement>("#chat-send-button")?.click();
    }).not.toThrow();
  });

  it("renders runtime model and context usage from snapshot", async () => {
    loadSidePanelHtml();
    const { port } = mockChrome();
    await importInitializedSidePanel();

    port.emit({
      type: "assistant.snapshot",
      state: createConnectedState(),
    });
    await flush();

    expect(document.querySelector("#model-button")?.textContent).toContain("Модель: Claude Sonnet");
    expect(document.querySelector("#context-usage")?.textContent).toContain("Контекст: 12 340 / 200 000 токенов · 6%");
  });

  it("shows connecting status when connecting", async () => {
    loadSidePanelHtml();
    const { port } = mockChrome();
    await importInitializedSidePanel();

    const connectingState = reduceAssistantState(createInitialAssistantState(), {
      kind: "connection_updated",
      connection: { connecting: true, online: false, configuredPort: 31416 },
    });

    port.emit({ type: "assistant.snapshot", state: connectingState });
    await flush();

    const statusEl = document.querySelector("#session-heading-status");
    expect(statusEl?.textContent).toContain("Подключаемся");
  });

  it("updates port input when snapshot carries configuredPort", async () => {
    loadSidePanelHtml();
    const { port } = mockChrome();
    await importInitializedSidePanel();

    port.emit({
      type: "assistant.snapshot",
      state: createConnectedState({ connection: { configuredPort: 31418, online: true } }),
    });
    await flush();

    const portInput = document.querySelector<HTMLInputElement>("#session-port-input");
    expect(portInput?.value).toBe("31418");
  });
});
