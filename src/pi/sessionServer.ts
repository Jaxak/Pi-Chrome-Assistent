import { WebSocketServer, WebSocket } from "ws";

import { PROTOCOL_VERSION } from "../shared/constants";
import {
  parseProtocolEnvelope,
  validateDirectSendChatPayload,
  validateDirectSendSelectionPayload,
  validateDirectSetModelPayload,
  type DirectCommandResult,
  type DirectSessionSnapshot,
  type PiMirrorEvent,
  type SelectionPayload,
} from "../shared/protocol";
import type { BrowserConnectLogger } from "./logging";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const DEFAULT_DIRECT_SESSION_PORT = 31_415;
export const DIRECT_SESSION_PORT_SCAN_LIMIT = 100;
export const WEBSOCKET_MAX_PAYLOAD_BYTES = 1_048_576; // 1 MB

// ---------------------------------------------------------------------------
// Rate limiting (M3)
// ---------------------------------------------------------------------------

const RATE_LIMIT_MESSAGES_PER_SECOND = 5;
const RATE_LIMIT_WINDOW_MS = 1000;

/**
 * Sliding-window rate limiter that tracks timestamps of accepted messages.
 * Allows at most `maxMessages` messages within `windowMs` milliseconds.
 */
class RateLimiter {
  private timestamps: number[] = [];
  private readonly maxMessages: number;
  private readonly windowMs: number;

  constructor(maxMessages: number, windowMs: number) {
    this.maxMessages = maxMessages;
    this.windowMs = windowMs;
  }

  tryConsume(): boolean {
    const now = Date.now();
    const cutoff = now - this.windowMs;

    // Remove expired timestamps
    this.timestamps = this.timestamps.filter((ts) => ts > cutoff);

    if (this.timestamps.length >= this.maxMessages) {
      return false;
    }

    this.timestamps.push(now);
    return true;
  }
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type DirectSessionServer = {
  /** The actual port the server is listening on (may differ from requested if 0 was passed). */
  port: number;
  /** Send a fresh snapshot to all currently-connected browser sockets. */
  broadcastSnapshot(): void;
  /** Broadcast a raw Pi mirror event to all currently-connected browser sockets. */
  broadcastEvent(event: PiMirrorEvent): void;
  /** Close the server and all connected client sockets. */
  close(): Promise<void>;
};

export type DirectSessionServerOptions = {
  /** Host address to bind, e.g. "127.0.0.1". */
  host: string;
  /** Port to listen on. Use 0 for an ephemeral port. */
  port: number;
  /** Build the current authoritative snapshot. Called on connect and on broadcastSnapshot. */
  buildSnapshot(): DirectSessionSnapshot;
  /** Called when browser sends a chat message. Return ok/error result. */
  onChatMessage(message: string): Promise<DirectCommandResult> | DirectCommandResult;
  /** Called when browser sends a selection. Return ok/error result. */
  onSelection(selection: SelectionPayload): Promise<DirectCommandResult> | DirectCommandResult;
  /** Called when browser requests a model change. Return ok/error result. */
  onSetModel(input: { provider: string; modelId: string }): Promise<DirectCommandResult> | DirectCommandResult;
  /** Logger for diagnostic messages. */
  logger: BrowserConnectLogger;
};

export type DirectSessionServerOnAvailablePortOptions = {
  /** Host address to bind, e.g. "127.0.0.1". */
  host: string;
  /** The first port to try. Subsequent ports are tried sequentially if occupied. */
  preferredPort: number;
  /** Maximum number of ports to try. Defaults to DIRECT_SESSION_PORT_SCAN_LIMIT. */
  scanLimit?: number;
  /** Build the current authoritative snapshot. Called on connect and on broadcastSnapshot. */
  buildSnapshot(): DirectSessionSnapshot;
  /** Called when browser sends a chat message. Return ok/error result. */
  onChatMessage(message: string): Promise<DirectCommandResult> | DirectCommandResult;
  /** Called when browser sends a selection. Return ok/error result. */
  onSelection(selection: SelectionPayload): Promise<DirectCommandResult> | DirectCommandResult;
  /** Called when browser requests a model change. Return ok/error result. */
  onSetModel(input: { provider: string; modelId: string }): Promise<DirectCommandResult> | DirectCommandResult;
  /** Logger for diagnostic messages. */
  logger: BrowserConnectLogger;
};

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Start a standalone WebSocket server for a single Pi session.
 *
 * On each new WebSocket connection the server immediately sends a
 * `session.snapshot` envelope so the browser gets authoritative state.
 * Incoming command envelopes (`session.chat.send`, `session.selection.send`,
 * `session.model.set`) are dispatched to the injected handlers.
 *
 * No heartbeat — for a local server with 1-2 clients this is unnecessary;
 * the connection lives until either side explicitly closes it.
 */
export async function startDirectSessionServer(
  options: DirectSessionServerOptions,
): Promise<DirectSessionServer> {

  const wss = new WebSocketServer({
    host: options.host,
    port: options.port,
    maxPayload: WEBSOCKET_MAX_PAYLOAD_BYTES,
  });

  return new Promise((resolve, reject) => {
    wss.on("connection", (ws) => {
      handleConnection(ws, options);
    });

    wss.on("listening", () => {
      const address = wss.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;

      resolve({
        port,
        broadcastSnapshot: () => sendSnapshotToAll(wss.clients, options.buildSnapshot()),
        broadcastEvent: (event: PiMirrorEvent) => sendEventToAll(wss.clients, event),
        close: () => closeServer(wss),
      });
    });

    wss.on("error", (error) => {
      reject(error);
    });
  });
}

/**
 * Check whether an error indicates the address is already in use (EADDRINUSE).
 */
function isAddressInUseError(error: unknown): boolean {
  if (error && typeof error === "object" && "code" in error) {
    return (error as NodeJS.ErrnoException).code === "EADDRINUSE";
  }
  return false;
}

/**
 * Start a direct session server, trying `preferredPort` first, then
 * `preferredPort + 1`, `preferredPort + 2`, … up to `scanLimit` attempts.
 *
 * Only EADDRINUSE errors are caught and retried. All other errors are
 * re-thrown immediately. If no free port is found within the scan limit,
 * a descriptive Russian error is thrown.
 */
export async function startDirectSessionServerOnAvailablePort(
  options: DirectSessionServerOnAvailablePortOptions,
): Promise<DirectSessionServer> {
  const limit = options.scanLimit ?? DIRECT_SESSION_PORT_SCAN_LIMIT;

  for (let offset = 0; offset < limit; offset += 1) {
    const port = options.preferredPort + offset;
    try {
      return await startDirectSessionServer({
        host: options.host,
        port,
        buildSnapshot: options.buildSnapshot,
        onChatMessage: options.onChatMessage,
        onSelection: options.onSelection,
        onSetModel: options.onSetModel,
        logger: options.logger,
      });
    } catch (error) {
      if (!isAddressInUseError(error)) {
        throw error;
      }
      // Port occupied — try the next one
    }
  }

  throw new Error(
    `Не удалось найти свободный порт для Chrome Assistent (проверено порты ${options.preferredPort}–${options.preferredPort + limit - 1})`,
  );
}

function handleConnection(ws: WebSocket, options: DirectSessionServerOptions): void {
  const rateLimiter = new RateLimiter(RATE_LIMIT_MESSAGES_PER_SECOND, RATE_LIMIT_WINDOW_MS);

  // Immediately send authoritative snapshot on connect
  sendSnapshot(ws, options.buildSnapshot());

  ws.on("message", async (rawData, _isBinary) => {
    let buffer: Buffer;
    if (Array.isArray(rawData)) {
      buffer = Buffer.concat(rawData);
    } else if (Buffer.isBuffer(rawData)) {
      buffer = rawData;
    } else {
      // ArrayBuffer
      buffer = Buffer.from(rawData);
    }
    const raw = buffer.toString("utf8");

    const envelope = parseProtocolEnvelope(raw);

    if (!envelope) {
      // Malformed message — send error
      sendError(ws, undefined, "Не удалось разобрать сообщение");
      return;
    }

    // Rate limiting (M3) — check after parsing so we can include requestId
    if (!rateLimiter.tryConsume()) {
      sendError(ws, envelope.requestId, "Превышен лимит сообщений. Подождите.");
      return;
    }

    switch (envelope.type) {
      case "session.chat.send": {
        const validation = validateDirectSendChatPayload(envelope.payload);
        if (!validation.ok) {
          sendError(ws, envelope.requestId, validation.error);
          return;
        }
        const result = await safelyCall(
          () => options.onChatMessage((envelope.payload as { message: string }).message),
        );
        sendCommandResult(ws, envelope.requestId, result);
        break;
      }

      case "session.selection.send": {
        const validation = validateDirectSendSelectionPayload(envelope.payload);
        if (!validation.ok) {
          sendError(ws, envelope.requestId, validation.error);
          return;
        }
        const result = await safelyCall(
          () => options.onSelection((envelope.payload as { selection: SelectionPayload }).selection),
        );
        sendCommandResult(ws, envelope.requestId, result);
        break;
      }

      case "session.model.set": {
        const validation = validateDirectSetModelPayload(envelope.payload);
        if (!validation.ok) {
          sendError(ws, envelope.requestId, validation.error);
          return;
        }
        const payload = envelope.payload as { provider: string; modelId: string };
        const result = await safelyCall(
          () => options.onSetModel({ provider: payload.provider, modelId: payload.modelId }),
        );
        sendCommandResult(ws, envelope.requestId, result);
        break;
      }

      case "session.snapshot":
      case "session.event":
      case "session.command.result":
      case "session.error":
        // Server-initiated types — ignore from client
        break;

      default:
        sendError(ws, envelope.requestId, `Неизвестный тип сообщения: ${envelope.type}`);
        break;
    }
  });

  ws.on("error", (error) => {
    options.logger.warn("session_server.client_error", {
      error: error.message,
    });
  });
}

// ---------------------------------------------------------------------------
// Sending helpers
// ---------------------------------------------------------------------------

function sendJson(ws: WebSocket, data: unknown): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

function sendSnapshot(ws: WebSocket, snapshot: DirectSessionSnapshot): void {
  sendJson(ws, {
    version: PROTOCOL_VERSION,
    type: "session.snapshot" as const,
    payload: snapshot,
  });
}

function sendCommandResult(ws: WebSocket, requestId: string | undefined, result: DirectCommandResult): void {
  sendJson(ws, {
    version: PROTOCOL_VERSION,
    type: "session.command.result" as const,
    ...(requestId !== undefined ? { requestId } : {}),
    payload: result,
  });
}

function sendError(ws: WebSocket, requestId: string | undefined, message: string): void {
  sendJson(ws, {
    version: PROTOCOL_VERSION,
    type: "session.error" as const,
    ...(requestId !== undefined ? { requestId } : {}),
    payload: { ok: false, error: message },
  });
}

function sendEvent(ws: WebSocket, event: PiMirrorEvent): void {
  sendJson(ws, {
    version: PROTOCOL_VERSION,
    type: "session.event" as const,
    payload: event,
  });
}

function sendSnapshotToAll(clients: Iterable<WebSocket>, snapshot: DirectSessionSnapshot): void {
  for (const ws of clients) {
    if (ws.readyState === WebSocket.OPEN) {
      sendSnapshot(ws, snapshot);
    }
  }
}

function sendEventToAll(clients: Iterable<WebSocket>, event: PiMirrorEvent): void {
  for (const ws of clients) {
    if (ws.readyState === WebSocket.OPEN) {
      sendEvent(ws, event);
    }
  }
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

async function closeServer(wss: WebSocketServer): Promise<void> {
  // Close all connected clients
  for (const ws of wss.clients) {
    try {
      ws.close();
    } catch {
      // Ignore close errors on already-closed sockets
    }
  }

  // Close the server itself
  return new Promise<void>((resolve, reject) => {
    wss.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

// ---------------------------------------------------------------------------
// Error wrapper
// ---------------------------------------------------------------------------

async function safelyCall(fn: () => Promise<DirectCommandResult> | DirectCommandResult): Promise<DirectCommandResult> {
  try {
    return await fn();
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Неизвестная ошибка" };
  }
}
