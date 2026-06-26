import { PROTOCOL_VERSION } from "./constants";

export const PROTOCOL_MESSAGE_TYPES = [
  "client.hello",
  "client.listTargets",
  "client.sendSelection",
  "client.subscribeTarget",
  "client.unsubscribeTarget",
  "client.sendChatMessage",
  "client.chatAccepted",
  "client.chatEvent",
  "target.register",
  "target.registered",
  "target.heartbeat",
  "target.unregister",
  "target.sendSelectionResult",
  "client.targets",
  "client.sendResult",
  "client.error",
  "target.deliverSelection",
  "target.deliverChatMessage",
  "target.chatEvent",
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

export type BrowserClientHelloPayload = {
  token: string;
};

export type BrowserClientSendSelectionPayload = {
  token: string;
  targetId: string;
  selection: SelectionPayload;
};

export type BrowserClientSubscribeTargetPayload = {
  token: string;
  targetId: string;
};

export type BrowserClientSendChatMessagePayload = {
  token: string;
  targetId: string;
  message: string;
};

export type TargetDeliverChatMessagePayload = {
  message: string;
  sentAt: number;
};

export type ChatEvent =
  | { kind: "user_message"; text: string; timestamp: number }
  | { kind: "agent_busy"; busy: boolean; label: string; timestamp: number }
  | { kind: "assistant_message_start"; messageId: string; timestamp: number }
  | { kind: "assistant_text_delta"; messageId: string; delta: string; timestamp: number }
  | { kind: "assistant_message_end"; messageId: string; timestamp: number }
  | { kind: "error"; message: string; timestamp: number };

export type TargetMetadata = {
  targetId: string;
  alias?: string;
  cwd: string;
  gitBranch?: string;
  pid: number;
  sessionName?: string;
  connectedAt: number;
  lastSeenAt: number;
};

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

type ValidationResult = { ok: true } | { ok: false; error: string };

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function hasFiniteTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function validateSubscribeTargetPayload(value: unknown): ValidationResult {
  if (!value || typeof value !== "object") {
    return { ok: false, error: "Payload must be an object" };
  }

  const payload = value as Partial<BrowserClientSubscribeTargetPayload>;

  if (!isNonEmptyString(payload.token)) {
    return { ok: false, error: "Missing token" };
  }

  if (!isNonEmptyString(payload.targetId)) {
    return { ok: false, error: "Missing targetId" };
  }

  return { ok: true };
}

export function validateSendChatMessagePayload(value: unknown): ValidationResult {
  const subscriptionValidation = validateSubscribeTargetPayload(value);

  if (!subscriptionValidation.ok) {
    return subscriptionValidation;
  }

  const payload = value as Partial<BrowserClientSendChatMessagePayload>;

  if (!isNonEmptyString(payload.message)) {
    return { ok: false, error: "Missing message" };
  }

  return { ok: true };
}

export function validateChatEvent(value: unknown): ValidationResult {
  if (!value || typeof value !== "object") {
    return { ok: false, error: "Payload must be an object" };
  }

  const event = value as Partial<ChatEvent> & { kind?: unknown; timestamp?: unknown };

  if (!hasFiniteTimestamp(event.timestamp)) {
    return { ok: false, error: "Missing timestamp" };
  }

  switch (event.kind) {
    case "user_message":
      return isNonEmptyString((event as Partial<Extract<ChatEvent, { kind: "user_message" }>>).text)
        ? { ok: true }
        : { ok: false, error: "Missing text" };

    case "agent_busy": {
      const busyEvent = event as Partial<Extract<ChatEvent, { kind: "agent_busy" }>>;
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
        (event as Partial<Extract<ChatEvent, { kind: "assistant_message_start" | "assistant_message_end" }>>)
          .messageId,
      )
        ? { ok: true }
        : { ok: false, error: "Missing messageId" };

    case "assistant_text_delta": {
      const deltaEvent = event as Partial<Extract<ChatEvent, { kind: "assistant_text_delta" }>>;

      if (!isNonEmptyString(deltaEvent.messageId)) {
        return { ok: false, error: "Missing messageId" };
      }

      if (typeof deltaEvent.delta !== "string") {
        return { ok: false, error: "Missing delta" };
      }

      return { ok: true };
    }

    case "error":
      return isNonEmptyString((event as Partial<Extract<ChatEvent, { kind: "error" }>>).message)
        ? { ok: true }
        : { ok: false, error: "Missing message" };

    default:
      return { ok: false, error: "Unknown chat event kind" };
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
