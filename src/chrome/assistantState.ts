import type { ChatEvent, TargetMetadata } from "../shared/protocol";
import type { DiagnosticEntry } from "./diagnostics";
import {
  createInitialSidePanelState,
  formatSidePanelStatus,
  reduceSidePanelChatEvent,
  type SidepanelChatMessage,
} from "./sidepanelState";

export type BackgroundAssistantState = {
  epoch: number;
  connection: {
    brokerOnline: boolean;
    bridgeOnline: boolean;
    connecting: boolean;
    tokenConfigured: boolean;
    browserAuthorized: boolean | undefined;
    lastError?: string;
  };
  targets: TargetMetadata[];
  selectedTargetId?: string;
  chat: {
    messages: SidepanelChatMessage[];
    agentBusy: boolean;
    busyLabel: string;
    sending: boolean;
    error?: string;
  };
  auth: {
    browserToken?: string;
    tokenConfigured: boolean;
    mutationPending: boolean;
    error?: string;
  };
  diagnostics: DiagnosticEntry[];
};

export type AssistantStateEvent =
  | { kind: "connection_updated"; connection: Partial<BackgroundAssistantState["connection"]> }
  | { kind: "targets_updated"; targets: TargetMetadata[] }
  | { kind: "select_target"; targetId?: string }
  | { kind: "chat_event"; event: ChatEvent }
  | { kind: "auth_updated"; auth: Partial<BackgroundAssistantState["auth"]> }
  | { kind: "diagnostics_updated"; diagnostics: DiagnosticEntry[] }
  | { kind: "epoch_incremented" };

export function createInitialAssistantState(): BackgroundAssistantState {
  const chat = createInitialSidePanelState();

  return {
    epoch: 0,
    connection: {
      brokerOnline: false,
      bridgeOnline: false,
      connecting: true,
      tokenConfigured: false,
      browserAuthorized: undefined,
    },
    targets: [],
    chat: {
      messages: chat.messages,
      agentBusy: chat.agentBusy,
      busyLabel: chat.busyLabel,
      sending: chat.sending,
      error: chat.error,
    },
    auth: {
      tokenConfigured: false,
      mutationPending: false,
    },
    diagnostics: [],
  };
}

export function reduceAssistantState(
  state: BackgroundAssistantState,
  event: AssistantStateEvent,
): BackgroundAssistantState {
  switch (event.kind) {
    case "connection_updated":
      return {
        ...state,
        connection: {
          ...state.connection,
          ...event.connection,
        },
      };

    case "targets_updated":
      return selectAvailableTarget(
        {
          ...state,
          targets: [...event.targets],
        },
        state.selectedTargetId,
      );

    case "select_target":
      return selectAvailableTarget(state, event.targetId);

    case "chat_event": {
      const nextChat = reduceSidePanelChatEvent(
        {
          bridgeOnline: state.connection.bridgeOnline,
          selectedTargetId: state.selectedTargetId,
          messages: state.chat.messages,
          agentBusy: state.chat.agentBusy,
          busyLabel: state.chat.busyLabel,
          sending: state.chat.sending,
          error: state.chat.error,
        },
        event.event,
      );

      return {
        ...state,
        chat: {
          messages: nextChat.messages,
          agentBusy: nextChat.agentBusy,
          busyLabel: nextChat.busyLabel,
          sending: nextChat.sending,
          error: nextChat.error,
        },
      };
    }

    case "auth_updated":
      return {
        ...state,
        auth: {
          ...state.auth,
          ...event.auth,
        },
        connection: {
          ...state.connection,
          ...(event.auth.tokenConfigured === undefined ? {} : { tokenConfigured: event.auth.tokenConfigured }),
        },
      };

    case "diagnostics_updated":
      return {
        ...state,
        diagnostics: [...event.diagnostics],
      };

    case "epoch_incremented":
      return {
        ...state,
        epoch: state.epoch + 1,
      };
  }
}

export function formatAssistantStatus(state: BackgroundAssistantState): string {
  const selectedTargetAvailable = state.selectedTargetId
    ? state.targets.some((target) => target.targetId === state.selectedTargetId)
    : false;

  return formatSidePanelStatus({
    brokerOnline: state.connection.brokerOnline,
    bridgeOnline: state.connection.bridgeOnline,
    tokenConfigured: state.connection.tokenConfigured,
    browserAuthorized: state.connection.browserAuthorized,
    targetsCount: state.targets.length,
    selectedTargetId: state.selectedTargetId,
    selectedTargetAvailable,
    lastError: state.connection.lastError,
    connecting: state.connection.connecting,
  });
}

export function isChatSendDisabled(state: BackgroundAssistantState, draftText: string): boolean {
  return (
    draftText.trim().length === 0 ||
    state.chat.sending ||
    state.chat.agentBusy ||
    state.connection.connecting ||
    !state.connection.brokerOnline ||
    !state.connection.bridgeOnline ||
    !state.connection.tokenConfigured ||
    state.connection.browserAuthorized !== true ||
    !state.selectedTargetId ||
    !state.targets.some((target) => target.targetId === state.selectedTargetId)
  );
}

export function selectAvailableTarget(
  state: BackgroundAssistantState,
  targetId?: string,
): BackgroundAssistantState {
  const selectedTargetId = targetId && state.targets.some((target) => target.targetId === targetId)
    ? targetId
    : undefined;

  return {
    ...state,
    selectedTargetId,
  };
}
