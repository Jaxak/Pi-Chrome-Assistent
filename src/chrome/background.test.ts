import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { StorageAdapter, DiagnosticEntry } from "./diagnostics";
import { createBackgroundMessageListener, brokerRequest } from "./background";
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
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("lists broker targets from the background message handler after broker auth", async () => {
    const storage = new FakeStorageAdapter({
      brokerToken: "shared-token",
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
        token: "shared-token",
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
      error: "No broker token configured in chrome.storage.local",
      targets: [],
      selectedTargetId: "target-1",
      tokenConfigured: false,
    });
    expect(webSocketFactory).not.toHaveBeenCalled();
    await expect(readDiagnostics(storage)).resolves.toEqual([
      expect.objectContaining({
        phase: "listTargets",
        message: "No broker token configured in chrome.storage.local",
      }),
    ]);
  });

  it("uses the authenticated broker path for sendSelection", async () => {
    const storage = new FakeStorageAdapter({
      brokerToken: "shared-token",
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
        token: "shared-token",
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
        token: "shared-token",
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
      brokerToken: "shared-token",
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

  it("propagates failed picker startup responses from the content script", async () => {
    const executeScript = vi.fn(async () => undefined);
    const sendMessage = vi.fn(async () => ({ ok: false, error: "Picker unavailable" }));

    vi.stubGlobal(
      "chrome",
      {
        scripting: { executeScript },
        tabs: { sendMessage },
        runtime: {
          onInstalled: { addListener: vi.fn() },
          onMessage: { addListener: vi.fn() },
        },
      } as unknown as typeof chrome,
    );

    const listener = createBackgroundMessageListener({
      getActiveTab: async () => ({ id: 321 } as chrome.tabs.Tab),
    });

    await expect(invokeMessageListener(listener, { type: "startDomPicker", targetId: "target-9" })).resolves.toEqual({
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
