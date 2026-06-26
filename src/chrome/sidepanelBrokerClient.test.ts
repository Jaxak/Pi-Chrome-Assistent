import { describe, expect, it, vi } from "vitest";

import { PROTOCOL_VERSION } from "../shared/constants";
import type { ChatEvent, ProtocolEnvelope, TargetMetadata } from "../shared/protocol";
import { SidePanelBrokerClient } from "./sidepanelBrokerClient";

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

describe("SidePanelBrokerClient", () => {
  it("authenticates and requests target list after opening the broker socket", async () => {
    const socket = new FakeWebSocket();
    const client = new SidePanelBrokerClient({
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

  it("publishes target list updates and subscribes to the selected target", async () => {
    const socket = new FakeWebSocket();
    const onTargets = vi.fn();
    const client = new SidePanelBrokerClient({
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
    expect(readSent(socket, 2)).toEqual({
      version: PROTOCOL_VERSION,
      type: "client.subscribeTarget",
      requestId: expect.any(String),
      payload: {
        token: "browser-token-1",
        targetId: "target-1",
      },
    });
  });

  it("reports the bridge online only after the broker accepts client target listing", async () => {
    const socket = new FakeWebSocket();
    const onConnectionState = vi.fn();
    const client = new SidePanelBrokerClient({
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
    const client = new SidePanelBrokerClient({
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
    const client = new SidePanelBrokerClient({
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
    const client = new SidePanelBrokerClient({
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

  it("ignores late socket events after the client is closed", async () => {
    const socket = new FakeWebSocket();
    const onConnectionState = vi.fn();
    const client = new SidePanelBrokerClient({
      browserToken: "browser-token-1",
      webSocketFactory: () => socket,
      onConnectionState,
      reconnectDelaysMs: [],
    });

    client.connect();
    client.close();

    socket.emitError();
    socket.emitOpen();
    socket.emitMessage({
      version: PROTOCOL_VERSION,
      type: "client.targets",
      payload: { targets: [target] },
    });
    await flush();

    expect(onConnectionState).toHaveBeenCalledTimes(1);
    expect(onConnectionState).toHaveBeenLastCalledWith({ online: false, statusText: "Подключаемся к Pi…" });
    expect(socket.sent).toEqual([]);
  });

  it("surfaces connection state and bounded reconnect attempts", async () => {
    vi.useFakeTimers();
    const sockets = [new FakeWebSocket(), new FakeWebSocket()];
    const firstSocket = sockets[0];
    const onConnectionState = vi.fn();
    const client = new SidePanelBrokerClient({
      browserToken: "browser-token-1",
      webSocketFactory: vi.fn(() => sockets.shift() ?? new FakeWebSocket()),
      onConnectionState,
      reconnectDelaysMs: [25],
    });

    try {
      client.connect();
      expect(onConnectionState).toHaveBeenCalledWith({ online: false, statusText: "Подключаемся к Pi…" });
      firstSocket.emitClose();
      await vi.advanceTimersByTimeAsync(25);
      await flush();

      expect(onConnectionState).toHaveBeenCalledWith({ online: false, statusText: "Pi недоступен" });
    } finally {
      vi.useRealTimers();
    }
  });
});
