import { execFile as execFileCallback } from "node:child_process";
import { basename } from "node:path";
import { promisify } from "node:util";

import WebSocket from "ws";

import {
  DEFAULT_BROKER_HOST,
  DEFAULT_BROKER_PORT,
  PROTOCOL_VERSION,
  TARGET_HEARTBEAT_INTERVAL_MS,
} from "../shared/constants";
import { formatSelectionMessage } from "../shared/formatSelectionMessage";
import {
  createRequestId,
  parseProtocolEnvelope,
  validateSelectionPayload,
  type ChatEvent,
  type DeliveryResult,
  type SelectionPayload,
  type TargetMetadata,
} from "../shared/protocol";
import type { BrowserConnectLogger } from "./logging";

const execFile = promisify(execFileCallback);
const CHAT_BUSY_LABEL = "Агент работает в фоне…";

function toErrorMessage(error: unknown): string {
  return error instanceof Error && error.message.length > 0 ? error.message : "Unknown error";
}

function normalizeOptionalString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function sendEnvelope(
  socket: WebSocket,
  envelope: {
    type: string;
    requestId?: string;
    payload?: unknown;
  },
): void {
  if (socket.readyState !== WebSocket.OPEN) {
    return;
  }

  socket.send(
    JSON.stringify({
      version: PROTOCOL_VERSION,
      type: envelope.type,
      requestId: envelope.requestId,
      payload: envelope.payload,
    }),
  );
}

export function getTargetDisplayLabel(
  metadata: Pick<TargetMetadata, "alias" | "cwd"> & Partial<TargetMetadata>,
): string {
  const alias = normalizeOptionalString(metadata.alias);

  if (alias) {
    return alias;
  }

  const directoryName = basename(metadata.cwd);
  return directoryName.length > 0 ? directoryName : metadata.cwd;
}

export async function getGitBranch(cwd: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFile("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd,
      timeout: 3_000,
      windowsHide: true,
    });
    const branch = stdout.trim();

    if (branch.length === 0 || branch === "HEAD") {
      return undefined;
    }

    return branch;
  } catch {
    return undefined;
  }
}

export type BuildTargetMetadataOptions = {
  targetId: string;
  alias?: string;
  cwd: string;
  pid: number;
  sessionName?: string;
  now?: number;
  getGitBranch?: (cwd: string) => Promise<string | undefined>;
};

export async function buildTargetMetadata(
  options: BuildTargetMetadataOptions,
): Promise<TargetMetadata> {
  const now = options.now ?? Date.now();
  const alias = normalizeOptionalString(options.alias);
  const sessionName = normalizeOptionalString(options.sessionName);
  const gitBranch = await (options.getGitBranch ?? getGitBranch)(options.cwd);

  return {
    targetId: options.targetId,
    ...(alias ? { alias } : {}),
    cwd: options.cwd,
    ...(gitBranch ? { gitBranch } : {}),
    pid: options.pid,
    ...(sessionName ? { sessionName } : {}),
    connectedAt: now,
    lastSeenAt: now,
  };
}

export type HandleDeliveredSelectionOptions = {
  selection: SelectionPayload;
  isIdle: () => boolean;
  sendUserMessage: (
    content: string,
    options?: {
      deliverAs?: "steer" | "followUp";
    },
  ) => void | Promise<void>;
  logger?: BrowserConnectLogger;
};

export async function handleDeliveredSelection(
  options: HandleDeliveredSelectionOptions,
): Promise<DeliveryResult> {
  try {
    const message = formatSelectionMessage(options.selection);
    const deliveryOptions = options.isIdle()
      ? undefined
      : ({ deliverAs: "followUp" } as const);

    await options.sendUserMessage(message, deliveryOptions);
    options.logger?.info("target.selection.delivered", {
      idle: deliveryOptions === undefined,
      url: options.selection.url,
      capturedAt: options.selection.capturedAt,
    });

    return { ok: true };
  } catch (error) {
    const errorMessage = toErrorMessage(error);
    options.logger?.error("target.selection.delivery_failed", {
      error: errorMessage,
      url: options.selection.url,
      capturedAt: options.selection.capturedAt,
    });

    return {
      ok: false,
      error: errorMessage,
    };
  }
}

export type HandleDeliveredChatMessageOptions = {
  message: string;
  isIdle: () => boolean;
  sendUserMessage: (
    content: string,
    options?: {
      deliverAs?: "steer" | "followUp";
    },
  ) => void | Promise<void>;
  emitChatEvent: (event: ChatEvent) => void;
  logger?: BrowserConnectLogger;
  now?: () => number;
};

export async function handleDeliveredChatMessage(
  options: HandleDeliveredChatMessageOptions,
): Promise<DeliveryResult> {
  const now = options.now ?? Date.now;
  const emitBusy = (busy: boolean) => {
    options.emitChatEvent({
      kind: "agent_busy",
      busy,
      label: CHAT_BUSY_LABEL,
      timestamp: now(),
    });
  };

  try {
    emitBusy(true);
    const deliveryOptions = options.isIdle()
      ? undefined
      : ({ deliverAs: "followUp" } as const);

    await options.sendUserMessage(options.message, deliveryOptions);
    options.logger?.info("target.chat.delivered", {
      idle: deliveryOptions === undefined,
    });

    return { ok: true };
  } catch (error) {
    const errorMessage = toErrorMessage(error);
    options.emitChatEvent({
      kind: "error",
      message: errorMessage,
      timestamp: now(),
    });
    emitBusy(false);
    options.logger?.error("target.chat.delivery_failed", {
      error: errorMessage,
    });

    return {
      ok: false,
      error: errorMessage,
    };
  }
}

export type ConnectTargetToBrokerOptions = {
  token: string;
  metadata: TargetMetadata;
  logger: BrowserConnectLogger;
  onDeliveredSelection: (
    selection: SelectionPayload,
  ) => DeliveryResult | Promise<DeliveryResult>;
  onDeliveredChatMessage?: (message: string) => DeliveryResult | Promise<DeliveryResult>;
  onDisconnect?: () => void;
  host?: string;
  port?: number;
  heartbeatIntervalMs?: number;
  registrationTimeoutMs?: number;
  webSocketFactory?: (url: string) => WebSocket;
};

export type ConnectedTargetClient = {
  readonly port: number;
  readonly url: string;
  readonly metadata: TargetMetadata;
  isOpen(): boolean;
  emitChatEvent(event: ChatEvent): void;
  close(): Promise<void>;
};

async function handleIncomingDeliveryMessage(
  socket: WebSocket,
  envelope: {
    requestId?: string;
    payload?: unknown;
  },
  options: Pick<ConnectTargetToBrokerOptions, "logger" | "onDeliveredSelection">,
): Promise<void> {
  if (typeof envelope.requestId !== "string" || envelope.requestId.length === 0) {
    options.logger.warn("target.delivery.invalid_request_id");
    return;
  }

  const selection = (envelope.payload as { selection?: unknown } | undefined)?.selection;
  const selectionValidation = validateSelectionPayload(selection);

  if (!selectionValidation.ok) {
    options.logger.warn("target.delivery.invalid_payload", {
      requestId: envelope.requestId,
      error: selectionValidation.error,
    });
    sendEnvelope(socket, {
      type: "target.sendSelectionResult",
      requestId: envelope.requestId,
      payload: {
        ok: false,
        error: selectionValidation.error,
      },
    });
    return;
  }

  const result = await options.onDeliveredSelection(selection as SelectionPayload);

  sendEnvelope(socket, {
    type: "target.sendSelectionResult",
    requestId: envelope.requestId,
    payload: result,
  });
}

async function handleIncomingChatMessage(
  envelope: {
    requestId?: string;
    payload?: unknown;
  },
  options: Pick<ConnectTargetToBrokerOptions, "logger" | "onDeliveredChatMessage">,
): Promise<void> {
  if (typeof envelope.requestId !== "string" || envelope.requestId.length === 0) {
    options.logger.warn("target.chat.invalid_request_id");
    return;
  }

  const payload = envelope.payload as { message?: unknown } | undefined;

  if (typeof payload?.message !== "string" || payload.message.trim().length === 0) {
    options.logger.warn("target.chat.invalid_payload", {
      requestId: envelope.requestId,
      error: "Missing message",
    });
    return;
  }

  if (!options.onDeliveredChatMessage) {
    options.logger.warn("target.chat.handler_missing", {
      requestId: envelope.requestId,
    });
    return;
  }

  await options.onDeliveredChatMessage(payload.message);
}

export async function connectTargetToBroker(
  options: ConnectTargetToBrokerOptions,
): Promise<ConnectedTargetClient> {
  const host = options.host ?? DEFAULT_BROKER_HOST;
  const port = options.port ?? DEFAULT_BROKER_PORT;
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? TARGET_HEARTBEAT_INTERVAL_MS;
  const registrationTimeoutMs = options.registrationTimeoutMs ?? 10_000;
  const url = `ws://${host}:${port}`;
  const socket = (options.webSocketFactory ?? ((nextUrl: string) => new WebSocket(nextUrl)))(url);
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  let registrationTimer: ReturnType<typeof setTimeout> | undefined;
  let isClosing = false;
  let registrationTimedOut = false;
  let registrationRequestId: string | undefined;
  let isRegistered = false;
  let hasClosed = socket.readyState === WebSocket.CLOSED;
  let resolveRegistration: (() => void) | undefined;
  let rejectRegistration: ((error: Error) => void) | undefined;

  const clearHeartbeatTimer = () => {
    if (!heartbeatTimer) {
      return;
    }

    clearInterval(heartbeatTimer);
    heartbeatTimer = undefined;
  };

  const clearRegistrationTimer = () => {
    if (!registrationTimer) {
      return;
    }

    clearTimeout(registrationTimer);
    registrationTimer = undefined;
  };

  const settleRegistrationFailure = (error: Error) => {
    clearRegistrationTimer();

    if (!rejectRegistration) {
      return;
    }

    const reject = rejectRegistration;
    resolveRegistration = undefined;
    rejectRegistration = undefined;
    reject(error);
  };

  const settleRegistrationSuccess = () => {
    if (!resolveRegistration) {
      return;
    }

    clearRegistrationTimer();
    isRegistered = true;
    heartbeatTimer = setInterval(() => {
      sendEnvelope(socket, {
        type: "target.heartbeat",
      });
    }, heartbeatIntervalMs);

    options.logger.info("target.connected", {
      targetId: options.metadata.targetId,
      url,
    });

    const resolve = resolveRegistration;
    resolveRegistration = undefined;
    rejectRegistration = undefined;
    resolve();
  };

  const rejectRegistrationFromBrokerMessage = (payload: unknown) => {
    if (!rejectRegistration) {
      return;
    }

    const error = (payload as { error?: unknown } | undefined)?.error;
    const errorMessage = typeof error === "string" && error.length > 0
      ? error
      : `Target registration failed: ${url}`;

    settleRegistrationFailure(new Error(errorMessage));
  };

  const closePromise = new Promise<void>((resolve) => {
    socket.once("close", () => {
      clearHeartbeatTimer();
      resolve();
    });
  });

  socket.on("message", async (rawMessage) => {
    const envelope = parseProtocolEnvelope(rawMessage.toString());

    if (!envelope) {
      options.logger.warn("target.broker.invalid_message", { rawMessage: rawMessage.toString() });
      return;
    }

    if (!isRegistered) {
      if (envelope.type === "target.registered" && envelope.requestId === registrationRequestId) {
        settleRegistrationSuccess();
        return;
      }

      if (envelope.type === "client.error" && envelope.requestId === registrationRequestId) {
        rejectRegistrationFromBrokerMessage(envelope.payload);
        return;
      }
    }

    if (envelope.type === "target.deliverSelection") {
      try {
        await handleIncomingDeliveryMessage(socket, envelope, options);
      } catch (error) {
        const errorMessage = toErrorMessage(error);
        options.logger.error("target.delivery.handler_failed", {
          requestId: envelope.requestId,
          error: errorMessage,
        });

        if (typeof envelope.requestId === "string") {
          sendEnvelope(socket, {
            type: "target.sendSelectionResult",
            requestId: envelope.requestId,
            payload: {
              ok: false,
              error: errorMessage,
            },
          });
        }
      }
      return;
    }

    if (envelope.type === "target.deliverChatMessage") {
      try {
        await handleIncomingChatMessage(envelope, options);
      } catch (error) {
        options.logger.error("target.chat.handler_failed", {
          requestId: envelope.requestId,
          error: toErrorMessage(error),
        });
      }
    }
  });

  socket.on("error", (error) => {
    if (!isRegistered) {
      settleRegistrationFailure(new Error(toErrorMessage(error)));
      return;
    }

    options.logger.warn("target.socket.error", { error: toErrorMessage(error), url });
  });

  socket.on("close", () => {
    hasClosed = true;
    clearRegistrationTimer();
    options.logger.info("target.socket.closed", {
      targetId: options.metadata.targetId,
      url,
      initiatedByClient: isClosing,
    });

    if (!isRegistered) {
      if (!registrationTimedOut) {
        settleRegistrationFailure(new Error(`Connection closed before target registration ack: ${url}`));
      }
      return;
    }

    if (!isClosing) {
      options.onDisconnect?.();
    }
  });

  await new Promise<void>((resolve, reject) => {
    resolveRegistration = resolve;
    rejectRegistration = reject;

    const onOpen = () => {
      socket.off("open", onOpen);
      registrationRequestId = createRequestId();
      clearRegistrationTimer();
      registrationTimer = setTimeout(() => {
        registrationTimedOut = true;
        isClosing = true;

        if (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN) {
          socket.terminate();
        }

        settleRegistrationFailure(new Error(`Target registration timed out after ${registrationTimeoutMs}ms: ${url}`));
      }, registrationTimeoutMs);

      sendEnvelope(socket, {
        type: "target.register",
        requestId: registrationRequestId,
        payload: {
          token: options.token,
          target: options.metadata,
        },
      });
    };

    if (socket.readyState === WebSocket.OPEN) {
      onOpen();
      return;
    }

    if (socket.readyState === WebSocket.CLOSED) {
      reject(new Error(`Connection closed before target registration ack: ${url}`));
      return;
    }

    socket.once("open", onOpen);
  });

  return {
    port,
    url,
    metadata: options.metadata,
    isOpen() {
      return !hasClosed && socket.readyState === WebSocket.OPEN;
    },
    emitChatEvent(event: ChatEvent) {
      sendEnvelope(socket, {
        type: "target.chatEvent",
        payload: event,
      });
    },
    async close() {
      if (isClosing) {
        await closePromise;
        return;
      }

      isClosing = true;
      clearHeartbeatTimer();

      if (socket.readyState === WebSocket.OPEN) {
        sendEnvelope(socket, {
          type: "target.unregister",
        });
        socket.close();
      } else if (socket.readyState === WebSocket.CONNECTING) {
        socket.terminate();
      }

      await closePromise;
    },
  };
}
