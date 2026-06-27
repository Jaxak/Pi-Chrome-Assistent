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
  disconnect(): void;
};

type MockChromeRuntime = {
  port: MockPort;
  ports: MockPort[];
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
    epoch: overrides.epoch ?? 1,
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
    runtime: {
      ...base.runtime,
      ...overrides.runtime,
    },
    diagnostics: overrides.diagnostics ?? base.diagnostics,
  };
}

function mockChromeRuntime(): MockChromeRuntime {
  const ports: MockPort[] = [];
  const createPort = (): MockPort & { addMessageListener(listener: PortListener): void; addDisconnectListener(listener: () => void): void } => {
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

  it("reconnects the assistant port after background disconnect instead of staying unavailable", async () => {
    vi.useFakeTimers();
    loadSidePanelHtml();
    const runtime = mockChromeRuntime();
    await importInitializedSidePanel();

    runtime.ports[0]?.emit({ type: "assistant.snapshot", state: createReadySnapshot() });
    await flush();

    runtime.ports[0]?.disconnect();
    await flush();

    expect(document.querySelector("#diagnostics-output")?.textContent).toContain("Переподключаем боковую панель…");

    await vi.advanceTimersByTimeAsync(250);
    runtime.ports[1]?.emit({ type: "assistant.snapshot", state: createReadySnapshot({ targets: [createTarget({ alias: "Alpha restored" })] }) });
    await flush();

    expect(chrome.runtime.connect).toHaveBeenCalledTimes(2);
    expect(document.querySelector("#target-container")?.textContent).toContain("Alpha restored");
  });

  it("renders context usage and model controls under the composer", async () => {
    loadSidePanelHtml();
    const runtime = mockChromeRuntime();
    await importInitializedSidePanel();

    runtime.port.emit({
      type: "assistant.snapshot",
      state: createReadySnapshot({
        runtime: {
          selectedTargetRuntime: {
            targetId: "target-1",
            model: { provider: "anthropic", id: "claude-sonnet", label: "Claude Sonnet" },
            contextUsage: { tokens: 12340, maxTokens: 200000, percent: 6 },
            isIdle: true,
            updatedAt: 1_710_000_000_500,
          },
          availableModels: [
            { provider: "anthropic", id: "claude-sonnet", label: "Claude Sonnet" },
            { provider: "openai", id: "gpt-4.1", label: "GPT 4.1" },
          ],
          modelMutationPending: false,
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

  it("keeps initial acquisition open when broker reports online before targets", async () => {
    loadSidePanelHtml();
    const { port } = mockChromeRuntime();
    await importInitializedSidePanel();

    port.emit({ type: "assistant.snapshot", state: createInitialAssistantState() });
    await flush();

    port.emit({
      type: "assistant.snapshot",
      state: createReadySnapshot({
        epoch: 1,
        targets: [],
        selectedTargetId: undefined,
        connection: {
          brokerOnline: false,
          bridgeOnline: false,
          connecting: true,
          tokenConfigured: true,
          browserAuthorized: undefined,
          targetsStale: false,
          targetsRefreshPending: true,
          lastError: undefined,
        },
      }),
    });
    await flush();

    port.emit({
      type: "assistant.snapshot",
      state: createReadySnapshot({
        epoch: 2,
        targets: [],
        selectedTargetId: undefined,
        connection: {
          brokerOnline: true,
          bridgeOnline: true,
          connecting: false,
          tokenConfigured: true,
          browserAuthorized: true,
          targetsStale: false,
          targetsRefreshPending: true,
          lastError: undefined,
        },
      }),
    });
    await flush();

    port.emit({
      type: "assistant.snapshot",
      state: createReadySnapshot({
        epoch: 3,
        targets: [createTarget({ targetId: "target-1", alias: "Alpha" })],
        selectedTargetId: "target-1",
        connection: {
          brokerOnline: true,
          bridgeOnline: true,
          connecting: false,
          tokenConfigured: true,
          browserAuthorized: true,
          targetsStale: false,
          targetsRefreshPending: false,
          lastError: undefined,
        },
      }),
    });
    await flush();

    expect(document.querySelector<HTMLButtonElement>('[data-target-id="target-1"]')?.textContent).toContain("Alpha");
  });

  it("renders targets on open after an initial bootstrap snapshot", async () => {
    loadSidePanelHtml();
    const { port } = mockChromeRuntime();
    await importInitializedSidePanel();

    port.emit({ type: "assistant.snapshot", state: createInitialAssistantState() });
    await flush();

    port.emit({
      type: "assistant.snapshot",
      state: createReadySnapshot({
        epoch: 1,
        targets: [createTarget({ targetId: "target-1", alias: "Alpha" })],
        selectedTargetId: "target-1",
      }),
    });
    await flush();

    expect(document.querySelector<HTMLButtonElement>('[data-target-id="target-1"]')?.textContent).toContain("Alpha");
  });

  it("posts target selection and marks the clicked target selected optimistically", async () => {
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
    expect(document.querySelector<HTMLButtonElement>('[data-target-id="target-1"]')?.className).not.toContain("target-option--selected");
    expect(document.querySelector<HTMLButtonElement>('[data-target-id="target-2"]')?.className).toContain("target-option--selected");
  });

  it("does not mutate target DOM when an identical snapshot arrives", async () => {
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

    const container = document.querySelector<HTMLElement>("#target-container");
    const mutations: MutationRecord[] = [];
    const observer = new MutationObserver((records) => mutations.push(...records));
    if (container) {
      observer.observe(container, { attributes: true, childList: true, characterData: true, subtree: true });
    }

    port.emit({
      type: "assistant.snapshot",
      state: createReadySnapshot({
        epoch: 2,
        targets: [createTarget({ targetId: "target-1", alias: "Alpha" }), createTarget({ targetId: "target-2", alias: "Beta" })],
        selectedTargetId: "target-1",
      }),
    });
    await flush();
    observer.disconnect();

    expect(mutations).toHaveLength(0);
  });

  it("does not mutate target placeholder DOM when an identical snapshot arrives", async () => {
    loadSidePanelHtml();
    const { port } = mockChromeRuntime();
    await importInitializedSidePanel();

    const noTargetsSnapshot = createReadySnapshot({
      targets: [],
      selectedTargetId: undefined,
      connection: {
        brokerOnline: false,
        bridgeOnline: false,
        connecting: false,
        tokenConfigured: true,
        browserAuthorized: undefined,
        targetsStale: false,
        targetsRefreshPending: false,
        lastError: "Pi недоступен",
      },
    });

    port.emit({ type: "assistant.snapshot", state: noTargetsSnapshot });
    await flush();

    const container = document.querySelector<HTMLElement>("#target-container");
    const mutations: MutationRecord[] = [];
    const observer = new MutationObserver((records) => mutations.push(...records));
    if (container) {
      observer.observe(container, { attributes: true, childList: true, characterData: true, subtree: true });
    }

    port.emit({ type: "assistant.snapshot", state: { ...noTargetsSnapshot, epoch: 2 } });
    await flush();
    observer.disconnect();

    expect(mutations).toHaveLength(0);
  });

  it("renders token guidance when token is cleared after target list freezes", async () => {
    loadSidePanelHtml();
    const { port } = mockChromeRuntime();
    await importInitializedSidePanel();

    port.emit({
      type: "assistant.snapshot",
      state: createReadySnapshot({
        targets: [createTarget({ targetId: "target-1", alias: "Alpha" })],
        selectedTargetId: "target-1",
      }),
    });
    await flush();

    port.emit({
      type: "assistant.snapshot",
      state: createReadySnapshot({
        epoch: 2,
        targets: [],
        selectedTargetId: undefined,
        connection: {
          brokerOnline: false,
          bridgeOnline: false,
          connecting: false,
          tokenConfigured: false,
          browserAuthorized: undefined,
          targetsStale: false,
          targetsRefreshPending: false,
          lastError: "Токен браузера не настроен.",
        },
      }),
    });
    await flush();

    expect(document.querySelector<HTMLButtonElement>('[data-target-id="target-1"]')).toBeNull();
    expect(document.querySelector("#target-container")?.textContent).toContain("Для отправки настройте browserToken");
  });

  it("keeps target acquisition open when token recovery reports online before targets", async () => {
    loadSidePanelHtml();
    const { port } = mockChromeRuntime();
    await importInitializedSidePanel();

    port.emit({
      type: "assistant.snapshot",
      state: createReadySnapshot({
        targets: [],
        selectedTargetId: undefined,
        connection: {
          brokerOnline: false,
          bridgeOnline: false,
          connecting: false,
          tokenConfigured: false,
          browserAuthorized: undefined,
          targetsStale: false,
          targetsRefreshPending: false,
          lastError: "Токен браузера не настроен.",
        },
      }),
    });
    await flush();

    port.emit({
      type: "assistant.snapshot",
      state: createReadySnapshot({
        epoch: 2,
        targets: [],
        selectedTargetId: undefined,
        connection: {
          brokerOnline: false,
          bridgeOnline: false,
          connecting: true,
          tokenConfigured: true,
          browserAuthorized: undefined,
          targetsStale: false,
          targetsRefreshPending: false,
          lastError: undefined,
        },
      }),
    });
    await flush();

    port.emit({
      type: "assistant.snapshot",
      state: createReadySnapshot({
        epoch: 3,
        targets: [],
        selectedTargetId: undefined,
        connection: {
          brokerOnline: true,
          bridgeOnline: true,
          connecting: false,
          tokenConfigured: true,
          browserAuthorized: true,
          targetsStale: false,
          targetsRefreshPending: false,
          lastError: undefined,
        },
      }),
    });
    await flush();

    port.emit({
      type: "assistant.snapshot",
      state: createReadySnapshot({
        epoch: 4,
        targets: [createTarget({ targetId: "target-1", alias: "Alpha" })],
        selectedTargetId: "target-1",
      }),
    });
    await flush();

    expect(document.querySelector<HTMLButtonElement>('[data-target-id="target-1"]')?.textContent).toContain("Alpha");
  });

  it("updates target container when token becomes configured after missing-token guidance", async () => {
    loadSidePanelHtml();
    const { port } = mockChromeRuntime();
    await importInitializedSidePanel();

    port.emit({
      type: "assistant.snapshot",
      state: createReadySnapshot({
        targets: [],
        selectedTargetId: undefined,
        connection: {
          brokerOnline: false,
          bridgeOnline: false,
          connecting: false,
          tokenConfigured: false,
          browserAuthorized: undefined,
          targetsStale: false,
          targetsRefreshPending: false,
          lastError: "Токен браузера не настроен.",
        },
      }),
    });
    await flush();

    port.emit({
      type: "assistant.snapshot",
      state: createReadySnapshot({
        epoch: 2,
        targets: [createTarget({ targetId: "target-1", alias: "Alpha" })],
        selectedTargetId: "target-1",
      }),
    });
    await flush();

    expect(document.querySelector<HTMLButtonElement>('[data-target-id="target-1"]')?.textContent).toContain("Alpha");
  });

  it("does not update target list from an unsolicited snapshot after initial render", async () => {
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

    const firstButton = document.querySelector<HTMLButtonElement>('[data-target-id="target-1"]');
    const secondButton = document.querySelector<HTMLButtonElement>('[data-target-id="target-2"]');

    port.emit({
      type: "assistant.snapshot",
      state: createReadySnapshot({
        epoch: 2,
        targets: [createTarget({ targetId: "target-3", alias: "Gamma" })],
        selectedTargetId: "target-3",
      }),
    });
    await flush();

    expect(document.querySelector<HTMLButtonElement>('[data-target-id="target-1"]')).toBe(firstButton);
    expect(document.querySelector<HTMLButtonElement>('[data-target-id="target-2"]')).toBe(secondButton);
    expect(document.querySelector<HTMLButtonElement>('[data-target-id="target-3"]')).toBeNull();
    expect(firstButton?.textContent).toContain("Alpha");
    expect(firstButton?.className).toContain("target-option--selected");
  });

  it("keeps optimistic selection through an older snapshot that still contains the pending target", async () => {
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
    port.emit({
      type: "assistant.snapshot",
      state: createReadySnapshot({
        epoch: 2,
        targets: [createTarget({ targetId: "target-1", alias: "Alpha" }), createTarget({ targetId: "target-2", alias: "Beta" })],
        selectedTargetId: "target-1",
      }),
    });
    await flush();

    expect(document.querySelector<HTMLButtonElement>('[data-target-id="target-1"]')?.className).not.toContain("target-option--selected");
    expect(document.querySelector<HTMLButtonElement>('[data-target-id="target-2"]')?.className).toContain("target-option--selected");
  });

  it("lets a second quick target click replace the optimistic selection", async () => {
    loadSidePanelHtml();
    const { port } = mockChromeRuntime();
    await importInitializedSidePanel();

    port.emit({
      type: "assistant.snapshot",
      state: createReadySnapshot({
        targets: [createTarget({ targetId: "target-1", alias: "Alpha" }), createTarget({ targetId: "target-2", alias: "Beta" })],
        selectedTargetId: undefined,
      }),
    });
    await flush();

    document.querySelector<HTMLButtonElement>('[data-target-id="target-1"]')?.click();
    document.querySelector<HTMLButtonElement>('[data-target-id="target-2"]')?.click();

    expect(port.postMessage).toHaveBeenCalledWith({ type: "assistant.selectTarget", targetId: "target-1" });
    expect(port.postMessage).toHaveBeenCalledWith({ type: "assistant.selectTarget", targetId: "target-2" });
    expect(document.querySelector<HTMLButtonElement>('[data-target-id="target-1"]')?.className).not.toContain("target-option--selected");
    expect(document.querySelector<HTMLButtonElement>('[data-target-id="target-2"]')?.className).toContain("target-option--selected");
  });

  it("updates target list after manual refresh", async () => {
    loadSidePanelHtml();
    const { port } = mockChromeRuntime();
    await importInitializedSidePanel();

    port.emit({
      type: "assistant.snapshot",
      state: createReadySnapshot({
        targets: [createTarget({ targetId: "target-1", alias: "Alpha" })],
        selectedTargetId: "target-1",
      }),
    });
    await flush();

    document.querySelector<HTMLButtonElement>("#refresh-sessions-button")?.click();
    port.emit({
      type: "assistant.snapshot",
      state: createReadySnapshot({
        epoch: 2,
        targets: [createTarget({ targetId: "target-2", alias: "Beta" })],
        selectedTargetId: "target-2",
      }),
    });
    await flush();

    expect(port.postMessage).toHaveBeenCalledWith({ type: "assistant.sessions.refresh" });
    expect(document.querySelector<HTMLButtonElement>('[data-target-id="target-1"]')).toBeNull();
    expect(document.querySelector<HTMLButtonElement>('[data-target-id="target-2"]')?.textContent).toContain("Beta");
    expect(document.querySelector<HTMLButtonElement>('[data-target-id="target-2"]')?.className).toContain("target-option--selected");
  });

  it("keeps manual refresh open from an empty list until refreshed targets arrive", async () => {
    loadSidePanelHtml();
    const { port } = mockChromeRuntime();
    await importInitializedSidePanel();

    port.emit({
      type: "assistant.snapshot",
      state: createReadySnapshot({
        targets: [],
        selectedTargetId: undefined,
      }),
    });
    await flush();

    document.querySelector<HTMLButtonElement>("#refresh-sessions-button")?.click();
    port.emit({
      type: "assistant.snapshot",
      state: createReadySnapshot({
        epoch: 2,
        targets: [],
        selectedTargetId: undefined,
        connection: {
          brokerOnline: false,
          bridgeOnline: false,
          connecting: true,
          tokenConfigured: true,
          browserAuthorized: undefined,
          targetsStale: false,
          targetsRefreshPending: true,
          lastError: undefined,
        },
      }),
    });
    await flush();

    port.emit({
      type: "assistant.snapshot",
      state: createReadySnapshot({
        epoch: 3,
        targets: [createTarget({ targetId: "target-2", alias: "Beta" })],
        selectedTargetId: "target-2",
        connection: {
          brokerOnline: true,
          bridgeOnline: true,
          connecting: false,
          tokenConfigured: true,
          browserAuthorized: true,
          targetsStale: false,
          targetsRefreshPending: false,
          lastError: undefined,
        },
      }),
    });
    await flush();

    expect(document.querySelector<HTMLButtonElement>('[data-target-id="target-2"]')?.textContent).toContain("Beta");
  });

  it("keeps manual refresh open when broker comes online before refreshed targets arrive", async () => {
    loadSidePanelHtml();
    const { port } = mockChromeRuntime();
    await importInitializedSidePanel();

    const alpha = createTarget({ targetId: "target-1", alias: "Alpha" });
    port.emit({
      type: "assistant.snapshot",
      state: createReadySnapshot({
        targets: [alpha],
        selectedTargetId: "target-1",
      }),
    });
    await flush();

    document.querySelector<HTMLButtonElement>("#refresh-sessions-button")?.click();
    port.emit({
      type: "assistant.snapshot",
      state: createReadySnapshot({
        epoch: 2,
        targets: [alpha],
        selectedTargetId: "target-1",
        connection: {
          brokerOnline: true,
          bridgeOnline: true,
          connecting: false,
          tokenConfigured: true,
          browserAuthorized: true,
          targetsStale: true,
          targetsRefreshPending: true,
          lastError: undefined,
        },
      }),
    });
    await flush();

    port.emit({
      type: "assistant.snapshot",
      state: createReadySnapshot({
        epoch: 3,
        targets: [createTarget({ targetId: "target-2", alias: "Beta" })],
        selectedTargetId: "target-2",
        connection: {
          brokerOnline: true,
          bridgeOnline: true,
          connecting: false,
          tokenConfigured: true,
          browserAuthorized: true,
          targetsStale: false,
          targetsRefreshPending: false,
          lastError: undefined,
        },
      }),
    });
    await flush();

    expect(document.querySelector<HTMLButtonElement>('[data-target-id="target-1"]')).toBeNull();
    expect(document.querySelector<HTMLButtonElement>('[data-target-id="target-2"]')?.textContent).toContain("Beta");
  });

  it("renders session refresh button and posts refresh command", async () => {
    loadSidePanelHtml();
    const { port } = mockChromeRuntime();
    await importInitializedSidePanel();

    const refreshButton = document.querySelector<HTMLButtonElement>("#refresh-sessions-button");
    expect(refreshButton?.textContent).toBe("Обновить");

    refreshButton?.click();

    expect(port.postMessage).toHaveBeenCalledWith({ type: "assistant.sessions.refresh" });
  });

  it("does not enter refreshing mode when manual refresh is clicked without a configured token", async () => {
    loadSidePanelHtml();
    const { port } = mockChromeRuntime();
    await importInitializedSidePanel();

    port.emit({
      type: "assistant.snapshot",
      state: createReadySnapshot({
        targets: [],
        selectedTargetId: undefined,
        connection: {
          brokerOnline: false,
          bridgeOnline: false,
          connecting: false,
          tokenConfigured: false,
          browserAuthorized: undefined,
          targetsStale: false,
          targetsRefreshPending: false,
          lastError: "Токен браузера не настроен.",
        },
      }),
    });
    await flush();

    document.querySelector<HTMLButtonElement>("#refresh-sessions-button")?.click();

    expect(port.postMessage).toHaveBeenCalledWith({ type: "assistant.sessions.refresh" });
    expect(document.querySelector("#session-stale-guidance")?.textContent).not.toContain("Обновляем список сессий");
    expect(document.querySelector("#target-container")?.textContent).toContain("Для отправки настройте browserToken");
  });

  it("does not auto-refresh sessions on a timer", async () => {
    vi.useFakeTimers();
    loadSidePanelHtml();
    const { port } = mockChromeRuntime();
    await importInitializedSidePanel();

    port.emit({
      type: "assistant.snapshot",
      state: createReadySnapshot({
        targets: [createTarget({ targetId: "target-1", alias: "Alpha" })],
        connection: {
          brokerOnline: false,
          bridgeOnline: false,
          connecting: false,
          tokenConfigured: true,
          browserAuthorized: undefined,
          targetsStale: true,
          targetsRefreshPending: false,
          lastError: "Pi недоступен",
        },
      }),
    });
    await flush();

    vi.advanceTimersByTime(5_000);

    expect(port.postMessage).not.toHaveBeenCalledWith({ type: "assistant.sessions.refresh" });
  });

  it("shows stale guidance with known targets while broker is offline", async () => {
    loadSidePanelHtml();
    const { port } = mockChromeRuntime();
    await importInitializedSidePanel();

    port.emit({
      type: "assistant.snapshot",
      state: createReadySnapshot({
        targets: [createTarget({ targetId: "target-1", alias: "Alpha" })],
        connection: {
          brokerOnline: false,
          bridgeOnline: false,
          connecting: false,
          tokenConfigured: true,
          browserAuthorized: undefined,
          lastError: "Pi недоступен",
          targetsStale: true,
          targetsRefreshPending: false,
        },
      }),
    });
    await flush();

    expect(document.querySelector<HTMLButtonElement>('[data-target-id="target-1"]')?.textContent).toContain("Alpha");
    expect(document.querySelector("#session-stale-guidance")?.textContent).toContain("Список может быть устаревшим");
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
          targetsStale: true,
          targetsRefreshPending: false,
          lastError: "Pi недоступен",
        },
      }),
    });
    await flush();

    expect(document.querySelector<HTMLButtonElement>('[data-target-id="target-1"]')?.textContent).toContain("Alpha");
    expect(document.querySelector<HTMLButtonElement>('[data-target-id="target-2"]')?.textContent).toContain("Beta");
    expect(document.querySelector("#target-container")?.textContent).not.toContain("Pi не подключён");
  });

  it("does not start DOM picker when frozen UI selection diverges from live background selection", async () => {
    loadSidePanelHtml();
    const { port, tabsQuery } = mockChromeRuntime();
    await importInitializedSidePanel();

    port.emit({
      type: "assistant.snapshot",
      state: createReadySnapshot({
        targets: [createTarget({ targetId: "target-1", alias: "Alpha" })],
        selectedTargetId: "target-1",
      }),
    });
    await flush();

    port.emit({
      type: "assistant.snapshot",
      state: createReadySnapshot({
        epoch: 2,
        targets: [createTarget({ targetId: "target-2", alias: "Beta" })],
        selectedTargetId: "target-2",
      }),
    });
    await flush();

    document.querySelector<HTMLButtonElement>("#send-button")?.click();
    await flush();

    expect(tabsQuery).not.toHaveBeenCalled();
    expect(port.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: "assistant.startDomPicker" }));
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
