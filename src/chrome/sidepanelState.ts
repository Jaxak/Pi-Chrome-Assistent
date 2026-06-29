import type { PiMirrorEvent, SessionEntryLike } from "../shared/protocol";

import type { ValidationResult } from "../shared/protocol";

const DEFAULT_BUSY_LABEL = "Агент работает в фоне…";
const MAX_CHAT_MESSAGES = 500;

export type SidepanelChatMessage =
  | { role: "user"; text: string; timestamp: number; messageId?: string }
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
      const messageId = event.message.id;
      const now = Date.now();

      // User message — add as placeholder (full text comes from snapshot at turn_end)
      if (event.message.role === "user") {
        // Deduplicate by messageId (idempotency on reconnect)
        const existingUser = state.messages.find(
          (m) => m.role === "user" && (m as { messageId?: string }).messageId === messageId,
        );
        if (existingUser) return state;
        return {
          ...state,
          messages: trimMessages([
            ...state.messages,
            {
              role: "user",
              text: "",
              timestamp: now,
              messageId,
            } as SidepanelChatMessage,
          ]),
          sending: true,
          error: undefined,
        };
      }

      // Assistant message — start streaming
      if (event.message.role === "assistant" || event.message.role === "") {
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

      return state;
    }

    case "message_update": {
      // Only assistant messages produce text deltas
      if (event.message.role !== "assistant" && event.message.role !== "") {
        return state;
      }
      let messageId = event.message.id;
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
      // Only assistant messages need streaming finalized
      if (event.message.role !== "assistant" && event.message.role !== "") {
        return state;
      }
      const messageId = event.message.id;
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

// ---- Validation helpers for SidePanelChatEvent ----

function hasFiniteTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function validateSidePanelChatEvent(value: unknown): ValidationResult {
  if (!value || typeof value !== "object") {
    return { ok: false, error: "Payload must be an object" };
  }

  const event = value as Partial<SidePanelChatEvent> & { kind?: unknown; timestamp?: unknown };

  if (!hasFiniteTimestamp(event.timestamp)) {
    return { ok: false, error: "Missing timestamp" };
  }

  switch (event.kind) {
    case "user_message":
      return isNonEmptyString((event as Partial<Extract<SidePanelChatEvent, { kind: "user_message" }>>).text)
        ? { ok: true }
        : { ok: false, error: "Missing text" };

    case "agent_busy": {
      const busyEvent = event as Partial<Extract<SidePanelChatEvent, { kind: "agent_busy" }>>;
      if (typeof busyEvent.busy !== "boolean") {
        return { ok: false, error: "Missing busy" };
      }

      if (typeof busyEvent.label !== "string") {
        return { ok: false, error: "Missing label" };
      }

      return { ok: true };
    }

    case "assistant_message_start":
    case "assistant_message_end":
      return isNonEmptyString(
        (event as Partial<Extract<SidePanelChatEvent, { kind: "assistant_message_start" | "assistant_message_end" }>>)
          .messageId,
      )
        ? { ok: true }
        : { ok: false, error: "Missing messageId" };

    case "assistant_text_delta": {
      const deltaEvent = event as Partial<Extract<SidePanelChatEvent, { kind: "assistant_text_delta" }>>;

      if (!isNonEmptyString(deltaEvent.messageId)) {
        return { ok: false, error: "Missing messageId" };
      }

      if (typeof deltaEvent.delta !== "string") {
        return { ok: false, error: "Missing delta" };
      }

      return { ok: true };
    }

    case "error":
      return isNonEmptyString((event as Partial<Extract<SidePanelChatEvent, { kind: "error" }>>).message)
        ? { ok: true }
        : { ok: false, error: "Missing message" };

    default:
      return { ok: false, error: "Unknown chat event kind" };
  }
}
