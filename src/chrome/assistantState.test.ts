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
      events: [],
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

    it("materializes chat.events from snapshot into visible chat messages", () => {
      const state = createInitialAssistantState();
      const snapshot = createDirectSnapshot({
        chat: {
          events: [
            { kind: "user_message", text: "Привет, Pi!", timestamp: 1_710_000_000_100 },
            { kind: "agent_busy", busy: true, label: "Агент работает в фоне…", timestamp: 1_710_000_000_101 },
            { kind: "assistant_message_start", messageId: "msg-1", timestamp: 1_710_000_000_200 },
            { kind: "assistant_text_delta", messageId: "msg-1", delta: "Привет!", timestamp: 1_710_000_000_300 },
            { kind: "assistant_text_delta", messageId: "msg-1", delta: " Как могу помочь?", timestamp: 1_710_000_000_400 },
            { kind: "assistant_message_end", messageId: "msg-1", timestamp: 1_710_000_000_500 },
          ],
          agentBusy: false,
          busyLabel: "Агент работает в фоне…",
        },
      });

      const nextState = reduceAssistantState(state, {
        kind: "session_snapshot",
        snapshot,
      });

      // User message should be materialized
      expect(nextState.chat.messages).toHaveLength(2);
      expect(nextState.chat.messages[0]).toEqual({
        role: "user",
        text: "Привет, Pi!",
        timestamp: 1_710_000_000_100,
      });
      // Assistant message with accumulated text, non-streaming
      expect(nextState.chat.messages[1]).toEqual({
        role: "assistant",
        messageId: "msg-1",
        text: "Привет! Как могу помочь?",
        streaming: false,
        timestamp: 1_710_000_000_200,
      });
    });

    it("preserves chat messages across reconnect with session_snapshot", () => {
      // Initial connection with some chat history
      let state = createInitialAssistantState();
      state = reduceAssistantState(state, {
        kind: "session_snapshot",
        snapshot: createDirectSnapshot({
          chat: {
            events: [
              { kind: "user_message", text: "Первый вопрос", timestamp: 1_710_000_000_100 },
              { kind: "assistant_message_start", messageId: "msg-1", timestamp: 1_710_000_000_200 },
              { kind: "assistant_text_delta", messageId: "msg-1", delta: "Ответ на первый вопрос", timestamp: 1_710_000_000_300 },
              { kind: "assistant_message_end", messageId: "msg-1", timestamp: 1_710_000_000_400 },
            ],
            agentBusy: false,
            busyLabel: "Агент работает в фоне…",
          },
        }),
      });

      const messagesBeforeReconnect = [...state.chat.messages];

      // Simulate reconnect: new snapshot with same history
      state = reduceAssistantState(state, {
        kind: "session_snapshot",
        snapshot: createDirectSnapshot({
          chat: {
            events: [
              { kind: "user_message", text: "Первый вопрос", timestamp: 1_710_000_000_100 },
              { kind: "assistant_message_start", messageId: "msg-1", timestamp: 1_710_000_000_200 },
              { kind: "assistant_text_delta", messageId: "msg-1", delta: "Ответ на первый вопрос", timestamp: 1_710_000_000_300 },
              { kind: "assistant_message_end", messageId: "msg-1", timestamp: 1_710_000_000_400 },
            ],
            agentBusy: false,
            busyLabel: "Агент работает в фоне…",
          },
        }),
      });

      // Messages should be preserved after reconnect
      expect(state.chat.messages).toEqual(messagesBeforeReconnect);
      expect(state.chat.messages).toHaveLength(2);
    });

    it("materializes snapshot chat events when chat was already populated from prior state", () => {
      let state = createInitialAssistantState();

      // First, some local chat state from user messages
      state = reduceAssistantState(state, {
        kind: "chat_event",
        event: { kind: "user_message", text: "Локальное сообщение", timestamp: 1_710_000_000_050 },
      });

      // Then a snapshot arrives with its own events — should materialize from snapshot
      const snapshot = createDirectSnapshot({
        chat: {
          events: [
            { kind: "user_message", text: "Привет, Pi!", timestamp: 1_710_000_000_100 },
            { kind: "assistant_message_start", messageId: "msg-1", timestamp: 1_710_000_000_200 },
            { kind: "assistant_text_delta", messageId: "msg-1", delta: "Привет!", timestamp: 1_710_000_000_300 },
            { kind: "assistant_message_end", messageId: "msg-1", timestamp: 1_710_000_000_400 },
          ],
          agentBusy: false,
          busyLabel: "Агент работает в фоне…",
        },
      });

      const nextState = reduceAssistantState(state, {
        kind: "session_snapshot",
        snapshot,
      });

      expect(nextState.chat.messages).toHaveLength(2);
      expect(nextState.chat.messages[0].role).toBe("user");
      expect(nextState.chat.messages[0].text).toBe("Привет, Pi!");
      expect(nextState.chat.messages[1].role).toBe("assistant");
      expect(nextState.chat.messages[1].text).toBe("Привет!");
    });

    it("clears chat messages when snapshot.chat.events is empty — no bleed from prior session (hardening)", () => {
      let state = createInitialAssistantState();

      // First, populate state with messages from a prior session
      state = reduceAssistantState(state, {
        kind: "session_snapshot",
        snapshot: createDirectSnapshot({
          chat: {
            events: [
              { kind: "user_message", text: "Старый вопрос", timestamp: 1_710_000_000_100 },
              { kind: "assistant_message_start", messageId: "old-1", timestamp: 1_710_000_000_200 },
              { kind: "assistant_text_delta", messageId: "old-1", delta: "Старый ответ", timestamp: 1_710_000_000_300 },
              { kind: "assistant_message_end", messageId: "old-1", timestamp: 1_710_000_000_400 },
            ],
            agentBusy: false,
            busyLabel: "Агент работает в фоне…",
          },
        }),
      });

      // Verify prior messages are present
      expect(state.chat.messages).toHaveLength(2);

      // Now apply a snapshot with empty chat.events (new/empty session)
      const emptySnapshot = createDirectSnapshot({
        session: { ...createDirectSnapshot().session, sessionName: "new-empty-session" },
        chat: {
          events: [],
          agentBusy: false,
          busyLabel: "Агент работает в фоне…",
        },
      });

      const nextState = reduceAssistantState(state, {
        kind: "session_snapshot",
        snapshot: emptySnapshot,
      });

      // Messages must be cleared — no bleed from prior session
      expect(nextState.chat.messages).toEqual([]);
    });

    it("clears chat messages when snapshot.chat.events is undefined — authoritative empty (hardening)", () => {
      let state = createInitialAssistantState();

      // Populate with messages
      state = reduceAssistantState(state, {
        kind: "session_snapshot",
        snapshot: createDirectSnapshot({
          chat: {
            events: [
              { kind: "user_message", text: "Сообщение", timestamp: 1_710_000_000_100 },
            ],
            agentBusy: false,
            busyLabel: "Агент работает в фоне…",
          },
        }),
      });
      expect(state.chat.messages).toHaveLength(1);

      // Apply snapshot where chat.events is explicitly undefined
      const snapshotNoEvents: DirectSessionSnapshot = {
        ...createDirectSnapshot(),
        chat: {
          agentBusy: false,
          busyLabel: "Агент работает в фоне…",
        },
      };
      delete (snapshotNoEvents.chat as { events?: unknown }).events;

      const nextState = reduceAssistantState(state, {
        kind: "session_snapshot",
        snapshot: snapshotNoEvents,
      });

      // Messages must be cleared
      expect(nextState.chat.messages).toEqual([]);
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
        snapshot: createDirectSnapshot({ chat: { agentBusy: true, busyLabel: "…" } }),
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
