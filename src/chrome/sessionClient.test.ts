import { describe, expect, it, vi } from "vitest";

import { PROTOCOL_VERSION } from "../shared/constants";
import type { DirectSessionSnapshot, PiMirrorEvent, ProtocolEnvelope } from "../shared/protocol";
import { SessionClient, type SessionClientOptions } from "./sessionClient";

type SocketEventName = "open" | "message" | "error" | "close";
type SocketEventListener = (event?: { data?: string }) => void;

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 3;

  readonly url: string | undefined;
  readonly sent: string[] = [];
  readonly listeners = new Map<SocketEventName, Set<SocketEventListener>>();
  readyState = FakeWebSocket.CONNECTING;
  closeCalls = 0;

  constructor(url?: string) {
    this.url = url;
  }

  addEventListener(eventName: SocketEventName, listener: SocketEventListener): void {
    const listeners = this.listeners.get(eventName) ?? new Set<SocketEventListener>();
    listeners.add(listener);
    this.listeners.set(eventName, listeners);
  }

  removeEventListener(eventName: SocketEventName, listener: SocketEventListener): void {
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

  private emit(eventName: SocketEventName, event?: { data?: string }): void {
    for (const listener of this.listeners.get(eventName) ?? []) {
      listener(event);
    }
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

function readSent<TPayload = unknown>(socket: FakeWebSocket, index: number): ProtocolEnvelope<TPayload> {
  return JSON.parse(socket.sent[index] ?? "{}");
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("SessionClient", () => {
  it("connects to ws://127.0.0.1:<port>", () => {
    const socket = new FakeWebSocket();
    const client = new SessionClient({
      
      port: 31415,
      webSocketFactory: (url) => {
        expect(url).toBe("ws://127.0.0.1:31415");
        return socket;
      },
      onSnapshot: vi.fn(),
      onConnectionState: vi.fn(),
    });

    client.connect();
    expect(socket.readyState).toBe(FakeWebSocket.CONNECTING);
  });

  it("reports connecting state on connect", () => {
    const onConnectionState = vi.fn();
    const socket = new FakeWebSocket();
    new SessionClient({
      
      port: 31415,
      webSocketFactory: () => socket,
      onSnapshot: vi.fn(),
      onConnectionState,
    }).connect();

    expect(onConnectionState).toHaveBeenCalledWith({
      online: false,
      connecting: true,
      statusText: "Подключаемся к Pi-сессии…",
    });
  });

  it("reports online after receiving session.snapshot", async () => {
    const socket = new FakeWebSocket();
    const onSnapshot = vi.fn();
    const onConnectionState = vi.fn();
    const snapshot = createSnapshot();
    const client = new SessionClient({
      
      port: 31415,
      webSocketFactory: () => socket,
      onSnapshot,
      onConnectionState,
    });

    client.connect();
    socket.emitOpen();
    socket.emitMessage({ version: PROTOCOL_VERSION, type: "session.snapshot", payload: snapshot });
    await flush();

    expect(onSnapshot).toHaveBeenCalledWith(snapshot);
    expect(onConnectionState).toHaveBeenCalledWith({
      online: true,
      connecting: false,
      statusText: "Подключено к Pi-сессии",
    });
  });

  it("sends session.chat.send without targetId", async () => {
    const socket = new FakeWebSocket();
    const client = new SessionClient({
      
      port: 31415,
      webSocketFactory: () => socket,
      onSnapshot: vi.fn(),
      onConnectionState: vi.fn(),
    });

    client.connect();
    socket.emitOpen();
    const sent = client.sendChatMessage(" Привет ");

    expect(sent).toBe(true);
    expect(readSent(socket, 0)).toMatchObject({
      version: PROTOCOL_VERSION,
      type: "session.chat.send",
      payload: { message: "Привет" },
    });
  });

  it("sends session.selection.send", async () => {
    const socket = new FakeWebSocket();
    const client = new SessionClient({
      
      port: 31415,
      webSocketFactory: () => socket,
      onSnapshot: vi.fn(),
      onConnectionState: vi.fn(),
    });

    client.connect();
    socket.emitOpen();
    const sent = client.sendSelection({
      url: "https://example.com",
      title: "Example",
      selectedText: "hello",
      selectedHtml: "<p>hello</p>",
      capturedAt: 1_710_000_000_000,
    });

    expect(sent).toBe(true);
    expect(readSent(socket, 0)).toMatchObject({
      version: PROTOCOL_VERSION,
      type: "session.selection.send",
      payload: {
        selection: {
          url: "https://example.com",
          title: "Example",
          selectedText: "hello",
          selectedHtml: "<p>hello</p>",
          capturedAt: 1_710_000_000_000,
        },
      },
    });
  });

  it("sends session.model.set without targetId", async () => {
    const socket = new FakeWebSocket();
    const client = new SessionClient({
      
      port: 31415,
      webSocketFactory: () => socket,
      onSnapshot: vi.fn(),
      onConnectionState: vi.fn(),
    });

    client.connect();
    socket.emitOpen();
    const sent = client.setModel({ provider: "anthropic", modelId: "claude-sonnet" });

    expect(sent).toBe(true);
    expect(readSent(socket, 0)).toMatchObject({
      version: PROTOCOL_VERSION,
      type: "session.model.set",
      payload: { provider: "anthropic", modelId: "claude-sonnet" },
    });
  });

  it("returns false when sending while not connected", () => {
    const socket = new FakeWebSocket();
    const client = new SessionClient({
      
      port: 31415,
      webSocketFactory: () => socket,
      onSnapshot: vi.fn(),
      onConnectionState: vi.fn(),
    });

    client.connect();
    // Don't emitOpen — socket is still CONNECTING
    expect(client.sendChatMessage("Hello")).toBe(false);
    expect(client.sendSelection({
      url: "https://example.com",
      title: "Test",
      selectedText: "text",
      selectedHtml: "<p>text</p>",
      capturedAt: 1_710_000_000_000,
    })).toBe(false);
    expect(client.setModel({ provider: "anthropic", modelId: "claude-sonnet" })).toBe(false);
  });

  it("reconnects to a new port with reconnectToPort", async () => {
    const sockets = [new FakeWebSocket(), new FakeWebSocket()];
    let socketIndex = 0;
    const onConnectionState = vi.fn();
    const client = new SessionClient({
      
      port: 31415,
      webSocketFactory: (url) => {
        expect(url).toBe(`ws://127.0.0.1:${socketIndex === 0 ? 31415 : 31416}`);
        return sockets[socketIndex++];
      },
      onSnapshot: vi.fn(),
      onConnectionState,
    });

    client.connect();
    sockets[0].emitOpen();
    await flush();

    client.reconnectToPort(31416);

    expect(sockets[0].closeCalls).toBe(1);
    expect(sockets[1].readyState).toBe(FakeWebSocket.CONNECTING);
    expect(onConnectionState).toHaveBeenLastCalledWith({
      online: false,
      connecting: true,
      statusText: "Подключаемся к Pi-сессии…",
    });
  });

  it("reports offline and reconnects after close event with backoff", async () => {
    vi.useFakeTimers();
    try {
      const sockets = [new FakeWebSocket(), new FakeWebSocket()];
      let socketIndex = 0;
      const webSocketFactory = vi.fn(() => sockets[socketIndex++]);
      const onConnectionState = vi.fn();
      const client = new SessionClient({
      
        port: 31415,
        webSocketFactory,
        onSnapshot: vi.fn(),
        onConnectionState,
        reconnectDelaysMs: [50],
      });

      client.connect();
      sockets[0].emitOpen();
      await flush();
      sockets[0].emitMessage({ version: PROTOCOL_VERSION, type: "session.snapshot", payload: createSnapshot() });
      await flush();

      expect(onConnectionState).toHaveBeenLastCalledWith({
        online: true,
        connecting: false,
        statusText: "Подключено к Pi-сессии",
      });

      sockets[0].emitClose();
      await flush();

      expect(onConnectionState).toHaveBeenLastCalledWith({
        online: false,
        connecting: false,
        statusText: "Pi-сессия недоступна",
      });

      await vi.advanceTimersByTimeAsync(50);
      await flush();

      expect(webSocketFactory).toHaveBeenCalledTimes(2);
      expect(onConnectionState).toHaveBeenLastCalledWith({
        online: false,
        connecting: true,
        statusText: "Подключаемся к Pi-сессии…",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels reconnect timer when closed", async () => {
    vi.useFakeTimers();
    try {
      const sockets = [new FakeWebSocket(), new FakeWebSocket()];
      let socketIndex = 0;
      const webSocketFactory = vi.fn(() => sockets[socketIndex++]);
      const client = new SessionClient({
      
        port: 31415,
        webSocketFactory,
        onSnapshot: vi.fn(),
        onConnectionState: vi.fn(),
        reconnectDelaysMs: [50],
      });

      client.connect();
      sockets[0].emitClose();
      client.close();
      await vi.advanceTimersByTimeAsync(50);
      await flush();

      expect(webSocketFactory).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("ignores messages after close", async () => {
    const socket = new FakeWebSocket();
    const onSnapshot = vi.fn();
    const client = new SessionClient({
      
      port: 31415,
      webSocketFactory: () => socket,
      onSnapshot,
      onConnectionState: vi.fn(),
    });

    client.connect();
    client.close();
    socket.emitOpen();
    socket.emitMessage({ version: PROTOCOL_VERSION, type: "session.snapshot", payload: createSnapshot() });
    await flush();

    expect(onSnapshot).not.toHaveBeenCalled();
  });

  it("handles session.error message", async () => {
    const socket = new FakeWebSocket();
    const onConnectionState = vi.fn();
    new SessionClient({
      
      port: 31415,
      webSocketFactory: () => socket,
      onSnapshot: vi.fn(),
      onConnectionState,
    }).connect();
    socket.emitOpen();
    socket.emitMessage({
      version: PROTOCOL_VERSION,
      type: "session.error",
      payload: { error: "Неверный запрос" },
    });
    await flush();

    expect(onConnectionState).toHaveBeenLastCalledWith({
      online: false,
      connecting: false,
      statusText: "Неверный запрос",
    });
  });

  it("handles session.command.result", async () => {
    const socket = new FakeWebSocket();
    const onCommandResult = vi.fn();
    new SessionClient({
      
      port: 31415,
      webSocketFactory: () => socket,
      onSnapshot: vi.fn(),
      onConnectionState: vi.fn(),
      onCommandResult,
    }).connect();
    socket.emitOpen();
    socket.emitMessage({
      version: PROTOCOL_VERSION,
      type: "session.command.result",
      requestId: "req-1",
      payload: { ok: true },
    });
    await flush();

    expect(onCommandResult).toHaveBeenCalledWith({
      requestId: "req-1",
      result: { ok: true },
    });
  });

  it("does not reconnect on socket error when connection was never established", async () => {
    vi.useFakeTimers();
    try {
      const sockets = [new FakeWebSocket(), new FakeWebSocket()];
      let socketIndex = 0;
      const webSocketFactory = vi.fn(() => sockets[socketIndex++]);
      const firstSocket = sockets[0];
      const onConnectionState = vi.fn();
      const client = new SessionClient({
      
        port: 31415,
        webSocketFactory,
        onSnapshot: vi.fn(),
        onConnectionState,
        reconnectDelaysMs: [25],
        idleTimeoutMs: 0,
      });

      client.connect();
      firstSocket.emitOpen();
      // No snapshot — everConnected stays false
      firstSocket.emitError();
      await flush();

      expect(firstSocket.closeCalls).toBe(1);

      firstSocket.emitClose();
      await flush();

      // No reconnect should be scheduled because everConnected is false
      await vi.advanceTimersByTimeAsync(100);
      await flush();

      expect(webSocketFactory).toHaveBeenCalledTimes(1);
      expect(onConnectionState).toHaveBeenLastCalledWith({
        online: false,
        connecting: false,
        statusText: 'Pi-сессия не найдена на порту 31415. Запустите Pi и нажмите «Подключить».',
      });
    } finally {
      vi.useRealTimers();
    }
  });

  // ─── Bounded backoff / retry-counter tests ───

  it("bounded backoff ramps up delays across consecutive closes after snapshot", async () => {
    vi.useFakeTimers();
    try {
      const sockets: FakeWebSocket[] = [];
      const webSocketFactory = vi.fn(() => {
        const socket = new FakeWebSocket();
        sockets.push(socket);
        return socket;
      });
      const client = new SessionClient({
      
        port: 31415,
        webSocketFactory,
        onSnapshot: vi.fn(),
        onConnectionState: vi.fn(),
        reconnectDelaysMs: [50, 100, 200],
        idleTimeoutMs: 0,
      });

      client.connect();
      sockets[0]!.emitOpen();
      // Send snapshot — everConnected = true
      sockets[0]!.emitMessage({ version: PROTOCOL_VERSION, type: "session.snapshot", payload: createSnapshot() });
      await flush();

      // Close #1 → reconnect at delay[0]=50
      sockets[0]!.emitClose();
      await flush();

      await vi.advanceTimersByTimeAsync(50);
      await flush();
      expect(webSocketFactory).toHaveBeenCalledTimes(2);
      sockets[1]!.emitOpen();
      // No snapshot — counter keeps incrementing

      // Close #2 → reconnect at delay[1]=100 (ramped up)
      sockets[1]!.emitClose();
      await flush();

      // After 60ms — should NOT have reconnected yet (100ms delay)
      await vi.advanceTimersByTimeAsync(60);
      await flush();
      expect(webSocketFactory).toHaveBeenCalledTimes(2);

      // After another 40ms (total 100ms from close #2) — should reconnect
      await vi.advanceTimersByTimeAsync(40);
      await flush();
      expect(webSocketFactory).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reconnectAttempt is NOT reset after open without snapshot but IS reset after snapshot", async () => {
    vi.useFakeTimers();
    try {
      const sockets: FakeWebSocket[] = [];
      const webSocketFactory = vi.fn(() => {
        const socket = new FakeWebSocket();
        sockets.push(socket);
        return socket;
      });
      const client = new SessionClient({
      
        port: 31415,
        webSocketFactory,
        onSnapshot: vi.fn(),
        onConnectionState: vi.fn(),
        reconnectDelaysMs: [50, 100, 200],
        idleTimeoutMs: 0,
      });

      client.connect();
      sockets[0]!.emitOpen();
      sockets[0]!.emitMessage({ version: PROTOCOL_VERSION, type: "session.snapshot", payload: createSnapshot() });
      await flush();
      // everConnected = true, reconnectAttempt = 0

      // Disconnect
      sockets[0]!.emitClose();
      await flush();

      // advance 50ms → reconnect #1
      await vi.advanceTimersByTimeAsync(50);
      await flush();
      expect(webSocketFactory).toHaveBeenCalledTimes(2);
      sockets[1]!.emitOpen();
      // open fired but NO snapshot — counter must NOT reset
      sockets[1]!.emitClose();
      await flush();

      // Counter was 0→1 after reconnect #1, now at 1, so delay = reconnectDelaysMs[1] = 100ms
      // Advance only 50ms — should NOT reconnect if counter persisted.
      await vi.advanceTimersByTimeAsync(50);
      await flush();
      expect(webSocketFactory).toHaveBeenCalledTimes(2);

      // Advance another 50ms (total 100ms from close #2) — should reconnect
      await vi.advanceTimersByTimeAsync(50);
      await flush();
      expect(webSocketFactory).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reconnectAttempt resets after successful snapshot", async () => {
    vi.useFakeTimers();
    try {
      const sockets: FakeWebSocket[] = [];
      const webSocketFactory = vi.fn(() => {
        const socket = new FakeWebSocket();
        sockets.push(socket);
        return socket;
      });
      const client = new SessionClient({
      
        port: 31415,
        webSocketFactory,
        onSnapshot: vi.fn(),
        onConnectionState: vi.fn(),
        reconnectDelaysMs: [50, 100, 200],
      });

      client.connect();
      sockets[0]!.emitOpen();
      sockets[0]!.emitMessage({ version: PROTOCOL_VERSION, type: "session.snapshot", payload: createSnapshot() });
      await flush();

      // Disconnect after successful snapshot
      sockets[0]!.emitClose();
      await flush();

      // Counter was reset by snapshot, so first reconnect delay = 50ms
      await vi.advanceTimersByTimeAsync(50);
      await flush();
      expect(webSocketFactory).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reconnect after 3+ consecutive closes uses correct bounded delays (with max cap)", async () => {
    vi.useFakeTimers();
    try {
      const sockets: FakeWebSocket[] = [];
      const webSocketFactory = vi.fn(() => {
        const socket = new FakeWebSocket();
        sockets.push(socket);
        return socket;
      });
      const onConnectionState = vi.fn();
      const delays = [10, 20, 30, 40, 50];
      const client = new SessionClient({
      
        port: 31415,
        webSocketFactory,
        onSnapshot: vi.fn(),
        onConnectionState,
        reconnectDelaysMs: delays,
        idleTimeoutMs: 0,
      });

      client.connect();
      sockets[0]!.emitOpen();
      // Send snapshot — everConnected = true
      sockets[0]!.emitMessage({ version: PROTOCOL_VERSION, type: "session.snapshot", payload: createSnapshot() });
      await flush();

      // 5 consecutive close+reconnect cycles, each getting a snapshot to keep resetting counter
      // Actually: we want to test the bounded cap of MAX_RECONNECT_ATTEMPTS
      // Close 5 times without snapshots → should hit the cap
      sockets[0]!.emitClose();
      await flush();

      // Reconnect attempts: 0→1 (delay[0]=10), 1→2 (delay[1]=20), 2→3 (delay[2]=30), 3→4 (delay[3]=40), 4→5 (delay[4]=50)
      // After 5th attempt (reconnectAttempt=5 >= MAX_RECONNECT_ATTEMPTS), no more reconnect
      for (let i = 0; i < 5; i++) {
        const expectedDelay = delays[i]!;
        await vi.advanceTimersByTimeAsync(expectedDelay);
        await flush();
        expect(webSocketFactory).toHaveBeenCalledTimes(i + 2);
        sockets[i + 1]!.emitOpen();
        // No snapshot — everConnected stays true but counter increments
        sockets[i + 1]!.emitClose();
        await flush();
      }

      // After 5th reconnect attempt, reconnectAttempt = 5 >= MAX_RECONNECT_ATTEMPTS
      // No 6th reconnect should happen
      await vi.advanceTimersByTimeAsync(100);
      await flush();
      expect(webSocketFactory).toHaveBeenCalledTimes(6);
      expect(onConnectionState).toHaveBeenLastCalledWith({
        online: false,
        connecting: false,
        statusText: 'Соединение с Pi потеряно. Нажмите «Подключить» для восстановления.',
      });
    } finally {
      vi.useRealTimers();
    }
  });

  // ─── session.event tests ───

  it("delivers session.event payload to onSessionEvent callback", async () => {
    const socket = new FakeWebSocket();
    const onSessionEvent = vi.fn();
    const client = new SessionClient({
      
      port: 31415,
      webSocketFactory: () => socket,
      onSnapshot: vi.fn(),
      onConnectionState: vi.fn(),
      onSessionEvent,
    });

    client.connect();
    socket.emitOpen();

    const mirrorEvent: PiMirrorEvent = {
      type: "message_start",
      message: { id: "msg-1", role: "user" },
    };
    socket.emitMessage({ version: PROTOCOL_VERSION, type: "session.event", payload: mirrorEvent });
    await flush();

    expect(onSessionEvent).toHaveBeenCalledWith(mirrorEvent);
  });

  it("delivers session.event for all PiMirrorEvent variants", async () => {
    const socket = new FakeWebSocket();
    const onSessionEvent = vi.fn();
    const client = new SessionClient({
      
      port: 31415,
      webSocketFactory: () => socket,
      onSnapshot: vi.fn(),
      onConnectionState: vi.fn(),
      onSessionEvent,
    });

    client.connect();
    socket.emitOpen();

    const events: PiMirrorEvent[] = [
      { type: "message_start", message: { id: "m1", role: "user" } },
      { type: "message_update", message: { id: "m2", role: "assistant" }, assistantMessageEvent: { type: "text_delta", text_delta: "Hello" } },
      { type: "message_end", message: { id: "m2", role: "assistant" }, stopReason: "end_turn" },
      { type: "turn_start", turnId: "t1" },
      { type: "turn_end", turnId: "t1" },
      { type: "tool_execution_start", toolName: "read_file", input: { path: "foo.ts" } },
      { type: "tool_execution_update", toolName: "read_file", output: { content: "code" } },
      { type: "tool_execution_end", toolName: "read_file", output: { size: 42 } },
      { type: "model_select", provider: "openai", modelId: "gpt-4" },
    ];

    for (const evt of events) {
      socket.emitMessage({ version: PROTOCOL_VERSION, type: "session.event", payload: evt });
    }
    await flush();

    expect(onSessionEvent).toHaveBeenCalledTimes(events.length);
    for (let i = 0; i < events.length; i++) {
      expect(onSessionEvent).toHaveBeenNthCalledWith(i + 1, events[i]);
    }
  });

  it("session.event does NOT call onSessionEvent when callback is not provided", async () => {
    const socket = new FakeWebSocket();
    const client = new SessionClient({
      
      port: 31415,
      webSocketFactory: () => socket,
      onSnapshot: vi.fn(),
      onConnectionState: vi.fn(),
    });

    client.connect();
    socket.emitOpen();

    const mirrorEvent: PiMirrorEvent = {
      type: "turn_start",
      turnId: "t1",
    };
    // Should not throw
    socket.emitMessage({ version: PROTOCOL_VERSION, type: "session.event", payload: mirrorEvent });
    await flush();
  });

  it("session.snapshot still updates connection state alongside session.event", async () => {
    const socket = new FakeWebSocket();
    const onSnapshot = vi.fn();
    const onConnectionState = vi.fn();
    const onSessionEvent = vi.fn();
    const snapshot = createSnapshot();
    const client = new SessionClient({
      
      port: 31415,
      webSocketFactory: () => socket,
      onSnapshot,
      onConnectionState,
      onSessionEvent,
    });

    client.connect();
    socket.emitOpen();

    // Send snapshot first
    socket.emitMessage({ version: PROTOCOL_VERSION, type: "session.snapshot", payload: snapshot });
    await flush();

    expect(onSnapshot).toHaveBeenCalledWith(snapshot);
    expect(onConnectionState).toHaveBeenCalledWith({
      online: true,
      connecting: false,
      statusText: "Подключено к Pi-сессии",
    });

    // Then send a session.event — snapshot callback must NOT be called again
    const mirrorEvent: PiMirrorEvent = { type: "message_start", message: { id: "m1", role: "user" } };
    socket.emitMessage({ version: PROTOCOL_VERSION, type: "session.event", payload: mirrorEvent });
    await flush();

    expect(onSessionEvent).toHaveBeenCalledWith(mirrorEvent);
    expect(onSnapshot).toHaveBeenCalledTimes(1); // still only once
  });

  it("reconnect still works after receiving session.event", async () => {
    vi.useFakeTimers();
    try {
      const sockets = [new FakeWebSocket(), new FakeWebSocket()];
      let socketIndex = 0;
      const webSocketFactory = vi.fn(() => sockets[socketIndex++]);
      const onSessionEvent = vi.fn();
      const onConnectionState = vi.fn();
      const client = new SessionClient({
      
        port: 31415,
        webSocketFactory,
        onSnapshot: vi.fn(),
        onConnectionState,
        onSessionEvent,
        reconnectDelaysMs: [50],
      });

      client.connect();
      sockets[0]!.emitOpen();
      await flush();
      sockets[0]!.emitMessage({ version: PROTOCOL_VERSION, type: "session.snapshot", payload: createSnapshot() });
      await flush();

      // Receive a session.event while connected
      const mirrorEvent: PiMirrorEvent = { type: "message_start", message: { id: "m1", role: "user" } };
      sockets[0]!.emitMessage({ version: PROTOCOL_VERSION, type: "session.event", payload: mirrorEvent });
      await flush();
      expect(onSessionEvent).toHaveBeenCalledWith(mirrorEvent);

      // Now close — reconnect should work normally
      sockets[0]!.emitClose();
      await flush();

      expect(onConnectionState).toHaveBeenLastCalledWith({
        online: false,
        connecting: false,
        statusText: "Pi-сессия недоступна",
      });

      await vi.advanceTimersByTimeAsync(50);
      await flush();

      expect(webSocketFactory).toHaveBeenCalledTimes(2);
      expect(onConnectionState).toHaveBeenLastCalledWith({
        online: false,
        connecting: true,
        statusText: "Подключаемся к Pi-сессии…",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  // ─── Reconnect persistence tests ───

  it("stops reconnecting after MAX_RECONNECT_ATTEMPTS (no snapshot on reconnects)", async () => {
    vi.useFakeTimers();
    try {
      const sockets: FakeWebSocket[] = [];
      const webSocketFactory = vi.fn(() => {
        const socket = new FakeWebSocket();
        sockets.push(socket);
        return socket;
      });
      const onConnectionState = vi.fn();
      const delays = [10, 20, 30, 40, 50];
      const client = new SessionClient({
      
        port: 31415,
        webSocketFactory,
        onSnapshot: vi.fn(),
        onConnectionState,
        reconnectDelaysMs: delays,
        idleTimeoutMs: 0,
      });

      client.connect();
      sockets[0]!.emitOpen();
      sockets[0]!.emitMessage({ version: PROTOCOL_VERSION, type: "session.snapshot", payload: createSnapshot() });
      await flush();

      // Close 5 times — should trigger up to 5 reconnects then stop
      sockets[0]!.emitClose();
      await flush();

      for (let i = 0; i < 5; i++) {
        await vi.advanceTimersByTimeAsync(delays[i]!);
        await flush();
        expect(webSocketFactory).toHaveBeenCalledTimes(i + 2);
        sockets[i + 1]!.emitOpen();
        sockets[i + 1]!.emitClose();
        await flush();
      }

      // No more reconnects after 5th attempt
      await vi.advanceTimersByTimeAsync(200);
      await flush();
      expect(webSocketFactory).toHaveBeenCalledTimes(6);
      expect(onConnectionState).toHaveBeenLastCalledWith({
        online: false,
        connecting: false,
        statusText: 'Соединение с Pi потеряно. Нажмите «Подключить» для восстановления.',
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("resets retry counter after successful reconnect and snapshot", async () => {
    vi.useFakeTimers();
    try {
      const sockets: FakeWebSocket[] = [];
      const webSocketFactory = vi.fn(() => {
        const socket = new FakeWebSocket();
        sockets.push(socket);
        return socket;
      });
      const onConnectionState = vi.fn();
      const client = new SessionClient({
      
        port: 31415,
        webSocketFactory,
        onSnapshot: vi.fn(),
        onConnectionState,
        reconnectDelaysMs: [50, 100, 200],
      });

      client.connect();
      sockets[0]!.emitOpen();
      sockets[0]!.emitMessage({ version: PROTOCOL_VERSION, type: "session.snapshot", payload: createSnapshot() });
      await flush();

      // Disconnect
      sockets[0]!.emitClose();
      await flush();

      // Reconnect after 50ms delay
      await vi.advanceTimersByTimeAsync(50);
      await flush();
      expect(webSocketFactory).toHaveBeenCalledTimes(2);

      // Socket #1 connects successfully
      sockets[1]!.emitOpen();
      sockets[1]!.emitMessage({ version: PROTOCOL_VERSION, type: "session.snapshot", payload: createSnapshot() });
      await flush();

      expect(onConnectionState).toHaveBeenLastCalledWith({
        online: true,
        connecting: false,
        statusText: "Подключено к Pi-сессии",
      });

      // Now disconnect again — should use the first delay (50ms) since counter was reset
      sockets[1]!.emitClose();
      await flush();

      // If counter was NOT reset, delay would be 100ms (attempt #2). Since it IS reset, delay is 50ms.
      await vi.advanceTimersByTimeAsync(50);
      await flush();

      expect(webSocketFactory).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reconnects to the new port after reconnectToPort when socket closes (with snapshot)", async () => {
    vi.useFakeTimers();
    try {
      const sockets = [new FakeWebSocket(), new FakeWebSocket(), new FakeWebSocket()];
      let socketIndex = 0;
      const urlsCalled: string[] = [];
      const webSocketFactory = vi.fn((url: string) => {
        urlsCalled.push(url);
        return sockets[socketIndex++];
      });
      const client = new SessionClient({
      
        port: 31415,
        webSocketFactory,
        onSnapshot: vi.fn(),
        onConnectionState: vi.fn(),
        reconnectDelaysMs: [50],
        idleTimeoutMs: 0,
      });

      // Initial connect to 31415
      client.connect();
      sockets[0].emitOpen();
      await flush();
      expect(urlsCalled[0]).toBe("ws://127.0.0.1:31415");

      // Reconnect to new port 31416
      client.reconnectToPort(31416);
      sockets[1].emitOpen();
      // Must send snapshot on the NEW port's socket to set everConnected=true
      sockets[1].emitMessage({ version: PROTOCOL_VERSION, type: "session.snapshot", payload: createSnapshot() });
      await flush();
      expect(urlsCalled[1]).toBe("ws://127.0.0.1:31416");

      // Close the connection to 31416 — reconnect should target 31416, not 31415
      sockets[1].emitClose();
      await flush();

      await vi.advanceTimersByTimeAsync(50);
      await flush();

      // The reconnection must go to 31416, NOT back to the original 31415
      expect(urlsCalled[2]).toBe("ws://127.0.0.1:31416");
    } finally {
      vi.useRealTimers();
    }
  });

  // ─── everConnected / no-auto-reconnect tests ───

  it("does not reconnect when connection was never established", async () => {
    vi.useFakeTimers();
    try {
      const sockets: FakeWebSocket[] = [];
      const webSocketFactory = vi.fn(() => {
        const socket = new FakeWebSocket();
        sockets.push(socket);
        return socket;
      });
      const onConnectionState = vi.fn();
      const client = new SessionClient({
      
        port: 31415,
        webSocketFactory,
        onSnapshot: vi.fn(),
        onConnectionState,
        reconnectDelaysMs: [50],
        idleTimeoutMs: 0,
      });

      client.connect();
      sockets[0]!.emitOpen();
      // No snapshot — everConnected stays false
      sockets[0]!.emitClose();
      await flush();

      // No reconnect timer should be scheduled
      await vi.advanceTimersByTimeAsync(200);
      await flush();

      expect(webSocketFactory).toHaveBeenCalledTimes(1);
      expect(onConnectionState).toHaveBeenLastCalledWith({
        online: false,
        connecting: false,
        statusText: 'Pi-сессия не найдена на порту 31415. Запустите Pi и нажмите «Подключить».',
      });
    } finally {
      vi.useRealTimers();
    }
  });

  // ─── Idle timeout tests ───

  it("idle timeout closes connection after inactivity", async () => {
    vi.useFakeTimers();
    try {
      const sockets: FakeWebSocket[] = [];
      const webSocketFactory = vi.fn(() => {
        const socket = new FakeWebSocket();
        sockets.push(socket);
        return socket;
      });
      const onConnectionState = vi.fn();
      const client = new SessionClient({
      
        port: 31415,
        webSocketFactory,
        onSnapshot: vi.fn(),
        onConnectionState,
        reconnectDelaysMs: [50],
        idleTimeoutMs: 5000,
      });

      client.connect();
      sockets[0]!.emitOpen();
      sockets[0]!.emitMessage({ version: PROTOCOL_VERSION, type: "session.snapshot", payload: createSnapshot() });
      await flush();

      expect(onConnectionState).toHaveBeenLastCalledWith({
        online: true,
        connecting: false,
        statusText: "Подключено к Pi-сессии",
      });

      // Advance to just before idle timeout — should still be connected
      await vi.advanceTimersByTimeAsync(4999);
      await flush();
      expect(onConnectionState).toHaveBeenLastCalledWith({
        online: true,
        connecting: false,
        statusText: "Подключено к Pi-сессии",
      });

      // Advance past idle timeout — connection should close
      await vi.advanceTimersByTimeAsync(2);
      await flush();

      expect(onConnectionState).toHaveBeenLastCalledWith({
        online: false,
        connecting: false,
        statusText: 'Сессия неактивна. Нажмите «Подключить» для восстановления.',
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("idle timer resets on incoming session.event", async () => {
    vi.useFakeTimers();
    try {
      const sockets: FakeWebSocket[] = [];
      const webSocketFactory = vi.fn(() => {
        const socket = new FakeWebSocket();
        sockets.push(socket);
        return socket;
      });
      const onConnectionState = vi.fn();
      const client = new SessionClient({
      
        port: 31415,
        webSocketFactory,
        onSnapshot: vi.fn(),
        onConnectionState,
        reconnectDelaysMs: [50],
        idleTimeoutMs: 5000,
      });

      client.connect();
      sockets[0]!.emitOpen();
      sockets[0]!.emitMessage({ version: PROTOCOL_VERSION, type: "session.snapshot", payload: createSnapshot() });
      await flush();

      // Advance 3000ms, then send a session.event — should reset idle timer
      await vi.advanceTimersByTimeAsync(3000);
      await flush();
      const mirrorEvent: PiMirrorEvent = { type: "turn_start", turnId: "t1" };
      sockets[0]!.emitMessage({ version: PROTOCOL_VERSION, type: "session.event", payload: mirrorEvent });
      await flush();

      // Still connected — idle timer was reset
      expect(onConnectionState).toHaveBeenLastCalledWith({
        online: true,
        connecting: false,
        statusText: "Подключено к Pi-сессии",
      });

      // Advance 4999ms from the session.event — still connected
      await vi.advanceTimersByTimeAsync(4999);
      await flush();
      expect(onConnectionState).toHaveBeenLastCalledWith({
        online: true,
        connecting: false,
        statusText: "Подключено к Pi-сессии",
      });

      // Advance past idle timeout from session.event — should disconnect
      await vi.advanceTimersByTimeAsync(2);
      await flush();
      expect(onConnectionState).toHaveBeenLastCalledWith({
        online: false,
        connecting: false,
        statusText: 'Сессия неактивна. Нажмите «Подключить» для восстановления.',
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("idle timer resets on incoming session.command.result", async () => {
    vi.useFakeTimers();
    try {
      const sockets: FakeWebSocket[] = [];
      const webSocketFactory = vi.fn(() => {
        const socket = new FakeWebSocket();
        sockets.push(socket);
        return socket;
      });
      const onConnectionState = vi.fn();
      const client = new SessionClient({
      
        port: 31415,
        webSocketFactory,
        onSnapshot: vi.fn(),
        onConnectionState,
        reconnectDelaysMs: [50],
        idleTimeoutMs: 5000,
      });

      client.connect();
      sockets[0]!.emitOpen();
      sockets[0]!.emitMessage({ version: PROTOCOL_VERSION, type: "session.snapshot", payload: createSnapshot() });
      await flush();

      // Advance 4000ms, then send a command result — should reset idle timer
      await vi.advanceTimersByTimeAsync(4000);
      await flush();
      sockets[0]!.emitMessage({
        version: PROTOCOL_VERSION,
        type: "session.command.result",
        requestId: "req-1",
        payload: { ok: true },
      });
      await flush();

      // Advance 4999ms from command result — still connected
      await vi.advanceTimersByTimeAsync(4999);
      await flush();
      expect(onConnectionState).toHaveBeenLastCalledWith({
        online: true,
        connecting: false,
        statusText: "Подключено к Pi-сессии",
      });

      // Advance past idle timeout
      await vi.advanceTimersByTimeAsync(2);
      await flush();
      expect(onConnectionState).toHaveBeenLastCalledWith({
        online: false,
        connecting: false,
        statusText: 'Сессия неактивна. Нажмите «Подключить» для восстановления.',
      });
    } finally {
      vi.useRealTimers();
    }
  });

  // ─── session.event validation (M4) ───

  it("should ignore malformed session.event payloads", async () => {
    const socket = new FakeWebSocket();
    const onSessionEvent = vi.fn();
    const client = new SessionClient({
      
      port: 31415,
      webSocketFactory: () => socket,
      onSnapshot: vi.fn(),
      onConnectionState: vi.fn(),
      onSessionEvent,
    });

    client.connect();
    socket.emitOpen();
    socket.emitMessage({ version: PROTOCOL_VERSION, type: "session.snapshot", payload: createSnapshot() });
    await flush();

    // Send malformed event (missing required fields: message.id and message.role)
    socket.emitMessage({
      version: PROTOCOL_VERSION,
      type: "session.event",
      payload: { type: "message_start" },
    });
    await flush();

    expect(onSessionEvent).not.toHaveBeenCalled();
  });

  it("should accept valid session.event payloads", async () => {
    const socket = new FakeWebSocket();
    const onSessionEvent = vi.fn();
    const client = new SessionClient({
      
      port: 31415,
      webSocketFactory: () => socket,
      onSnapshot: vi.fn(),
      onConnectionState: vi.fn(),
      onSessionEvent,
    });

    client.connect();
    socket.emitOpen();
    socket.emitMessage({ version: PROTOCOL_VERSION, type: "session.snapshot", payload: createSnapshot() });
    await flush();

    // Send valid event
    socket.emitMessage({
      version: PROTOCOL_VERSION,
      type: "session.event",
      payload: {
        type: "message_start",
        message: { id: "msg-1", role: "assistant" },
      },
    });
    await flush();

    expect(onSessionEvent).toHaveBeenCalledWith({
      type: "message_start",
      message: { id: "msg-1", role: "assistant" },
    });
  });

  it("connect() resets everConnected and allows fresh connection attempt", async () => {
    vi.useFakeTimers();
    try {
      const sockets: FakeWebSocket[] = [];
      const webSocketFactory = vi.fn(() => {
        const socket = new FakeWebSocket();
        sockets.push(socket);
        return socket;
      });
      const onConnectionState = vi.fn();
      const client = new SessionClient({
      
        port: 31415,
        webSocketFactory,
        onSnapshot: vi.fn(),
        onConnectionState,
        reconnectDelaysMs: [50],
        idleTimeoutMs: 0,
      });

      // First connect — fails (no snapshot)
      client.connect();
      sockets[0]!.emitOpen();
      sockets[0]!.emitClose();
      await flush();

      expect(onConnectionState).toHaveBeenLastCalledWith({
        online: false,
        connecting: false,
        statusText: 'Pi-сессия не найдена на порту 31415. Запустите Pi и нажмите «Подключить».',
      });

      // No reconnect happened
      await vi.advanceTimersByTimeAsync(100);
      await flush();
      expect(webSocketFactory).toHaveBeenCalledTimes(1);

      // Second connect() — should try again (everConnected reset)
      client.connect();
      expect(webSocketFactory).toHaveBeenCalledTimes(2);
      expect(onConnectionState).toHaveBeenLastCalledWith({
        online: false,
        connecting: true,
        statusText: "Подключаемся к Pi-сессии…",
      });

      // This time Pi is available — send snapshot
      sockets[1]!.emitOpen();
      sockets[1]!.emitMessage({ version: PROTOCOL_VERSION, type: "session.snapshot", payload: createSnapshot() });
      await flush();

      expect(onConnectionState).toHaveBeenLastCalledWith({
        online: true,
        connecting: false,
        statusText: "Подключено к Pi-сессии",
      });
    } finally {
      vi.useRealTimers();
    }
  });
});
