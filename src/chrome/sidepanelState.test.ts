import { describe, expect, it } from "vitest";

import {
  createInitialSidePanelState,
  chooseSidePanelSelectedTargetId,
  formatSidePanelStatus,
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
  it("keeps the selected target when it still exists after a dynamic update", () => {
    expect(chooseSidePanelSelectedTargetId(
      [{ targetId: "target-1" }, { targetId: "target-2" }],
      ["target-2"],
    )).toBe("target-2");
  });

  it("clears the selected target when it disappears after a dynamic update", () => {
    expect(chooseSidePanelSelectedTargetId(
      [{ targetId: "target-2" }],
      ["target-1"],
    )).toBeUndefined();
  });

  it("does not automatically select the only available target without an explicit preference", () => {
    expect(chooseSidePanelSelectedTargetId(
      [{ targetId: "target-2" }],
      [undefined],
    )).toBeUndefined();
  });

  it("restores a stored selected target when it appears in the current target list", () => {
    expect(chooseSidePanelSelectedTargetId(
      [{ targetId: "target-2" }],
      [undefined, "target-2"],
    )).toBe("target-2");
  });

  it.each([
    [
      "broker unavailable",
      { brokerOnline: false, bridgeOnline: false, tokenConfigured: true, browserAuthorized: true, targetsCount: 0, selectedTargetAvailable: false, connecting: false },
      "Pi не подключён. Выполните /chrome-assistent-connect в терминале.",
    ],
    [
      "token missing",
      { brokerOnline: true, bridgeOnline: false, tokenConfigured: false, browserAuthorized: undefined, targetsCount: 0, selectedTargetAvailable: false, connecting: false },
      "Для отправки настройте browserToken в chrome.storage.local.",
    ],
    [
      "token missing while broker is offline",
      { brokerOnline: false, bridgeOnline: false, tokenConfigured: false, browserAuthorized: undefined, targetsCount: 0, selectedTargetAvailable: false, connecting: false },
      "Для отправки настройте browserToken в chrome.storage.local.",
    ],
    [
      "auth error",
      { brokerOnline: true, bridgeOnline: false, tokenConfigured: true, browserAuthorized: false, targetsCount: 0, selectedTargetAvailable: false, connecting: false },
      "Браузер не авторизован в Pi. Выполните /chrome-assistent-auth в терминале.",
    ],
    [
      "auth error while broker is offline",
      { brokerOnline: false, bridgeOnline: false, tokenConfigured: true, browserAuthorized: false, targetsCount: 0, selectedTargetAvailable: false, connecting: false },
      "Браузер не авторизован в Pi. Выполните /chrome-assistent-auth в терминале.",
    ],
    [
      "targets empty",
      { brokerOnline: true, bridgeOnline: true, tokenConfigured: true, browserAuthorized: true, targetsCount: 0, selectedTargetAvailable: false, connecting: false },
      "Pi подключён · нет активных целей",
    ],
    [
      "selected target gone",
      { brokerOnline: true, bridgeOnline: true, tokenConfigured: true, browserAuthorized: true, targetsCount: 2, selectedTargetId: "target-1", selectedTargetAvailable: false, connecting: false },
      "Pi подключён · выбранная сессия закрыта",
    ],
    [
      "normal",
      { brokerOnline: true, bridgeOnline: true, tokenConfigured: true, browserAuthorized: true, targetsCount: 2, selectedTargetId: "target-1", selectedTargetAvailable: true, connecting: false },
      "Pi подключён · целей: 2",
    ],
  ])("formats %s status", (_name, status, expected) => {
    expect(formatSidePanelStatus(status)).toBe(expected);
  });

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
