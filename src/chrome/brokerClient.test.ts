import { describe, expect, it, vi } from "vitest";

import { PROTOCOL_VERSION } from "../shared/constants";
import type { ChatEvent, ProtocolEnvelope, TargetMetadata, TargetRuntimeState } from "../shared/protocol";
import { BrokerClient } from "./brokerClient";

type BrokerEventName = "open" | "message" | "error" | "close";
type BrokerEventListener = (event?: { data?: string }) => void;

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 3;

  readonly sent: string[] = [];
  readonly listeners = new Map<BrokerEventName, Set<BrokerEventListener>>();
  readyState = FakeWebSocket.CONNECTING;
  closeCalls = 0;

  addEventListener(eventName: BrokerEventName, listener: BrokerEventListener): void {
    const listeners = this.listeners.get(eventName) ?? new Set<BrokerEventListener>();
    listeners.add(listener);
    this.listeners.set(eventName, listeners);
  }

  removeEventListener(eventName: BrokerEventName, listener: BrokerEventListener): void {
    this.listeners.get(eventName)?.delete(listener);
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

  emitMessage(envelope: ProtocolEnvelope): void {
    this.emit("message", { data: JSON.stringify(envelope) });
  }

  emitClose(): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.emit("close");
  }

  emitError(): void {
    this.emit("error");
  }

  private emit(eventName: BrokerEventName, event?: { data?: string }): void {
    for (const listener of this.listeners.get(eventName) ?? []) {
      listener(event);
    }
  }
}

const target: TargetMetadata = {
  targetId: "target-1",
  alias: "frontend",
  cwd: "/repo/project",
  gitBranch: "main",
  pid: 123,
  sessionName: "session",
  connectedAt: 1_710_000_000_000,
  lastSeenAt: 1_710_000_000_100,
};

function readSent<TPayload = unknown>(socket: FakeWebSocket, index: number): ProtocolEnvelope<TPayload> {
  return JSON.parse(socket.sent[index] ?? "{}");
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function sentTypes(socket: FakeWebSocket): string[] {
  return socket.sent.map((message) => JSON.parse(message).type as string);
}

describe("BrokerClient", () => {
  it("authenticates and requests target list after opening the broker socket", async () => {
    const socket = new FakeWebSocket();
    const client = new BrokerClient({
      browserToken: "browser-token-1",
      webSocketFactory: () => socket,
      reconnectDelaysMs: [],
    });

    client.connect();
    socket.emitOpen();
    await flush();

    expect(readSent(socket, 0)).toEqual({
      version: PROTOCOL_VERSION,
      type: "client.hello",
      requestId: expect.any(String),
      payload: { token: "browser-token-1" },
    });
    expect(readSent(socket, 1)).toEqual({
      version: PROTOCOL_VERSION,
      type: "client.listTargets",
      requestId: expect.any(String),
    });
  });

  it("publishes target list updates without auto-subscribing from target snapshots", async () => {
    const socket = new FakeWebSocket();
    const onTargets = vi.fn();
    const client = new BrokerClient({
      browserToken: "browser-token-1",
      selectedTargetId: "target-1",
      webSocketFactory: () => socket,
      onTargets,
      reconnectDelaysMs: [],
    });

    client.connect();
    socket.emitOpen();
    await flush();
    const listEnvelope = readSent(socket, 1);

    socket.emitMessage({
      version: PROTOCOL_VERSION,
      type: "client.targets",
      requestId: listEnvelope.requestId,
      payload: { targets: [target] },
    });
    await flush();

    expect(onTargets).toHaveBeenCalledWith([target]);
    expect(sentTypes(socket)).toEqual(["client.hello", "client.listTargets"]);
  });

  it("publishes unsolicited target list updates after the initial snapshot", async () => {
    const socket = new FakeWebSocket();
    const onTargets = vi.fn();
    const client = new BrokerClient({
      browserToken: "browser-token-1",
      webSocketFactory: () => socket,
      onTargets,
      reconnectDelaysMs: [],
    });
    const nextTarget: TargetMetadata = {
      ...target,
      targetId: "target-2",
      alias: "backend",
    };

    client.connect();
    socket.emitOpen();
    socket.emitMessage({
      version: PROTOCOL_VERSION,
      type: "client.targets",
      requestId: readSent(socket, 1).requestId,
      payload: { targets: [target] },
    });
    await flush();

    socket.emitMessage({
      version: PROTOCOL_VERSION,
      type: "client.targets",
      payload: { targets: [target, nextTarget] },
    });
    await flush();

    expect(onTargets).toHaveBeenCalledTimes(2);
    expect(onTargets).toHaveBeenLastCalledWith([target, nextTarget]);
  });

  it("subscribes and unsubscribes only through explicit selected target updates", async () => {
    const socket = new FakeWebSocket();
    const client = new BrokerClient({
      browserToken: "browser-token-1",
      selectedTargetId: "target-1",
      webSocketFactory: () => socket,
      reconnectDelaysMs: [],
    });

    client.connect();
    socket.emitOpen();
    socket.emitMessage({
      version: PROTOCOL_VERSION,
      type: "client.targets",
      payload: { targets: [target] },
    });
    await flush();

    expect(sentTypes(socket)).toEqual(["client.hello", "client.listTargets"]);

    client.setSelectedTargetId("target-1");

    expect(readSent(socket, 2)).toEqual({
      version: PROTOCOL_VERSION,
      type: "client.subscribeTarget",
      requestId: expect.any(String),
      payload: {
        token: "browser-token-1",
        targetId: "target-1",
      },
    });

    client.setSelectedTargetId("target-2");

    expect(readSent(socket, 3)).toEqual({
      version: PROTOCOL_VERSION,
      type: "client.unsubscribeTarget",
      requestId: expect.any(String),
      payload: {
        token: "browser-token-1",
        targetId: "target-1",
      },
    });
    expect(readSent(socket, 4)).toEqual({
      version: PROTOCOL_VERSION,
      type: "client.subscribeTarget",
      requestId: expect.any(String),
      payload: {
        token: "browser-token-1",
        targetId: "target-2",
      },
    });

    client.setSelectedTargetId(undefined);

    expect(readSent(socket, 5)).toEqual({
      version: PROTOCOL_VERSION,
      type: "client.unsubscribeTarget",
      requestId: expect.any(String),
      payload: {
        token: "browser-token-1",
        targetId: "target-2",
      },
    });
  });

  it("publishes runtime state and available model updates", async () => {
    const socket = new FakeWebSocket();
    const onRuntimeState = vi.fn();
    const onAvailableModels = vi.fn();
    const runtimeState: TargetRuntimeState = {
      targetId: "target-1",
      model: { provider: "anthropic", id: "claude-sonnet", label: "Claude Sonnet" },
      contextUsage: { tokens: 1000, maxTokens: 200000, percent: 0.5 },
      isIdle: true,
      updatedAt: 1_710_000_000_200,
    };
    const client = new BrokerClient({
      browserToken: "browser-token-1",
      webSocketFactory: () => socket,
      onRuntimeState,
      onAvailableModels,
      reconnectDelaysMs: [],
    });

    client.connect();
    socket.emitOpen();
    socket.emitMessage({ version: PROTOCOL_VERSION, type: "client.runtimeState" as never, payload: runtimeState });
    socket.emitMessage({
      version: PROTOCOL_VERSION,
      type: "client.availableModels" as never,
      payload: { targetId: "target-1", models: [{ provider: "anthropic", id: "claude-sonnet", label: "Claude Sonnet" }] },
    });
    await flush();

    expect(onRuntimeState).toHaveBeenCalledWith(runtimeState);
    expect(onAvailableModels).toHaveBeenCalledWith([{ provider: "anthropic", id: "claude-sonnet", label: "Claude Sonnet" }], "target-1");
  });

  it("sends selected target model changes through the broker socket", async () => {
    const socket = new FakeWebSocket();
    const client = new BrokerClient({
      browserToken: "browser-token-1",
      selectedTargetId: "target-1",
      webSocketFactory: () => socket,
      reconnectDelaysMs: [],
      requestIdFactory: () => "model-request-1",
    });

    client.connect();
    socket.emitOpen();
    const sent = client.setTargetModel({ provider: "anthropic", modelId: "claude-sonnet" });

    expect(sent).toBe(true);
    expect(readSent(socket, 2)).toEqual({
      version: PROTOCOL_VERSION,
      type: "client.setTargetModel",
      requestId: "model-request-1",
      payload: {
        token: "browser-token-1",
        targetId: "target-1",
        provider: "anthropic",
        modelId: "claude-sonnet",
      },
    });
  });

  it("publishes model set results", async () => {
    const socket = new FakeWebSocket();
    const onModelSetResult = vi.fn();
    const client = new BrokerClient({
      browserToken: "browser-token-1",
      webSocketFactory: () => socket,
      onModelSetResult,
      reconnectDelaysMs: [],
    });

    client.connect();
    socket.emitOpen();
    socket.emitMessage({
      version: PROTOCOL_VERSION,
      type: "client.modelSetResult",
      requestId: "model-request-1",
      payload: { ok: false, error: "Модель недоступна" },
    });
    await flush();

    expect(onModelSetResult).toHaveBeenCalledWith({ ok: false, error: "Модель недоступна" });
  });

  it("publishes an updated target list without reporting offline when the selected target disappears", async () => {
    const socket = new FakeWebSocket();
    const onTargets = vi.fn();
    const onConnectionState = vi.fn();
    const client = new BrokerClient({
      browserToken: "browser-token-1",
      selectedTargetId: "target-1",
      webSocketFactory: () => socket,
      onTargets,
      onConnectionState,
      reconnectDelaysMs: [],
    });

    client.connect();
    socket.emitOpen();
    socket.emitMessage({
      version: PROTOCOL_VERSION,
      type: "client.targets",
      requestId: readSent(socket, 1).requestId,
      payload: { targets: [target] },
    });
    await flush();

    socket.emitMessage({
      version: PROTOCOL_VERSION,
      type: "client.targets",
      payload: { targets: [] },
    });
    await flush();

    expect(onTargets).toHaveBeenLastCalledWith([]);
    expect(onConnectionState).not.toHaveBeenCalledWith({ online: false, statusText: "Pi недоступен" });
    expect(onConnectionState).not.toHaveBeenCalledWith({ online: false, statusText: "Target is not available" });
    expect(onConnectionState).toHaveBeenLastCalledWith({ online: true, statusText: "Pi подключён" });
    expect(socket.sent).toHaveLength(2);
  });

  it("reports the bridge online only after the broker accepts client target listing", async () => {
    const socket = new FakeWebSocket();
    const onConnectionState = vi.fn();
    const client = new BrokerClient({
      browserToken: "browser-token-1",
      webSocketFactory: () => socket,
      onConnectionState,
      reconnectDelaysMs: [],
    });

    client.connect();
    socket.emitOpen();
    await flush();

    expect(onConnectionState).toHaveBeenCalledTimes(1);
    expect(onConnectionState).toHaveBeenLastCalledWith({ online: false, statusText: "Подключаемся к Pi…" });

    socket.emitMessage({
      version: PROTOCOL_VERSION,
      type: "client.targets",
      requestId: readSent(socket, 1).requestId,
      payload: { targets: [target] },
    });
    await flush();

    expect(onConnectionState).toHaveBeenLastCalledWith({ online: true, statusText: "Pi подключён" });
  });

  it("keeps the bridge online when a selected target becomes unavailable", async () => {
    const socket = new FakeWebSocket();
    const onConnectionState = vi.fn();
    const client = new BrokerClient({
      browserToken: "browser-token-1",
      selectedTargetId: "target-1",
      webSocketFactory: () => socket,
      onConnectionState,
      reconnectDelaysMs: [],
    });

    client.connect();
    socket.emitOpen();
    socket.emitMessage({
      version: PROTOCOL_VERSION,
      type: "client.targets",
      requestId: readSent(socket, 1).requestId,
      payload: { targets: [target] },
    });
    await flush();
    client.setSelectedTargetId("target-1");

    socket.emitMessage({
      version: PROTOCOL_VERSION,
      type: "client.error",
      requestId: readSent(socket, 2).requestId,
      payload: { error: "Target is not available" },
    });
    await flush();

    expect(onConnectionState).not.toHaveBeenCalledWith({ online: false, statusText: "Target is not available" });
    expect(onConnectionState).toHaveBeenLastCalledWith({ online: true, statusText: "Pi подключён" });
  });

  it("sends chat messages to the selected target", async () => {
    const socket = new FakeWebSocket();
    const client = new BrokerClient({
      browserToken: "browser-token-1",
      selectedTargetId: "target-1",
      webSocketFactory: () => socket,
      reconnectDelaysMs: [],
    });

    client.connect();
    socket.emitOpen();
    await flush();

    expect(client.sendChatMessage(" Привет ")).toBe(true);

    expect(readSent(socket, 2)).toEqual({
      version: PROTOCOL_VERSION,
      type: "client.sendChatMessage",
      requestId: expect.any(String),
      payload: {
        token: "browser-token-1",
        targetId: "target-1",
        message: "Привет",
      },
    });
  });

  it("forwards broker chat events to the caller", async () => {
    const socket = new FakeWebSocket();
    const onChatEvent = vi.fn();
    const client = new BrokerClient({
      browserToken: "browser-token-1",
      webSocketFactory: () => socket,
      onChatEvent,
      reconnectDelaysMs: [],
    });
    const chatEvent: ChatEvent = {
      kind: "assistant_text_delta",
      messageId: "message-1",
      delta: "Привет",
      timestamp: 1_710_000_000_000,
    };

    client.connect();
    socket.emitOpen();
    socket.emitMessage({
      version: PROTOCOL_VERSION,
      type: "client.chatEvent",
      payload: chatEvent,
    });
    await flush();

    expect(onChatEvent).toHaveBeenCalledWith(chatEvent);
  });

  it("ignores late open, target and chat events after close", async () => {
    const socket = new FakeWebSocket();
    const onTargets = vi.fn();
    const onChatEvent = vi.fn();
    const onConnectionState = vi.fn();
    const client = new BrokerClient({
      browserToken: "browser-token-1",
      webSocketFactory: () => socket,
      onTargets,
      onChatEvent,
      onConnectionState,
      reconnectDelaysMs: [],
    });
    const chatEvent: ChatEvent = {
      kind: "assistant_text_delta",
      messageId: "message-1",
      delta: "Привет",
      timestamp: 1_710_000_000_000,
    };

    client.connect();
    client.close();
    socket.emitError();
    socket.emitOpen();
    socket.emitMessage({
      version: PROTOCOL_VERSION,
      type: "client.targets",
      payload: { targets: [target] },
    });
    socket.emitMessage({
      version: PROTOCOL_VERSION,
      type: "client.chatEvent",
      payload: chatEvent,
    });
    await flush();

    expect(socket.sent).toEqual([]);
    expect(onTargets).not.toHaveBeenCalled();
    expect(onChatEvent).not.toHaveBeenCalled();
    expect(onConnectionState).toHaveBeenCalledTimes(1);
    expect(onConnectionState).toHaveBeenLastCalledWith({ online: false, statusText: "Подключаемся к Pi…" });
  });

  it("closes an active socket and ignores stale events when connect is called again", async () => {
    const sockets = [new FakeWebSocket(), new FakeWebSocket()];
    const onTargets = vi.fn();
    const webSocketFactory = vi.fn(() => sockets.shift() ?? new FakeWebSocket());
    const client = new BrokerClient({
      browserToken: "browser-token-1",
      webSocketFactory,
      onTargets,
      reconnectDelaysMs: [],
    });

    client.connect();
    const firstSocket = webSocketFactory.mock.results[0].value;
    client.connect();
    const secondSocket = webSocketFactory.mock.results[1].value;

    firstSocket.emitOpen();
    firstSocket.emitMessage({
      version: PROTOCOL_VERSION,
      type: "client.targets",
      payload: { targets: [target] },
    });
    secondSocket.emitOpen();
    await flush();

    expect(webSocketFactory).toHaveBeenCalledTimes(2);
    expect(firstSocket.closeCalls).toBe(1);
    expect(firstSocket.sent).toEqual([]);
    expect(secondSocket.sent).toHaveLength(2);
    expect(onTargets).not.toHaveBeenCalled();
  });

  it("closes the current socket after an error and reconnects after close", async () => {
    vi.useFakeTimers();
    const sockets = [new FakeWebSocket(), new FakeWebSocket()];
    const firstSocket = sockets[0];
    const webSocketFactory = vi.fn(() => sockets.shift() ?? new FakeWebSocket());
    const client = new BrokerClient({
      browserToken: "browser-token-1",
      webSocketFactory,
      reconnectDelaysMs: [25],
    });

    try {
      client.connect();
      firstSocket.emitOpen();
      firstSocket.emitError();
      await flush();

      expect(firstSocket.closeCalls).toBe(1);

      firstSocket.emitClose();
      await vi.advanceTimersByTimeAsync(25);
      await flush();

      expect(webSocketFactory).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("closes and reconnects when the initial broker handshake times out", async () => {
    vi.useFakeTimers();
    const sockets = [new FakeWebSocket(), new FakeWebSocket()];
    const firstSocket = sockets[0];
    const webSocketFactory = vi.fn(() => sockets.shift() ?? new FakeWebSocket());
    const client = new BrokerClient({
      browserToken: "browser-token-1",
      webSocketFactory,
      reconnectDelaysMs: [25],
      handshakeTimeoutMs: 50,
    });

    try {
      client.connect();
      firstSocket.emitOpen();
      await vi.advanceTimersByTimeAsync(50);
      await flush();

      expect(firstSocket.closeCalls).toBe(1);

      firstSocket.emitClose();
      await vi.advanceTimersByTimeAsync(25);
      await flush();

      expect(webSocketFactory).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not reconnect forever after browser authorization errors", async () => {
    vi.useFakeTimers();
    const socket = new FakeWebSocket();
    const webSocketFactory = vi.fn(() => socket);
    const onConnectionState = vi.fn();
    const client = new BrokerClient({
      browserToken: "browser-token-1",
      webSocketFactory,
      onConnectionState,
      reconnectDelaysMs: [25],
    });

    try {
      client.connect();
      socket.emitOpen();
      socket.emitMessage({
        version: PROTOCOL_VERSION,
        type: "client.error",
        requestId: readSent(socket, 0).requestId,
        payload: { error: "Браузер не авторизован в Pi" },
      });
      await flush();

      expect(onConnectionState).toHaveBeenLastCalledWith({ online: false, statusText: "Браузер не авторизован в Pi" });

      socket.emitClose();
      await vi.advanceTimersByTimeAsync(25);
      await flush();

      expect(webSocketFactory).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("surfaces connection state transitions during reconnect attempts", async () => {
    vi.useFakeTimers();
    const sockets = [new FakeWebSocket(), new FakeWebSocket()];
    const firstSocket = sockets[0];
    const webSocketFactory = vi.fn(() => sockets.shift() ?? new FakeWebSocket());
    const onConnectionState = vi.fn();
    const client = new BrokerClient({
      browserToken: "browser-token-1",
      webSocketFactory,
      onConnectionState,
      reconnectDelaysMs: [25],
    });

    try {
      client.connect();
      expect(onConnectionState).toHaveBeenLastCalledWith({ online: false, statusText: "Подключаемся к Pi…" });

      firstSocket.emitOpen();
      firstSocket.emitMessage({
        version: PROTOCOL_VERSION,
        type: "client.targets",
        requestId: readSent(firstSocket, 1).requestId,
        payload: { targets: [target] },
      });
      await flush();

      expect(onConnectionState).toHaveBeenLastCalledWith({ online: true, statusText: "Pi подключён" });

      firstSocket.emitClose();
      expect(onConnectionState).toHaveBeenLastCalledWith({ online: false, statusText: "Pi недоступен" });

      await vi.advanceTimersByTimeAsync(25);
      await flush();

      expect(webSocketFactory).toHaveBeenCalledTimes(2);
      expect(onConnectionState).toHaveBeenLastCalledWith({ online: false, statusText: "Подключаемся к Pi…" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels a pending reconnect timer when closed", async () => {
    vi.useFakeTimers();
    const sockets = [new FakeWebSocket(), new FakeWebSocket()];
    const firstSocket = sockets[0];
    const webSocketFactory = vi.fn(() => sockets.shift() ?? new FakeWebSocket());
    const client = new BrokerClient({
      browserToken: "browser-token-1",
      webSocketFactory,
      reconnectDelaysMs: [25],
    });

    try {
      client.connect();
      firstSocket.emitClose();
      client.close();
      await vi.advanceTimersByTimeAsync(25);
      await flush();

      expect(webSocketFactory).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
