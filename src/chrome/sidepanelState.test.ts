import { describe, expect, it } from "vitest";

import {
  createInitialSidePanelState,
  reduceSidePanelChatEvent,
  startSendingUserMessage,
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
