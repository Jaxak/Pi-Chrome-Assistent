import { describe, expect, it, vi } from "vitest";

import { PROTOCOL_VERSION } from "../shared/constants";
import type { ChatEvent, ProtocolEnvelope, TargetMetadata } from "../shared/protocol";
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

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function sentTypes(socket: FakeWebSocket): string[] {
  return socket.sent.map((message) => JSON.parse(message).type as string);
}

describe("BrokerClient", () => {
  it("ignores late open, target and chat events after close", async () => {
    const socket = new FakeWebSocket();
    const onTargets = vi.fn();
    const onChatEvent = vi.fn();
    const client = new BrokerClient({
      browserToken: "browser-token-1",
      webSocketFactory: () => socket,
      onTargets,
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
    client.close();
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

  it("does not subscribe from a targets update until background explicitly sets selection", async () => {
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

    expect(sentTypes(socket)).toEqual(["client.hello", "client.listTargets"]);

    client.setSelectedTargetId("target-1");

    expect(sentTypes(socket)).toEqual(["client.hello", "client.listTargets", "client.subscribeTarget"]);
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
