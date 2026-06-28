import { describe, expect, it } from "vitest";

import type { DirectSessionSnapshot, TargetModelSummary, TargetContextUsage } from "../shared/protocol";
import {
  createInitialAssistantState,
  formatAssistantStatus,
  isChatSendDisabled,
  reduceAssistantState,
  type BackgroundAssistantState,
  type AssistantStateEvent,
} from "./assistantState";

const DEFAULT_PORT = 31415;

function createDirectSnapshot(overrides: Partial<DirectSessionSnapshot> = {}): DirectSessionSnapshot {
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

describe("assistantState", () => {
  describe("createInitialAssistantState", () => {
    it("creates initial direct session state with default port and offline connection", () => {
      const state = createInitialAssistantState();

      expect(state.epoch).toBe(0);
      expect(state.connection).toMatchObject({
        online: false,
        connecting: false,
        configuredPort: DEFAULT_PORT,
      });
      expect(state.session).toBeUndefined();
      expect(state.chat.messages).toEqual([]);
      expect(state.chat.agentBusy).toBe(false);
      expect(state.chat.sending).toBe(false);
      expect(state.runtime.availableModels).toEqual([]);
      expect(state.runtime.modelMutationPending).toBe(false);
      expect(state.diagnostics).toEqual([]);
    });
  });

  describe("reduceAssistantState - session_snapshot", () => {
    it("applies direct session snapshot and sets online", () => {
      const state = createInitialAssistantState();
      const snapshot = createDirectSnapshot();

      const nextState = reduceAssistantState(state, {
        kind: "session_snapshot",
        snapshot,
      });

      expect(nextState.connection.online).toBe(true);
      expect(nextState.connection.connecting).toBe(false);
      expect(nextState.connection.lastError).toBeUndefined();
      expect(nextState.session).toMatchObject({
        cwd: "/repo",
        gitBranch: "main",
        pid: 1234,
        connectedAt: 1_710_000_000_000,
      });
      expect(nextState.runtime.model).toEqual({
        provider: "anthropic",
        id: "claude-sonnet",
        label: "Claude Sonnet",
      });
      expect(nextState.runtime.availableModels).toEqual([
        { provider: "anthropic", id: "claude-sonnet", label: "Claude Sonnet" },
      ]);
      expect(nextState.runtime.contextUsage).toEqual({
        tokens: 1000,
        maxTokens: 200000,
        percent: 0.5,
      });
      expect(nextState.runtime.isIdle).toBe(true);
    });

    it("preserves configuredPort when applying snapshot", () => {
      let state = createInitialAssistantState();
      state = reduceAssistantState(state, {
        kind: "connection_updated",
        connection: { configuredPort: 31416 },
      });

      const nextState = reduceAssistantState(state, {
        kind: "session_snapshot",
        snapshot: createDirectSnapshot(),
      });

      expect(nextState.connection.configuredPort).toBe(31416);
      expect(nextState.connection.online).toBe(true);
    });

    // --- Mirror-behavior тесты ---

    it("snapshot с chat.entries рендерит полную сохранённую историю user/assistant сообщений", () => {
      const state = createInitialAssistantState();
      const snapshot = createDirectSnapshot({
        chat: {
          entries: [
            {
              type: "message" as const,
              id: "e1",
              timestamp: "2025-01-01T00:00:00Z",
              message: {
                role: "user" as const,
                content: [{ type: "text" as const, text: "Привет, Pi!" }],
              },
            },
            {
              type: "message" as const,
              id: "e2",
              timestamp: "2025-01-01T00:00:01Z",
              message: {
                role: "assistant" as const,
                id: "msg-1",
                content: [{ type: "text" as const, text: "Привет! Как могу помочь?" }],
              },
            },
          ],
          agentBusy: false,
          busyLabel: "Агент работает в фоне…",
        },
      });

      const nextState = reduceAssistantState(state, {
        kind: "session_snapshot",
        snapshot,
      });

      // Ожидается: snapshot с entries → полный список сообщений
      expect(nextState.chat.messages).toHaveLength(2);
      expect(nextState.chat.messages[0]).toMatchObject({
        role: "user",
        text: "Привет, Pi!",
      });
      expect(nextState.chat.messages[1]).toMatchObject({
        role: "assistant",
        messageId: "msg-1",
        text: "Привет! Как могу помочь?",
        streaming: false,
      });
    });

    it("session.event с message_update добавляет live assistant delta к текущему потоковому сообщению", () => {
      let state = createInitialAssistantState();
      // Сначала snapshot с entries
      state = reduceAssistantState(state, {
        kind: "session_snapshot",
        snapshot: createDirectSnapshot({
          chat: {
            entries: [
              {
                type: "message" as const,
                id: "e1",
                timestamp: "2025-01-01T00:00:00Z",
                message: {
                  role: "user" as const,
                  content: [{ type: "text" as const, text: "Вопрос" }],
                },
              },
            ],
            agentBusy: true,
            busyLabel: "Агент работает в фоне…",
          },
        }),
      });

      // Затем live event — сообщение ассистента началось
      state = reduceAssistantState(state, {
        kind: "session.event",
        event: {
          type: "message_start",
          message: { id: "live-1", role: "assistant" },
        },
      });

      // Текст начал приходить
      state = reduceAssistantState(state, {
        kind: "session.event",
        event: {
          type: "message_update",
          message: { id: "live-1", role: "assistant" },
          assistantMessageEvent: { type: "text_delta", text_delta: "Прив" },
        },
      });

      // Ещё дельта
      state = reduceAssistantState(state, {
        kind: "session.event",
        event: {
          type: "message_update",
          message: { id: "live-1", role: "assistant" },
          assistantMessageEvent: { type: "text_delta", text_delta: "ет!" },
        },
      });

      // Live assistant сообщение должно быть в состоянии
      const assistantMsgs = state.chat.messages.filter(
        (m) => m.role === "assistant" && m.messageId === "live-1",
      );
      expect(assistantMsgs).toHaveLength(1);
      expect(assistantMsgs[0].text).toBe("Привет!");
      expect(assistantMsgs[0]).toMatchObject({ streaming: true });
    });

    it("reconnect с теми же entries воспроизводит тот же чат без зависимости от локального состояния", () => {
      const entries = [
        {
          type: "message" as const,
          id: "e1",
          timestamp: "2025-01-01T00:00:00Z",
          message: {
            role: "user" as const,
            content: [{ type: "text" as const, text: "Первый вопрос" }],
          },
        },
        {
          type: "message" as const,
          id: "e2",
          timestamp: "2025-01-01T00:00:01Z",
          message: {
            role: "assistant" as const,
            id: "msg-1",
            content: [{ type: "text" as const, text: "Ответ на первый вопрос" }],
          },
        },
      ];

      // Первый connect
      let state = createInitialAssistantState();
      state = reduceAssistantState(state, {
        kind: "session_snapshot",
        snapshot: createDirectSnapshot({
          chat: { entries, agentBusy: false, busyLabel: "Агент работает в фоне…" },
        }),
      });

      const messagesAfterFirstConnect = [...state.chat.messages];

      // Симулируем reconnect: полностью чистое состояние
      state = createInitialAssistantState();
      state = reduceAssistantState(state, {
        kind: "session_snapshot",
        snapshot: createDirectSnapshot({
          chat: { entries, agentBusy: false, busyLabel: "Агент работает в фоне…" },
        }),
      });

      // После reconnect с тем же snapshot чат должен быть идентичен
      expect(state.chat.messages).toEqual(messagesAfterFirstConnect);
      expect(state.chat.messages).toHaveLength(2);
    });

    it("открытие/закрытие sidepanel не требует /reload или /chrome-assistent-connect для новых сообщений ассистента", () => {
      // Sidepanel открывается — получает snapshot с entries
      let state = createInitialAssistantState();
      state = reduceAssistantState(state, {
        kind: "session_snapshot",
        snapshot: createDirectSnapshot({
          chat: {
            entries: [
              {
                type: "message" as const,
                id: "e1",
                timestamp: "2025-01-01T00:00:00Z",
                message: {
                  role: "user" as const,
                  content: [{ type: "text" as const, text: "Вопрос" }],
                },
              },
              {
                type: "message" as const,
                id: "e2",
                timestamp: "2025-01-01T00:00:01Z",
                message: {
                  role: "assistant" as const,
                  id: "msg-1",
                  content: [{ type: "text" as const, text: "Ответ" }],
                },
              },
            ],
            agentBusy: false,
            busyLabel: "Агент работает в фоне…",
          },
        }),
      });

      // После получения snapshot чат виден сразу
      expect(state.chat.messages).toHaveLength(2);
      expect(state.chat.messages[0].role).toBe("user");
      expect(state.chat.messages[1].role).toBe("assistant");

      // Затем приходят live events — без нового snapshot
      state = reduceAssistantState(state, {
        kind: "session.event",
        event: {
          type: "message_start",
          message: { id: "live-2", role: "assistant" },
        },
      });
      state = reduceAssistantState(state, {
        kind: "session.event",
        event: {
          type: "message_update",
          message: { id: "live-2", role: "assistant" },
          assistantMessageEvent: { type: "text_delta", text_delta: "Новый ответ" },
        },
      });

      // Новые сообщения должны появиться
      const liveMsgs = state.chat.messages.filter(
        (m) => m.role === "assistant" && m.messageId === "live-2",
      );
      expect(liveMsgs).toHaveLength(1);
      expect(liveMsgs[0].text).toBe("Новый ответ");
    });

    it("message_end завершает потоковое сообщение ассистента", () => {
      let state = createInitialAssistantState();
      state = reduceAssistantState(state, {
        kind: "session_snapshot",
        snapshot: createDirectSnapshot({
          chat: {
            entries: [
              {
                type: "message" as const,
                id: "e1",
                timestamp: "2025-01-01T00:00:00Z",
                message: {
                  role: "user" as const,
                  content: [{ type: "text" as const, text: "Вопрос" }],
                },
              },
            ],
            agentBusy: true,
            busyLabel: "Агент работает в фоне…",
          },
        }),
      });

      state = reduceAssistantState(state, {
        kind: "session.event",
        event: {
          type: "message_start",
          message: { id: "live-end", role: "assistant" },
        },
      });
      state = reduceAssistantState(state, {
        kind: "session.event",
        event: {
          type: "message_update",
          message: { id: "live-end", role: "assistant" },
          assistantMessageEvent: { type: "text_delta", text_delta: "Готово" },
        },
      });

      // Проверяем что потоковое
      const streamingMsgs = state.chat.messages.filter(
        (m) => m.role === "assistant" && m.messageId === "live-end",
      );
      expect(streamingMsgs[0]).toMatchObject({ streaming: true });

      // message_end завершает
      state = reduceAssistantState(state, {
        kind: "session.event",
        event: {
          type: "message_end",
          message: { id: "live-end", role: "assistant" },
        },
      });

      const finishedMsgs = state.chat.messages.filter(
        (m) => m.role === "assistant" && m.messageId === "live-end",
      );
      expect(finishedMsgs[0]).toMatchObject({ streaming: false });
      expect(state.chat.agentBusy).toBe(false);
      expect(state.chat.sending).toBe(false);
    });

    it("пустой snapshot entries очищает видимый чат", () => {
      let state = createInitialAssistantState();
      // Snapshot с сообщениями
      state = reduceAssistantState(state, {
        kind: "session_snapshot",
        snapshot: createDirectSnapshot({
          chat: {
            entries: [
              {
                type: "message" as const,
                id: "e1",
                timestamp: "2025-01-01T00:00:00Z",
                message: {
                  role: "user" as const,
                  content: [{ type: "text" as const, text: "Привет" }],
                },
              },
            ],
            agentBusy: false,
            busyLabel: "Агент работает в фоне…",
          },
        }),
      });

      expect(state.chat.messages).toHaveLength(1);

      // Новый snapshot с пустыми entries — чат должен очиститься
      state = reduceAssistantState(state, {
        kind: "session_snapshot",
        snapshot: createDirectSnapshot({
          chat: {
            entries: [],
            agentBusy: false,
            busyLabel: "Агент работает в фоне…",
          },
        }),
      });

      expect(state.chat.messages).toEqual([]);
    });

    it("preserves pending user message when snapshot arrives before Pi processes it", () => {
      let state = createInitialAssistantState();

      // User sends a message (optimistically added, sending=true)
      state = reduceAssistantState(state, {
        kind: "chat_event",
        event: {
          kind: "user_message",
          text: "ping",
          timestamp: 1000,
        },
      });

      expect(state.chat.messages).toHaveLength(1);
      expect(state.chat.messages[0]).toEqual({
        role: "user",
        text: "ping",
        timestamp: 1000,
      });
      expect(state.chat.sending).toBe(true);

      // Pi sends snapshot BEFORE it has processed the user message
      // (entries don't contain the user message yet)
      state = reduceAssistantState(state, {
        kind: "session_snapshot",
        snapshot: createDirectSnapshot({
          chat: {
            entries: [],
            agentBusy: true,
            busyLabel: "Думаю…",
          },
        }),
      });

      // User message should be preserved (not overwritten by empty entries)
      expect(state.chat.messages).toHaveLength(1);
      expect(state.chat.messages[0]).toEqual({
        role: "user",
        text: "ping",
        timestamp: 1000,
      });
      expect(state.chat.sending).toBe(true); // Still sending until Pi confirms

      // Now Pi sends snapshot WITH the user message in entries
      state = reduceAssistantState(state, {
        kind: "session_snapshot",
        snapshot: createDirectSnapshot({
          chat: {
            entries: [
              {
                type: "message" as const,
                id: "e1",
                timestamp: new Date(1000).toISOString(),
                message: {
                  role: "user" as const,
                  content: [{ type: "text" as const, text: "ping" }],
                },
              },
            ],
            agentBusy: true,
            busyLabel: "Думаю…",
          },
        }),
      });

      // User message is now from server, sending should be false
      expect(state.chat.messages).toHaveLength(1);
      expect(state.chat.sending).toBe(false);
    });
  });

  describe("reduceAssistantState - connection_updated", () => {
    it("updates connection state fields", () => {
      const state = createInitialAssistantState();

      const nextState = reduceAssistantState(state, {
        kind: "connection_updated",
        connection: {
          connecting: true,
          online: false,
          lastError: undefined,
        },
      });

      expect(nextState.connection.connecting).toBe(true);
      expect(nextState.connection.online).toBe(false);
    });

    it("updates configuredPort", () => {
      const state = createInitialAssistantState();

      const nextState = reduceAssistantState(state, {
        kind: "connection_updated",
        connection: { configuredPort: 31416 },
      });

      expect(nextState.connection.configuredPort).toBe(31416);
    });

    it("sets lastError", () => {
      const state = createInitialAssistantState();

      const nextState = reduceAssistantState(state, {
        kind: "connection_updated",
        connection: { lastError: "Не удалось подключиться к Pi-сессии" },
      });

      expect(nextState.connection.lastError).toBe("Не удалось подключиться к Pi-сессии");
    });
  });

  describe("reduceAssistantState - chat_event", () => {
    it("trims a user chat message and marks sending busy", () => {
      let state = createInitialAssistantState();
      state = reduceAssistantState(state, {
        kind: "session_snapshot",
        snapshot: createDirectSnapshot(),
      });

      const nextState = reduceAssistantState(state, {
        kind: "chat_event",
        event: { kind: "user_message", text: " Привет Pi ", timestamp: 1_710_000_000_300 },
      });

      expect(nextState.chat.messages).toEqual([
        { role: "user", text: "Привет Pi", timestamp: 1_710_000_000_300 },
      ]);
      expect(nextState.chat.agentBusy).toBe(true);
      expect(nextState.chat.sending).toBe(true);
    });

    it("clears agentBusy and sending when a chat error arrives", () => {
      let state = createInitialAssistantState();
      state = reduceAssistantState(state, {
        kind: "session_snapshot",
        snapshot: createDirectSnapshot({ chat: { entries: [], agentBusy: true, busyLabel: "…" } }),
      });
      state = reduceAssistantState(state, {
        kind: "chat_event",
        event: { kind: "user_message", text: "test", timestamp: 1_710_000_000_200 },
      });

      const nextState = reduceAssistantState(state, {
        kind: "chat_event",
        event: { kind: "error", message: "Не удалось отправить сообщение", timestamp: 1_710_000_000_400 },
      });

      expect(nextState.chat.agentBusy).toBe(false);
      expect(nextState.chat.sending).toBe(false);
      expect(nextState.chat.error).toBe("Не удалось отправить сообщение");
    });
  });

  describe("reduceAssistantState - runtime_updated", () => {
    it("stores model and context usage independently", () => {
      let state = createInitialAssistantState();
      state = reduceAssistantState(state, {
        kind: "session_snapshot",
        snapshot: createDirectSnapshot(),
      });
      const model: TargetModelSummary = { provider: "openai", id: "gpt-4", label: "GPT-4" };
      const contextUsage: TargetContextUsage = { tokens: 5000, maxTokens: 200000, percent: 2.5 };

      const nextState = reduceAssistantState(state, {
        kind: "runtime_updated",
        runtime: {
          model,
          contextUsage,
          isIdle: false,
          availableModels: [
            { provider: "anthropic", id: "claude-sonnet", label: "Claude Sonnet" },
            { provider: "openai", id: "gpt-4", label: "GPT-4" },
          ],
        },
      });

      expect(nextState.runtime.model).toEqual(model);
      expect(nextState.runtime.contextUsage).toEqual(contextUsage);
      expect(nextState.runtime.isIdle).toBe(false);
      expect(nextState.runtime.availableModels).toEqual([
        { provider: "anthropic", id: "claude-sonnet", label: "Claude Sonnet" },
        { provider: "openai", id: "gpt-4", label: "GPT-4" },
      ]);
    });

    it("tracks model mutation pending and error", () => {
      const state = createInitialAssistantState();

      const pendingState = reduceAssistantState(state, {
        kind: "runtime_updated",
        runtime: { modelMutationPending: true, modelError: undefined },
      });
      const failedState = reduceAssistantState(pendingState, {
        kind: "runtime_updated",
        runtime: { modelMutationPending: false, modelError: "Модель недоступна" },
      });

      expect(pendingState.runtime.modelMutationPending).toBe(true);
      expect(failedState.runtime.modelMutationPending).toBe(false);
      expect(failedState.runtime.modelError).toBe("Модель недоступна");
    });
  });

  describe("reduceAssistantState - diagnostics_updated", () => {
    it("updates diagnostics list", () => {
      const state = createInitialAssistantState();

      const nextState = reduceAssistantState(state, {
        kind: "diagnostics_updated",
        diagnostics: [
          { timestamp: 1_710_000_000_001, phase: "startup", message: "Первый журнал" },
        ],
      });

      expect(nextState.diagnostics).toEqual([
        { timestamp: 1_710_000_000_001, phase: "startup", message: "Первый журнал" },
      ]);
    });
  });

  describe("reduceAssistantState - epoch_incremented", () => {
    it("increments epoch", () => {
      const state = createInitialAssistantState();

      const nextState = reduceAssistantState(state, { kind: "epoch_incremented" });

      expect(nextState.epoch).toBe(1);
    });
  });

  describe("formatAssistantStatus", () => {
    it("returns connecting status when connecting", () => {
      const state = createInitialAssistantState();
      const stateConnecting = reduceAssistantState(state, {
        kind: "connection_updated",
        connection: { connecting: true },
      });
      expect(formatAssistantStatus(stateConnecting)).toBe("Подключаемся к Pi…");
    });

    it("returns online status when connected with session", () => {
      let state = createInitialAssistantState();
      state = reduceAssistantState(state, {
        kind: "session_snapshot",
        snapshot: createDirectSnapshot(),
      });
      expect(formatAssistantStatus(state)).toBe("Подключено к Pi-сессии");
    });

    it("returns offline status with error", () => {
      const state = createInitialAssistantState();
      const stateError = reduceAssistantState(state, {
        kind: "connection_updated",
        connection: {
          online: false,
          connecting: false,
          lastError: "Не удалось подключиться к 127.0.0.1:31415",
        },
      });
      expect(formatAssistantStatus(stateError)).toBe("Не удалось подключиться к 127.0.0.1:31415");
    });

    it("returns disconnected status when offline without error", () => {
      const state = createInitialAssistantState();
      expect(formatAssistantStatus(state)).toBe("Pi не подключён. Введите порт и нажмите «Подключить».");
    });
  });

  describe("isChatSendDisabled", () => {
    it("returns true when empty draft text", () => {
      let state = createInitialAssistantState();
      state = reduceAssistantState(state, {
        kind: "session_snapshot",
        snapshot: createDirectSnapshot(),
      });
      expect(isChatSendDisabled(state, "")).toBe(true);
      expect(isChatSendDisabled(state, "   ")).toBe(true);
    });

    it("returns true when sending or agent busy", () => {
      let state = createInitialAssistantState();
      state = reduceAssistantState(state, {
        kind: "session_snapshot",
        snapshot: createDirectSnapshot(),
      });
      state = reduceAssistantState(state, {
        kind: "chat_event",
        event: { kind: "user_message", text: "test", timestamp: 1_710_000_000_300 },
      });
      expect(isChatSendDisabled(state, "Сообщение")).toBe(true);
    });

    it("returns true when connecting", () => {
      let state = createInitialAssistantState();
      state = reduceAssistantState(state, {
        kind: "connection_updated",
        connection: { connecting: true },
      });
      expect(isChatSendDisabled(state, "Сообщение")).toBe(true);
    });

    it("returns true when not online", () => {
      const state = createInitialAssistantState();
      expect(isChatSendDisabled(state, "Сообщение")).toBe(true);
    });

    it("returns false when online and not busy", () => {
      let state = createInitialAssistantState();
      state = reduceAssistantState(state, {
        kind: "session_snapshot",
        snapshot: createDirectSnapshot(),
      });
      expect(isChatSendDisabled(state, "Сообщение")).toBe(false);
    });
  });

  describe("no multi-session concepts", () => {
    it("state has no auth section", () => {
      const state = createInitialAssistantState();
      expect("auth" in state).toBe(false);
    });
  });
});
