import type { DirectSessionSnapshot, PiMirrorEvent, TargetModelSummary, TargetContextUsage } from "../shared/protocol";
import type { DiagnosticEntry } from "./diagnostics";
import {
  createInitialSidePanelState,
  hydrateMessagesFromEntries,
  applyMirrorEventToChatState,
  reduceSidePanelChatEvent,
  type SidepanelChatMessage,
  type SidePanelChatEvent,
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
  | { kind: "chat_event"; event: SidePanelChatEvent }
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
          ...state.chat,
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
  // Keep messages that are either streaming OR completed but not yet in snapshot
  // (handles race condition where snapshot arrives before sessionManager updates).
  // Deduplicate by text content to handle messageId mismatches,
  // but only if text is non-empty (streaming messages often start empty).
  const serverAssistantTexts = new Set(
    serverMessages
      .filter((m): m is SidepanelChatMessage & { role: "assistant" } => m.role === "assistant")
      .filter((m) => m.text.length > 0)
      .map((m) => m.text),
  );
  
  const pendingAssistantMessages = localAssistantMessages.filter(
    (m) => !serverAssistantIds.has(m.messageId) &&
           (m.text.length === 0 || !serverAssistantTexts.has(m.text)),
  );

  // Find pending user messages (only if we're currently sending)
  // For regular messages: deduplicate by text content
  // For pending messages: keep them until server has a message containing similar content
  let pendingUserMessages: Array<SidepanelChatMessage & { role: "user" }> = [];
  if (sending) {
    const serverUserTexts = new Set(
      serverMessages
        .filter((m): m is SidepanelChatMessage & { role: "user" } => m.role === "user")
        .map((m) => m.text),
    );
    
    const serverUserTextsArray = Array.from(serverUserTexts);

    // Check if any server message contains key parts of the pending message
    const hasSimilarServerMessage = (pendingText: string): boolean => {
      // Extract meaningful parts from pending text (skip emoji prefix)
      const cleanText = pendingText.replace(/^\p{Emoji}\s*/u, "").trim();
      if (cleanText.length === 0) return false;
      
      // Take first line (usually the comment) as the key
      const firstLine = cleanText.split("\n")[0].slice(0, 50);
      
      return serverUserTextsArray.some(serverText => 
        serverText.includes(firstLine)
      );
    };

    pendingUserMessages = localMessages.filter(
      (m): m is SidepanelChatMessage & { role: "user" } => {
        if (m.role !== "user") return false;
        
        const isPending = (m as { pending?: boolean }).pending === true;
        
        if (isPending) {
          // Keep pending message until server has similar content
          return !hasSimilarServerMessage(m.text);
        }
        
        // Regular message: keep if not in server
        return !serverUserTexts.has(m.text);
      },
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
  const serverUserTexts = new Set(
    serverMessages
      .filter((m): m is SidepanelChatMessage & { role: "user" } => m.role === "user")
      .map((m) => m.text),
  );
  
  const serverUserTextsArray = Array.from(serverUserTexts);

  // Same logic as in mergeWithPendingMessages
  const hasSimilarServerMessage = (pendingText: string): boolean => {
    const cleanText = pendingText.replace(/^\p{Emoji}\s*/u, "").trim();
    if (cleanText.length === 0) return false;
    const firstLine = cleanText.split("\n")[0].slice(0, 50);
    return serverUserTextsArray.some(serverText => serverText.includes(firstLine));
  };

  return localMessages.some((m) => {
    if (m.role !== "user") return false;
    
    const isPending = (m as { pending?: boolean }).pending === true;
    
    if (isPending) {
      // Pending message counts as "pending" only if no similar server message
      return !hasSimilarServerMessage(m.text);
    }
    
    // Regular message: pending if not in server
    return !serverUserTexts.has(m.text);
  });
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
      // Using || (not ??): if Pi sends an empty string "" for busyLabel
      // we keep the previous label instead of flashing a blank indicator
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
