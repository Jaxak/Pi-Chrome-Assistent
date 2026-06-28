import { afterEach, describe, expect, it, vi } from "vitest";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { DEFAULT_DIRECT_SESSION_PORT } from "./sessionServer";
import type { DirectSessionServer, DirectSessionServerOnAvailablePortOptions } from "./sessionServer";
import type { DeliveryResult, DirectSessionSnapshot, SelectionPayload } from "../shared/protocol";
import { formatSelectionMessage } from "../shared/formatSelectionMessage";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

let capturedSessionServerOptions: DirectSessionServerOnAvailablePortOptions | undefined;
const mockBroadcastSnapshot = vi.fn();
const mockBroadcastEvent = vi.fn();
const mockClose = vi.fn(async () => undefined);

const fakeServer: DirectSessionServer = {
  port: 31416,
  broadcastSnapshot: mockBroadcastSnapshot,
  broadcastEvent: mockBroadcastEvent,
  close: mockClose,
};

vi.mock("./sessionServer", () => ({
  DEFAULT_DIRECT_SESSION_PORT: 31415,
  startDirectSessionServerOnAvailablePort: vi.fn(
    (options: DirectSessionServerOnAvailablePortOptions) => {
      capturedSessionServerOptions = options;
      return Promise.resolve(fakeServer);
    },
  ),
}));

vi.mock("./logging", () => ({
  createFileLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  })),
  createMemoryLogger: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Fake ExtensionAPI
// ---------------------------------------------------------------------------

function createFakePi(): {
  pi: ExtensionAPI;
  ctx: ExtensionContext;
  registerCommandCalls: Array<{ name: string; handler: (args: string, ctx: ExtensionContext) => Promise<void> }>;
  onCalls: Array<{ event: string; handler: (event: unknown, ctx: ExtensionContext) => void | Promise<void> }>;
  sendUserMessage: ReturnType<typeof vi.fn>;
  setModel: ReturnType<typeof vi.fn>;
  getSessionName: ReturnType<typeof vi.fn>;
} {
  const sendUserMessage = vi.fn(async () => true);
  const setModel = vi.fn(async () => true);
  const getSessionName = vi.fn(() => "test-session");
  const registerCommandCalls: Array<{ name: string; handler: (args: string, ctx: ExtensionContext) => Promise<void> }> = [];
  const onCalls: Array<{ event: string; handler: (event: unknown, ctx: ExtensionContext) => void | Promise<void> }> = [];

  const ctx: ExtensionContext = {
    cwd: "/repo/test",
    isIdle: () => true,
    model: { provider: "anthropic", id: "claude-sonnet-4-20250514", name: "Claude Sonnet 4" },
    getContextUsage: () => ({ tokens: 500, contextWindow: 200000, percent: 0.25 }),
    modelRegistry: {
      getAvailable: async () => [
        { provider: "anthropic", id: "claude-sonnet-4-20250514", name: "Claude Sonnet 4" },
        { provider: "anthropic", id: "claude-opus-4-20250514", name: "Claude Opus 4" },
      ],
    },
    ui: {
      setStatus: vi.fn(),
      notify: vi.fn(),
      input: vi.fn(),
    },
  } as unknown as ExtensionContext;

  const pi = {
    registerCommand: vi.fn((name: string, opts: { description: string; handler: (args: string, ctx: ExtensionContext) => Promise<void> }) => {
      registerCommandCalls.push({ name, handler: opts.handler });
    }),
    on: vi.fn((event: string, handler: (event: unknown, ctx: ExtensionContext) => void | Promise<void>) => {
      onCalls.push({ event, handler: handler });
    }),
    sendUserMessage,
    setModel,
    getSessionName,
  } as unknown as ExtensionAPI;

  return { pi, ctx, registerCommandCalls, onCalls, sendUserMessage, setModel, getSessionName };
}

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  capturedSessionServerOptions = undefined;
  mockBroadcastSnapshot.mockReset();
  mockBroadcastEvent.mockReset();
  mockClose.mockReset();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("buildDirectRuntimeState", () => {
  it("returns runtime without targetId: model summary, contextUsage, isIdle, updatedAt", async () => {
    const { buildDirectRuntimeState } = await import("./browserConnectExtension");
    const fakeNow = 1_710_000_000_000;
    const runtime = buildDirectRuntimeState({
      ctx: {
        model: { provider: "anthropic", id: "claude-sonnet", name: "Claude Sonnet" },
        getContextUsage: () => ({ tokens: 1000, contextWindow: 200000, percent: 0.5 }),
        isIdle: () => true,
      },
      now: () => fakeNow,
    });

    expect(runtime).toEqual({
      model: { provider: "anthropic", id: "claude-sonnet", label: "Claude Sonnet" },
      contextUsage: { tokens: 1000, maxTokens: 200000, percent: 0.5 },
      isIdle: true,
      updatedAt: fakeNow,
    });
    expect(runtime).not.toHaveProperty("targetId");
  });
});

describe("handleDirectModelSet", () => {
  it("sets model when available and returns {ok:true}", async () => {
    const { handleDirectModelSet } = await import("./browserConnectExtension");
    const model = { provider: "anthropic", id: "claude-sonnet" };
    const pi = { setModel: vi.fn(async () => true) };

    const result = await handleDirectModelSet({
      input: { provider: "anthropic", modelId: "claude-sonnet" },
      ctx: { modelRegistry: { getAvailable: async () => [model] } },
      pi,
    });

    expect(result).toEqual({ ok: true });
    expect(pi.setModel).toHaveBeenCalledWith(model);
  });

  it("unavailable model returns Russian error", async () => {
    const { handleDirectModelSet } = await import("./browserConnectExtension");

    const result = await handleDirectModelSet({
      input: { provider: "openai", modelId: "gpt-99" },
      ctx: { modelRegistry: { getAvailable: async () => [] } },
      pi: { setModel: vi.fn() },
    });

    expect(result.ok).toBe(false);
    expect(result.error).toBe("Модель недоступна");
  });
});

describe("browserConnectExtension registration", () => {
  it("registers chrome-assistent-connect only", async () => {
    const { default: browserConnectExtension } = await import("./browserConnectExtension");
    const { pi } = createFakePi();

    browserConnectExtension(pi);

    const registeredNames = (pi.registerCommand as ReturnType<typeof vi.fn>).mock.calls.map(
      (call: unknown[]) => call[0] as string,
    );

    expect(registeredNames).toEqual(["chrome-assistent-connect"]);
  });
});

describe("connect command", () => {
  it("calls startDirectSessionServerOnAvailablePort with host 127.0.0.1 and preferredPort DEFAULT_DIRECT_SESSION_PORT, sets status/notify with actual mocked port 31416", async () => {
    const { default: browserConnectExtension } = await import("./browserConnectExtension");
    const { pi, ctx, registerCommandCalls } = createFakePi();

    browserConnectExtension(pi);

    const connectEntry = registerCommandCalls.find((c) => c.name === "chrome-assistent-connect");
    expect(connectEntry).toBeDefined();

    await connectEntry!.handler("", ctx);

    const startMock = (await import("./sessionServer")).startDirectSessionServerOnAvailablePort as ReturnType<typeof vi.fn>;
    expect(startMock).toHaveBeenCalledWith(
      expect.objectContaining({
        host: "127.0.0.1",
        preferredPort: DEFAULT_DIRECT_SESSION_PORT,
      }),
    );

    const setStatus = ctx.ui.setStatus as ReturnType<typeof vi.fn>;
    const notify = ctx.ui.notify as ReturnType<typeof vi.fn>;

    expect(setStatus).toHaveBeenCalledWith(
      "chrome-assistent-connect",
      expect.stringContaining("31416"),
    );
    expect(notify).toHaveBeenCalledWith(
      expect.stringContaining("31416"),
      expect.any(String),
    );
  });
});

describe("running connect twice", () => {
  it("closes previous server before replacing it", async () => {
    const { default: browserConnectExtension } = await import("./browserConnectExtension");
    const { pi, ctx, registerCommandCalls } = createFakePi();

    browserConnectExtension(pi);

    const connectEntry = registerCommandCalls.find((c) => c.name === "chrome-assistent-connect");
    expect(connectEntry).toBeDefined();

    await connectEntry!.handler("", ctx);
    await connectEntry!.handler("", ctx);

    expect(mockClose).toHaveBeenCalledTimes(1);
  });
});

describe("session_shutdown", () => {
  it("closes active server", async () => {
    const { default: browserConnectExtension } = await import("./browserConnectExtension");
    const { pi, ctx, registerCommandCalls, onCalls } = createFakePi();

    browserConnectExtension(pi);

    const connectEntry = registerCommandCalls.find((c) => c.name === "chrome-assistent-connect");
    expect(connectEntry).toBeDefined();

    await connectEntry!.handler("", ctx);

    const shutdownEntry = onCalls.find((c) => c.event === "session_shutdown");
    expect(shutdownEntry).toBeDefined();

    await shutdownEntry!.handler({}, ctx);

    expect(mockClose).toHaveBeenCalledTimes(1);
  });
});

describe("injected direct server handlers", () => {
  it("onChatMessage calls pi.sendUserMessage and returns command result", async () => {
    const { default: browserConnectExtension } = await import("./browserConnectExtension");
    const { pi, ctx, registerCommandCalls, sendUserMessage } = createFakePi();

    browserConnectExtension(pi);

    const connectEntry = registerCommandCalls.find((c) => c.name === "chrome-assistent-connect");
    await connectEntry!.handler("", ctx);

    expect(capturedSessionServerOptions).toBeDefined();
    const onChatMessage = capturedSessionServerOptions!.onChatMessage;
    const result = await onChatMessage("Привет, мир");

    expect(sendUserMessage).toHaveBeenCalledWith("Привет, мир", undefined);
    expect(result).toEqual({ ok: true });
  });

  it("onChatMessage passes undefined options when ctx.isIdle() is true (new message)", async () => {
    const { default: browserConnectExtension } = await import("./browserConnectExtension");
    const { pi, ctx, registerCommandCalls, sendUserMessage } = createFakePi();
    // Default ctx.isIdle() returns true

    browserConnectExtension(pi);

    const connectEntry = registerCommandCalls.find((c) => c.name === "chrome-assistent-connect");
    await connectEntry!.handler("", ctx);

    expect(capturedSessionServerOptions).toBeDefined();
    const onChatMessage = capturedSessionServerOptions!.onChatMessage;
    await onChatMessage("Привет, мир");

    expect(sendUserMessage).toHaveBeenCalledWith("Привет, мир", undefined);
  });

  it("onChatMessage passes {deliverAs:'followUp'} when ctx.isIdle() is false (follow-up)", async () => {
    const { default: browserConnectExtension } = await import("./browserConnectExtension");
    const { pi, ctx, registerCommandCalls, sendUserMessage } = createFakePi();
    // Override isIdle to return false (agent busy)
    ctx.isIdle = () => false;

    browserConnectExtension(pi);

    const connectEntry = registerCommandCalls.find((c) => c.name === "chrome-assistent-connect");
    await connectEntry!.handler("", ctx);

    expect(capturedSessionServerOptions).toBeDefined();
    const onChatMessage = capturedSessionServerOptions!.onChatMessage;
    await onChatMessage("follow-up message");

    expect(sendUserMessage).toHaveBeenCalledWith("follow-up message", { deliverAs: "followUp" });
  });

  it("onSelection passes undefined options when ctx.isIdle() is true", async () => {
    const { default: browserConnectExtension } = await import("./browserConnectExtension");
    const { pi, ctx, registerCommandCalls, sendUserMessage } = createFakePi();
    // Default ctx.isIdle() returns true

    browserConnectExtension(pi);

    const connectEntry = registerCommandCalls.find((c) => c.name === "chrome-assistent-connect");
    await connectEntry!.handler("", ctx);

    const selection: SelectionPayload = {
      url: "https://example.com",
      title: "Example",
      selectedText: "выделенный текст",
      selectedHtml: "<span>выделенный текст</span>",
      capturedAt: Date.now(),
    };

    expect(capturedSessionServerOptions).toBeDefined();
    const onSelection = capturedSessionServerOptions!.onSelection;
    await onSelection(selection);

    const expectedMessage = formatSelectionMessage(selection);
    expect(sendUserMessage).toHaveBeenCalledWith(expectedMessage, undefined);
  });

  it("onSelection passes {deliverAs:'followUp'} when ctx.isIdle() is false", async () => {
    const { default: browserConnectExtension } = await import("./browserConnectExtension");
    const { pi, ctx, registerCommandCalls, sendUserMessage } = createFakePi();
    // Override isIdle to return false (agent busy)
    ctx.isIdle = () => false;

    browserConnectExtension(pi);

    const connectEntry = registerCommandCalls.find((c) => c.name === "chrome-assistent-connect");
    await connectEntry!.handler("", ctx);

    const selection: SelectionPayload = {
      url: "https://example.com",
      title: "Example",
      selectedText: "выделенный текст",
      selectedHtml: "<span>выделенный текст</span>",
      capturedAt: Date.now(),
    };

    expect(capturedSessionServerOptions).toBeDefined();
    const onSelection = capturedSessionServerOptions!.onSelection;
    await onSelection(selection);

    const expectedMessage = formatSelectionMessage(selection);
    expect(sendUserMessage).toHaveBeenCalledWith(expectedMessage, { deliverAs: "followUp" });
  });

  it("onSelection calls pi.sendUserMessage with formatted selection text and returns command result", async () => {
    const { default: browserConnectExtension } = await import("./browserConnectExtension");
    const { pi, ctx, registerCommandCalls, sendUserMessage } = createFakePi();

    browserConnectExtension(pi);

    const connectEntry = registerCommandCalls.find((c) => c.name === "chrome-assistent-connect");
    await connectEntry!.handler("", ctx);

    const selection: SelectionPayload = {
      url: "https://example.com",
      title: "Example",
      selectedText: "выделенный текст",
      selectedHtml: "<span>выделенный текст</span>",
      capturedAt: Date.now(),
    };

    expect(capturedSessionServerOptions).toBeDefined();
    const onSelection = capturedSessionServerOptions!.onSelection;
    const result = await onSelection(selection);

    const expectedMessage = formatSelectionMessage(selection);
    expect(sendUserMessage).toHaveBeenCalledWith(expectedMessage, undefined);
    expect(result).toEqual({ ok: true });
  });

  it("onSetModel calls pi.setModel and returns command result", async () => {
    const { default: browserConnectExtension } = await import("./browserConnectExtension");
    const { pi, ctx, registerCommandCalls, setModel } = createFakePi();

    browserConnectExtension(pi);

    const connectEntry = registerCommandCalls.find((c) => c.name === "chrome-assistent-connect");
    await connectEntry!.handler("", ctx);

    expect(capturedSessionServerOptions).toBeDefined();
    const onSetModel = capturedSessionServerOptions!.onSetModel;
    const result = await onSetModel({ provider: "anthropic", modelId: "claude-sonnet-4-20250514" });

    expect(setModel).toHaveBeenCalled();
    expect(result).toEqual({ ok: true });
  });
});

describe("Pi events", () => {
  it("message_start/message_update/message_end and model_select call server.broadcastSnapshot after connected", async () => {
    const { default: browserConnectExtension } = await import("./browserConnectExtension");
    const { pi, ctx, registerCommandCalls, onCalls } = createFakePi();

    browserConnectExtension(pi);

    const connectEntry = registerCommandCalls.find((c) => c.name === "chrome-assistent-connect");
    await connectEntry!.handler("", ctx);

    // Fire Pi events
    const messageStartHandler = onCalls.find((c) => c.event === "message_start");
    const messageUpdateHandler = onCalls.find((c) => c.event === "message_update");
    const messageEndHandler = onCalls.find((c) => c.event === "message_end");
    const modelSelectHandler = onCalls.find((c) => c.event === "model_select");

    messageStartHandler?.handler({ message: { role: "assistant", id: "msg-1" } }, ctx);
    messageUpdateHandler?.handler(
      { message: { role: "assistant", id: "msg-1" }, assistantMessageEvent: { type: "text_delta", text_delta: "Hello" } },
      ctx,
    );
    messageEndHandler?.handler({ message: { role: "assistant", id: "msg-1" } }, ctx);
    modelSelectHandler?.handler({}, ctx);

    expect(mockBroadcastSnapshot).toHaveBeenCalledTimes(4);
  });

  it("message_start/message_update/message_end forward raw events via broadcastEvent", async () => {
    const { default: browserConnectExtension } = await import("./browserConnectExtension");
    const { pi, ctx, registerCommandCalls, onCalls } = createFakePi();

    browserConnectExtension(pi);

    const connectEntry = registerCommandCalls.find((c) => c.name === "chrome-assistent-connect");
    await connectEntry!.handler("", ctx);

    const messageStartHandler = onCalls.find((c) => c.event === "message_start");
    const messageUpdateHandler = onCalls.find((c) => c.event === "message_update");
    const messageEndHandler = onCalls.find((c) => c.event === "message_end");

    messageStartHandler?.handler({ message: { role: "assistant", id: "msg-1" } }, ctx);
    messageUpdateHandler?.handler(
      { message: { role: "assistant", id: "msg-1" }, assistantMessageEvent: { type: "text_delta", text_delta: "Hello" } },
      ctx,
    );
    messageEndHandler?.handler({ message: { role: "assistant", id: "msg-1" }, stopReason: "end_turn" }, ctx);

    // broadcastEvent should have been called 3 times (message_start, message_update, message_end)
    expect(mockBroadcastEvent).toHaveBeenCalledTimes(3);

    // Verify message_start event
    expect(mockBroadcastEvent).toHaveBeenNthCalledWith(1, {
      type: "message_start",
      message: { id: "msg-1", role: "assistant" },
    });

    // Verify message_update with assistantMessageEvent
    expect(mockBroadcastEvent).toHaveBeenNthCalledWith(2, {
      type: "message_update",
      message: { id: "msg-1", role: "assistant" },
      assistantMessageEvent: { type: "text_delta", text_delta: "Hello" },
    });

    // Verify message_end with stopReason
    expect(mockBroadcastEvent).toHaveBeenNthCalledWith(3, {
      type: "message_end",
      message: { id: "msg-1", role: "assistant" },
      stopReason: "end_turn",
    });
  });

  it("turn_start/turn_end forward raw events via broadcastEvent", async () => {
    const { default: browserConnectExtension } = await import("./browserConnectExtension");
    const { pi, ctx, registerCommandCalls, onCalls } = createFakePi();

    browserConnectExtension(pi);

    const connectEntry = registerCommandCalls.find((c) => c.name === "chrome-assistent-connect");
    await connectEntry!.handler("", ctx);

    const turnStartHandler = onCalls.find((c) => c.event === "turn_start");
    const turnEndHandler = onCalls.find((c) => c.event === "turn_end");

    turnStartHandler?.handler({ turnId: "turn-1" }, ctx);
    turnEndHandler?.handler({ turnId: "turn-1" }, ctx);

    expect(mockBroadcastEvent).toHaveBeenCalledWith({
      type: "turn_start",
      turnId: "turn-1",
    });
    expect(mockBroadcastEvent).toHaveBeenCalledWith({
      type: "turn_end",
      turnId: "turn-1",
    });
  });

  it("tool_execution_start/update/end forward raw events via broadcastEvent", async () => {
    const { default: browserConnectExtension } = await import("./browserConnectExtension");
    const { pi, ctx, registerCommandCalls, onCalls } = createFakePi();

    browserConnectExtension(pi);

    const connectEntry = registerCommandCalls.find((c) => c.name === "chrome-assistent-connect");
    await connectEntry!.handler("", ctx);

    const toolStartHandler = onCalls.find((c) => c.event === "tool_execution_start");
    const toolUpdateHandler = onCalls.find((c) => c.event === "tool_execution_update");
    const toolEndHandler = onCalls.find((c) => c.event === "tool_execution_end");

    toolStartHandler?.handler({ toolName: "read_file", input: { path: "/tmp/test" } }, ctx);
    toolUpdateHandler?.handler({ toolName: "read_file", output: "content" }, ctx);
    toolEndHandler?.handler({ toolName: "read_file", output: "content" }, ctx);

    expect(mockBroadcastEvent).toHaveBeenCalledWith({
      type: "tool_execution_start",
      toolName: "read_file",
      input: { path: "/tmp/test" },
    });
    expect(mockBroadcastEvent).toHaveBeenCalledWith({
      type: "tool_execution_update",
      toolName: "read_file",
      output: "content",
    });
    expect(mockBroadcastEvent).toHaveBeenCalledWith({
      type: "tool_execution_end",
      toolName: "read_file",
      output: "content",
    });
  });

  it("broadcastEvent is not called before connect (no active server)", async () => {
    const { default: browserConnectExtension } = await import("./browserConnectExtension");
    const { pi, ctx, onCalls } = createFakePi();

    browserConnectExtension(pi);

    // Fire message_update BEFORE connecting (no active server)
    const messageUpdateHandler = onCalls.find((c) => c.event === "message_update");
    expect(() => {
      messageUpdateHandler?.handler(
        { message: { role: "assistant", id: "msg-1" }, assistantMessageEvent: { type: "text_delta", text_delta: "test" } },
        ctx,
      );
    }).not.toThrow();

    // Should not have called broadcastEvent (server is undefined)
    expect(mockBroadcastEvent).not.toHaveBeenCalled();
  });
});

describe("mirror snapshot — entries from sessionManager.getBranch()", () => {
  it("buildSnapshot includes entries from sessionManager.getBranch()", async () => {
    const { default: browserConnectExtension } = await import("./browserConnectExtension");
    const { pi, ctx, registerCommandCalls } = createFakePi();

    // Симулируем sessionManager с entry-записями
    const mockSessionManager = {
      getBranch: () => [
        { type: "message", id: "e1", parentId: null, timestamp: "2025-01-01T00:00:00Z", message: { role: "user", content: [{ type: "text", text: "Первый вопрос" }] } },
        { type: "message", id: "e2", parentId: "e1", timestamp: "2025-01-01T00:00:01Z", message: { role: "assistant", id: "e2", content: [{ type: "text", text: "Ответ на первый вопрос" }] } },
        { type: "message", id: "e3", parentId: "e2", timestamp: "2025-01-01T00:00:02Z", message: { role: "user", content: [{ type: "text", text: "Второй вопрос" }] } },
        { type: "message", id: "e4", parentId: "e3", timestamp: "2025-01-01T00:00:03Z", message: { role: "assistant", id: "e4", content: [{ type: "text", text: "Ответ на второй вопрос" }] } },
      ],
    };
    (ctx as unknown as Record<string, unknown>).sessionManager = mockSessionManager;

    browserConnectExtension(pi);

    const connectEntry = registerCommandCalls.find((c) => c.name === "chrome-assistent-connect");
    await connectEntry!.handler("", ctx);

    // Получить snapshot
    const snapshot = capturedSessionServerOptions!.buildSnapshot();

    // В mirror-архитектуре snapshot.chat.entries должен содержать raw entries
    // вместо синтетических chat.events
    const entries = snapshot.chat.entries;
    expect(Array.isArray(entries)).toBe(true);
    expect(entries.length).toBeGreaterThanOrEqual(4);
  });

  it("snapshot.chat.entries preserves faithful entry shapes from sessionManager", async () => {
    const { default: browserConnectExtension } = await import("./browserConnectExtension");
    const { pi, ctx, registerCommandCalls } = createFakePi();

    const mockSessionManager = {
      getBranch: () => [
        { type: "message", id: "u1", parentId: null, timestamp: "2025-06-01T10:00:00Z", message: { role: "user", content: "Здравствуй" } },
        { type: "message", id: "a1", parentId: "u1", timestamp: "2025-06-01T10:00:01Z", message: { role: "assistant", id: "a1", content: [{ type: "text", text: "Привет! Чем могу помочь?" }] } },
      ],
    };
    (ctx as unknown as Record<string, unknown>).sessionManager = mockSessionManager;

    browserConnectExtension(pi);

    const connectEntry = registerCommandCalls.find((c) => c.name === "chrome-assistent-connect");
    await connectEntry!.handler("", ctx);

    const snapshot = capturedSessionServerOptions!.buildSnapshot();
    const entries = snapshot.chat.entries;

    // Проверяем что entries — это именно объекты из sessionManager, а не синтетические ChatEvent
    expect(entries[0]).toHaveProperty("type", "message");
    expect(entries[0]).toHaveProperty("id", "u1");
    expect(entries[0].message.role).toBe("user");

    expect(entries[1]).toHaveProperty("type", "message");
    expect(entries[1]).toHaveProperty("id", "a1");
    expect(entries[1].message.role).toBe("assistant");
  });

  it("snapshot.chat.entries is empty array when sessionManager returns empty branch", async () => {
    const { default: browserConnectExtension } = await import("./browserConnectExtension");
    const { pi, ctx, registerCommandCalls } = createFakePi();

    const mockSessionManager = {
      getBranch: () => [],
    };
    (ctx as unknown as Record<string, unknown>).sessionManager = mockSessionManager;

    browserConnectExtension(pi);

    const connectEntry = registerCommandCalls.find((c) => c.name === "chrome-assistent-connect");
    await connectEntry!.handler("", ctx);

    const snapshot = capturedSessionServerOptions!.buildSnapshot();
    expect(snapshot.chat.entries).toEqual([]);
  });

  it("snapshot.chat.agentBusy reflects ctx.isIdle()", async () => {
    const { default: browserConnectExtension } = await import("./browserConnectExtension");
    const { pi, ctx, registerCommandCalls } = createFakePi();

    const mockSessionManager = { getBranch: () => [] };
    (ctx as unknown as Record<string, unknown>).sessionManager = mockSessionManager;

    // isIdle = true => agentBusy = false
    ctx.isIdle = () => true;

    browserConnectExtension(pi);

    const connectEntry = registerCommandCalls.find((c) => c.name === "chrome-assistent-connect");
    await connectEntry!.handler("", ctx);

    let snapshot = capturedSessionServerOptions!.buildSnapshot();
    expect(snapshot.chat.agentBusy).toBe(false);

    // isIdle = false => agentBusy = true
    ctx.isIdle = () => false;
    snapshot = capturedSessionServerOptions!.buildSnapshot();
    expect(snapshot.chat.agentBusy).toBe(true);
  });

  it("snapshot.chat.busyLabel is Russian", async () => {
    const { default: browserConnectExtension } = await import("./browserConnectExtension");
    const { pi, ctx, registerCommandCalls } = createFakePi();

    const mockSessionManager = { getBranch: () => [] };
    (ctx as unknown as Record<string, unknown>).sessionManager = mockSessionManager;

    browserConnectExtension(pi);

    const connectEntry = registerCommandCalls.find((c) => c.name === "chrome-assistent-connect");
    await connectEntry!.handler("", ctx);

    const snapshot = capturedSessionServerOptions!.buildSnapshot();
    expect(snapshot.chat.busyLabel).toBe("Агент работает в фоне…");
  });
});

// --- Удалён блок mergeChatEvents (устаревшая overlap-merge стратегия) ---

// --- Удалён блок snapshot merge — duplicate avoidance (устаревшая overlap-merge стратегия) ---
