import { describe, expect, it } from "vitest";

import type { TargetMetadata, TargetRuntimeState } from "../shared/protocol";
import {
  createInitialAssistantState,
  formatAssistantStatus,
  isChatSendDisabled,
  reduceAssistantState,
  selectAvailableTarget,
  type BackgroundAssistantState,
} from "./assistantState";

function createTarget(overrides: Partial<TargetMetadata> = {}): TargetMetadata {
  return {
    targetId: "target-1",
    cwd: "/workspace/project",
    pid: 1234,
    connectedAt: 1_710_000_000_000,
    lastSeenAt: 1_710_000_000_100,
    ...overrides,
  };
}

function createReadyState(overrides: Partial<BackgroundAssistantState> = {}): BackgroundAssistantState {
  const target = createTarget();

  return {
    ...createInitialAssistantState(),
    connection: {
      brokerOnline: true,
      bridgeOnline: true,
      connecting: false,
      tokenConfigured: true,
      browserAuthorized: true,
      targetsStale: false,
      targetsRefreshPending: false,
    },
    auth: {
      tokenConfigured: true,
      mutationPending: false,
      browserToken: "browser-token",
    },
    targets: [target],
    selectedTargetId: target.targetId,
    ...overrides,
  };
}

describe("assistantState", () => {
  it("creates an initial state with connecting status, no token, no targets, and disabled chat", () => {
    const state = createInitialAssistantState();

    expect(state.connection.connecting).toBe(true);
    expect(state.connection.tokenConfigured).toBe(false);
    expect(state.auth.tokenConfigured).toBe(false);
    expect(state.auth.browserToken).toBeUndefined();
    expect(state.targets).toEqual([]);
    expect(state.selectedTargetId).toBeUndefined();
    expect(isChatSendDisabled(state, "Привет")).toBe(true);
  });

  it.each([
    ["connecting", createInitialAssistantState(), "Подключаемся к Pi…"],
    [
      "token missing",
      {
        ...createInitialAssistantState(),
        connection: { ...createInitialAssistantState().connection, connecting: false, brokerOnline: true },
      },
      "Для отправки настройте browserToken в chrome.storage.local.",
    ],
    [
      "auth required",
      {
        ...createReadyState(),
        connection: { ...createReadyState().connection, browserAuthorized: false },
      },
      "Браузер не авторизован в Pi. Выполните /chrome-assistent-auth в терминале.",
    ],
    [
      "broker unavailable",
      {
        ...createReadyState({ targets: [], selectedTargetId: undefined }),
        connection: { ...createReadyState().connection, brokerOnline: false, bridgeOnline: false },
      },
      "Pi не подключён. Выполните /chrome-assistent-connect в терминале.",
    ],
    ["targets empty", createReadyState({ targets: [], selectedTargetId: undefined }), "Pi подключён · нет активных целей"],
    [
      "selected target gone",
      createReadyState({ selectedTargetId: "missing-target" }),
      "Pi подключён · выбранная сессия закрыта",
    ],
    ["ready", createReadyState(), "Pi подключён · целей: 1"],
  ])("formats stable Russian status for %s", (_name, state, expected) => {
    expect(formatAssistantStatus(state)).toBe(expected);
  });

  it("clears selectedTargetId and disables sending when the selected target disappears", () => {
    const selected = createTarget({ targetId: "target-1" });
    const remaining = createTarget({ targetId: "target-2" });
    const state = createReadyState({ targets: [selected, remaining], selectedTargetId: selected.targetId });

    const nextState = selectAvailableTarget(
      reduceAssistantState(state, { kind: "targets_updated", targets: [remaining] }),
      selected.targetId,
    );

    expect(nextState.selectedTargetId).toBeUndefined();
    expect(isChatSendDisabled(nextState, "Привет")).toBe(true);
  });

  it("trims a user chat message and marks sending busy", () => {
    const state = createReadyState();

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

  it("stores runtime state and available models independently", () => {
    const state = createReadyState();
    const runtime: TargetRuntimeState = {
      targetId: "target-1",
      model: { provider: "anthropic", id: "claude-sonnet", label: "Claude Sonnet" },
      contextUsage: { tokens: 1000, maxTokens: 200000, percent: 0.5 },
      isIdle: true,
      updatedAt: 1_710_000_000_500,
    };

    const nextState = reduceAssistantState(state, {
      kind: "runtime_updated",
      runtime: {
        selectedTargetRuntime: runtime,
        availableModels: [{ provider: "anthropic", id: "claude-sonnet", label: "Claude Sonnet" }],
      },
    });

    expect(nextState.runtime.selectedTargetRuntime).toEqual(runtime);
    expect(nextState.runtime.availableModels).toEqual([{ provider: "anthropic", id: "claude-sonnet", label: "Claude Sonnet" }]);
    expect(nextState.runtime.modelMutationPending).toBe(false);
  });

  it("tracks model mutation pending and error", () => {
    const state = createReadyState();

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

  it("clears agentBusy and sending when a chat error arrives", () => {
    const state = createReadyState({
      chat: {
        ...createReadyState().chat,
        agentBusy: true,
        sending: true,
      },
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
