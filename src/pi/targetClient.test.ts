import { EventEmitter } from "node:events";

import WebSocket from "ws";
import { describe, expect, it, vi } from "vitest";

import { PROTOCOL_VERSION } from "../shared/constants";
import type { ChatEvent, ProtocolEnvelope, TargetMetadata, TargetRuntimeState } from "../shared/protocol";
import { createMemoryLogger } from "./logging";
import {
  buildTargetMetadata,
  connectTargetToBroker,
  getTargetDisplayLabel,
  handleDeliveredChatMessage,
  handleDeliveredSelection,
} from "./targetClient";

class FakeWebSocket extends EventEmitter {
  readyState: number = WebSocket.CONNECTING;
  readonly sentMessages: string[] = [];
  terminated = false;

  send(data: string): void {
    this.sentMessages.push(data);
  }

  open(): void {
    this.readyState = WebSocket.OPEN;
    this.emit("open");
  }

  receive(envelope: ProtocolEnvelope): void {
    this.emit("message", Buffer.from(JSON.stringify(envelope)));
  }

  close(): void {
    if (this.readyState === WebSocket.CLOSED) {
      return;
    }

    this.readyState = WebSocket.CLOSED;
    this.emit("close");
  }

  terminate(): void {
    this.terminated = true;
    this.close();
  }
}

const targetMetadata: TargetMetadata = {
  targetId: "target-1",
  alias: "frontend",
  cwd: "/repo/project",
  pid: 123,
  connectedAt: 1_710_000_000_000,
  lastSeenAt: 1_710_000_000_000,
};

describe("getTargetDisplayLabel", () => {
  it("uses alias when present", () => {
    expect(
      getTargetDisplayLabel({
        targetId: "target-1",
        alias: "frontend",
        cwd: "/repo/project",
        pid: 123,
        connectedAt: 1,
        lastSeenAt: 1,
      }),
    ).toBe("frontend");
  });
});

describe("buildTargetMetadata", () => {
  it("includes cwd, pid, alias and git branch when available", async () => {
    const metadata = await buildTargetMetadata({
      targetId: "target-1",
      alias: "frontend",
      cwd: "/repo/project",
      pid: 123,
      sessionName: "session",
      now: 1_710_000_000_000,
      getGitBranch: vi.fn(async () => "feat/test"),
    });

    expect(metadata).toEqual({
      targetId: "target-1",
      alias: "frontend",
      cwd: "/repo/project",
      gitBranch: "feat/test",
      pid: 123,
      sessionName: "session",
      connectedAt: 1_710_000_000_000,
      lastSeenAt: 1_710_000_000_000,
    });
  });
});

describe("handleDeliveredChatMessage", () => {
  it("sends chat text immediately when Pi is idle and emits busy events", async () => {
    const sendUserMessage = vi.fn();
    const emitChatEvent = vi.fn();

    await expect(handleDeliveredChatMessage({
      message: "Привет",
      isIdle: () => true,
      sendUserMessage,
      emitChatEvent,
      now: () => 1_710_000_000_000,
    })).resolves.toEqual({ ok: true });

    expect(sendUserMessage).toHaveBeenCalledWith("Привет", undefined);
    expect(emitChatEvent).toHaveBeenNthCalledWith(1, {
      kind: "agent_busy",
      busy: true,
      label: "Агент работает в фоне…",
      timestamp: 1_710_000_000_000,
    });
  });

  it("queues chat text as followUp when Pi is busy", async () => {
    const sendUserMessage = vi.fn();
    const emitChatEvent = vi.fn();

    await expect(handleDeliveredChatMessage({
      message: "Продолжи",
      isIdle: () => false,
      sendUserMessage,
      emitChatEvent,
      now: () => 1_710_000_000_000,
    })).resolves.toEqual({ ok: true });

    expect(sendUserMessage).toHaveBeenCalledWith("Продолжи", { deliverAs: "followUp" });
  });

  it("emits error and clears busy when chat delivery fails", async () => {
    const emitChatEvent = vi.fn();

    await expect(handleDeliveredChatMessage({
      message: "Привет",
      isIdle: () => true,
      sendUserMessage: vi.fn(async () => {
        throw new Error("Pi недоступен");
      }),
      emitChatEvent,
      now: () => 1_710_000_000_000,
    })).resolves.toEqual({ ok: false, error: "Pi недоступен" });

    expect(emitChatEvent).toHaveBeenCalledWith({
      kind: "error",
      message: "Pi недоступен",
      timestamp: 1_710_000_000_000,
    });
    expect(emitChatEvent).toHaveBeenCalledWith({
      kind: "agent_busy",
      busy: false,
      label: "Агент работает в фоне…",
      timestamp: 1_710_000_000_000,
    });
  });
});

describe("handleDeliveredSelection", () => {
  it("sends selection immediately when Pi is idle", async () => {
    const sendUserMessage = vi.fn();

    await handleDeliveredSelection({
      selection: {
        url: "https://example.com",
        title: "Example",
        selectedText: "hello",
        selectedHtml: "<p>hello</p>",
        capturedAt: Date.now(),
      },
      isIdle: () => true,
      sendUserMessage,
    });

    expect(sendUserMessage).toHaveBeenCalledWith(expect.stringContaining("hello"), undefined);
  });

  it("queues as followUp when Pi is busy", async () => {
    const sendUserMessage = vi.fn();

    await handleDeliveredSelection({
      selection: {
        url: "https://example.com",
        title: "Example",
        selectedText: "hello",
        selectedHtml: "<p>hello</p>",
        capturedAt: Date.now(),
      },
      isIdle: () => false,
      sendUserMessage,
    });

    expect(sendUserMessage).toHaveBeenCalledWith(expect.any(String), { deliverAs: "followUp" });
  });
});

describe("connectTargetToBroker", () => {
  it("resolves only after a matching target.registered ack", async () => {
    const socket = new FakeWebSocket();
    const connectPromise = connectTargetToBroker({
      token: "test-token",
      metadata: targetMetadata,
      logger: createMemoryLogger(),
      onDeliveredSelection: vi.fn(async () => ({ ok: true })),
      webSocketFactory: () => socket as unknown as WebSocket,
      heartbeatIntervalMs: 60_000,
    });
    let settled = false;

    void connectPromise.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );

    socket.open();
    await Promise.resolve();

    expect(settled).toBe(false);
    expect(socket.sentMessages).toHaveLength(1);

    const registerEnvelope = JSON.parse(socket.sentMessages[0]) as ProtocolEnvelope<{
      token: string;
      target: TargetMetadata;
    }>;

    expect(registerEnvelope).toMatchObject({
      version: PROTOCOL_VERSION,
      type: "target.register",
      payload: {
        token: "test-token",
        target: targetMetadata,
      },
    });
    expect(registerEnvelope.requestId).toEqual(expect.any(String));

    socket.receive({
      version: PROTOCOL_VERSION,
      type: "target.registered",
      requestId: registerEnvelope.requestId,
    });

    const connected = await connectPromise;
    expect(connected.url).toBe("ws://127.0.0.1:17345");

    await connected.close();
  });

  it("rejects when the broker closes before registration ack", async () => {
    const socket = new FakeWebSocket();
    const connectPromise = connectTargetToBroker({
      token: "test-token",
      metadata: targetMetadata,
      logger: createMemoryLogger(),
      onDeliveredSelection: vi.fn(async () => ({ ok: true })),
      webSocketFactory: () => socket as unknown as WebSocket,
    });

    socket.open();
    socket.close();

    await expect(connectPromise).rejects.toThrow(/registration/i);
  });

  it("times out registration when the broker never acknowledges and terminates the socket", async () => {
    vi.useFakeTimers();
    const socket = new FakeWebSocket();

    try {
      const connectPromise = connectTargetToBroker({
        token: "test-token",
        metadata: targetMetadata,
        logger: createMemoryLogger(),
        onDeliveredSelection: vi.fn(async () => ({ ok: true })),
        webSocketFactory: () => socket as unknown as WebSocket,
        registrationTimeoutMs: 25,
        heartbeatIntervalMs: 60_000,
      });

      socket.open();
      await Promise.resolve();

      expect(socket.sentMessages).toHaveLength(1);
      expect(socket.terminated).toBe(false);

      const rejection = expect(connectPromise).rejects.toThrow(/timed out/i);

      await vi.advanceTimersByTimeAsync(25);

      await rejection;
      expect(socket.terminated).toBe(true);
      expect(socket.readyState).toBe(WebSocket.CLOSED);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports whether the established broker socket is still open", async () => {
    const socket = new FakeWebSocket();
    const connectPromise = connectTargetToBroker({
      token: "test-token",
      metadata: targetMetadata,
      logger: createMemoryLogger(),
      onDeliveredSelection: vi.fn(async () => ({ ok: true })),
      webSocketFactory: () => socket as unknown as WebSocket,
      heartbeatIntervalMs: 60_000,
    });

    socket.open();

    const registerEnvelope = JSON.parse(socket.sentMessages[0]) as ProtocolEnvelope;
    socket.receive({
      version: PROTOCOL_VERSION,
      type: "target.registered",
      requestId: registerEnvelope.requestId,
    });

    const connected = await connectPromise;
    expect(connected.isOpen()).toBe(true);

    socket.close();

    expect(connected.isOpen()).toBe(false);

    await connected.close();
  });

  it("delivers broker chat messages to the chat handler", async () => {
    const socket = new FakeWebSocket();
    const onDeliveredChatMessage = vi.fn(async () => ({ ok: true }));
    const connectPromise = connectTargetToBroker({
      token: "test-token",
      metadata: targetMetadata,
      logger: createMemoryLogger(),
      onDeliveredSelection: vi.fn(async () => ({ ok: true })),
      onDeliveredChatMessage,
      webSocketFactory: () => socket as unknown as WebSocket,
      heartbeatIntervalMs: 60_000,
    });

    socket.open();

    const registerEnvelope = JSON.parse(socket.sentMessages[0]) as ProtocolEnvelope;
    socket.receive({
      version: PROTOCOL_VERSION,
      type: "target.registered",
      requestId: registerEnvelope.requestId,
    });

    const connected = await connectPromise;
    socket.receive({
      version: PROTOCOL_VERSION,
      type: "target.deliverChatMessage",
      requestId: "chat-1",
      payload: {
        message: "Привет",
        sentAt: 1_710_000_000_000,
      },
    });
    await Promise.resolve();

    expect(onDeliveredChatMessage).toHaveBeenCalledWith("Привет");

    await connected.close();
  });

  it("emits chat events to the broker", async () => {
    const socket = new FakeWebSocket();
    const connectPromise = connectTargetToBroker({
      token: "test-token",
      metadata: targetMetadata,
      logger: createMemoryLogger(),
      onDeliveredSelection: vi.fn(async () => ({ ok: true })),
      webSocketFactory: () => socket as unknown as WebSocket,
      heartbeatIntervalMs: 60_000,
    });

    socket.open();

    const registerEnvelope = JSON.parse(socket.sentMessages[0]) as ProtocolEnvelope;
    socket.receive({
      version: PROTOCOL_VERSION,
      type: "target.registered",
      requestId: registerEnvelope.requestId,
    });

    const connected = await connectPromise;
    const chatEvent: ChatEvent = {
      kind: "assistant_message_start",
      messageId: "message-1",
      timestamp: 1_710_000_000_000,
    };
    connected.emitChatEvent(chatEvent);

    expect(JSON.parse(socket.sentMessages.at(-1) ?? "{}")).toEqual({
      version: PROTOCOL_VERSION,
      type: "target.chatEvent",
      payload: chatEvent,
    });

    await connected.close();
  });

  it("emits runtime state and available models to the broker", async () => {
    const socket = new FakeWebSocket();
    const runtimeState: TargetRuntimeState = {
      targetId: "target-1",
      model: { provider: "anthropic", id: "claude-sonnet", label: "Claude Sonnet" },
      contextUsage: { tokens: 1000, maxTokens: 200000, percent: 0.5 },
      isIdle: true,
      updatedAt: 1_710_000_000_500,
    };
    const connectPromise = connectTargetToBroker({
      token: "test-token",
      metadata: targetMetadata,
      logger: createMemoryLogger(),
      onDeliveredSelection: vi.fn(async () => ({ ok: true })),
      webSocketFactory: () => socket as unknown as WebSocket,
      heartbeatIntervalMs: 60_000,
    });

    socket.open();
    const registerEnvelope = JSON.parse(socket.sentMessages[0]) as ProtocolEnvelope;
    socket.receive({ version: PROTOCOL_VERSION, type: "target.registered", requestId: registerEnvelope.requestId });

    const connected = await connectPromise;
    connected.emitRuntimeState!(runtimeState);
    connected.emitAvailableModels!([{ provider: "anthropic", id: "claude-sonnet", label: "Claude Sonnet" }]);

    expect(JSON.parse(socket.sentMessages.at(-2) ?? "{}")).toEqual({
      version: PROTOCOL_VERSION,
      type: "target.runtimeState",
      payload: runtimeState,
    });
    expect(JSON.parse(socket.sentMessages.at(-1) ?? "{}")).toEqual({
      version: PROTOCOL_VERSION,
      type: "target.availableModels",
      payload: { models: [{ provider: "anthropic", id: "claude-sonnet", label: "Claude Sonnet" }] },
    });

    await connected.close();
  });

  it("handles target model set commands", async () => {
    const socket = new FakeWebSocket();
    const onSetModel = vi.fn(async () => ({ ok: false, error: "Модель недоступна" }));
    const connectPromise = connectTargetToBroker({
      token: "test-token",
      metadata: targetMetadata,
      logger: createMemoryLogger(),
      onDeliveredSelection: vi.fn(async () => ({ ok: true })),
      onSetModel,
      webSocketFactory: () => socket as unknown as WebSocket,
      heartbeatIntervalMs: 60_000,
    });

    socket.open();
    const registerEnvelope = JSON.parse(socket.sentMessages[0]) as ProtocolEnvelope;
    socket.receive({ version: PROTOCOL_VERSION, type: "target.registered", requestId: registerEnvelope.requestId });

    const connected = await connectPromise;
    socket.receive({
      version: PROTOCOL_VERSION,
      type: "target.setModel",
      requestId: "model-1",
      payload: { provider: "anthropic", modelId: "claude-sonnet" },
    });
    await Promise.resolve();

    expect(onSetModel).toHaveBeenCalledWith({ provider: "anthropic", modelId: "claude-sonnet" });
    expect(JSON.parse(socket.sentMessages.at(-1) ?? "{}")).toEqual({
      version: PROTOCOL_VERSION,
      type: "target.modelSetResult",
      requestId: "model-1",
      payload: { ok: false, error: "Модель недоступна" },
    });

    await connected.close();
  });

  it("calls onDisconnect when an established broker socket closes unexpectedly", async () => {
    const socket = new FakeWebSocket();
    const onDisconnect = vi.fn();
    const connectPromise = connectTargetToBroker({
      token: "test-token",
      metadata: targetMetadata,
      logger: createMemoryLogger(),
      onDeliveredSelection: vi.fn(async () => ({ ok: true })),
      onDisconnect,
      webSocketFactory: () => socket as unknown as WebSocket,
      heartbeatIntervalMs: 60_000,
    });

    socket.open();

    const registerEnvelope = JSON.parse(socket.sentMessages[0]) as ProtocolEnvelope;
    socket.receive({
      version: PROTOCOL_VERSION,
      type: "target.registered",
      requestId: registerEnvelope.requestId,
    });

    const connected = await connectPromise;
    socket.close();

    expect(onDisconnect).toHaveBeenCalledOnce();

    await connected.close();
  });
});
