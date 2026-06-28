import type { ChatEvent, DirectSessionSnapshot, PiMirrorEvent, TargetModelSummary, TargetContextUsage } from "../shared/protocol";
import type { DiagnosticEntry } from "./diagnostics";
import {
  createInitialSidePanelState,
  hydrateMessagesFromEntries,
  applyMirrorEventToChatState,
  reduceSidePanelChatEvent,
  type SidepanelChatMessage,
} from "./sidepanelState";

const DEFAULT_DIRECT_SESSION_PORT = 31415;

export type BackgroundAssistantState = {
  epoch: number;
  connection: {
    online: boolean;
    connecting: boolean;
    configuredPort: number;
    lastError?: string;
  };
  session?: {
    cwd: string;
    gitBranch?: string;
    pid: number;
    sessionName?: string;
    alias?: string;
    connectedAt: number;
  };
  chat: {
    messages: SidepanelChatMessage[];
    agentBusy: boolean;
    busyLabel: string;
    sending: boolean;
    error?: string;
  };
  runtime: {
    model?: TargetModelSummary;
    availableModels: TargetModelSummary[];
    contextUsage?: TargetContextUsage;
    isIdle: boolean;
    modelMutationPending: boolean;
    modelError?: string;
    updatedAt?: number;
  };
  diagnostics: DiagnosticEntry[];
};

export type AssistantStateEvent =
  | { kind: "connection_updated"; connection: Partial<BackgroundAssistantState["connection"]> }
  | { kind: "session_snapshot"; snapshot: DirectSessionSnapshot }
  | { kind: "chat_event"; event: ChatEvent }
  | { kind: "session.event"; event: PiMirrorEvent }
  | { kind: "runtime_updated"; runtime: Partial<BackgroundAssistantState["runtime"]> }
  | { kind: "diagnostics_updated"; diagnostics: DiagnosticEntry[] }
  | { kind: "epoch_incremented" };

export function createInitialAssistantState(): BackgroundAssistantState {
  const chat = createInitialSidePanelState();

  return {
    epoch: 0,
    connection: {
      online: false,
      connecting: false,
      configuredPort: DEFAULT_DIRECT_SESSION_PORT,
    },
    chat: {
      messages: chat.messages,
      agentBusy: chat.agentBusy,
      busyLabel: chat.busyLabel,
      sending: chat.sending,
      error: chat.error,
    },
    runtime: {
      availableModels: [],
      isIdle: true,
      modelMutationPending: false,
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

    case "session_snapshot":
      return applySessionSnapshot(state, event.snapshot);

    case "chat_event": {
      const sidePanelState = {
        bridgeOnline: state.connection.online,
        messages: state.chat.messages,
        agentBusy: state.chat.agentBusy,
        busyLabel: state.chat.busyLabel,
        sending: state.chat.sending,
        error: state.chat.error,
      };

      const nextChat = reduceSidePanelChatEvent(sidePanelState, event.event);

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

    case "session.event": {
      const sidePanelState = {
        bridgeOnline: state.connection.online,
        messages: state.chat.messages,
        agentBusy: state.chat.agentBusy,
        busyLabel: state.chat.busyLabel,
        sending: state.chat.sending,
        error: state.chat.error,
      };

      const nextChat = applyMirrorEventToChatState(sidePanelState, event.event);

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

    case "runtime_updated":
      return {
        ...state,
        runtime: {
          ...state.runtime,
          ...event.runtime,
          availableModels: event.runtime.availableModels
            ? [...event.runtime.availableModels]
            : state.runtime.availableModels,
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

function applySessionSnapshot(
  state: BackgroundAssistantState,
  snapshot: DirectSessionSnapshot,
): BackgroundAssistantState {
  const entries = snapshot.chat.entries ?? [];
  const hydratedMessages = hydrateMessagesFromEntries(entries);

  return {
    ...state,
    connection: {
      ...state.connection,
      online: true,
      connecting: false,
      lastError: undefined,
    },
    session: { ...snapshot.session },
    runtime: {
      model: snapshot.runtime.model,
      availableModels: [...snapshot.runtime.availableModels],
      contextUsage: snapshot.runtime.contextUsage,
      isIdle: snapshot.runtime.isIdle,
      updatedAt: snapshot.runtime.updatedAt,
      modelMutationPending: false,
      modelError: undefined,
    },
    chat: {
      messages: hydratedMessages,
      agentBusy: snapshot.chat.agentBusy,
      busyLabel: snapshot.chat.busyLabel || state.chat.busyLabel,
      sending: false,
      error: undefined,
    },
  };
}

export function formatAssistantStatus(state: BackgroundAssistantState): string {
  if (state.connection.connecting) {
    return "Подключаемся к Pi…";
  }

  if (state.connection.online) {
    return "Подключено к Pi-сессии";
  }

  if (state.connection.lastError) {
    return state.connection.lastError;
  }

  return "Pi не подключён. Введите порт и нажмите «Подключить».";
}

export function isChatSendDisabled(state: BackgroundAssistantState, draftText: string): boolean {
  return (
    draftText.trim().length === 0 ||
    state.chat.sending ||
    state.chat.agentBusy ||
    state.connection.connecting ||
    !state.connection.online
  );
}
