import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { StorageAdapter, DiagnosticEntry } from "./diagnostics";
import { configureSidePanelOnActionClick, createBackgroundMessageListener, brokerRequest } from "./background";
import { BROWSER_TOKEN_STORAGE_KEY } from "./browserToken";
import { PROTOCOL_VERSION } from "../shared/constants";
import type { TargetMetadata } from "../shared/protocol";

class FakeStorageAdapter implements StorageAdapter {
  private readonly values = new Map<string, unknown>();

  constructor(initialValues: Record<string, unknown> = {}) {
    for (const [key, value] of Object.entries(initialValues)) {
      this.values.set(key, value);
    }
  }

  async get<T>(key: string): Promise<T | undefined> {
    return this.values.get(key) as T | undefined;
  }

  async set<T>(key: string, value: T): Promise<void> {
    this.values.set(key, value);
  }

  async remove(key: string): Promise<void> {
    this.values.delete(key);
  }
}

type BrokerEventName = "open" | "message" | "error" | "close";
type BrokerEventListener = (event?: { data?: string }) => void;

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readonly sent: string[] = [];
  readonly eventListeners = new Map<BrokerEventName, Set<BrokerEventListener>>();
  readyState = FakeWebSocket.CONNECTING;
  closeCalls = 0;

  addEventListener(eventName: BrokerEventName, listener: BrokerEventListener): void {
    const listeners = this.eventListeners.get(eventName) ?? new Set<BrokerEventListener>();
    listeners.add(listener);
    this.eventListeners.set(eventName, listeners);
  }

  removeEventListener(eventName: BrokerEventName, listener: BrokerEventListener): void {
    this.eventListeners.get(eventName)?.delete(listener);
  }

  send(payload: string): void {
    this.sent.push(payload);
  }

  close(): void {
    this.closeCalls += 1;
    this.readyState = FakeWebSocket.CLOSED;
  }

  emitOpen(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.emit("open");
  }

  emitMessage(data: string): void {
    this.emit("message", { data });
  }

  emitClose(): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.emit("close");
  }

  private emit(eventName: BrokerEventName, event?: { data?: string }): void {
    for (const listener of this.eventListeners.get(eventName) ?? []) {
      listener(event);
    }
  }
}

function createTarget(overrides: Partial<TargetMetadata> = {}): TargetMetadata {
  return {
    targetId: "target-1",
    alias: "Alpha",
    cwd: "/tmp/pi",
    gitBranch: "main",
    pid: 1234,
    sessionName: "session-a",
    connectedAt: 1_710_000_000_000,
    lastSeenAt: 1_710_000_000_100,
    ...overrides,
  };
}

function readSentEnvelope<TPayload = unknown>(socket: FakeWebSocket, index: number): {
  version: number;
  type?: string;
  requestId?: string;
  payload?: TPayload;
} {
  return JSON.parse(socket.sent[index] ?? "{}");
}

function invokeMessageListener(
  listener: ReturnType<typeof createBackgroundMessageListener>,
  message: unknown,
): Promise<unknown> {
  return new Promise((resolve) => {
    listener(message, {} as chrome.runtime.MessageSender, (response?: unknown) => {
      resolve(response);
    });
  });
}

async function flushAsyncWork(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

async function waitFor(condition: () => boolean, attempts = 20): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (condition()) {
      return;
    }

    await flushAsyncWork();
  }

  throw new Error("Condition was not met in time");
}

async function readDiagnostics(storage: StorageAdapter): Promise<DiagnosticEntry[]> {
  return ((await storage.get<DiagnosticEntry[]>("diagnostics")) ?? []).slice();
}

describe("background", () => {
  it("starts the assistant state server when a sidepanel port connects", async () => {
    vi.resetModules();
    const onConnectAddListener = vi.fn();
    const webSocketFactory = vi.fn(() => new FakeWebSocket());

    vi.stubGlobal("WebSocket", webSocketFactory);
    vi.stubGlobal(
      "chrome",
      {
        storage: {
          local: {
            get: vi.fn(async () => ({})),
            set: vi.fn(async () => undefined),
            remove: vi.fn(async () => undefined),
          },
        },
        action: { onClicked: { addListener: vi.fn() } },
        sidePanel: {
          setPanelBehavior: vi.fn(async () => undefined),
          open: vi.fn(async () => undefined),
        },
        runtime: {
          onInstalled: { addListener: vi.fn() },
          onConnect: { addListener: onConnectAddListener },
          onMessage: { addListener: vi.fn() },
        },
      } as unknown as typeof chrome,
    );

    await import("./background");

    expect(onConnectAddListener).toHaveBeenCalledOnce();
    expect(webSocketFactory).not.toHaveBeenCalled();

    const onConnect = onConnectAddListener.mock.calls[0]?.[0] as (port: chrome.runtime.Port) => void;
    onConnect({
      name: "sidepanel",
      postMessage: vi.fn(),
      onMessage: { addListener: vi.fn(), removeListener: vi.fn() },
      onDisconnect: { addListener: vi.fn(), removeListener: vi.fn() },
    } as unknown as chrome.runtime.Port);

    expect(webSocketFactory).toHaveBeenCalledWith("ws://127.0.0.1:17345");
  });

  it("configures Chrome action clicks to open the side panel", async () => {
    const addListener = vi.fn();
    const setPanelBehavior = vi.fn(async () => undefined);
    const open = vi.fn(async () => undefined);
    configureSidePanelOnActionClick({
      action: { onClicked: { addListener } },
      sidePanel: { setPanelBehavior, open },
    });

    expect(setPanelBehavior).toHaveBeenCalledWith({ openPanelOnActionClick: true });
    expect(addListener).toHaveBeenCalledOnce();

    const onClicked = addListener.mock.calls[0]?.[0] as (tab: chrome.tabs.Tab) => Promise<void>;
    await onClicked({ windowId: 42 } as chrome.tabs.Tab);

    expect(open).toHaveBeenCalledWith({ windowId: 42 });
  });

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("returns browser auth state and creates a token when missing", async () => {
    const storage = new FakeStorageAdapter();
    const listener = createBackgroundMessageListener({ storage });

    vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValue("11111111-1111-4111-8111-111111111111");

    await expect(invokeMessageListener(listener, { type: "getBrowserAuthState" })).resolves.toEqual({
      ok: true,
      browserToken: "11111111-1111-4111-8111-111111111111",
      tokenConfigured: true,
    });
    await expect(storage.get(BROWSER_TOKEN_STORAGE_KEY)).resolves.toBe(
      "11111111-1111-4111-8111-111111111111",
    );
  });

  it("regenerates the browser token via the background message handler", async () => {
    const storage = new FakeStorageAdapter({
      [BROWSER_TOKEN_STORAGE_KEY]: "11111111-1111-4111-8111-111111111111",
    });
    const listener = createBackgroundMessageListener({ storage });

    vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValue("22222222-2222-4222-8222-222222222222");

    await expect(invokeMessageListener(listener, { type: "regenerateBrowserToken" })).resolves.toEqual({
      ok: true,
      browserToken: "22222222-2222-4222-8222-222222222222",
      tokenConfigured: true,
    });
    await expect(storage.get(BROWSER_TOKEN_STORAGE_KEY)).resolves.toBe(
      "22222222-2222-4222-8222-222222222222",
    );
  });

  it("clears the browser token via the background message handler", async () => {
    const storage = new FakeStorageAdapter({
      [BROWSER_TOKEN_STORAGE_KEY]: "11111111-1111-4111-8111-111111111111",
    });
    const listener = createBackgroundMessageListener({ storage });

    await expect(invokeMessageListener(listener, { type: "clearBrowserToken" })).resolves.toEqual({
      ok: true,
      tokenConfigured: false,
    });
    await expect(storage.get(BROWSER_TOKEN_STORAGE_KEY)).resolves.toBeUndefined();
  });

  it("lists broker targets from the background message handler after broker auth", async () => {
    const storage = new FakeStorageAdapter({
      [BROWSER_TOKEN_STORAGE_KEY]: "browser-token-1",
      selectedTargetId: "target-1",
    });
    const socket = new FakeWebSocket();
    const listener = createBackgroundMessageListener({
      storage,
      webSocketFactory: () => socket,
      openTimeoutMs: 100,
      responseTimeoutMs: 100,
    });

    const responsePromise = invokeMessageListener(listener, { type: "listTargets" });

    await waitFor(() => (socket.eventListeners.get("open")?.size ?? 0) > 0);
    socket.emitOpen();
    await waitFor(() => socket.sent.length === 2);

    expect(readSentEnvelope<{ token?: string }>(socket, 0)).toEqual({
      version: PROTOCOL_VERSION,
      type: "client.hello",
      requestId: expect.any(String),
      payload: {
        token: "browser-token-1",
      },
    });

    const requestEnvelope = readSentEnvelope(socket, 1);
    expect(requestEnvelope).toEqual({
      version: PROTOCOL_VERSION,
      type: "client.listTargets",
      requestId: expect.any(String),
    });

    socket.emitMessage(
      JSON.stringify({
        version: PROTOCOL_VERSION,
        type: "client.targets",
        requestId: requestEnvelope.requestId,
        payload: { targets: [createTarget()] },
      }),
    );
    await flushAsyncWork();

    await expect(responsePromise).resolves.toEqual({
      ok: true,
      targets: [createTarget()],
      selectedTargetId: "target-1",
      tokenConfigured: true,
    });
  });

  it("fails listTargets early when broker token is missing", async () => {
    const storage = new FakeStorageAdapter({
      selectedTargetId: "target-1",
    });
    const webSocketFactory = vi.fn(() => new FakeWebSocket());
    const listener = createBackgroundMessageListener({
      storage,
      webSocketFactory,
      openTimeoutMs: 100,
      responseTimeoutMs: 100,
    });

    await expect(invokeMessageListener(listener, { type: "listTargets" })).resolves.toEqual({
      ok: false,
      error: "No browser token configured in chrome.storage.local",
      targets: [],
      selectedTargetId: "target-1",
      tokenConfigured: false,
    });
    expect(webSocketFactory).not.toHaveBeenCalled();
    await expect(readDiagnostics(storage)).resolves.toEqual([
      expect.objectContaining({
        phase: "listTargets",
        message: "No browser token configured in chrome.storage.local",
      }),
    ]);
  });

  it("surfaces client.hello auth failures from the broker", async () => {
    const storage = new FakeStorageAdapter({
      [BROWSER_TOKEN_STORAGE_KEY]: "browser-token-1",
      selectedTargetId: "target-1",
    });
    const socket = new FakeWebSocket();
    const listener = createBackgroundMessageListener({
      storage,
      webSocketFactory: () => socket,
      openTimeoutMs: 100,
      responseTimeoutMs: 100,
    });

    const responsePromise = invokeMessageListener(listener, { type: "listTargets" });

    await waitFor(() => (socket.eventListeners.get("open")?.size ?? 0) > 0);
    socket.emitOpen();
    await waitFor(() => socket.sent.length === 2);

    const helloEnvelope = readSentEnvelope<{ token?: string }>(socket, 0);
    expect(helloEnvelope).toMatchObject({
      version: PROTOCOL_VERSION,
      type: "client.hello",
      payload: {
        token: "browser-token-1",
      },
    });

    socket.emitMessage(
      JSON.stringify({
        version: PROTOCOL_VERSION,
        type: "client.error",
        requestId: helloEnvelope.requestId,
        payload: { error: "Браузер не авторизован в Pi" },
      }),
    );
    await flushAsyncWork();

    await expect(responsePromise).resolves.toEqual({
      ok: false,
      error: "Браузер не авторизован в Pi",
      targets: [],
      selectedTargetId: "target-1",
      tokenConfigured: true,
    });
    await expect(readDiagnostics(storage)).resolves.toEqual([
      expect.objectContaining({
        phase: "listTargets",
        message: "Браузер не авторизован в Pi",
      }),
    ]);
  });

  it("uses the authenticated broker path for sendSelection", async () => {
    const storage = new FakeStorageAdapter({
      [BROWSER_TOKEN_STORAGE_KEY]: "browser-token-1",
      selectedTargetId: "target-1",
    });
    const socket = new FakeWebSocket();
    const listener = createBackgroundMessageListener({
      storage,
      webSocketFactory: () => socket,
      openTimeoutMs: 100,
      responseTimeoutMs: 100,
    });

    const responsePromise = invokeMessageListener(listener, {
      type: "sendSelection",
      selection: {
        url: "https://example.com",
        title: "Example",
        selectedText: "hello",
        selectedHtml: "<p>hello</p>",
        capturedAt: 1_710_000_000_000,
      },
    });

    await waitFor(() => (socket.eventListeners.get("open")?.size ?? 0) > 0);
    socket.emitOpen();
    await waitFor(() => socket.sent.length === 2);

    expect(readSentEnvelope<{ token?: string }>(socket, 0)).toEqual({
      version: PROTOCOL_VERSION,
      type: "client.hello",
      requestId: expect.any(String),
      payload: {
        token: "browser-token-1",
      },
    });

    const requestEnvelope = readSentEnvelope<{
      token?: string;
      targetId?: string;
      selection?: Record<string, unknown>;
    }>(socket, 1);
    expect(requestEnvelope).toEqual({
      version: PROTOCOL_VERSION,
      type: "client.sendSelection",
      requestId: expect.any(String),
      payload: {
        token: "browser-token-1",
        targetId: "target-1",
        selection: {
          url: "https://example.com",
          title: "Example",
          selectedText: "hello",
          selectedHtml: "<p>hello</p>",
          capturedAt: 1_710_000_000_000,
        },
      },
    });

    socket.emitMessage(
      JSON.stringify({
        version: PROTOCOL_VERSION,
        type: "client.sendResult",
        requestId: requestEnvelope.requestId,
        payload: { ok: true },
      }),
    );
    await flushAsyncWork();

    await expect(responsePromise).resolves.toEqual({ ok: true });
  });

  it("records diagnostics when sendSelection times out", async () => {
    const storage = new FakeStorageAdapter({
      [BROWSER_TOKEN_STORAGE_KEY]: "browser-token-1",
      selectedTargetId: "target-1",
    });
    const socket = new FakeWebSocket();
    const listener = createBackgroundMessageListener({
      storage,
      webSocketFactory: () => socket,
      openTimeoutMs: 100,
      responseTimeoutMs: 100,
    });

    const responsePromise = invokeMessageListener(listener, {
      type: "sendSelection",
      selection: {
        url: "https://example.com",
        title: "Example",
        selectedText: "hello",
        selectedHtml: "<p>hello</p>",
        capturedAt: 1_710_000_000_000,
      },
    });

    await waitFor(() => (socket.eventListeners.get("open")?.size ?? 0) > 0);
    socket.emitOpen();
    await waitFor(() => socket.sent.length === 2);
    await vi.advanceTimersByTimeAsync(100);

    await expect(responsePromise).resolves.toEqual({
      ok: false,
      error: "Broker response timed out during client.sendSelection",
    });
    await expect(readDiagnostics(storage)).resolves.toEqual([
      expect.objectContaining({
        phase: "sendSelection",
        message: "Broker response timed out during client.sendSelection",
      }),
    ]);
  });

  it("records picker diagnostics from the content script", async () => {
    const storage = new FakeStorageAdapter();
    const listener = createBackgroundMessageListener({
      storage,
      now: () => 1_710_000_000_123,
    });

    await expect(
      invokeMessageListener(listener, {
        type: "pickerDiagnostic",
        phase: "sendSelection",
        message: "Unable to send selection to Pi.",
        url: "https://example.com/article",
      }),
    ).resolves.toEqual({ ok: true });

    await expect(readDiagnostics(storage)).resolves.toEqual([
      {
        timestamp: 1_710_000_000_123,
        phase: "picker:sendSelection",
        message: "Unable to send selection to Pi. (https://example.com/article)",
      },
    ]);
  });

  it("starts DOM picker on the explicit tabId from the message", async () => {
    const executeScript = vi.fn(async () => undefined);
    const sendMessage = vi.fn(async () => ({ ok: true }));
    const get = vi.fn(async () => ({ id: 555, url: "https://example.com/page" } as chrome.tabs.Tab));
    const getActiveTab = vi.fn(async () => ({ id: 321, url: "https://wrong.example" } as chrome.tabs.Tab));

    vi.stubGlobal(
      "chrome",
      {
        scripting: { executeScript },
        tabs: { get, sendMessage },
        runtime: {
          onInstalled: { addListener: vi.fn() },
          onMessage: { addListener: vi.fn() },
        },
      } as unknown as typeof chrome,
    );

    const listener = createBackgroundMessageListener({ getActiveTab });

    await expect(invokeMessageListener(listener, { type: "startDomPicker", targetId: "target-9", tabId: 555 })).resolves.toEqual({
      ok: true,
    });

    expect(getActiveTab).not.toHaveBeenCalled();
    expect(get).toHaveBeenCalledWith(555);
    expect(executeScript).toHaveBeenCalledWith({
      target: { tabId: 555 },
      files: ["contentScript.js"],
    });
    expect(sendMessage).toHaveBeenCalledWith(555, { type: "startDomPicker", targetId: "target-9" });
  });

  it("returns a Russian error when startDomPicker has no explicit tabId", async () => {
    const listener = createBackgroundMessageListener();

    await expect(invokeMessageListener(listener, { type: "startDomPicker", targetId: "target-9" })).resolves.toEqual({
      ok: false,
      error: "Не удалось определить вкладку для DOM picker.",
    });
  });

  it("returns a Russian error before script injection on restricted tab URLs", async () => {
    const executeScript = vi.fn(async () => undefined);
    const get = vi.fn(async () => ({ id: 555, url: "chrome://extensions" } as chrome.tabs.Tab));

    vi.stubGlobal(
      "chrome",
      {
        scripting: { executeScript },
        tabs: { get, sendMessage: vi.fn() },
        runtime: {
          onInstalled: { addListener: vi.fn() },
          onMessage: { addListener: vi.fn() },
        },
      } as unknown as typeof chrome,
    );

    const listener = createBackgroundMessageListener();

    await expect(invokeMessageListener(listener, { type: "startDomPicker", targetId: "target-9", tabId: 555 })).resolves.toEqual({
      ok: false,
      error: "DOM picker можно запускать только на обычных http/https страницах.",
    });

    expect(executeScript).not.toHaveBeenCalled();
  });

  it("records diagnostics when script injection for DOM picker fails", async () => {
    const storage = new FakeStorageAdapter();
    const executeScript = vi.fn(async () => {
      throw new Error("Cannot access contents of url");
    });
    const get = vi.fn(async () => ({ id: 555, url: "https://example.com/page" } as chrome.tabs.Tab));

    vi.stubGlobal(
      "chrome",
      {
        scripting: { executeScript },
        tabs: { get, sendMessage: vi.fn() },
        runtime: {
          onInstalled: { addListener: vi.fn() },
          onMessage: { addListener: vi.fn() },
        },
      } as unknown as typeof chrome,
    );

    const listener = createBackgroundMessageListener({ storage, now: () => 1_710_000_000_123 });

    await expect(invokeMessageListener(listener, { type: "startDomPicker", targetId: "target-9", tabId: 555 })).resolves.toEqual({
      ok: false,
      error: "Не удалось запустить DOM picker: Cannot access contents of url",
    });
    await expect(readDiagnostics(storage)).resolves.toEqual([
      expect.objectContaining({
        timestamp: 1_710_000_000_123,
        phase: "startDomPicker",
        message: "Cannot access contents of url",
      }),
    ]);
  });

  it("propagates failed picker startup responses from the content script", async () => {
    const executeScript = vi.fn(async () => undefined);
    const sendMessage = vi.fn(async () => ({ ok: false, error: "Picker unavailable" }));
    const get = vi.fn(async () => ({ id: 321, url: "https://example.com/page" } as chrome.tabs.Tab));

    vi.stubGlobal(
      "chrome",
      {
        scripting: { executeScript },
        tabs: { get, sendMessage },
        runtime: {
          onInstalled: { addListener: vi.fn() },
          onMessage: { addListener: vi.fn() },
        },
      } as unknown as typeof chrome,
    );

    const listener = createBackgroundMessageListener();

    await expect(invokeMessageListener(listener, { type: "startDomPicker", targetId: "target-9", tabId: 321 })).resolves.toEqual({
      ok: false,
      error: "Picker unavailable",
    });

    expect(executeScript).toHaveBeenCalledWith({
      target: { tabId: 321 },
      files: ["contentScript.js"],
    });
    expect(sendMessage).toHaveBeenCalledWith(321, { type: "startDomPicker", targetId: "target-9" });
  });

  it("times out broker connection opens and closes the socket", async () => {
    const socket = new FakeWebSocket();
    const requestPromise = brokerRequest(
      {
        type: "client.listTargets",
        accept: () => null,
      },
      {
        webSocketFactory: () => socket,
        openTimeoutMs: 100,
        responseTimeoutMs: 100,
      },
    );
    const rejectionExpectation = expect(requestPromise).rejects.toThrow(
      "Broker connection timed out: ws://127.0.0.1:17345",
    );

    await vi.advanceTimersByTimeAsync(100);

    await rejectionExpectation;
    expect(socket.closeCalls).toBeGreaterThan(0);
    expect(socket.readyState).toBe(FakeWebSocket.CLOSED);
  });

  it("times out broker responses and closes the socket", async () => {
    const socket = new FakeWebSocket();
    const requestPromise = brokerRequest(
      {
        type: "client.listTargets",
        accept: (envelope) => {
          if (envelope.type !== "client.targets") {
            return null;
          }

          return {
            type: envelope.type,
            payload: envelope.payload as { targets: unknown[] },
          };
        },
      },
      {
        webSocketFactory: () => socket,
        openTimeoutMs: 100,
        responseTimeoutMs: 100,
      },
    );
    const rejectionExpectation = expect(requestPromise).rejects.toThrow(
      "Broker response timed out during client.listTargets",
    );

    socket.emitOpen();
    await flushAsyncWork();
    await vi.advanceTimersByTimeAsync(100);

    await rejectionExpectation;
    expect(socket.closeCalls).toBeGreaterThan(0);
    expect(socket.readyState).toBe(FakeWebSocket.CLOSED);
  });
});
