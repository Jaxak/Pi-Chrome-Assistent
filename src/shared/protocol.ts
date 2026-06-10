import { PROTOCOL_VERSION } from "./constants";

export const PROTOCOL_MESSAGE_TYPES = [
  "client.hello",
  "client.listTargets",
  "client.sendSelection",
  "target.register",
  "target.registered",
  "target.heartbeat",
  "target.unregister",
  "target.sendSelectionResult",
  "client.targets",
  "client.sendResult",
  "client.error",
  "target.deliverSelection",
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

export function validateSelectionPayload(
  value: unknown,
): { ok: true } | { ok: false; error: string } {
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
