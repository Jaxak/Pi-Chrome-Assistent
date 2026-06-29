import { PROTOCOL_VERSION } from "./constants";

export const PROTOCOL_MESSAGE_TYPES = [
  "session.snapshot",
  "session.event",
  "session.chat.send",
  "session.selection.send",
  "session.model.set",
  "session.command.result",
  "session.error",
] as const;

export type ProtocolMessageType = (typeof PROTOCOL_MESSAGE_TYPES)[number];

const PROTOCOL_MESSAGE_TYPE_SET = new Set<string>(PROTOCOL_MESSAGE_TYPES);

export type ProtocolEnvelope<TPayload = unknown> = {
  version: typeof PROTOCOL_VERSION;
  type: ProtocolMessageType;
  requestId?: string;
  payload?: TPayload;
};

export type SelectionPayload = {
  url: string;
  title: string;
  selectedText: string;
  selectedHtml: string;
  selector?: string;
  comment?: string;
  capturedAt: number;
};

export type DirectSendChatPayload = { message: string };
export type DirectSendSelectionPayload = { selection: SelectionPayload };
export type DirectSetModelPayload = { provider: string; modelId: string };

export type SessionEntryLike = {
  type: "message";
  id: string;
  timestamp: string;
  message: {
    role:
      | "user"
      | "assistant"
      | "toolResult"
      | "custom"
      | "branchSummary"
      | "compactionSummary";
    id?: string;
    content?: unknown;
    stopReason?: string;
    errorMessage?: string;
  };
};

export type DirectSessionSnapshot = {
  session: {
    cwd: string;
    gitBranch?: string;
    pid: number;
    sessionName?: string;
    alias?: string;
    connectedAt: number;
  };
  chat: {
    entries: SessionEntryLike[];
    agentBusy: boolean;
    busyLabel: string;
  };
  runtime: {
    model?: TargetModelSummary;
    availableModels: TargetModelSummary[];
    contextUsage?: TargetContextUsage;
    isIdle: boolean;
    updatedAt: number;
  };
};

export type DirectCommandResult = DeliveryResult;

export type TargetModelSummary = {
  provider: string;
  id: string;
  label?: string;
};

export type TargetContextUsage = {
  tokens: number | null;
  maxTokens: number;
  percent: number | null;
};

/**
 * PiMirrorEvent — live event union for mirror forwarding.
 * Replaces the old ChatEvent as the protocol for real-time Pi event forwarding.
 * These events are NOT the authoritative history model — they supplement
 * the snapshot's `chat.entries` with live streaming updates.
 */
export type PiMirrorEvent =
  | { type: "message_start"; message: { id: string; role: string; content?: unknown } }
  | {
      type: "message_update";
      message: { id: string; role: string };
      assistantMessageEvent?: { type: "text_delta"; text_delta: string };
    }
  | { type: "message_end"; message: { id: string; role: string }; stopReason?: string }
  | { type: "turn_start"; turnId: string }
  | { type: "turn_end"; turnId: string }
  | { type: "tool_execution_start"; toolName: string; input?: unknown }
  | { type: "tool_execution_update"; toolName: string; output?: unknown }
  | { type: "tool_execution_end"; toolName: string; output?: unknown; error?: string }
  | { type: "model_select"; provider: string; modelId: string };

export type DeliveryResult = {
  ok: boolean;
  error?: string;
};

function createRandomIdSegment(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }

  if (typeof globalThis.crypto?.getRandomValues === "function") {
    const bytes = new Uint8Array(16);
    globalThis.crypto.getRandomValues(bytes);
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  }

  return `${Math.random().toString(16).slice(2)}${Math.random().toString(16).slice(2)}`;
}

export function createRequestId(): string {
  return `${Date.now().toString(36)}-${createRandomIdSegment()}`;
}

export function isProtocolEnvelope(value: unknown): value is ProtocolEnvelope {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Partial<ProtocolEnvelope>;
  return (
    candidate.version === PROTOCOL_VERSION &&
    typeof candidate.type === "string" &&
    PROTOCOL_MESSAGE_TYPE_SET.has(candidate.type) &&
    (candidate.requestId === undefined || typeof candidate.requestId === "string")
  );
}

export function parseProtocolEnvelope(raw: string): ProtocolEnvelope | null {
  try {
    const parsed = JSON.parse(raw);
    return isProtocolEnvelope(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export type ValidationResult = { ok: true } | { ok: false; error: string };

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function hasFiniteTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function validateDirectSendChatPayload(value: unknown): ValidationResult {
  if (!value || typeof value !== "object") {
    return { ok: false, error: "Payload must be an object" };
  }

  const payload = value as Partial<DirectSendChatPayload>;

  if (!isNonEmptyString(payload.message)) {
    return { ok: false, error: "Missing message" };
  }

  return { ok: true };
}

export function validateDirectSendSelectionPayload(value: unknown): ValidationResult {
  if (!value || typeof value !== "object") {
    return { ok: false, error: "Payload must be an object" };
  }

  const payload = value as Partial<DirectSendSelectionPayload>;

  const selectionValidation = validateSelectionPayload(payload.selection);
  if (!selectionValidation.ok) {
    return selectionValidation;
  }

  return { ok: true };
}

export function validateDirectSetModelPayload(value: unknown): ValidationResult {
  if (!value || typeof value !== "object") {
    return { ok: false, error: "Payload must be an object" };
  }

  const payload = value as Partial<DirectSetModelPayload>;

  if (!isNonEmptyString(payload.provider)) {
    return { ok: false, error: "Missing provider" };
  }

  if (!isNonEmptyString(payload.modelId)) {
    return { ok: false, error: "Missing modelId" };
  }

  return { ok: true };
}

/**
 * Validate a PiMirrorEvent — the new live-event format for mirror forwarding.
 */
export function validatePiMirrorEvent(value: unknown): ValidationResult {
  if (!value || typeof value !== "object") {
    return { ok: false, error: "Payload must be an object" };
  }

  const event = value as Record<string, unknown>;
  const type = event.type;

  if (typeof type !== "string") {
    return { ok: false, error: "Missing event type" };
  }

  switch (type) {
    case "message_start":
    case "message_end": {
      const msg = event.message;
      if (!msg || typeof msg !== "object") {
        return { ok: false, error: "Missing message" };
      }
      const m = msg as Record<string, unknown>;
      if (typeof m.id !== "string" || m.id.length === 0) {
        return { ok: false, error: "Missing message.id" };
      }
      if (typeof m.role !== "string") {
        return { ok: false, error: "Missing message.role" };
      }
      return { ok: true };
    }

    case "message_update": {
      const msg = event.message;
      if (!msg || typeof msg !== "object") {
        return { ok: false, error: "Missing message" };
      }
      const m = msg as Record<string, unknown>;
      if (typeof m.id !== "string" || m.id.length === 0) {
        return { ok: false, error: "Missing message.id" };
      }
      if (typeof m.role !== "string") {
        return { ok: false, error: "Missing message.role" };
      }
      // assistantMessageEvent is optional, but if present must be valid
      if (event.assistantMessageEvent !== undefined) {
        const ame = event.assistantMessageEvent as Record<string, unknown>;
        if (typeof ame !== "object" || ame === null) {
          return { ok: false, error: "Invalid assistantMessageEvent" };
        }
        if (ame.type !== "text_delta") {
          return { ok: false, error: "Unsupported assistantMessageEvent type" };
        }
        if (typeof ame.text_delta !== "string") {
          return { ok: false, error: "Missing text_delta" };
        }
      }
      return { ok: true };
    }

    case "turn_start":
    case "turn_end": {
      if (typeof event.turnId !== "string" || event.turnId.length === 0) {
        return { ok: false, error: "Missing turnId" };
      }
      return { ok: true };
    }

    case "tool_execution_start":
    case "tool_execution_update":
    case "tool_execution_end": {
      if (typeof event.toolName !== "string" || event.toolName.length === 0) {
        return { ok: false, error: "Missing toolName" };
      }
      return { ok: true };
    }

    case "model_select": {
      if (typeof event.provider !== "string" || event.provider.length === 0) {
        return { ok: false, error: "Missing provider" };
      }
      if (typeof event.modelId !== "string" || event.modelId.length === 0) {
        return { ok: false, error: "Missing modelId" };
      }
      return { ok: true };
    }

    default:
      return { ok: false, error: `Unknown mirror event type: ${type}` };
  }
}

export function validateSelectionPayload(value: unknown): ValidationResult {
  if (!value || typeof value !== "object") {
    return { ok: false, error: "Payload must be an object" };
  }

  const payload = value as Partial<SelectionPayload>;

  if (typeof payload.url !== "string" || payload.url.length === 0) {
    return { ok: false, error: "Missing url" };
  }

  if (typeof payload.title !== "string") {
    return { ok: false, error: "Missing title" };
  }

  if (typeof payload.selectedText !== "string") {
    return { ok: false, error: "Missing selectedText" };
  }

  if (typeof payload.selectedHtml !== "string") {
    return { ok: false, error: "Missing selectedHtml" };
  }

  if (payload.selector !== undefined && typeof payload.selector !== "string") {
    return { ok: false, error: "Invalid selector" };
  }

  if (payload.comment !== undefined && typeof payload.comment !== "string") {
    return { ok: false, error: "Invalid comment" };
  }

  if (typeof payload.capturedAt !== "number" || !Number.isFinite(payload.capturedAt)) {
    return { ok: false, error: "Missing capturedAt" };
  }

  if (payload.selectedText.length === 0 && payload.selectedHtml.length === 0) {
    return { ok: false, error: "Selection must include text or html" };
  }

  return { ok: true };
}
