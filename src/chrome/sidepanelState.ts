import type { PiMirrorEvent, SessionEntryLike } from "../shared/protocol";

const DEFAULT_BUSY_LABEL = "Агент работает в фоне…";
const MAX_CHAT_MESSAGES = 500;

export type SidepanelChatMessage =
  | { role: "user"; text: string; timestamp: number }
  | { role: "assistant"; messageId: string; text: string; streaming: boolean; timestamp: number }
  | { role: "system"; text: string; tone: "info" | "warning" | "error"; timestamp: number };

export type SidePanelState = {
  bridgeOnline: boolean;
  messages: SidepanelChatMessage[];
  agentBusy: boolean;
  busyLabel: string;
  sending: boolean;
  error?: string;
};

export type SidePanelChatEvent =
  | { kind: "user_message"; text: string; timestamp: number }
  | { kind: "agent_busy"; busy: boolean; label: string; timestamp: number }
  | { kind: "assistant_message_start"; messageId: string; timestamp: number }
  | { kind: "assistant_text_delta"; messageId: string; delta: string; timestamp: number }
  | { kind: "assistant_message_end"; messageId: string; timestamp: number }
  | { kind: "error"; message: string; timestamp: number };

export function createInitialSidePanelState(): SidePanelState {
  return {
    bridgeOnline: false,
    messages: [],
    agentBusy: false,
    busyLabel: DEFAULT_BUSY_LABEL,
    sending: false,
  };
}

/**
 * Trim message array to keep only the last MAX_CHAT_MESSAGES entries.
 */
function trimMessages(messages: SidepanelChatMessage[]): SidepanelChatMessage[] {
  if (messages.length <= MAX_CHAT_MESSAGES) {
    return messages;
  }
  return messages.slice(-MAX_CHAT_MESSAGES);
}

export function startSendingUserMessage(
  state: SidePanelState,
  message: string,
  timestamp: number,
): SidePanelState {
  const text = message.trim();

  if (!text) {
    return state;
  }

  return {
    ...state,
    messages: trimMessages([
      ...state.messages,
      {
        role: "user",
        text,
        timestamp,
      },
    ]),
    agentBusy: true,
    busyLabel: DEFAULT_BUSY_LABEL,
    sending: true,
    error: undefined,
  };
}

export function reduceSidePanelChatEvent(state: SidePanelState, event: SidePanelChatEvent): SidePanelState {
  switch (event.kind) {
    case "user_message":
      return startSendingUserMessage(state, event.text, event.timestamp);

    case "agent_busy":
      return {
        ...state,
        agentBusy: event.busy,
        busyLabel: event.label.trim() || DEFAULT_BUSY_LABEL,
        ...(event.busy ? {} : { sending: false }),
      };

    case "assistant_message_start":
      return {
        ...state,
        messages: trimMessages([
          ...state.messages,
          {
            role: "assistant",
            messageId: event.messageId,
            text: "",
            streaming: true,
            timestamp: event.timestamp,
          },
        ]),
        agentBusy: true,
        busyLabel: DEFAULT_BUSY_LABEL,
        sending: false,
        error: undefined,
      };

    case "assistant_text_delta":
      return {
        ...state,
        messages: state.messages.map((message) => {
          if (message.role !== "assistant" || message.messageId !== event.messageId) {
            return message;
          }

          return {
            ...message,
            text: `${message.text}${event.delta}`,
          };
        }),
      };

    case "assistant_message_end":
      return {
        ...state,
        messages: state.messages.map((message) => {
          if (message.role !== "assistant" || message.messageId !== event.messageId) {
            return message;
          }

          return {
            ...message,
            streaming: false,
          };
        }),
        agentBusy: false,
        sending: false,
      };

    case "error":
      return {
        ...state,
        messages: trimMessages([
          ...state.messages,
          {
            role: "system",
            text: event.message,
            tone: "error",
            timestamp: event.timestamp,
          },
        ]),
        agentBusy: false,
        sending: false,
        error: event.message,
      };
  }
}

/**
 * Extract text content from a session entry's message.content.
 * Handles content as array of { type: "text", text: string } or as a string.
 */
function extractEntryText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .filter((part) => typeof part === "object" && part !== null && (part as Record<string, unknown>).type === "text")
      .map((part) => (part as { text?: string }).text ?? "")
      .join("");
  }
  return "";
}

/**
 * Hydrate visible chat messages from authoritative session entries.
 * Supports roles: user, assistant. Other roles are silently skipped.
 */
export function hydrateMessagesFromEntries(entries: SessionEntryLike[]): SidepanelChatMessage[] {
  const messages: SidepanelChatMessage[] = [];

  for (const entry of entries) {
    if (entry.type !== "message") {
      continue;
    }

    const msg = entry.message;
    const text = extractEntryText(msg.content);
    const timestamp = new Date(entry.timestamp).getTime();

    if (msg.role === "user") {
      messages.push({
        role: "user",
        text,
        timestamp: Number.isFinite(timestamp) ? timestamp : Date.now(),
      });
    } else if (msg.role === "assistant") {
      const messageId = (msg as { id?: string }).id ?? entry.id;
      messages.push({
        role: "assistant",
        messageId,
        text,
        streaming: false,
        timestamp: Number.isFinite(timestamp) ? timestamp : Date.now(),
      });
    }
    // toolResult, custom, branchSummary, compactionSummary — skipped for now
  }

  return messages;
}

/**
 * Apply a raw PiMirrorEvent to the sidepanel chat state.
 * Handles: message_start, message_update (text_delta), message_end.
 * Other event types are safely ignored.
 */
export function applyMirrorEventToChatState(state: SidePanelState, event: PiMirrorEvent): SidePanelState {
  switch (event.type) {
    case "message_start": {
      // Accept assistant messages; also accept empty role as assistant (fallback for incomplete events)
      if (event.message.role !== "assistant" && event.message.role !== "") {
        return state;
      }
      const messageId = event.message.id;
      const now = Date.now();
      // Check if we already have this message (reconnect idempotency)
      const existing = state.messages.find(
        (m) => m.role === "assistant" && m.messageId === messageId,
      );
      if (existing) {
        return state;
      }
      return {
        ...state,
        messages: trimMessages([
          ...state.messages,
          {
            role: "assistant",
            messageId,
            text: "",
            streaming: true,
            timestamp: now,
          },
        ]),
        agentBusy: true,
        busyLabel: DEFAULT_BUSY_LABEL,
        sending: false,
        error: undefined,
      };
    }

    case "message_update": {
      let messageId = event.message.id;
      // Accept assistant messages; also accept empty role as assistant (fallback for incomplete events)
      if (event.message.role !== "assistant" && event.message.role !== "") {
        return state;
      }
      const delta = event.assistantMessageEvent?.type === "text_delta"
        ? event.assistantMessageEvent.text_delta
        : undefined;

      if (delta === undefined || delta === "") {
        return state;
      }

      // If messageId is empty, find the last streaming assistant message
      if (!messageId) {
        const lastStreaming = [...state.messages].reverse().find(
          (m) => m.role === "assistant" && m.streaming === true,
        );
        if (lastStreaming && lastStreaming.role === "assistant") {
          messageId = lastStreaming.messageId;
        }
      }

      // If message doesn't exist yet, create it (handles out-of-order)
      const idx = state.messages.findIndex(
        (m) => m.role === "assistant" && m.messageId === messageId,
      );
      
      if (idx < 0) {
        const now = Date.now();
        return {
          ...state,
          messages: trimMessages([
            ...state.messages,
            {
              role: "assistant",
              messageId,
              text: delta,
              streaming: true,
              timestamp: now,
            },
          ]),
          agentBusy: true,
          busyLabel: DEFAULT_BUSY_LABEL,
          sending: false,
          error: undefined,
        };
      }

      return {
        ...state,
        messages: state.messages.map((m) => {
          if (m.role !== "assistant" || m.messageId !== messageId) {
            return m;
          }
          return { ...m, text: `${m.text}${delta}` };
        }),
      };
    }

    case "message_end": {
      const messageId = event.message.id;
      // Accept assistant messages; also accept empty role as assistant (fallback for incomplete events)
      if (event.message.role !== "assistant" && event.message.role !== "") {
        return state;
      }
      return {
        ...state,
        messages: state.messages.map((m) => {
          if (m.role !== "assistant" || m.messageId !== messageId) {
            return m;
          }
          return { ...m, streaming: false };
        }),
        agentBusy: false,
        sending: false,
      };
    }

    case "turn_end": {
      // turn_end signals the agent has finished its turn — ensure agentBusy is cleared
      return {
        ...state,
        agentBusy: false,
        sending: false,
      };
    }

    // turn_start, tool_execution_*, model_select — safely ignored
    default:
      return state;
  }
}
