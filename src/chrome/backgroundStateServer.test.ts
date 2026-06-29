import { describe, expect, it, vi } from "vitest";

import type { DirectSessionSnapshot, PiMirrorEvent, SelectionPayload } from "../shared/protocol";
import type { SessionConnectionState } from "./sessionClient";
import {
  BackgroundAssistantStateServer,
  type BackgroundStateServerStorage,
  type ChromeRuntimePortLike,
} from "./backgroundStateServer";
import { isChatSendDisabled } from "./assistantState";
import { createDirectSnapshot } from "./test-utils";

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
  onSessionEvent?: (event: PiMirrorEvent) => void;
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

  emitSessionEvent(event: PiMirrorEvent): void {
    this.options.onSessionEvent?.(event);
  }
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
    server.applySessionSnapshot(createDirectSnapshot());

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
    server.applySessionSnapshot(createDirectSnapshot());

    port.emitMessage({ type: "assistant.sendChatMessage", message: " Привет Pi " });
    await flushAsyncWork();

    expect(sessionClients[0]?.sendChatMessage).toHaveBeenCalledWith("Привет Pi");
    // No optimistic user message in chat — message will appear from server snapshot
    expect(server.getSnapshot().chat.messages).toEqual([]);
    // agentBusy is set to true instead of sending for busy indicator
    expect(server.getSnapshot().chat.agentBusy).toBe(true);
  });

  it("sends model set through sessionClient on assistant.model.set", async () => {
    const { server, sessionClients } = createServer();
    const port = new FakePort();

    await server.start();
    server.connectPort(port);

    // Connect to create session client
    port.emitMessage({ type: "assistant.session.connect", port: 31415 });
    await flushAsyncWork();
    server.applySessionSnapshot(createDirectSnapshot());

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

    server.applySessionSnapshot(createDirectSnapshot());

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

    server.applySessionSnapshot(createDirectSnapshot());

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

    server.applySessionSnapshot(createDirectSnapshot());

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
    server.applySessionSnapshot(createDirectSnapshot());

    // Chat events are part of the snapshot, not separate
    expect(server.getSnapshot().chat.agentBusy).toBe(false);
  });

  it("snapshot с chat.entries рендерит полную историю сообщений", () => {
    const { server } = createServer();
    const snapshot = createDirectSnapshot({
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
    const snapshot = createDirectSnapshot({
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
    server.applySessionSnapshot(createDirectSnapshot());

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
    server.applySessionSnapshot(createDirectSnapshot());

    port.emitMessage({ type: "assistant.sendChatMessage", message: "Первое" });
    port.emitMessage({ type: "assistant.sendChatMessage", message: "Второе" });
    await flushAsyncWork();

    // Only first send is executed — second is blocked by agentBusy=true
    expect(sessionClients[0]?.sendChatMessage).toHaveBeenCalledTimes(1);
    expect(sessionClients[0]?.sendChatMessage).toHaveBeenCalledWith("Первое");
    // No optimistic messages in chat
    expect(server.getSnapshot().chat.messages).toEqual([]);
    // isChatSendDisabled blocks because agentBusy=true
    expect(server.getSnapshot().chat.agentBusy).toBe(true);
  });

  it("adds a Pi unavailable chat error when sessionClient send fails", async () => {
    const { server, sessionClients } = createServer();
    const port = new FakePort();

    await server.start();
    server.connectPort(port);

    // Connect to create session client
    port.emitMessage({ type: "assistant.session.connect", port: 31415 });
    await flushAsyncWork();
    server.applySessionSnapshot(createDirectSnapshot());
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
    server.applySessionSnapshot(createDirectSnapshot());

    port.emitMessage({ type: "assistant.model.set", provider: "anthropic", modelId: "claude-sonnet" });
    expect(server.getSnapshot().runtime.modelMutationPending).toBe(true);

    // New snapshot resets modelMutationPending
    server.applySessionSnapshot(createDirectSnapshot());
    expect(server.getSnapshot().runtime.modelMutationPending).toBe(false);
  });

  it("no multi-session concepts in snapshot", () => {
    const { server } = createServer();
    server.applySessionSnapshot(createDirectSnapshot());

    const snapshot = server.getSnapshot();
    expect("targets" in snapshot).toBe(false);
    expect("auth" in snapshot).toBe(false);
    expect("brokerOnline" in snapshot.connection).toBe(false);
    expect("bridgeOnline" in snapshot.connection).toBe(false);
    expect("tokenConfigured" in snapshot.connection).toBe(false);
    expect("browserAuthorized" in snapshot.connection).toBe(false);
  });

  it("auto-restores saved session port on first port connect — updates configuredPort only, no auto-connect", async () => {
    const { server, storage, sessionClients } = createServer();
    const port = new FakePort();

    // Simulate a previously saved port from before service-worker restart
    storage.values.set("sessionPort", 31416);

    await server.start();
    server.connectPort(port);
    await flushAsyncWork();

    // No SessionClient should be created — the user must click «Подключить»
    expect(sessionClients).toHaveLength(0);

    // But the configuredPort should be restored in UI
    const snapshot = server.getSnapshot();
    expect(snapshot.connection.configuredPort).toBe(31416);
    expect(snapshot.connection.connecting).toBe(false);
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
    // configuredPort stays at default
    expect(server.getSnapshot().connection.configuredPort).toBe(31415);
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

  it("restored saved port requires explicit connect command to create SessionClient", async () => {
    const { server, storage, sessionClients } = createServer();
    const port = new FakePort();

    // Simulate previously saved port
    storage.values.set("sessionPort", 31416);

    await server.start();
    server.connectPort(port);
    await flushAsyncWork();

    // No SessionClient created yet — only configuredPort was restored
    expect(sessionClients).toHaveLength(0);
    expect(server.getSnapshot().connection.configuredPort).toBe(31416);
    expect(server.getSnapshot().connection.connecting).toBe(false);

    // User clicks «Подключить» → explicit connect command
    port.emitMessage({ type: "assistant.session.connect", port: 31416 });
    await flushAsyncWork();

    // Now SessionClient is created and connects
    expect(sessionClients).toHaveLength(1);
    expect(sessionClients[0]?.port).toBe(31416);
    expect(sessionClients[0]?.connect).toHaveBeenCalledTimes(1);

    // Simulate successful connection
    sessionClients[0]?.emitConnectionState({
      online: true,
      connecting: false,
      statusText: "Подключено к Pi-сессии",
    });

    expect(server.getSnapshot().connection.online).toBe(true);
    expect(server.getSnapshot().connection.configuredPort).toBe(31416);
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
    server.applySessionSnapshot(createDirectSnapshot());

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
    server.applySessionSnapshot(createDirectSnapshot());

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

  // ─── Task 7: snapshot + live event mirror flow tests ───

  it("onSnapshot hydrates full history from entries (Task 7)", async () => {
    const { server, sessionClients } = createServer();
    const port = new FakePort();

    await server.start();
    server.connectPort(port);
    port.emitMessage({ type: "assistant.session.connect", port: 31415 });
    await flushAsyncWork();

    const snapshot = createDirectSnapshot({
      chat: {
        entries: [
          {
            type: "message" as const,
            id: "e1",
            timestamp: "2025-01-01T00:00:00Z",
            message: {
              role: "user" as const,
              content: [{ type: "text" as const, text: "Вопрос 1" }],
            },
          },
          {
            type: "message" as const,
            id: "e2",
            timestamp: "2025-01-01T00:00:01Z",
            message: {
              role: "assistant" as const,
              id: "msg-a",
              content: [{ type: "text" as const, text: "Ответ 1" }],
            },
          },
          {
            type: "message" as const,
            id: "e3",
            timestamp: "2025-01-01T00:00:02Z",
            message: {
              role: "user" as const,
              content: [{ type: "text" as const, text: "Вопрос 2" }],
            },
          },
          {
            type: "message" as const,
            id: "e4",
            timestamp: "2025-01-01T00:00:03Z",
            message: {
              role: "assistant" as const,
              id: "msg-b",
              content: [{ type: "text" as const, text: "Ответ 2" }],
            },
          },
        ],
        agentBusy: false,
        busyLabel: "Агент работает в фоне…",
      },
    });

    sessionClients[0]?.emitSnapshot(snapshot);

    const state = server.getSnapshot();
    expect(state.chat.messages).toHaveLength(4);
    expect(state.chat.messages[0]).toMatchObject({ role: "user", text: "Вопрос 1" });
    expect(state.chat.messages[1]).toMatchObject({ role: "assistant", messageId: "msg-a", text: "Ответ 1", streaming: false });
    expect(state.chat.messages[2]).toMatchObject({ role: "user", text: "Вопрос 2" });
    expect(state.chat.messages[3]).toMatchObject({ role: "assistant", messageId: "msg-b", text: "Ответ 2", streaming: false });
  });

  it("onSessionEvent(message_update) updates currently visible assistant response (Task 7)", async () => {
    const { server, sessionClients } = createServer();
    const port = new FakePort();

    await server.start();
    server.connectPort(port);

    // Connect and establish session
    port.emitMessage({ type: "assistant.session.connect", port: 31415 });
    await flushAsyncWork();

    // First hydrate with snapshot that has a message
    server.applySessionSnapshot(createDirectSnapshot({
      chat: {
        entries: [
          {
            type: "message" as const,
            id: "e1",
            timestamp: "2025-01-01T00:00:00Z",
            message: {
              role: "user" as const,
              content: [{ type: "text" as const, text: "Привет" }],
            },
          },
        ],
        agentBusy: true,
        busyLabel: "Агент работает в фоне…",
      },
    }));

    // Now emit a live session.event with message_start
    sessionClients[0]?.emitSessionEvent({
      type: "message_start",
      message: { id: "live-1", role: "assistant" },
    });

    const afterStart = server.getSnapshot();
    expect(afterStart.chat.messages).toHaveLength(2); // user + new assistant
    const liveMsg = afterStart.chat.messages[1];
    expect(liveMsg.role).toBe("assistant");
    if (liveMsg.role === "assistant") {
      expect(liveMsg.messageId).toBe("live-1");
      expect(liveMsg.text).toBe("");
      expect(liveMsg.streaming).toBe(true);
    }

    // Now emit a message_update with text_delta
    sessionClients[0]?.emitSessionEvent({
      type: "message_update",
      message: { id: "live-1", role: "assistant" },
      assistantMessageEvent: { type: "text_delta", text_delta: "Привет, " },
    });

    const afterUpdate = server.getSnapshot();
    const updatedMsg = afterUpdate.chat.messages.find(
      (m) => m.role === "assistant" && m.messageId === "live-1",
    );
    expect(updatedMsg).toBeDefined();
    if (updatedMsg?.role === "assistant") {
      expect(updatedMsg.text).toBe("Привет, ");
      expect(updatedMsg.streaming).toBe(true);
    }

    // Emit another delta
    sessionClients[0]?.emitSessionEvent({
      type: "message_update",
      message: { id: "live-1", role: "assistant" },
      assistantMessageEvent: { type: "text_delta", text_delta: "как дела?" },
    });

    const afterSecond = server.getSnapshot();
    const finalMsg = afterSecond.chat.messages.find(
      (m) => m.role === "assistant" && m.messageId === "live-1",
    );
    if (finalMsg?.role === "assistant") {
      expect(finalMsg.text).toBe("Привет, как дела?");
    }
  });

  it("reconnect does not require /reload to see new live messages (Task 7)", async () => {
    const { server, sessionClients } = createServer();
    const port = new FakePort();

    await server.start();
    server.connectPort(port);

    // Connect session
    port.emitMessage({ type: "assistant.session.connect", port: 31415 });
    await flushAsyncWork();

    // Initial snapshot with one entry
    const initialSnapshot = createDirectSnapshot({
      chat: {
        entries: [
          {
            type: "message" as const,
            id: "e1",
            timestamp: "2025-01-01T00:00:00Z",
            message: {
              role: "user" as const,
              content: [{ type: "text" as const, text: "Привет" }],
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
    server.applySessionSnapshot(initialSnapshot);

    // Live event streams a new message
    sessionClients[0]?.emitSessionEvent({
      type: "message_start",
      message: { id: "live-new", role: "assistant" },
    });
    sessionClients[0]?.emitSessionEvent({
      type: "message_update",
      message: { id: "live-new", role: "assistant" },
      assistantMessageEvent: { type: "text_delta", text_delta: "Новое сообщение" },
    });

    let state = server.getSnapshot();
    const liveMsgAfterStream = state.chat.messages.find(
      (m) => m.role === "assistant" && m.messageId === "live-new",
    );
    expect(liveMsgAfterStream).toBeDefined();
    if (liveMsgAfterStream?.role === "assistant") {
      expect(liveMsgAfterStream.text).toBe("Новое сообщение");
    }

    // Simulate reconnect: new snapshot with all entries including the new one
    const reconnectSnapshot = createDirectSnapshot({
      chat: {
        entries: [
          {
            type: "message" as const,
            id: "e1",
            timestamp: "2025-01-01T00:00:00Z",
            message: {
              role: "user" as const,
              content: [{ type: "text" as const, text: "Привет" }],
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
          {
            type: "message" as const,
            id: "e3",
            timestamp: "2025-01-01T00:00:04Z",
            message: {
              role: "assistant" as const,
              id: "live-new",
              content: [{ type: "text" as const, text: "Новое сообщение" }],
            },
          },
        ],
        agentBusy: false,
        busyLabel: "Агент работает в фоне…",
      },
    });
    server.applySessionSnapshot(reconnectSnapshot);

    state = server.getSnapshot();
    // All 3 messages present after reconnect snapshot
    expect(state.chat.messages).toHaveLength(3);
    expect(state.chat.messages.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "assistant",
    ]);
    const reconnectedLive = state.chat.messages.find(
      (m) => m.role === "assistant" && m.messageId === "live-new",
    );
    expect(reconnectedLive).toBeDefined();
    if (reconnectedLive?.role === "assistant") {
      expect(reconnectedLive.text).toBe("Новое сообщение");
    }
  });

  it("opening a new sidepanel port receives already-current mirrored state (Task 7)", async () => {
    const { server, sessionClients } = createServer();
    const portA = new FakePort();

    await server.start();
    server.connectPort(portA);

    // Connect session via port A
    portA.emitMessage({ type: "assistant.session.connect", port: 31415 });
    await flushAsyncWork();

    // Snapshot hydrates history
    server.applySessionSnapshot(createDirectSnapshot({
      chat: {
        entries: [
          {
            type: "message" as const,
            id: "e1",
            timestamp: "2025-01-01T00:00:00Z",
            message: {
              role: "user" as const,
              content: [{ type: "text" as const, text: "Привет" }],
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
    }));

    // Live event streams a delta
    sessionClients[0]?.emitSessionEvent({
      type: "message_start",
      message: { id: "live-x", role: "assistant" },
    });
    sessionClients[0]?.emitSessionEvent({
      type: "message_update",
      message: { id: "live-x", role: "assistant" },
      assistantMessageEvent: { type: "text_delta", text_delta: "Стриминг..." },
    });

    // NOW connect a second sidepanel port
    const portB = new FakePort();
    server.connectPort(portB);

    // portB should have received a snapshot with the current full state
    const portBSnapshot = portB.postedMessages[0] as {
      type?: string;
      state?: ReturnType<typeof server.getSnapshot>;
    };
    expect(portBSnapshot.type).toBe("assistant.snapshot");

    const portBState = portBSnapshot.state;
    expect(portBState).toBeDefined();
    if (!portBState) {
      throw new Error("Ожидался assistant.snapshot state для нового sidepanel port");
    }
    // Should include both snapshot messages + live-streamed message
    expect(portBState.chat.messages).toHaveLength(3);
    expect(portBState.chat.messages.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "assistant",
    ]);
    const liveMsg = portBState.chat.messages.find(
      (m) => m.role === "assistant" && m.messageId === "live-x",
    );
    expect(liveMsg).toBeDefined();
    if (liveMsg?.role === "assistant") {
      expect(liveMsg.text).toBe("Стриминг...");
    }
  });

  it("handles assistant.startDomPicker command and delegates to injected startDomPicker", async () => {
    const startPicker = vi.fn(async () => ({ ok: true }));
    const { server } = createServer({ startDomPicker: startPicker });
    const port = new FakePort();

    await server.start();
    server.connectPort(port);

    // Must be online
    server.applySessionSnapshot(createDirectSnapshot());

    port.emitMessage({ type: "assistant.startDomPicker", tabId: 42 });
    await flushAsyncWork();

    expect(startPicker).toHaveBeenCalledWith({ tabId: 42 });
  });

  it("handles assistant.startDomPicker without tabId", async () => {
    const startPicker = vi.fn(async () => ({ ok: true }));
    const { server } = createServer({ startDomPicker: startPicker });
    const port = new FakePort();

    await server.start();
    server.connectPort(port);
    server.applySessionSnapshot(createDirectSnapshot());

    port.emitMessage({ type: "assistant.startDomPicker" });
    await flushAsyncWork();

    expect(startPicker).toHaveBeenCalledWith({ tabId: undefined });
  });

  it("records error when startDomPicker fails (not online)", async () => {
    const { server, diagnostics } = createServer();
    const port = new FakePort();

    await server.start();
    server.connectPort(port);

    // Not online
    port.emitMessage({ type: "assistant.startDomPicker" });
    await flushAsyncWork();

    expect(diagnostics).toContainEqual(
      expect.objectContaining({ phase: "assistant.startDomPicker", message: "Pi-сессия не подключена." }),
    );
  });

  it("handles assistant.stopDomPicker command via injected DI", async () => {
    const stopDomPicker = vi.fn().mockResolvedValue(undefined);
    const { server } = createServer({ stopDomPicker });
    const port = new FakePort();

    await server.start();
    server.connectPort(port);

    port.emitMessage({ type: "assistant.stopDomPicker" });
    await flushAsyncWork();

    expect(stopDomPicker).toHaveBeenCalledTimes(1);
    expect(stopDomPicker).toHaveBeenCalledWith();
  });

  it("handles assistant.stopDomPicker command (fallback)", async () => {
    const queryTabs = vi.fn(async () => [{ id: 99, url: "https://example.com" }]);
    const sendMessage = vi.fn(async () => ({ ok: true }));

    vi.stubGlobal("chrome", {
      tabs: { query: queryTabs, sendMessage },
    } as unknown as typeof chrome);

    const { server } = createServer();
    const port = new FakePort();

    await server.start();
    server.connectPort(port);

    port.emitMessage({ type: "assistant.stopDomPicker" });
    await flushAsyncWork();

    expect(queryTabs).toHaveBeenCalledWith({ active: true, currentWindow: true });
    expect(sendMessage).toHaveBeenCalledWith(99, { type: "stopDomPicker" });

    vi.unstubAllGlobals();
  });

  it("stopDomPicker fallback is best-effort and does not throw when content script is unreachable", async () => {
    const queryTabs = vi.fn(async () => [{ id: 99, url: "https://example.com" }]);
    const sendMessage = vi.fn(async () => {
      throw new Error("Receiving end does not exist");
    });

    vi.stubGlobal("chrome", {
      tabs: { query: queryTabs, sendMessage },
    } as unknown as typeof chrome);

    const { server, diagnostics } = createServer();
    const port = new FakePort();

    await server.start();
    server.connectPort(port);

    port.emitMessage({ type: "assistant.stopDomPicker" });
    await flushAsyncWork();

    // Should NOT have recorded an error (best-effort)
    expect(diagnostics).toHaveLength(0);

    vi.unstubAllGlobals();
  });

  // ─── Task T4: setModel error paths ───

  describe("setModel error paths", () => {
    it("should show error when offline", async () => {
      const port = new FakePort();
      const { server } = createServer();
      server.connectPort(port);
      await flushAsyncWork();

      // Offline state (no session connected)
      port.emitMessage({
        type: "assistant.model.set",
        provider: "openai",
        modelId: "gpt-4",
      });
      await flushAsyncWork();

      const state = server.getSnapshot();
      expect(state.runtime.modelError).toBe("Pi-сессия не подключена.");
      expect(state.runtime.modelMutationPending).toBe(false);
    });

    it("should show error when provider is empty", async () => {
      const port = new FakePort();
      const { server, sessionClients } = createServer();
      server.connectPort(port);
      await flushAsyncWork();

      // Connect the session
      port.emitMessage({ type: "assistant.session.connect", port: 31415 });
      await flushAsyncWork();
      sessionClients[0]?.emitConnectionState({
        online: true,
        connecting: false,
        statusText: "Подключено к Pi-сессии",
      });
      sessionClients[0]?.emitSnapshot(createDirectSnapshot());
      await flushAsyncWork();

      port.emitMessage({
        type: "assistant.model.set",
        provider: "  ", // whitespace only
        modelId: "gpt-4",
      });
      await flushAsyncWork();

      const state = server.getSnapshot();
      expect(state.runtime.modelError).toBe("Выберите модель.");
    });

    it("should show error when modelId is empty", async () => {
      const port = new FakePort();
      const { server, sessionClients } = createServer();
      server.connectPort(port);
      await flushAsyncWork();

      // Connect the session
      port.emitMessage({ type: "assistant.session.connect", port: 31415 });
      await flushAsyncWork();
      sessionClients[0]?.emitConnectionState({
        online: true,
        connecting: false,
        statusText: "Подключено к Pi-сессии",
      });
      sessionClients[0]?.emitSnapshot(createDirectSnapshot());
      await flushAsyncWork();

      port.emitMessage({
        type: "assistant.model.set",
        provider: "openai",
        modelId: "", // empty
      });
      await flushAsyncWork();

      const state = server.getSnapshot();
      expect(state.runtime.modelError).toBe("Выберите модель.");
    });

    it("should show error when setModel send fails", async () => {
      const port = new FakePort();
      const { server, sessionClients } = createServer();
      server.connectPort(port);
      await flushAsyncWork();

      // Connect the session
      port.emitMessage({ type: "assistant.session.connect", port: 31415 });
      await flushAsyncWork();
      sessionClients[0]?.emitConnectionState({
        online: true,
        connecting: false,
        statusText: "Подключено к Pi-сессии",
      });
      sessionClients[0]?.emitSnapshot(createDirectSnapshot());
      await flushAsyncWork();

      // Make setModel return false
      Object.defineProperty(sessionClients[0], 'setModel', {
        value: vi.fn().mockReturnValue(false),
        writable: true,
        configurable: true,
      });

      port.emitMessage({
        type: "assistant.model.set",
        provider: "openai",
        modelId: "gpt-4",
      });
      await flushAsyncWork();

      const state = server.getSnapshot();
      expect(state.runtime.modelError).toBe("Pi недоступен");
      expect(state.runtime.modelMutationPending).toBe(false);
    });
  });
});
