import { describe, expect, it, vi } from "vitest";

import type { ChatEvent, DirectSessionSnapshot, SelectionPayload } from "../shared/protocol";
import type { SessionConnectionState } from "./sessionClient";
import {
  BackgroundAssistantStateServer,
  type BackgroundStateServerStorage,
  type ChromeRuntimePortLike,
} from "./backgroundStateServer";
import { isChatSendDisabled } from "./assistantState";

class FakePort implements ChromeRuntimePortLike {
  readonly name = "sidepanel";
  readonly postedMessages: unknown[] = [];
  throwOnPost = false;
  private readonly messageListeners = new Set<(message: unknown) => void>();
  private readonly disconnectListeners = new Set<() => void>();

  readonly onMessage = {
    addListener: (listener: (message: unknown) => void): void => {
      this.messageListeners.add(listener);
    },
    removeListener: (listener: (message: unknown) => void): void => {
      this.messageListeners.delete(listener);
    },
  };

  readonly onDisconnect = {
    addListener: (listener: () => void): void => {
      this.disconnectListeners.add(listener);
    },
    removeListener: (listener: () => void): void => {
      this.disconnectListeners.delete(listener);
    },
  };

  postMessage(message: unknown): void {
    if (this.throwOnPost) {
      throw new Error("port closed");
    }

    this.postedMessages.push(message);
  }

  emitMessage(message: unknown): void {
    for (const listener of this.messageListeners) {
      listener(message);
    }
  }

  disconnect(): void {
    for (const listener of this.disconnectListeners) {
      listener();
    }
  }
}

class FakeStorage implements BackgroundStateServerStorage {
  readonly values = new Map<string, unknown>();
  readonly removedKeys: string[] = [];
  getError: unknown;
  setError: unknown;

  async get<T>(key: string): Promise<T | undefined> {
    if (this.getError) {
      throw this.getError;
    }

    return this.values.get(key) as T | undefined;
  }

  async set<T>(key: string, value: T): Promise<void> {
    if (this.setError) {
      throw this.setError;
    }

    this.values.set(key, value);
  }

  async remove(key: string): Promise<void> {
    this.removedKeys.push(key);
    this.values.delete(key);
  }
}

type FakeSessionClientOptions = {
  port?: number;
  onSnapshot?: (snapshot: DirectSessionSnapshot) => void;
  onConnectionState?: (state: SessionConnectionState) => void;
};

class FakeSessionClient {
  port: number;
  readonly connect = vi.fn();
  readonly close = vi.fn();
  readonly reconnectToPort = vi.fn((port: number) => {
    this.port = port;
  });
  sendChatMessageResult = true;
  readonly sendChatMessage = vi.fn((message: string): boolean => {
    void message;
    return this.sendChatMessageResult;
  });
  sendSelectionResult = true;
  readonly sendSelection = vi.fn((selection: SelectionPayload): boolean => {
    void selection;
    return this.sendSelectionResult;
  });
  readonly setModel = vi.fn((input: { provider: string; modelId: string }): boolean => {
    void input;
    return true;
  });

  constructor(readonly options: FakeSessionClientOptions) {
    this.port = options.port ?? 31415;
  }

  emitSnapshot(snapshot: DirectSessionSnapshot): void {
    this.options.onSnapshot?.(snapshot);
  }

  emitConnectionState(state: SessionConnectionState): void {
    this.options.onConnectionState?.(state);
  }
}

function createSnapshot(overrides: Partial<DirectSessionSnapshot> = {}): DirectSessionSnapshot {
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
      availableModels: [{ provider: "anthropic", id: "claude-sonnet", label: "Claude Sonnet" }],
      contextUsage: { tokens: 1000, maxTokens: 200000, percent: 0.5 },
      isIdle: true,
      updatedAt: 1_710_000_000_500,
    },
    ...overrides,
  };
}

function createServer(overrides: Partial<ConstructorParameters<typeof BackgroundAssistantStateServer>[0]> = {}) {
  const storage = new FakeStorage();
  const diagnostics: Array<{ phase: string; message: string }> = [];
  const sessionClients: FakeSessionClient[] = [];
  const server = new BackgroundAssistantStateServer({
    storage,
    runtimeClock: () => 1_710_000_000_123,
    sessionClientFactory: (options) => {
      const client = new FakeSessionClient(options);
      sessionClients.push(client);
      return client;
    },
    recordDiagnostic: async (diagnostic) => {
      diagnostics.push({ phase: diagnostic.phase, message: diagnostic.message });
    },
    ...overrides,
  });

  return { server, storage, diagnostics, sessionClients };
}

async function flushAsyncWork(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });

  return { promise, resolve, reject };
}

describe("BackgroundAssistantStateServer", () => {
  it("starts without connecting to any session by default", async () => {
    const { server, sessionClients } = createServer();

    await server.start();

    expect(sessionClients).toHaveLength(0);
    expect(server.getSnapshot().connection.online).toBe(false);
    expect(server.getSnapshot().connection.connecting).toBe(false);
    expect(server.getSnapshot().connection.configuredPort).toBe(31415);
  });

  it("connects to user supplied port via assistant.session.connect and stores it", async () => {
    const { server, sessionClients, storage } = createServer();
    const port = new FakePort();

    await server.start();
    server.connectPort(port);

    port.emitMessage({ type: "assistant.session.connect", port: 31416 });
    await flushAsyncWork();

    expect(sessionClients).toHaveLength(1);
    expect(sessionClients[0]?.port).toBe(31416);
    expect(sessionClients[0]?.connect).toHaveBeenCalledTimes(1);
    expect(server.getSnapshot().connection.configuredPort).toBe(31416);
  });

  it("rejects invalid port in assistant.session.connect with Russian error", async () => {
    const { server, sessionClients } = createServer();
    const port = new FakePort();

    await server.start();
    server.connectPort(port);

    port.emitMessage({ type: "assistant.session.connect", port: 0 });

    expect(sessionClients).toHaveLength(0);
    const snapshot = server.getSnapshot();
    expect(snapshot.connection.lastError).toBeDefined();
    expect(snapshot.connection.lastError).toContain("порт");
  });

  it("rejects port > 65535 with Russian error", async () => {
    const { server, sessionClients } = createServer();
    const port = new FakePort();

    await server.start();
    server.connectPort(port);

    port.emitMessage({ type: "assistant.session.connect", port: 70000 });

    expect(sessionClients).toHaveLength(0);
    expect(server.getSnapshot().connection.lastError).toBeDefined();
    expect(server.getSnapshot().connection.lastError).toContain("порт");
  });

  it("applies session.snapshot and sets online", () => {
    const { server, sessionClients } = createServer();

    const client = sessionClients.length === 0 ? undefined : sessionClients[0];
    // Manually create a client since start doesn't
    const { sessionClients: clients2 } = createServer({
      sessionClientFactory: (options) => {
        const client = new FakeSessionClient(options);
        return client;
      },
    });
    // Use applySessionSnapshot directly
    server.applySessionSnapshot(createSnapshot());

    expect(server.getSnapshot().connection.online).toBe(true);
    expect(server.getSnapshot().session).toMatchObject({
      cwd: "/repo",
      pid: 1234,
    });
  });

  it("updates connection state from SessionClient callbacks", async () => {
    const { server, sessionClients, storage } = createServer();
    const port = new FakePort();

    await server.start();
    server.connectPort(port);

    port.emitMessage({ type: "assistant.session.connect", port: 31415 });
    await flushAsyncWork();

    // Simulate connecting state
    sessionClients[0]?.emitConnectionState({
      online: false,
      connecting: true,
      statusText: "Подключаемся к Pi-сессии…",
    });

    expect(server.getSnapshot().connection.connecting).toBe(true);
    expect(server.getSnapshot().connection.online).toBe(false);

    // Simulate online
    sessionClients[0]?.emitConnectionState({
      online: true,
      connecting: false,
      statusText: "Подключено к Pi-сессии",
    });

    expect(server.getSnapshot().connection.connecting).toBe(false);
    expect(server.getSnapshot().connection.online).toBe(true);
  });

  it("sends chat through sessionClient on assistant.sendChatMessage", async () => {
    const { server, sessionClients } = createServer();
    const port = new FakePort();

    await server.start();
    server.connectPort(port);

    // Connect to a port to create a session client
    port.emitMessage({ type: "assistant.session.connect", port: 31415 });
    await flushAsyncWork();
    server.applySessionSnapshot(createSnapshot());

    port.emitMessage({ type: "assistant.sendChatMessage", message: " Привет Pi " });
    await flushAsyncWork();

    expect(sessionClients[0]?.sendChatMessage).toHaveBeenCalledWith("Привет Pi");
    expect(server.getSnapshot().chat.messages.at(-1)).toMatchObject({ role: "user", text: "Привет Pi" });
    expect(server.getSnapshot().chat.agentBusy).toBe(true);
    expect(server.getSnapshot().chat.sending).toBe(true);
  });

  it("sends model set through sessionClient on assistant.model.set", async () => {
    const { server, sessionClients } = createServer();
    const port = new FakePort();

    await server.start();
    server.connectPort(port);

    // Connect to create session client
    port.emitMessage({ type: "assistant.session.connect", port: 31415 });
    await flushAsyncWork();
    server.applySessionSnapshot(createSnapshot());

    port.emitMessage({ type: "assistant.model.set", provider: "anthropic", modelId: "claude-sonnet" });

    expect(sessionClients[0]?.setModel).toHaveBeenCalledWith({
      provider: "anthropic",
      modelId: "claude-sonnet",
    });
    expect(server.getSnapshot().runtime.modelMutationPending).toBe(true);
  });

  it("disconnects and removes old session client when reconnecting to new port", async () => {
    const { server, sessionClients } = createServer();
    const port = new FakePort();

    await server.start();
    server.connectPort(port);

    port.emitMessage({ type: "assistant.session.connect", port: 31415 });
    await flushAsyncWork();
    expect(sessionClients).toHaveLength(1);

    port.emitMessage({ type: "assistant.session.connect", port: 31416 });
    await flushAsyncWork();
    expect(sessionClients).toHaveLength(2);
    expect(sessionClients[0]?.close).toHaveBeenCalledTimes(1);
    expect(sessionClients[1]?.port).toBe(31416);
  });

  it("immediately posts an assistant snapshot when a port connects", () => {
    const { server } = createServer();
    const port = new FakePort();

    server.connectPort(port);

    expect(port.postedMessages).toEqual([
      {
        type: "assistant.snapshot",
        state: server.getSnapshot(),
      },
    ]);
  });

  it("broadcasts snapshot to multiple ports", async () => {
    const { server } = createServer();
    const portA = new FakePort();
    const portB = new FakePort();

    await server.start();
    server.connectPort(portA);
    server.connectPort(portB);

    server.applySessionSnapshot(createSnapshot());

    const expected = { type: "assistant.snapshot", state: server.getSnapshot() };
    expect(portA.postedMessages.at(-1)).toEqual(expected);
    expect(portB.postedMessages.at(-1)).toEqual(expected);
  });

  it("removes disconnected ports from future broadcasts", async () => {
    const { server } = createServer();
    const connectedPort = new FakePort();
    const disconnectedPort = new FakePort();

    await server.start();
    server.connectPort(connectedPort);
    server.connectPort(disconnectedPort);
    disconnectedPort.disconnect();

    server.applySessionSnapshot(createSnapshot());

    expect(connectedPort.postedMessages).toHaveLength(2);
    expect(disconnectedPort.postedMessages).toHaveLength(1);
  });

  it("removes ports that throw on postMessage and continues broadcasting", async () => {
    const { server } = createServer();
    const throwingPort = new FakePort();
    const healthyPort = new FakePort();
    throwingPort.throwOnPost = true;

    await server.start();

    expect(() => server.connectPort(throwingPort)).not.toThrow();
    server.connectPort(healthyPort);

    server.applySessionSnapshot(createSnapshot());

    expect(healthyPort.postedMessages.at(-1)).toEqual({ type: "assistant.snapshot", state: server.getSnapshot() });
    expect(throwingPort.postedMessages).toHaveLength(0);
  });

  it("handles assistant.diagnostics.refresh", async () => {
    const { server, storage } = createServer();
    const port = new FakePort();
    const storedDiagnostics = [
      { timestamp: 1_710_000_000_001, phase: "startup", message: "Первый журнал" },
    ];
    storage.values.set("diagnostics", storedDiagnostics);

    await server.start();
    server.connectPort(port);

    port.emitMessage({ type: "assistant.diagnostics.refresh" });
    await flushAsyncWork();

    expect(server.getSnapshot().diagnostics).toEqual(storedDiagnostics);
  });

  it("handles session chat events via sessionClient snapshot", () => {
    const { server } = createServer();
    server.applySessionSnapshot(createSnapshot());

    // Chat events are part of the snapshot, not separate
    expect(server.getSnapshot().chat.agentBusy).toBe(false);
  });

  // --- Удалены тесты с chat.events (устаревшая архитектура) ---
  // Заменены на mirror-behavior тесты ниже.

  it("snapshot с chat.entries рендерит полную историю сообщений", () => {
    const { server } = createServer();
    const snapshot = createSnapshot({
      chat: {
        entries: [
          {
            type: "message" as const,
            id: "e1",
            timestamp: "2025-01-01T00:00:00Z",
            message: {
              role: "user" as const,
              content: [{ type: "text" as const, text: "Привет, Pi!" }],
            },
          },
          {
            type: "message" as const,
            id: "e2",
            timestamp: "2025-01-01T00:00:01Z",
            message: {
              role: "assistant" as const,
              id: "msg-1",
              content: [{ type: "text" as const, text: "Привет!" }],
            },
          },
        ],
        agentBusy: false,
        busyLabel: "Агент работает в фоне…",
      },
    });
    server.applySessionSnapshot(snapshot);

    const state = server.getSnapshot();
    expect(state.chat.messages).toHaveLength(2);
    expect(state.chat.messages[0]).toMatchObject({
      role: "user",
      text: "Привет, Pi!",
    });
    expect(state.chat.messages[1]).toMatchObject({
      role: "assistant",
      messageId: "msg-1",
      text: "Привет!",
      streaming: false,
    });
  });

  it("reconnect с теми же entries воспроизводит тот же чат", () => {
    const { server } = createServer();
    const entries = [
      {
        type: "message" as const,
        id: "e1",
        timestamp: "2025-01-01T00:00:00Z",
        message: {
          role: "user" as const,
          content: [{ type: "text" as const, text: "Вопрос" }],
        },
      },
      {
        type: "message" as const,
        id: "e2",
        timestamp: "2025-01-01T00:00:01Z",
        message: {
          role: "assistant" as const,
          id: "msg-1",
          content: [{ type: "text" as const, text: "Ответ" }],
        },
      },
    ];
    const snapshot = createSnapshot({
      chat: { entries, agentBusy: false, busyLabel: "Агент работает в фоне…" },
    });

    // Первый snapshot
    server.applySessionSnapshot(snapshot);
    const firstState = server.getSnapshot();

    // Симулируем reconnect: тот же snapshot
    server.applySessionSnapshot(snapshot);
    const secondState = server.getSnapshot();

    expect(secondState.chat.messages).toEqual(firstState.chat.messages);
    expect(secondState.chat.messages).toHaveLength(2);
  });

  it("isChatSendDisabled returns true when not online", () => {
    const { server } = createServer();

    expect(isChatSendDisabled(server.getSnapshot(), "Сообщение")).toBe(true);
  });

  it("isChatSendDisabled returns false when online", () => {
    const { server } = createServer();
    server.applySessionSnapshot(createSnapshot());

    expect(isChatSendDisabled(server.getSnapshot(), "Сообщение")).toBe(false);
  });

  it("does not append or call client twice for duplicate sends while chat is busy", async () => {
    const { server, sessionClients } = createServer();
    const port = new FakePort();

    await server.start();
    server.connectPort(port);

    // Connect to create session client
    port.emitMessage({ type: "assistant.session.connect", port: 31415 });
    await flushAsyncWork();
    server.applySessionSnapshot(createSnapshot());

    port.emitMessage({ type: "assistant.sendChatMessage", message: "Первое" });
    port.emitMessage({ type: "assistant.sendChatMessage", message: "Второе" });
    await flushAsyncWork();

    expect(sessionClients[0]?.sendChatMessage).toHaveBeenCalledTimes(1);
    expect(sessionClients[0]?.sendChatMessage).toHaveBeenCalledWith("Первое");
    expect(server.getSnapshot().chat.messages).toEqual([
      { role: "user", text: "Первое", timestamp: 1_710_000_000_123 },
    ]);
  });

  it("adds a Pi unavailable chat error when sessionClient send fails", async () => {
    const { server, sessionClients } = createServer();
    const port = new FakePort();

    await server.start();
    server.connectPort(port);

    // Connect to create session client
    port.emitMessage({ type: "assistant.session.connect", port: 31415 });
    await flushAsyncWork();
    server.applySessionSnapshot(createSnapshot());
    if (sessionClients[0]) {
      sessionClients[0].sendChatMessageResult = false;
    }

    port.emitMessage({ type: "assistant.sendChatMessage", message: "Привет" });
    await flushAsyncWork();

    expect(sessionClients[0]?.sendChatMessage).toHaveBeenCalledWith("Привет");
    expect(server.getSnapshot().chat.error).toBe("Pi недоступен");
    expect(server.getSnapshot().chat.agentBusy).toBe(false);
    expect(server.getSnapshot().chat.sending).toBe(false);
  });

  it("clears model mutation pending when model set result comes via snapshot", async () => {
    const { server } = createServer();
    const port = new FakePort();

    await server.start();
    server.connectPort(port);

    // Connect to create session client
    port.emitMessage({ type: "assistant.session.connect", port: 31415 });
    await flushAsyncWork();
    server.applySessionSnapshot(createSnapshot());

    port.emitMessage({ type: "assistant.model.set", provider: "anthropic", modelId: "claude-sonnet" });
    expect(server.getSnapshot().runtime.modelMutationPending).toBe(true);

    // New snapshot resets modelMutationPending
    server.applySessionSnapshot(createSnapshot());
    expect(server.getSnapshot().runtime.modelMutationPending).toBe(false);
  });

  it("no multi-session concepts in snapshot", () => {
    const { server } = createServer();
    server.applySessionSnapshot(createSnapshot());

    const snapshot = server.getSnapshot();
    expect("targets" in snapshot).toBe(false);
    expect("auth" in snapshot).toBe(false);
    expect("brokerOnline" in snapshot.connection).toBe(false);
    expect("bridgeOnline" in snapshot.connection).toBe(false);
    expect("tokenConfigured" in snapshot.connection).toBe(false);
    expect("browserAuthorized" in snapshot.connection).toBe(false);
  });

  it("auto-restores saved session port on first port connect — creates SessionClient", async () => {
    const { server, storage, sessionClients } = createServer();
    const port = new FakePort();

    // Simulate a previously saved port from before service-worker restart
    storage.values.set("sessionPort", 31416);

    await server.start();
    server.connectPort(port);
    await flushAsyncWork();

    // A SessionClient should have been created for the saved port
    expect(sessionClients).toHaveLength(1);
    expect(sessionClients[0]?.port).toBe(31416);
    expect(sessionClients[0]?.connect).toHaveBeenCalledTimes(1);

    // Connection state should reflect the restored port
    const snapshot = server.getSnapshot();
    expect(snapshot.connection.configuredPort).toBe(31416);
    expect(snapshot.connection.connecting).toBe(true);
  });

  it("does NOT auto-connect when no saved port in storage", async () => {
    const { server, storage, sessionClients } = createServer();
    const port = new FakePort();

    // No sessionPort in storage — empty map from createServer
    expect(storage.values.get("sessionPort")).toBeUndefined();

    await server.start();
    server.connectPort(port);
    await flushAsyncWork();

    // No SessionClient should be created
    expect(sessionClients).toHaveLength(0);
    const snapshot = server.getSnapshot();
    expect(snapshot.connection.connecting).toBe(false);
    expect(snapshot.connection.configuredPort).toBe(31415); // default
  });

  it("skips auto-restore for invalid saved port values", async () => {
    const { server, storage, sessionClients } = createServer();
    const port = new FakePort();

    // Invalid port: out of range
    storage.values.set("sessionPort", 70000);

    await server.start();
    server.connectPort(port);
    await flushAsyncWork();

    expect(sessionClients).toHaveLength(0);
    expect(server.getSnapshot().connection.connecting).toBe(false);
  });

  // ─── Task 1: Additional restore/reconnect tests ───

  it("after SessionClient disconnects, reconnect state remains in background state", async () => {
    const { server, sessionClients } = createServer();
    const port = new FakePort();

    await server.start();
    server.connectPort(port);

    port.emitMessage({ type: "assistant.session.connect", port: 31415 });
    await flushAsyncWork();

    // Simulate client connecting
    sessionClients[0]?.emitConnectionState({
      online: false,
      connecting: true,
      statusText: "Подключаемся к Pi-сессии…",
    });

    expect(server.getSnapshot().connection.connecting).toBe(true);
    expect(server.getSnapshot().connection.configuredPort).toBe(31415);
  });

  it("restored SessionClient can go online after saved-port reconnect", async () => {
    const { server, storage, sessionClients } = createServer();
    const port = new FakePort();

    // Simulate previously saved port
    storage.values.set("sessionPort", 31416);

    await server.start();
    server.connectPort(port);
    await flushAsyncWork();

    // SessionClient created for saved port
    expect(sessionClients).toHaveLength(1);

    // Simulate the restored client going online
    sessionClients[0]?.emitConnectionState({
      online: true,
      connecting: false,
      statusText: "Подключено к Pi-сессии",
    });

    expect(server.getSnapshot().connection.online).toBe(true);
    expect(server.getSnapshot().connection.configuredPort).toBe(31416);
    expect(server.getSnapshot().connection.connecting).toBe(false);
  });

  it("stop() closes session client and clears it", async () => {
    const { server, sessionClients } = createServer();
    const port = new FakePort();

    await server.start();
    server.connectPort(port);

    port.emitMessage({ type: "assistant.session.connect", port: 31415 });
    await flushAsyncWork();

    expect(sessionClients).toHaveLength(1);

    server.stop();

    expect(sessionClients[0]?.close).toHaveBeenCalledTimes(1);
    expect(server.getSnapshot().connection.online).toBe(false);
  });

  it("sends selection through sessionClient and returns result", async () => {
    const { server, sessionClients } = createServer();
    const port = new FakePort();

    await server.start();
    server.connectPort(port);

    port.emitMessage({ type: "assistant.session.connect", port: 31415 });
    await flushAsyncWork();
    server.applySessionSnapshot(createSnapshot());

    const selection: SelectionPayload = {
      url: "https://example.com",
      title: "Example",
      selectedText: "выделенный текст",
      selectedHtml: "<span>текст</span>",
      capturedAt: 1_710_000_000_000,
    };

    const result = server.sendSelection(selection);
    expect(result).toEqual({ ok: true });
    expect(sessionClients[0]?.sendSelection).toHaveBeenCalledWith(selection);
  });

  it("sendSelection returns error when no session client", async () => {
    const { server } = createServer();

    const selection: SelectionPayload = {
      url: "https://example.com",
      title: "Example",
      selectedText: "текст",
      selectedHtml: "<span>текст</span>",
      capturedAt: 1_710_000_000_000,
    };

    const result = server.sendSelection(selection);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("Pi-сессия не подключена");
    }
  });

  it("sendSelection returns error when session client send fails", async () => {
    const { server, sessionClients } = createServer();
    const port = new FakePort();

    await server.start();
    server.connectPort(port);

    port.emitMessage({ type: "assistant.session.connect", port: 31415 });
    await flushAsyncWork();
    server.applySessionSnapshot(createSnapshot());

    if (sessionClients[0]) {
      sessionClients[0].sendSelectionResult = false;
    }

    const selection: SelectionPayload = {
      url: "https://example.com",
      title: "Example",
      selectedText: "текст",
      selectedHtml: "<span>текст</span>",
      capturedAt: 1_710_000_000_000,
    };

    const result = server.sendSelection(selection);
    expect(result.ok).toBe(false);
  });
});
