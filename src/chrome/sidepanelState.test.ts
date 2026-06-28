import { describe, expect, it } from "vitest";

import type { SessionEntryLike, PiMirrorEvent } from "../shared/protocol";
import {
  createInitialSidePanelState,
  reduceSidePanelChatEvent,
  startSendingUserMessage,
  hydrateMessagesFromEntries,
  applyMirrorEventToChatState,
  type SidePanelState,
} from "./sidepanelState";

function createState(overrides: Partial<SidePanelState> = {}): SidePanelState {
  return {
    ...createInitialSidePanelState(),
    ...overrides,
  };
}

describe("sidepanelState", () => {
  it("appends user messages and enables the busy indicator", () => {
    const state = startSendingUserMessage(createState(), "Привет", 1_710_000_000_000);

    expect(state.messages).toEqual([
      {
        role: "user",
        text: "Привет",
        timestamp: 1_710_000_000_000,
      },
    ]);
    expect(state.agentBusy).toBe(true);
    expect(state.busyLabel).toBe("Агент работает в фоне…");
    expect(state.sending).toBe(true);
  });

  it("creates a streaming assistant message on assistant_message_start", () => {
    const state = reduceSidePanelChatEvent(createState({ agentBusy: true, sending: true }), {
      kind: "assistant_message_start",
      messageId: "message-1",
      timestamp: 1_710_000_000_100,
    });

    expect(state.messages).toEqual([
      {
        role: "assistant",
        messageId: "message-1",
        text: "",
        streaming: true,
        timestamp: 1_710_000_000_100,
      },
    ]);
    expect(state.agentBusy).toBe(true);
    expect(state.sending).toBe(false);
  });

  it("appends assistant text deltas to the matching assistant message", () => {
    const state = reduceSidePanelChatEvent(
      createState({
        messages: [
          {
            role: "assistant",
            messageId: "message-1",
            text: "При",
            streaming: true,
            timestamp: 1_710_000_000_100,
          },
        ],
      }),
      {
        kind: "assistant_text_delta",
        messageId: "message-1",
        delta: "вет",
        timestamp: 1_710_000_000_200,
      },
    );

    expect(state.messages).toEqual([
      {
        role: "assistant",
        messageId: "message-1",
        text: "Привет",
        streaming: true,
        timestamp: 1_710_000_000_100,
      },
    ]);
  });

  it("marks assistant messages non-streaming and clears busy on assistant_message_end", () => {
    const state = reduceSidePanelChatEvent(
      createState({
        agentBusy: true,
        sending: true,
        messages: [
          {
            role: "assistant",
            messageId: "message-1",
            text: "Готово",
            streaming: true,
            timestamp: 1_710_000_000_100,
          },
        ],
      }),
      {
        kind: "assistant_message_end",
        messageId: "message-1",
        timestamp: 1_710_000_000_300,
      },
    );

    expect(state.messages).toEqual([
      {
        role: "assistant",
        messageId: "message-1",
        text: "Готово",
        streaming: false,
        timestamp: 1_710_000_000_100,
      },
    ]);
    expect(state.agentBusy).toBe(false);
    expect(state.sending).toBe(false);
  });

  it("appends system errors and clears busy and sending", () => {
    const state = reduceSidePanelChatEvent(createState({ agentBusy: true, sending: true }), {
      kind: "error",
      message: "Не удалось отправить сообщение",
      timestamp: 1_710_000_000_400,
    });

    expect(state.messages).toEqual([
      {
        role: "system",
        text: "Не удалось отправить сообщение",
        tone: "error",
        timestamp: 1_710_000_000_400,
      },
    ]);
    expect(state.agentBusy).toBe(false);
    expect(state.sending).toBe(false);
    expect(state.error).toBe("Не удалось отправить сообщение");
  });
});

describe("message limit", () => {
  it("should keep only last 500 messages", () => {
    let state = createInitialSidePanelState();

    // Add 600 user messages
    for (let i = 0; i < 600; i++) {
      state = startSendingUserMessage(state, `Message ${i}`, i);
    }

    expect(state.messages.length).toBe(500);
    // Should keep the latest messages
    expect((state.messages[0] as { text: string }).text).toBe("Message 100");
    expect((state.messages[499] as { text: string }).text).toBe("Message 599");
  });
});

describe("hydrateMessagesFromEntries", () => {
  it("hydrates user and assistant messages from entries", () => {
    const entries: SessionEntryLike[] = [
      {
        type: "message",
        id: "e1",
        timestamp: "2025-01-01T00:00:00Z",
        message: {
          role: "user",
          content: [{ type: "text", text: "Привет, Pi!" }],
        },
      },
      {
        type: "message",
        id: "e2",
        timestamp: "2025-01-01T00:00:01Z",
        message: {
          role: "assistant",
          id: "msg-1",
          content: [{ type: "text", text: "Привет! Как могу помочь?" }],
        },
      },
    ];

    const messages = hydrateMessagesFromEntries(entries);

    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({
      role: "user",
      text: "Привет, Pi!",
    });
    expect(messages[1]).toMatchObject({
      role: "assistant",
      messageId: "msg-1",
      text: "Привет! Как могу помочь?",
      streaming: false,
    });
  });

  it("returns empty array for empty entries", () => {
    const messages = hydrateMessagesFromEntries([]);
    expect(messages).toEqual([]);
  });

  it("skips non-user/non-assistant roles", () => {
    const entries: SessionEntryLike[] = [
      {
        type: "message",
        id: "e1",
        timestamp: "2025-01-01T00:00:00Z",
        message: {
          role: "user",
          content: [{ type: "text", text: "Hello" }],
        },
      },
      {
        type: "message",
        id: "e2",
        timestamp: "2025-01-01T00:00:01Z",
        message: {
          role: "toolResult",
          content: [{ type: "text", text: "tool output" }],
        },
      },
    ];

    const messages = hydrateMessagesFromEntries(entries);
    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe("user");
  });

  it("handles string content in entries", () => {
    const entries: SessionEntryLike[] = [
      {
        type: "message",
        id: "e1",
        timestamp: "2025-01-01T00:00:00Z",
        message: {
          role: "user",
          content: "Simple text content",
        },
      },
    ];

    const messages = hydrateMessagesFromEntries(entries);
    expect(messages[0]).toMatchObject({
      role: "user",
      text: "Simple text content",
    });
  });
});

describe("applyMirrorEventToChatState", () => {
  it("creates streaming assistant message on message_start", () => {
    const state = createInitialSidePanelState();
    const event: PiMirrorEvent = {
      type: "message_start",
      message: { id: "live-1", role: "assistant" },
    };

    const result = applyMirrorEventToChatState(state, event);

    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]).toMatchObject({
      role: "assistant",
      messageId: "live-1",
      text: "",
      streaming: true,
    });
    expect(result.agentBusy).toBe(true);
  });

  it("appends text_delta from message_update to streaming message", () => {
    const state = createInitialSidePanelState();
    state.messages = [
      {
        role: "assistant",
        messageId: "live-1",
        text: "При",
        streaming: true,
        timestamp: Date.now(),
      },
    ];

    const event: PiMirrorEvent = {
      type: "message_update",
      message: { id: "live-1", role: "assistant" },
      assistantMessageEvent: { type: "text_delta", text_delta: "вет" },
    };

    const result = applyMirrorEventToChatState(state, event);

    expect(result.messages[0]).toMatchObject({
      role: "assistant",
      messageId: "live-1",
      text: "Привет",
      streaming: true,
    });
  });

  it("creates message if message_update arrives before message_start", () => {
    const state = createInitialSidePanelState();

    const event: PiMirrorEvent = {
      type: "message_update",
      message: { id: "live-2", role: "assistant" },
      assistantMessageEvent: { type: "text_delta", text_delta: "Текст" },
    };

    const result = applyMirrorEventToChatState(state, event);

    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]).toMatchObject({
      role: "assistant",
      messageId: "live-2",
      text: "Текст",
      streaming: true,
    });
  });

  it("finalizes streaming message on message_end", () => {
    const state = createInitialSidePanelState();
    state.messages = [
      {
        role: "assistant",
        messageId: "live-1",
        text: "Готово",
        streaming: true,
        timestamp: Date.now(),
      },
    ];
    state.agentBusy = true;

    const event: PiMirrorEvent = {
      type: "message_end",
      message: { id: "live-1", role: "assistant" },
    };

    const result = applyMirrorEventToChatState(state, event);

    expect(result.messages[0]).toMatchObject({
      role: "assistant",
      messageId: "live-1",
      text: "Готово",
      streaming: false,
    });
    expect(result.agentBusy).toBe(false);
  });

  it("ignores non-assistant roles on message_start", () => {
    const state = createInitialSidePanelState();
    const event: PiMirrorEvent = {
      type: "message_start",
      message: { id: "live-1", role: "user" },
    };

    const result = applyMirrorEventToChatState(state, event);

    expect(result.messages).toEqual([]);
  });

  it("ignores unknown event types safely", () => {
    const state = createInitialSidePanelState();
    state.messages = [
      {
        role: "user",
        text: "Hello",
        timestamp: Date.now(),
      },
    ];

    const event: PiMirrorEvent = {
      type: "turn_start",
      turnId: "turn-1",
    };

    const result = applyMirrorEventToChatState(state, event);

    expect(result.messages).toEqual(state.messages);
  });

  it("ignores message_update without text_delta", () => {
    const state = createInitialSidePanelState();
    state.messages = [
      {
        role: "assistant",
        messageId: "live-1",
        text: "Existing",
        streaming: true,
        timestamp: Date.now(),
      },
    ];

    const event: PiMirrorEvent = {
      type: "message_update",
      message: { id: "live-1", role: "assistant" },
    };

    const result = applyMirrorEventToChatState(state, event);

    expect(result.messages[0]).toMatchObject({
      text: "Existing",
    });
  });

  it("сбрасывает agentBusy и sending при получении turn_end", () => {
    const state = createInitialSidePanelState();
    state.agentBusy = true;
    state.sending = true;

    const event: PiMirrorEvent = {
      type: "turn_end",
      turnId: "turn-1",
    };

    const result = applyMirrorEventToChatState(state, event);

    expect(result.agentBusy).toBe(false);
    expect(result.sending).toBe(false);
  });
});
