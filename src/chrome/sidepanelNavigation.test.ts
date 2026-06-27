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
  disconnect(): void;
};

type MockChromeRuntime = {
  port: MockPort;
  ports: MockPort[];
  tabsQuery: ReturnType<typeof vi.fn>;
  sendMessage: ReturnType<typeof vi.fn>;
};

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
      events: [],
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
  let state: BackgroundAssistantState = reduceAssistantState(base, {
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

function mockChromeRuntime(): MockChromeRuntime {
  const ports: MockPort[] = [];
  const createPort = (): MockPort & {
    addMessageListener(listener: PortListener): void;
    addDisconnectListener(listener: () => void): void;
  } => {
    const listeners: PortListener[] = [];
    const disconnectListeners: Array<() => void> = [];
    const port = {
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
      addMessageListener(listener: PortListener) {
        listeners.push(listener);
      },
      addDisconnectListener(listener: () => void) {
        disconnectListeners.push(listener);
      },
    };
    ports.push(port);
    return port;
  };
  const port = createPort();
  const tabsQuery = vi.fn(async () => [{ id: 1 }]);
  const sendMessage = vi.fn(async () => ({ ok: true }));

  let connectCount = 0;

  vi.stubGlobal("chrome", {
    runtime: {
      connect: vi.fn(() => {
        const nextPort = connectCount === 0 ? port : createPort();
        connectCount += 1;
        return {
          name: "sidepanel",
          postMessage: nextPort.postMessage,
          onMessage: {
            addListener: vi.fn((listener: PortListener) => {
              nextPort.addMessageListener(listener);
            }),
          },
          onDisconnect: {
            addListener: vi.fn((listener: () => void) => {
              nextPort.addDisconnectListener(listener);
            }),
          },
        };
      }),
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

  return { port, ports, tabsQuery, sendMessage };
}

async function importInitializedSidePanel(): Promise<void> {
  vi.resetModules();
  await import("./sidepanel");
  await flush();
}

describe("sidepanel navigation", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.resetModules();
    document.documentElement.innerHTML = "";
  });

  it("renders port input with default 31415", async () => {
    loadSidePanelHtml();
    mockChromeRuntime();
    await importInitializedSidePanel();

    const portInput = document.querySelector<HTMLInputElement>("#session-port-input");
    expect(portInput).not.toBeNull();
    expect(portInput?.value).toBe("31415");
  });

  it("renders connect button with Russian label", async () => {
    loadSidePanelHtml();
    mockChromeRuntime();
    await importInitializedSidePanel();

    const connectButton = document.querySelector<HTMLButtonElement>("#connect-session-button");
    expect(connectButton).not.toBeNull();
    expect(connectButton?.textContent).toBe("Подключить");
  });

  it("posts connect command with entered port", async () => {
    const runtime = mockChromeRuntime();
    loadSidePanelHtml();
    await importInitializedSidePanel();

    const portInput = document.querySelector<HTMLInputElement>("#session-port-input")!;
    portInput.value = "31416";
    document.querySelector<HTMLButtonElement>("#connect-session-button")!.click();

    expect(runtime.port.postMessage).toHaveBeenCalledWith({
      type: "assistant.session.connect",
      port: 31416,
    });
  });

  it("posts connect command with default port 31415", async () => {
    const runtime = mockChromeRuntime();
    loadSidePanelHtml();
    await importInitializedSidePanel();

    document.querySelector<HTMLButtonElement>("#connect-session-button")!.click();

    expect(runtime.port.postMessage).toHaveBeenCalledWith({
      type: "assistant.session.connect",
      port: 31415,
    });
  });

  it("does not post connect command for invalid port", async () => {
    const runtime = mockChromeRuntime();
    loadSidePanelHtml();
    await importInitializedSidePanel();

    const portInput = document.querySelector<HTMLInputElement>("#session-port-input")!;
    portInput.value = "abc";
    document.querySelector<HTMLButtonElement>("#connect-session-button")!.click();

    expect(runtime.port.postMessage).not.toHaveBeenCalled();
  });

  it("does not post connect command for port out of range", async () => {
    const runtime = mockChromeRuntime();
    loadSidePanelHtml();
    await importInitializedSidePanel();

    const portInput = document.querySelector<HTMLInputElement>("#session-port-input")!;
    portInput.value = "70000";
    document.querySelector<HTMLButtonElement>("#connect-session-button")!.click();

    expect(runtime.port.postMessage).not.toHaveBeenCalled();
  });

  it("updates port input from snapshot configuredPort", async () => {
    loadSidePanelHtml();
    const runtime = mockChromeRuntime();
    await importInitializedSidePanel();

    runtime.port.emit({
      type: "assistant.snapshot",
      state: createConnectedState({ connection: { configuredPort: 31417, online: true } }),
    });
    await flush();

    const portInput = document.querySelector<HTMLInputElement>("#session-port-input");
    expect(portInput?.value).toBe("31417");
  });

  it("reconnects the assistant port after background disconnect", async () => {
    vi.useFakeTimers();
    loadSidePanelHtml();
    const runtime = mockChromeRuntime();
    await importInitializedSidePanel();

    runtime.ports[0]?.emit({ type: "assistant.snapshot", state: createConnectedState() });
    await flush();

    runtime.ports[0]?.disconnect();
    await flush();

    expect(document.querySelector("#diagnostics-output")?.textContent).toContain("Переподключаем боковую панель…");

    await vi.advanceTimersByTimeAsync(250);
    runtime.ports[1]?.emit({
      type: "assistant.snapshot",
      state: createConnectedState({
        snapshot: createDirectSnapshot({ session: { ...createDirectSnapshot().session, alias: "Alpha restored" } }),
      }),
    });
    await flush();

    expect(chrome.runtime.connect).toHaveBeenCalledTimes(2);
  });

  it("renders context usage and model controls under the composer", async () => {
    loadSidePanelHtml();
    const runtime = mockChromeRuntime();
    await importInitializedSidePanel();

    runtime.port.emit({
      type: "assistant.snapshot",
      state: createConnectedState({
        runtime: {
          model: { provider: "anthropic", id: "claude-sonnet", label: "Claude Sonnet" },
          contextUsage: { tokens: 12340, maxTokens: 200000, percent: 6 },
          isIdle: true,
          updatedAt: 1_710_000_000_500,
          availableModels: [
            { provider: "anthropic", id: "claude-sonnet", label: "Claude Sonnet" },
            { provider: "openai", id: "gpt-4.1", label: "GPT 4.1" },
          ],
          modelMutationPending: false,
          modelError: undefined,
        },
      }),
    });
    await flush();

    expect(document.querySelector("#model-button")?.textContent).toContain("Модель: Claude Sonnet");
    expect(document.querySelector("#context-usage")?.textContent).toContain("Контекст: 12 340 / 200 000 токенов · 6%");

    document.querySelector<HTMLButtonElement>("#model-button")?.click();
    expect(document.querySelector("#model-menu")?.textContent).toContain("GPT 4.1");

    document.querySelector<HTMLButtonElement>("[data-model-id='gpt-4.1']")?.click();
    expect(runtime.port.postMessage).toHaveBeenCalledWith({
      type: "assistant.model.set",
      provider: "openai",
      modelId: "gpt-4.1",
    });
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

  it("renders connected status text when online", async () => {
    loadSidePanelHtml();
    const runtime = mockChromeRuntime();
    await importInitializedSidePanel();

    runtime.port.emit({
      type: "assistant.snapshot",
      state: createConnectedState({ connection: { configuredPort: 31415, online: true } }),
    });
    await flush();

    const statusEl = document.querySelector("#session-connection-status");
    expect(statusEl?.textContent).toContain("✅");
    expect(statusEl?.textContent).toContain("Подключено");
    expect(statusEl?.textContent).toContain("31415");
  });

  it("shows warning disconnected status when offline", async () => {
    loadSidePanelHtml();
    const runtime = mockChromeRuntime();
    await importInitializedSidePanel();

    runtime.port.emit({
      type: "assistant.snapshot",
      state: createInitialAssistantState(),
    });
    await flush();

    const statusEl = document.querySelector("#session-connection-status");
    expect(statusEl?.textContent).toContain("⚠️");
    expect(statusEl?.textContent).toContain("Введите порт");
  });

  it("renders status tone data attribute on connection element", async () => {
    loadSidePanelHtml();
    const runtime = mockChromeRuntime();
    await importInitializedSidePanel();

    // Online → success tone
    runtime.port.emit({
      type: "assistant.snapshot",
      state: createConnectedState({ connection: { configuredPort: 31415, online: true } }),
    });
    await flush();
    let statusEl = document.querySelector<HTMLElement>("#session-connection-status");
    expect(statusEl?.dataset.tone).toBe("success");

    // Offline → warning tone
    runtime.port.emit({
      type: "assistant.snapshot",
      state: createInitialAssistantState(),
    });
    await flush();
    statusEl = document.querySelector<HTMLElement>("#session-connection-status");
    expect(statusEl?.dataset.tone).toBe("warning");
  });

  it("renders error status tone when lastError exists", async () => {
    loadSidePanelHtml();
    const runtime = mockChromeRuntime();
    await importInitializedSidePanel();

    const errorState = createConnectedState({
      connection: { configuredPort: 31415, online: false, lastError: "Pi-сессия недоступна" },
    });
    runtime.port.emit({
      type: "assistant.snapshot",
      state: errorState,
    });
    await flush();

    const statusEl = document.querySelector<HTMLElement>("#session-connection-status");
    expect(statusEl?.textContent).toContain("❌");
    expect(statusEl?.textContent).toContain("Pi-сессия недоступна");
    expect(statusEl?.dataset.tone).toBe("error");
  });

  it("renders info status tone when connecting", async () => {
    loadSidePanelHtml();
    const runtime = mockChromeRuntime();
    await importInitializedSidePanel();

    const connectingState = reduceAssistantState(createInitialAssistantState(), {
      kind: "connection_updated",
      connection: { connecting: true, online: false, configuredPort: 31416 },
    });
    runtime.port.emit({
      type: "assistant.snapshot",
      state: connectingState,
    });
    await flush();

    const statusEl = document.querySelector<HTMLElement>("#session-connection-status");
    expect(statusEl?.textContent).toContain("🔄");
    expect(statusEl?.textContent).toContain("Подключаемся");
    expect(statusEl?.dataset.tone).toBe("info");
  });

  it("posts chat send command when online", async () => {
    loadSidePanelHtml();
    const runtime = mockChromeRuntime();
    await importInitializedSidePanel();

    runtime.port.emit({ type: "assistant.snapshot", state: createConnectedState() });
    await flush();

    const input = document.querySelector<HTMLTextAreaElement>("#chat-input");
    if (input) {
      input.value = "  Привет Pi  ";
      input.dispatchEvent(new Event("input"));
    }

    document.querySelector<HTMLButtonElement>("#chat-send-button")?.click();

    expect(runtime.port.postMessage).toHaveBeenCalledWith({ type: "assistant.sendChatMessage", message: "Привет Pi" });
    expect(input?.value).toBe("");
  });

  it("does not post chat send when offline", async () => {
    loadSidePanelHtml();
    const runtime = mockChromeRuntime();
    await importInitializedSidePanel();

    const input = document.querySelector<HTMLTextAreaElement>("#chat-input");
    if (input) {
      input.value = "Привет";
      input.dispatchEvent(new Event("input"));
    }

    document.querySelector<HTMLButtonElement>("#chat-send-button")?.click();

    expect(runtime.port.postMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "assistant.sendChatMessage" }),
    );
  });

  it("does not have session list UI elements", async () => {
    loadSidePanelHtml();
    mockChromeRuntime();
    await importInitializedSidePanel();

    expect(document.querySelector("#target-container")).toBeNull();
    expect(document.querySelector("#refresh-sessions-button")).toBeNull();
    expect(document.querySelector("#session-stale-guidance")).toBeNull();
  });

  it("does not have auth drawer UI elements", async () => {
    loadSidePanelHtml();
    mockChromeRuntime();
    await importInitializedSidePanel();

    expect(document.querySelector("#panel-auth")).toBeNull();
    expect(document.querySelector("#tab-auth")).toBeNull();
    expect(document.querySelector("#header-auth-button")).toBeNull();
    expect(document.querySelector("#browser-token-output")).toBeNull();
  });

  it("no green circle behind avatar icon", async () => {
    loadSidePanelHtml();
    mockChromeRuntime();
    await importInitializedSidePanel();

    const avatar = document.querySelector<HTMLImageElement>(".avatar");
    expect(avatar).not.toBeNull();
    // The avatar should be a direct img element, not a container div with a background
    expect(avatar?.tagName.toLowerCase()).toBe("img");
  });

  it("posts DOM picker command through assistant port with active tab id", async () => {
    loadSidePanelHtml();
    const { port, tabsQuery } = mockChromeRuntime();
    await importInitializedSidePanel();

    port.emit({ type: "assistant.snapshot", state: createConnectedState() });
    await flush();

    document.querySelector<HTMLButtonElement>("#send-button")?.click();
    await flush();

    expect(tabsQuery).toHaveBeenCalledWith({ active: true, currentWindow: true });
    expect(port.postMessage).toHaveBeenCalledWith({ type: "assistant.startDomPicker", tabId: 1 });
  });
});
