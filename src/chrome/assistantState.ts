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
const MAX_CHAT_MESSAGES = 500;

/**
 * Trim message array to keep only the last MAX_CHAT_MESSAGES entries.
 */
function trimMessages(messages: SidepanelChatMessage[]): SidepanelChatMessage[] {
  if (messages.length <= MAX_CHAT_MESSAGES) {
    return messages;
  }
  return messages.slice(-MAX_CHAT_MESSAGES);
}

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
    activeToolsCount: number;
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
      activeToolsCount: 0,
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
      // Handle tool execution events directly - update counter
      if (event.event.type === "tool_execution_start") {
        return {
          ...state,
          chat: {
            ...state.chat,
            activeToolsCount: state.chat.activeToolsCount + 1,
          },
        };
      }
      
      if (event.event.type === "tool_execution_end") {
        return {
          ...state,
          chat: {
            ...state.chat,
            activeToolsCount: Math.max(0, state.chat.activeToolsCount - 1),
          },
        };
      }
      
      // Handle turn_end - reset tools counter
      if (event.event.type === "turn_end") {
        return {
          ...state,
          chat: {
            ...state.chat,
            agentBusy: false,
            sending: false,
            activeToolsCount: 0,
          },
        };
      }
      
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
          ...state.chat,
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

/**
 * Merge local messages with server-hydrated messages.
 * Preserves:
 * 1. User messages that were added locally but not yet present in server entries
 *    (handles race condition where Pi sends a snapshot before processing user's message)
 * 2. Streaming assistant messages that are not yet in server entries
 *    (entries only contain completed messages from sessionManager.getBranch())
 */
function mergeWithPendingMessages(
  localMessages: SidepanelChatMessage[],
  serverMessages: SidepanelChatMessage[],
  sending: boolean,
): SidepanelChatMessage[] {
  // Collect IDs of assistant messages already in server snapshot
  const serverAssistantIds = new Set(
    serverMessages
      .filter((m): m is SidepanelChatMessage & { role: "assistant" } => m.role === "assistant")
      .map((m) => m.messageId),
  );

  // Find local assistant messages
  const localAssistantMessages = localMessages.filter(
    (m): m is SidepanelChatMessage & { role: "assistant" } => m.role === "assistant",
  );

  // For each server assistant message, check if we have a local version with more text
  const mergedServerMessages = serverMessages.map((serverMsg) => {
    if (serverMsg.role !== "assistant") {
      return serverMsg;
    }
    
    const localVersion = localAssistantMessages.find(
      (m) => m.messageId === serverMsg.messageId,
    );
    
    // If local version has more text, use it instead
    if (localVersion && localVersion.text.length > serverMsg.text.length) {
      return localVersion;
    }
    
    return serverMsg;
  });

  // Find assistant messages not in server at all.
  // Only keep STREAMING messages as pending - completed messages should already
  // be in the server snapshot (even if with different messageId).
  // Also deduplicate by text content to handle messageId mismatches.
  const serverAssistantTexts = new Set(
    serverMessages
      .filter((m): m is SidepanelChatMessage & { role: "assistant" } => m.role === "assistant")
      .map((m) => m.text),
  );
  
  const pendingAssistantMessages = localAssistantMessages.filter(
    (m) => m.streaming && 
           !serverAssistantIds.has(m.messageId) &&
           !serverAssistantTexts.has(m.text),
  );

  // Find pending user messages (only if we're currently sending)
  let pendingUserMessages: Array<SidepanelChatMessage & { role: "user" }> = [];
  if (sending) {
    const serverUserTimestamps = new Set(
      serverMessages
        .filter((m): m is SidepanelChatMessage & { role: "user" } => m.role === "user")
        .map((m) => m.timestamp),
    );

    pendingUserMessages = localMessages.filter(
      (m): m is SidepanelChatMessage & { role: "user" } =>
        m.role === "user" && !serverUserTimestamps.has(m.timestamp),
    );
  }

  if (pendingAssistantMessages.length === 0 && pendingUserMessages.length === 0) {
    return mergedServerMessages;
  }

  // Append pending user messages and assistant messages at the end
  return [...mergedServerMessages, ...pendingUserMessages, ...pendingAssistantMessages];
}

/**
 * Check if there are pending user messages that were preserved during merge.
 * Used to determine if `sending` flag should remain true.
 */
function hasPendingUserMessages(
  localMessages: SidepanelChatMessage[],
  serverMessages: SidepanelChatMessage[],
): boolean {
  const serverUserTimestamps = new Set(
    serverMessages
      .filter((m): m is SidepanelChatMessage & { role: "user" } => m.role === "user")
      .map((m) => m.timestamp),
  );

  return localMessages.some(
    (m) => m.role === "user" && !serverUserTimestamps.has(m.timestamp),
  );
}

function applySessionSnapshot(
  state: BackgroundAssistantState,
  snapshot: DirectSessionSnapshot,
): BackgroundAssistantState {
  const entries = snapshot.chat.entries ?? [];
  const hydratedMessages = hydrateMessagesFromEntries(entries);

  // Merge: preserve local user messages that are not yet in server entries.
  // This prevents losing optimistically-added user messages when Pi sends
  // a snapshot before it has processed the user's message.
  const mergedMessages = mergeWithPendingMessages(state.chat.messages, hydratedMessages, state.chat.sending);

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
      messages: trimMessages(mergedMessages),
      agentBusy: snapshot.chat.agentBusy,
      busyLabel: snapshot.chat.busyLabel || state.chat.busyLabel,
      // Keep sending=true only if we preserved pending user messages (not streaming assistant)
      sending: state.chat.sending && hasPendingUserMessages(state.chat.messages, hydratedMessages),
      // Preserve tools counter; reset only on turn_end or when agent becomes idle
      activeToolsCount: snapshot.runtime.isIdle ? 0 : state.chat.activeToolsCount,
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
