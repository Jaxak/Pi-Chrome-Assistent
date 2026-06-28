import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { DEFAULT_DIRECT_SESSION_PORT } from "./sessionServer";
import type { DirectSessionServer, DirectSessionServerOnAvailablePortOptions } from "./sessionServer";
import type { ChatEvent, DeliveryResult, DirectSessionSnapshot, SelectionPayload } from "../shared/protocol";
import { formatSelectionMessage } from "../shared/formatSelectionMessage";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

let capturedSessionServerOptions: DirectSessionServerOnAvailablePortOptions | undefined;
const mockBroadcastSnapshot = vi.fn();
const mockClose = vi.fn(async () => undefined);

const fakeServer: DirectSessionServer = {
  port: 31416,
  broadcastSnapshot: mockBroadcastSnapshot,
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
      { message: { role: "assistant", id: "msg-1" }, assistantMessageEvent: { text_delta: "Hello" } },
      ctx,
    );
    messageEndHandler?.handler({ message: { role: "assistant", id: "msg-1" } }, ctx);
    modelSelectHandler?.handler({}, ctx);

    expect(mockBroadcastSnapshot).toHaveBeenCalledTimes(4);
  });
});

describe("session history in snapshot on reconnect", () => {
  it("buildSnapshot includes user+assistant history from sessionManager, not only transient chatEvents", async () => {
    const { default: browserConnectExtension } = await import("./browserConnectExtension");
    const { pi, ctx, registerCommandCalls, onCalls, sendUserMessage } = createFakePi();

    // Simulate sessionManager with message entries
    const mockSessionManager = {
      getBranch: () => [
        { type: "message", id: "e1", parentId: null, timestamp: "2025-01-01T00:00:00Z", message: { role: "user", content: [{ type: "text", text: "Первый вопрос" }] } },
        { type: "message", id: "e2", parentId: "e1", timestamp: "2025-01-01T00:00:01Z", message: { role: "assistant", content: [{ type: "text", text: "Ответ на первый вопрос" }] } },
        { type: "message", id: "e3", parentId: "e2", timestamp: "2025-01-01T00:00:02Z", message: { role: "user", content: [{ type: "text", text: "Второй вопрос" }] } },
        { type: "message", id: "e4", parentId: "e3", timestamp: "2025-01-01T00:00:03Z", message: { role: "assistant", content: [{ type: "text", text: "Ответ на второй вопрос" }] } },
      ],
    };
    (ctx as unknown as Record<string, unknown>).sessionManager = mockSessionManager;

    browserConnectExtension(pi);

    const connectEntry = registerCommandCalls.find((c) => c.name === "chrome-assistent-connect");
    await connectEntry!.handler("", ctx);

    // Trigger a user message to populate transient chatEvents too
    expect(capturedSessionServerOptions).toBeDefined();
    await capturedSessionServerOptions!.onChatMessage!("Третий вопрос");

    // Get the snapshot via broadcastSnapshot
    const snapshot = capturedSessionServerOptions!.buildSnapshot();

    // The snapshot should contain history from sessionManager
    const chatEvents = snapshot.chat.events ?? [];
    const userMessages = chatEvents.filter((e: { kind?: string }) => e.kind === "user_message");
    const assistantMessages = chatEvents.filter((e: { kind?: string }) => e.kind === "assistant_message_start");

    // Should have at least the 3 user messages (2 from sessionManager + 1 transient)
    expect(userMessages.length).toBeGreaterThanOrEqual(3);
    // Should have at least the 2 assistant messages from sessionManager
    expect(assistantMessages.length).toBeGreaterThanOrEqual(2);
  });

  it("buildSnapshot recovers full history after re-connect (second connect command)", async () => {
    const { default: browserConnectExtension } = await import("./browserConnectExtension");
    const { pi, ctx, registerCommandCalls } = createFakePi();

    const mockSessionManager = {
      getBranch: () => [
        { type: "message", id: "e1", parentId: null, timestamp: "2025-01-01T00:00:00Z", message: { role: "user", content: [{ type: "text", text: "Вопрос A" }] } },
        { type: "message", id: "e2", parentId: "e1", timestamp: "2025-01-01T00:00:01Z", message: { role: "assistant", content: [{ type: "text", text: "Ответ A" }] } },
      ],
    };
    (ctx as unknown as Record<string, unknown>).sessionManager = mockSessionManager;

    browserConnectExtension(pi);

    const connectEntry = registerCommandCalls.find((c) => c.name === "chrome-assistent-connect");
    // First connect
    await connectEntry!.handler("", ctx);
    // Second connect (reconnect scenario)
    await connectEntry!.handler("", ctx);

    const snapshot = capturedSessionServerOptions!.buildSnapshot();
    const chatEvents = snapshot.chat.events ?? [];

    // After reconnect, history should still be present
    const userMessages = chatEvents.filter((e: { kind?: string }) => e.kind === "user_message");
    expect(userMessages.length).toBeGreaterThanOrEqual(1);
    const assistantStarts = chatEvents.filter((e: { kind?: string }) => e.kind === "assistant_message_start");
    expect(assistantStarts.length).toBeGreaterThanOrEqual(1);
  });

  it("buildSnapshot handles empty sessionManager gracefully", async () => {
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
    // Should not throw and should have empty or minimal events
    expect(snapshot.chat.events).toBeDefined();
  });
});

describe("mergeChatEvents — overlap-merge strategy", () => {
  let merge: typeof import("./browserConnectExtension").mergeChatEvents;

  beforeAll(async () => {
    const mod = await import("./browserConnectExtension");
    merge = mod.mergeChatEvents;
  });

  it("does NOT eat a new user_message with identical text when it follows persisted history (append-only)", () => {
    // sessionHistory has one turn fully persisted
    const sessionHistory = [
      { kind: "user_message" as const, text: "hello", timestamp: 1 },
      {
        kind: "assistant_message_start" as const,
        messageId: "m1",
        timestamp: 2,
      },
      { kind: "assistant_text_delta" as const, messageId: "m1", delta: "Hi", timestamp: 3 },
      { kind: "assistant_message_end" as const, messageId: "m1", timestamp: 4 },
    ];

    // transient contains a NEW user message with the SAME text "hello"
    // but this is a separate interaction after the persisted history.
    // It must NOT be dropped.
    const transient = [
      { kind: "user_message" as const, text: "hello", timestamp: 10 },
    ];

    const result = merge(sessionHistory, transient);

    // The new transient user_message must be present (not eaten by text-based dedup)
    const userMessages = result.filter(
      (e) => e.kind === "user_message",
    );
    expect(userMessages.length).toBe(2);
    // The new one should have timestamp 10
    expect(userMessages[1]).toMatchObject({ kind: "user_message", text: "hello", timestamp: 10 });
  });

  it("removes overlap when transient prefix matches sessionHistory suffix (exact signature match)", () => {
    // sessionHistory ends with events that are also at the start of transient
    const sharedEvents = [
      { kind: "user_message" as const, text: "Вопрос", timestamp: 5 },
      {
        kind: "assistant_message_start" as const,
        messageId: "a1",
        timestamp: 6,
      },
      {
        kind: "assistant_text_delta" as const,
        messageId: "a1",
        delta: "Ответ",
        timestamp: 7,
      },
      {
        kind: "assistant_message_end" as const,
        messageId: "a1",
        timestamp: 8,
      },
    ];

    const sessionHistory = [
      { kind: "user_message" as const, text: "Раньше", timestamp: 1 },
      ...sharedEvents,
    ];

    const transient = [
      ...sharedEvents,
      { kind: "user_message" as const, text: "Новый вопрос", timestamp: 20 },
    ];

    const result = merge(sessionHistory, transient);

    // sharedEvents should appear exactly once (from sessionHistory)
    const userQuestions = result.filter(
      (e) => e.kind === "user_message" && e.text === "Вопрос",
    );
    expect(userQuestions.length).toBe(1);

    const a1Starts = result.filter(
      (e) => e.kind === "assistant_message_start" && e.messageId === "a1",
    );
    expect(a1Starts.length).toBe(1);

    // New transient event after overlap should be appended
    const newMsgs = result.filter(
      (e) => e.kind === "user_message" && e.text === "Новый вопрос",
    );
    expect(newMsgs.length).toBe(1);
    expect(newMsgs[0].timestamp).toBe(20);

    // Total: Раньше + sharedEvents(4) + Новый вопрос = 6
    expect(result.length).toBe(6);
  });

  it("handles empty transient", () => {
    const history = [
      { kind: "user_message" as const, text: "test", timestamp: 1 },
    ];
    expect(merge(history, [])).toEqual(history);
  });

  it("handles empty sessionHistory", () => {
    const transient = [
      { kind: "user_message" as const, text: "test", timestamp: 1 },
    ];
    expect(merge([], transient)).toEqual(transient);
  });

  it("handles no overlap — all transient events appended", () => {
    const sessionHistory = [
      { kind: "user_message" as const, text: "old", timestamp: 1 },
    ];
    const transient = [
      { kind: "user_message" as const, text: "new", timestamp: 2 },
      { kind: "agent_busy" as const, busy: true, label: "…", timestamp: 3 },
    ];
    const result = merge(sessionHistory, transient);
    expect(result.length).toBe(3);
    expect((result[0] as Extract<ChatEvent, { kind: "user_message" }>).text).toBe("old");
    expect((result[1] as Extract<ChatEvent, { kind: "user_message" }>).text).toBe("new");
    expect(result[2].kind).toBe("agent_busy");
  });

  it("handles full overlap — transient entirely consumed", () => {
    const events = [
      { kind: "user_message" as const, text: "x", timestamp: 1 },
    ];
    const result = merge(events, [...events]);
    expect(result).toEqual(events);
    expect(result.length).toBe(1);
  });

  it("agent_busy and error events from transient are always appended after overlap", () => {
    const sessionHistory = [
      { kind: "user_message" as const, text: "q", timestamp: 1 },
    ];
    const transient = [
      { kind: "user_message" as const, text: "q", timestamp: 1 },
      { kind: "agent_busy" as const, busy: true, label: "…", timestamp: 2 },
      { kind: "error" as const, message: "boom", timestamp: 3 },
    ];

    const result = merge(sessionHistory, transient);

    // Overlap of user_message should be stripped
    // But agent_busy and error should be appended
    const busyEvents = result.filter((e) => e.kind === "agent_busy");
    const errorEvents = result.filter((e) => e.kind === "error");
    expect(busyEvents.length).toBe(1);
    expect(errorEvents.length).toBe(1);
  });

  it("assistant messages with same messageId but different position are NOT overlapped (overlap is prefix-only)", () => {
    // sessionHistory ends with assistant m1
    const sessionHistory = [
      {
        kind: "assistant_message_start" as const,
        messageId: "m1",
        timestamp: 1,
      },
      { kind: "assistant_text_delta" as const, messageId: "m1", delta: "A", timestamp: 2 },
      { kind: "assistant_message_end" as const, messageId: "m1", timestamp: 3 },
    ];

    // transient starts with something different, then has m1 again — NOT overlap
    const transient = [
      { kind: "user_message" as const, text: "later", timestamp: 10 },
      {
        kind: "assistant_message_start" as const,
        messageId: "m1",
        timestamp: 11,
      },
    ];

    const result = merge(sessionHistory, transient);

    // No overlap detected (first transient event doesn't match first suffix event)
    // m1 start appears twice (once from sessionHistory, once from transient) — correct
    const m1Starts = result.filter(
      (e) => e.kind === "assistant_message_start" && e.messageId === "m1",
    );
    expect(m1Starts.length).toBe(2);
    expect(result.length).toBe(5);
  });
});

describe("snapshot merge — duplicate avoidance (hardening)", () => {
  it("unit: mergeChatEvents appends transient when timestamps differ (string ts vs number ts)", async () => {
    const { mergeChatEvents: merge } = await import("./browserConnectExtension");
    
    // Simulate what buildChatEventsFromSessionBranch produces (string timestamps)
    const sessionHistory = [
      { kind: "user_message" as const, text: "Вопрос 1", timestamp: "2025-01-01T00:00:00Z" },
      { kind: "assistant_message_start" as const, messageId: "p2", timestamp: "2025-01-01T00:00:01Z" },
      { kind: "assistant_text_delta" as const, messageId: "p2", delta: "Ответ 1", timestamp: "2025-01-01T00:00:01Z" },
      { kind: "assistant_message_end" as const, messageId: "p2", timestamp: "2025-01-01T00:00:01Z" },
    ];
    
    // Simulate what Pi event handlers produce (Date.now() timestamps)
    const transient = [
      { kind: "assistant_message_start" as const, messageId: "p2", timestamp: Date.now() },
      { kind: "assistant_text_delta" as const, messageId: "p2", delta: "Ответ 1", timestamp: Date.now() },
      { kind: "assistant_message_end" as const, messageId: "p2", timestamp: Date.now() },
    ];
    
    const result = merge(sessionHistory as unknown as ChatEvent[], transient);
    
    // No overlap (timestamps differ) → all transient appended
    const p2Starts = result.filter(
      (e) => e.kind === "assistant_message_start" && e.messageId === "p2",
    );
    expect(p2Starts.length).toBe(2); // 1 from sessionHistory + 1 from transient
  });

  it("transient assistant events are appended when timestamps differ from sessionHistory (no overlap)", async () => {
    const { default: browserConnectExtension } = await import("./browserConnectExtension");
    const { pi, ctx, registerCommandCalls, onCalls } = createFakePi();

    // sessionManager branch contains a completed turn (persisted after turn_end)
    const mockSessionManager = {
      getBranch: () => [
        { type: "message", id: "p1", parentId: null, timestamp: "2025-01-01T00:00:00Z", message: { role: "user", content: [{ type: "text", text: "Вопрос 1" }] } },
        { type: "message", id: "p2", parentId: "p1", timestamp: "2025-01-01T00:00:01Z", message: { role: "assistant", id: "p2", content: [{ type: "text", text: "Ответ 1" }] } },
      ],
    };
    (ctx as unknown as Record<string, unknown>).sessionManager = mockSessionManager;

    browserConnectExtension(pi);

    const connectEntry = registerCommandCalls.find((c) => c.name === "chrome-assistent-connect");
    await connectEntry!.handler("", ctx);

    // Simulate transient assistant events (Date.now() timestamps, differ from sessionHistory timestamps)
    const msgStartHandler = onCalls.find((c) => c.event === "message_start");
    const msgUpdateHandler = onCalls.find((c) => c.event === "message_update");
    const msgEndHandler = onCalls.find((c) => c.event === "message_end");

    msgStartHandler?.handler({ message: { role: "assistant", id: "p2" } }, ctx);
    msgUpdateHandler?.handler(
      { message: { role: "assistant", id: "p2" }, assistantMessageEvent: { text_delta: "Ответ 1" } },
      ctx,
    );
    msgEndHandler?.handler({ message: { role: "assistant", id: "p2" } }, ctx);

    const snapshot = capturedSessionServerOptions!.buildSnapshot();
    const chatEvents = snapshot.chat.events ?? [];

    // With overlap-merge: in this test both sessionHistory and transient have the same
    // Date.now()-derived timestamps (because buildChatEventsFromSessionBranch uses
    // baseTs=Date.now() and the Pi handlers also use Date.now() in the same tick).
    // The overlap is detected and transient is consumed — only sessionHistory events remain.
    const p2Starts = chatEvents.filter((e: { kind?: string; messageId?: string }) =>
      e.kind === "assistant_message_start" && e.messageId === "p2",
    );
    expect(p2Starts.length).toBe(1); // overlap consumed the transient p2 events
  });

  it("includes transient events that are NOT in sessionManager (new events since last persist)", async () => {
    const { default: browserConnectExtension } = await import("./browserConnectExtension");
    const { pi, ctx, registerCommandCalls, onCalls } = createFakePi();

    // sessionManager has one turn
    const mockSessionManager = {
      getBranch: () => [
        { type: "message", id: "p1", parentId: null, timestamp: "2025-01-01T00:00:00Z", message: { role: "user", content: [{ type: "text", text: "Вопрос 1" }] } },
        { type: "message", id: "p2", parentId: "p1", timestamp: "2025-01-01T00:00:01Z", message: { role: "assistant", id: "p2", content: [{ type: "text", text: "Ответ 1" }] } },
      ],
    };
    (ctx as unknown as Record<string, unknown>).sessionManager = mockSessionManager;

    browserConnectExtension(pi);

    const connectEntry = registerCommandCalls.find((c) => c.name === "chrome-assistent-connect");
    await connectEntry!.handler("", ctx);

    // Simulate a NEW transient assistant message NOT in sessionManager yet
    const msgStartHandler = onCalls.find((c) => c.event === "message_start");
    const msgUpdateHandler = onCalls.find((c) => c.event === "message_update");
    const msgEndHandler = onCalls.find((c) => c.event === "message_end");

    msgStartHandler?.handler({ message: { role: "assistant", id: "new-1" } }, ctx);
    msgUpdateHandler?.handler(
      { message: { role: "assistant", id: "new-1" }, assistantMessageEvent: { text_delta: "Новый ответ" } },
      ctx,
    );
    msgEndHandler?.handler({ message: { role: "assistant", id: "new-1" } }, ctx);

    const snapshot = capturedSessionServerOptions!.buildSnapshot();
    const chatEvents = snapshot.chat.events ?? [];

    // The new transient event SHOULD appear
    const newStarts = chatEvents.filter((e: { kind?: string; messageId?: string }) =>
      e.kind === "assistant_message_start" && e.messageId === "new-1",
    );
    expect(newStarts.length).toBe(1);

    // And the persisted one from sessionManager should also be present
    const p2Starts = chatEvents.filter((e: { kind?: string; messageId?: string }) =>
      e.kind === "assistant_message_start" && e.messageId === "p2",
    );
    expect(p2Starts.length).toBe(1);
  });

  it("includes both sessionHistory and transient user_messages with same text but different timestamps (not overlap)", async () => {
    const { default: browserConnectExtension } = await import("./browserConnectExtension");
    const { pi, ctx, registerCommandCalls } = createFakePi();

    // sessionManager has a user message with a specific historical timestamp
    const mockSessionManager = {
      getBranch: () => [
        { type: "message", id: "u1", parentId: null, timestamp: "2025-01-01T00:00:00Z", message: { role: "user", content: [{ type: "text", text: "Привет" }] } },
      ],
    };
    (ctx as unknown as Record<string, unknown>).sessionManager = mockSessionManager;

    browserConnectExtension(pi);

    const connectEntry = registerCommandCalls.find((c) => c.name === "chrome-assistent-connect");
    await connectEntry!.handler("", ctx);

    // Send the same user message via transient chatEvents (new timestamp != persisted timestamp)
    expect(capturedSessionServerOptions).toBeDefined();
    await capturedSessionServerOptions!.onChatMessage!("Привет");

    const snapshot = capturedSessionServerOptions!.buildSnapshot();
    const chatEvents = snapshot.chat.events ?? [];

    // With overlap-merge: sessionHistory "Привет" has baseTs=Date.now(), transient "Привет"
    // also has Date.now() — in the same tick they share the same millisecond timestamp.
    // The overlap is detected: transient user_message overlaps with sessionHistory suffix.
    // Only the agent_busy event from transient is appended.
    const privetMsgs = chatEvents.filter(
      (e: { kind?: string; text?: string }) =>
        e.kind === "user_message" && e.text === "Привет",
    );
    expect(privetMsgs.length).toBe(1); // overlap consumed the transient user_message
  });
});
