import { createServer } from "node:http";

import WebSocket, { WebSocketServer } from "ws";

import {
  BROWSER_NOT_AUTHORIZED_ERROR,
  PROTOCOL_VERSION,
  TARGET_STALE_AFTER_MS,
} from "../shared/constants";
import {
  createRequestId,
  parseProtocolEnvelope,
  validateChatEvent,
  validateSelectionPayload,
  validateSendChatMessagePayload,
  validateSubscribeTargetPayload,
  type BrowserClientHelloPayload,
  type BrowserClientSendChatMessagePayload,
  type BrowserClientSendSelectionPayload,
  type BrowserClientSubscribeTargetPayload,
  type ChatEvent,
  type DeliveryResult,
  type SelectionPayload,
  type TargetMetadata,
} from "../shared/protocol";
import type { BrowserConnectLogger } from "./logging";

export type TargetConnection = (
  payload: SelectionPayload,
  clientSocket?: WebSocket,
) => DeliveryResult | Promise<DeliveryResult>;

type RegisteredTarget = {
  metadata: TargetMetadata;
  connection: TargetConnection;
};

function cloneTargetMetadata(metadata: TargetMetadata): TargetMetadata {
  return { ...metadata };
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error && error.message.length > 0 ? error.message : "Target delivery failed";
}

export class BrowserConnectBrokerState {
  private readonly targets = new Map<string, RegisteredTarget>();

  registerTarget(metadata: TargetMetadata, connection: TargetConnection): void {
    this.targets.set(metadata.targetId, {
      metadata: cloneTargetMetadata(metadata),
      connection,
    });
  }

  listTargets(): TargetMetadata[] {
    return Array.from(this.targets.values(), ({ metadata }) => cloneTargetMetadata(metadata));
  }

  heartbeat(targetId: string, lastSeenAt: number): boolean {
    const target = this.targets.get(targetId);

    if (!target) {
      return false;
    }

    target.metadata.lastSeenAt = lastSeenAt;
    return true;
  }

  unregisterTarget(targetId: string): boolean {
    return this.targets.delete(targetId);
  }

  removeStaleTargets(now: number, staleAfterMs: number): void {
    for (const [targetId, target] of this.targets.entries()) {
      if (now - target.metadata.lastSeenAt >= staleAfterMs) {
        this.targets.delete(targetId);
      }
    }
  }

  async deliverSelection(
    targetId: string,
    payload: SelectionPayload,
    clientSocket?: WebSocket,
  ): Promise<DeliveryResult> {
    const target = this.targets.get(targetId);

    if (!target) {
      return {
        ok: false,
        error: "Target is not available",
      };
    }

    try {
      return await (clientSocket === undefined
        ? target.connection(payload)
        : target.connection(payload, clientSocket));
    } catch (error) {
      return {
        ok: false,
        error: toErrorMessage(error),
      };
    }
  }
}

export type StartBrokerServerOptions = {
  host: string;
  port: number;
  targetToken: string;
  isBrowserTokenTrusted(token: string): boolean | Promise<boolean>;
  logger: BrowserConnectLogger;
  staleAfterMs?: number;
  deliveryTimeoutMs?: number;
};

export type BrowserConnectBrokerServer = {
  port: number;
  close(): Promise<void>;
};

type BrokerMessagePayload = Record<string, unknown> | undefined;

type PendingDelivery = {
  clientSocket: WebSocket;
  targetSocket: WebSocket;
  timeoutId: ReturnType<typeof setTimeout>;
  resolve(result: DeliveryResult): void;
};

type SettledDeliveryTombstone = {
  targetSocket: WebSocket;
  settledAt: number;
  reason: string;
};

const SETTLED_DELIVERY_TOMBSTONE_TTL_MS = 60_000;
const MAX_SETTLED_DELIVERY_TOMBSTONES = 1_000;

function sendEnvelope(socket: WebSocket, envelope: {
  type: string;
  requestId?: string;
  payload?: unknown;
}): void {
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

function sendClientError(socket: WebSocket, requestId: string | undefined, error: string): void {
  sendEnvelope(socket, {
    type: "client.error",
    requestId,
    payload: { error },
  });
}

function isValidToken(value: unknown, token: string): boolean {
  return typeof value === "string" && value === token;
}

function parseClientHelloPayload(
  payload: BrokerMessagePayload,
): { ok: true; token: string } | { ok: false; error: string } {
  if (!payload || typeof payload !== "object") {
    return { ok: false, error: "Payload must be an object" };
  }

  const candidate = payload as Partial<BrowserClientHelloPayload>;

  if (typeof candidate.token !== "string" || candidate.token.length === 0) {
    return { ok: false, error: "Missing token" };
  }

  return { ok: true, token: candidate.token };
}

function isTargetMetadata(value: unknown): value is TargetMetadata {
  if (!value || typeof value !== "object") {
    return false;
  }

  const target = value as Partial<TargetMetadata>;

  return (
    typeof target.targetId === "string" &&
    target.targetId.length > 0 &&
    (target.alias === undefined || typeof target.alias === "string") &&
    typeof target.cwd === "string" &&
    target.cwd.length > 0 &&
    (target.gitBranch === undefined || typeof target.gitBranch === "string") &&
    typeof target.pid === "number" &&
    Number.isFinite(target.pid) &&
    (target.sessionName === undefined || typeof target.sessionName === "string") &&
    typeof target.connectedAt === "number" &&
    Number.isFinite(target.connectedAt) &&
    typeof target.lastSeenAt === "number" &&
    Number.isFinite(target.lastSeenAt)
  );
}

function parseClientSendSelectionPayload(
  payload: BrokerMessagePayload,
):
  | ({ ok: true } & BrowserClientSendSelectionPayload)
  | { ok: false; error: string } {
  if (!payload || typeof payload !== "object") {
    return { ok: false, error: "Payload must be an object" };
  }

  const candidate = payload as Partial<BrowserClientSendSelectionPayload>;

  if (typeof candidate.token !== "string") {
    return { ok: false, error: "Missing token" };
  }

  if (typeof candidate.targetId !== "string" || candidate.targetId.length === 0) {
    return { ok: false, error: "Missing targetId" };
  }

  const selectionValidation = validateSelectionPayload(candidate.selection);

  if (!selectionValidation.ok) {
    return selectionValidation;
  }

  return {
    ok: true,
    token: candidate.token,
    targetId: candidate.targetId,
    selection: candidate.selection as SelectionPayload,
  };
}

function parseClientSubscribeTargetPayload(
  payload: BrokerMessagePayload,
):
  | ({ ok: true } & BrowserClientSubscribeTargetPayload)
  | { ok: false; error: string } {
  const validation = validateSubscribeTargetPayload(payload);

  if (!validation.ok) {
    return validation;
  }

  const candidate = payload as BrowserClientSubscribeTargetPayload;
  return {
    ok: true,
    token: candidate.token,
    targetId: candidate.targetId,
  };
}

function parseClientSendChatMessagePayload(
  payload: BrokerMessagePayload,
):
  | ({ ok: true } & BrowserClientSendChatMessagePayload)
  | { ok: false; error: string } {
  const validation = validateSendChatMessagePayload(payload);

  if (!validation.ok) {
    return validation;
  }

  const candidate = payload as BrowserClientSendChatMessagePayload;
  return {
    ok: true,
    token: candidate.token,
    targetId: candidate.targetId,
    message: candidate.message.trim(),
  };
}

export async function startBrokerServer(
  options: StartBrokerServerOptions,
): Promise<BrowserConnectBrokerServer> {
  const staleAfterMs = options.staleAfterMs ?? TARGET_STALE_AFTER_MS;
  const deliveryTimeoutMs = options.deliveryTimeoutMs ?? 30_000;
  const state = new BrowserConnectBrokerState();
  const server = createServer();
  const webSocketServer = new WebSocketServer({ server });
  const sockets = new Set<WebSocket>();
  const authenticatedClientSockets = new Set<WebSocket>();
  const authenticatedBrowserTokens = new Map<WebSocket, string>();
  const authenticatingClientSockets = new Map<WebSocket, Promise<boolean>>();
  const socketToTargetId = new Map<WebSocket, string>();
  const targetIdToSocket = new Map<string, WebSocket>();
  const browserSubscriptionsByTargetId = new Map<string, Set<WebSocket>>();
  const browserSocketSubscriptions = new Map<WebSocket, Set<string>>();
  const pendingDeliveries = new Map<string, PendingDelivery>();
  const settledDeliveryTombstones = new Map<string, SettledDeliveryTombstone>();
  let staleCleanupTimer: ReturnType<typeof setInterval> | undefined;
  let isClosing = false;

  const verifyBrowserToken = async (token: string): Promise<boolean> => {
    try {
      return await options.isBrowserTokenTrusted(token);
    } catch (error) {
      options.logger.warn("broker.client.browser_token_check_failed", {
        error: toErrorMessage(error),
      });
      return false;
    }
  };

  const ensureAuthenticatedClient = async (socket: WebSocket, requestId: string | undefined): Promise<boolean> => {
    if (authenticatedClientSockets.has(socket)) {
      return true;
    }

    const authenticationPromise = authenticatingClientSockets.get(socket);

    if (authenticationPromise) {
      const authenticated = await authenticationPromise;
      return authenticated && authenticatedClientSockets.has(socket);
    }

    sendClientError(socket, requestId, "Client is not authenticated");
    socket.close();
    return false;
  };

  const isMatchingBrowserToken = (socket: WebSocket, token: string, requestId: string | undefined): boolean => {
    const authenticatedBrowserToken = authenticatedBrowserTokens.get(socket);

    if (!authenticatedBrowserToken || token !== authenticatedBrowserToken) {
      sendClientError(socket, requestId, BROWSER_NOT_AUTHORIZED_ERROR);
      socket.close();
      return false;
    }

    return true;
  };

  const subscribeBrowserToTarget = (socket: WebSocket, targetId: string) => {
    const targetSubscriptions = browserSubscriptionsByTargetId.get(targetId) ?? new Set<WebSocket>();
    targetSubscriptions.add(socket);
    browserSubscriptionsByTargetId.set(targetId, targetSubscriptions);

    const socketSubscriptions = browserSocketSubscriptions.get(socket) ?? new Set<string>();
    socketSubscriptions.add(targetId);
    browserSocketSubscriptions.set(socket, socketSubscriptions);
  };

  const unsubscribeBrowserFromTarget = (socket: WebSocket, targetId: string) => {
    const targetSubscriptions = browserSubscriptionsByTargetId.get(targetId);
    targetSubscriptions?.delete(socket);

    if (targetSubscriptions?.size === 0) {
      browserSubscriptionsByTargetId.delete(targetId);
    }

    const socketSubscriptions = browserSocketSubscriptions.get(socket);
    socketSubscriptions?.delete(targetId);

    if (socketSubscriptions?.size === 0) {
      browserSocketSubscriptions.delete(socket);
    }
  };

  const clearBrowserSubscriptions = (socket: WebSocket) => {
    const subscribedTargetIds = browserSocketSubscriptions.get(socket);

    if (!subscribedTargetIds) {
      return;
    }

    for (const targetId of subscribedTargetIds) {
      const targetSubscriptions = browserSubscriptionsByTargetId.get(targetId);
      targetSubscriptions?.delete(socket);

      if (targetSubscriptions?.size === 0) {
        browserSubscriptionsByTargetId.delete(targetId);
      }
    }

    browserSocketSubscriptions.delete(socket);
  };

  const forwardChatEvent = (targetId: string, requestId: string | undefined, chatEvent: ChatEvent) => {
    for (const browserSocket of browserSubscriptionsByTargetId.get(targetId) ?? []) {
      sendEnvelope(browserSocket, {
        type: "client.chatEvent",
        requestId,
        payload: chatEvent,
      });
    }
  };

  const pruneSettledDeliveryTombstones = (now = Date.now()) => {
    for (const [requestId, tombstone] of settledDeliveryTombstones.entries()) {
      if (now - tombstone.settledAt < SETTLED_DELIVERY_TOMBSTONE_TTL_MS) {
        continue;
      }

      settledDeliveryTombstones.delete(requestId);
    }

    while (settledDeliveryTombstones.size > MAX_SETTLED_DELIVERY_TOMBSTONES) {
      const oldestRequestId = settledDeliveryTombstones.keys().next().value;

      if (typeof oldestRequestId !== "string") {
        break;
      }

      settledDeliveryTombstones.delete(oldestRequestId);
    }
  };

  const rememberSettledDelivery = (requestId: string, targetSocket: WebSocket, reason: string) => {
    settledDeliveryTombstones.set(requestId, {
      targetSocket,
      settledAt: Date.now(),
      reason,
    });
    pruneSettledDeliveryTombstones();
  };

  const settlePendingDelivery = (requestId: string, result: DeliveryResult, reason: string): boolean => {
    const pending = pendingDeliveries.get(requestId);

    if (!pending) {
      return false;
    }

    pendingDeliveries.delete(requestId);
    clearTimeout(pending.timeoutId);
    rememberSettledDelivery(requestId, pending.targetSocket, reason);
    pending.resolve(result);
    return true;
  };

  const resolvePendingDeliveriesForSocket = (socket: WebSocket, error: string) => {
    for (const [requestId, pending] of pendingDeliveries.entries()) {
      if (pending.targetSocket === socket || pending.clientSocket === socket) {
        settlePendingDelivery(requestId, { ok: false, error }, error);
      }
    }
  };

  const unregisterSocketTarget = (socket: WebSocket) => {
    const targetId = socketToTargetId.get(socket);

    if (!targetId) {
      return;
    }

    socketToTargetId.delete(socket);
    resolvePendingDeliveriesForSocket(socket, "Target disconnected");

    const registeredSocket = targetIdToSocket.get(targetId);

    if (registeredSocket === socket) {
      targetIdToSocket.delete(targetId);
      state.unregisterTarget(targetId);
      options.logger.info("broker.target.unregistered", { targetId });
    }
  };

  const clearStaleCleanupTimer = () => {
    if (!staleCleanupTimer) {
      return;
    }

    clearInterval(staleCleanupTimer);
    staleCleanupTimer = undefined;
  };

  const startStaleCleanupTimer = () => {
    staleCleanupTimer = setInterval(() => {
      const now = Date.now();

      for (const targetMetadata of state.listTargets()) {
        if (now - targetMetadata.lastSeenAt < staleAfterMs) {
          continue;
        }

        state.unregisterTarget(targetMetadata.targetId);

        const targetSocket = targetIdToSocket.get(targetMetadata.targetId);
        targetIdToSocket.delete(targetMetadata.targetId);

        if (targetSocket) {
          socketToTargetId.delete(targetSocket);
          resolvePendingDeliveriesForSocket(targetSocket, "Target is stale");
          targetSocket.close();
        }

        options.logger.warn("broker.target.stale", {
          targetId: targetMetadata.targetId,
          lastSeenAt: targetMetadata.lastSeenAt,
        });
      }
    }, Math.max(1_000, Math.min(staleAfterMs, 5_000)));
  };

  const closeWebSocketServer = () => new Promise<void>((resolve, reject) => {
    webSocketServer.close((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });

  const closeHttpServer = () => new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });

  const cleanupStartupFailure = async () => {
    clearStaleCleanupTimer();
    await Promise.allSettled([
      closeWebSocketServer().catch(() => undefined),
      closeHttpServer().catch(() => undefined),
    ]);
  };

  webSocketServer.on("error", (error) => {
    options.logger.warn("broker.websocket_server.error", { error: toErrorMessage(error) });
  });

  webSocketServer.on("connection", (socket) => {
    sockets.add(socket);

    socket.on("message", async (rawMessage) => {
      const envelope = parseProtocolEnvelope(rawMessage.toString());

      if (!envelope) {
        sendClientError(socket, undefined, "Invalid protocol message");
        socket.close();
        return;
      }

      const payload = envelope.payload as BrokerMessagePayload;

      switch (envelope.type) {
        case "client.hello": {
          if (authenticatedClientSockets.has(socket) || authenticatingClientSockets.has(socket)) {
            sendClientError(socket, envelope.requestId, "Client authentication is already in progress");
            socket.close();
            return;
          }

          const parsedPayload = parseClientHelloPayload(payload);
          let authenticationPromise!: Promise<boolean>;

          authenticationPromise = (async () => {
            if (!parsedPayload.ok || !await verifyBrowserToken(parsedPayload.token)) {
              sendClientError(socket, envelope.requestId, BROWSER_NOT_AUTHORIZED_ERROR);
              socket.close();
              return false;
            }

            if (socket.readyState !== WebSocket.OPEN || authenticatingClientSockets.get(socket) !== authenticationPromise) {
              return false;
            }

            authenticatedClientSockets.add(socket);
            authenticatedBrowserTokens.set(socket, parsedPayload.token);
            options.logger.info("broker.client.authenticated");
            return true;
          })().finally(() => {
            if (authenticatingClientSockets.get(socket) === authenticationPromise) {
              authenticatingClientSockets.delete(socket);
            }
          });

          authenticatingClientSockets.set(socket, authenticationPromise);
          await authenticationPromise;
          return;
        }

        case "client.listTargets": {
          if (!authenticatedClientSockets.has(socket)) {
            const authenticationPromise = authenticatingClientSockets.get(socket);

            if (authenticationPromise) {
              const authenticated = await authenticationPromise;

              if (!authenticated || !authenticatedClientSockets.has(socket)) {
                return;
              }
            } else {
              sendClientError(socket, envelope.requestId, "Client is not authenticated");
              socket.close();
              return;
            }
          }

          sendEnvelope(socket, {
            type: "client.targets",
            requestId: envelope.requestId,
            payload: {
              targets: state.listTargets(),
            },
          });
          return;
        }

        case "client.sendSelection": {
          const parsedPayload = parseClientSendSelectionPayload(payload);

          if (!parsedPayload.ok) {
            sendClientError(socket, envelope.requestId, parsedPayload.error);
            return;
          }

          if (!authenticatedClientSockets.has(socket)) {
            const authenticationPromise = authenticatingClientSockets.get(socket);

            if (authenticationPromise) {
              const authenticated = await authenticationPromise;

              if (!authenticated || !authenticatedClientSockets.has(socket)) {
                return;
              }
            } else {
              sendClientError(socket, envelope.requestId, "Client is not authenticated");
              socket.close();
              return;
            }
          }

          const authenticatedBrowserToken = authenticatedBrowserTokens.get(socket);

          if (!authenticatedBrowserToken || parsedPayload.token !== authenticatedBrowserToken) {
            sendClientError(socket, envelope.requestId, BROWSER_NOT_AUTHORIZED_ERROR);
            socket.close();
            return;
          }

          const result = await state.deliverSelection(parsedPayload.targetId, parsedPayload.selection, socket);

          sendEnvelope(socket, {
            type: "client.sendResult",
            requestId: envelope.requestId,
            payload: result,
          });
          return;
        }

        case "client.subscribeTarget": {
          const parsedPayload = parseClientSubscribeTargetPayload(payload);

          if (!parsedPayload.ok) {
            sendClientError(socket, envelope.requestId, parsedPayload.error);
            return;
          }

          if (!await ensureAuthenticatedClient(socket, envelope.requestId)) {
            return;
          }

          if (!isMatchingBrowserToken(socket, parsedPayload.token, envelope.requestId)) {
            return;
          }

          if (!targetIdToSocket.has(parsedPayload.targetId)) {
            sendClientError(socket, envelope.requestId, "Target is not available");
            return;
          }

          subscribeBrowserToTarget(socket, parsedPayload.targetId);
          return;
        }

        case "client.unsubscribeTarget": {
          const parsedPayload = parseClientSubscribeTargetPayload(payload);

          if (!parsedPayload.ok) {
            sendClientError(socket, envelope.requestId, parsedPayload.error);
            return;
          }

          if (!await ensureAuthenticatedClient(socket, envelope.requestId)) {
            return;
          }

          if (!isMatchingBrowserToken(socket, parsedPayload.token, envelope.requestId)) {
            return;
          }

          unsubscribeBrowserFromTarget(socket, parsedPayload.targetId);
          return;
        }

        case "client.sendChatMessage": {
          const parsedPayload = parseClientSendChatMessagePayload(payload);

          if (!parsedPayload.ok) {
            sendClientError(socket, envelope.requestId, parsedPayload.error);
            return;
          }

          if (!await ensureAuthenticatedClient(socket, envelope.requestId)) {
            return;
          }

          if (!isMatchingBrowserToken(socket, parsedPayload.token, envelope.requestId)) {
            return;
          }

          const targetSocket = targetIdToSocket.get(parsedPayload.targetId);

          if (!targetSocket || targetSocket.readyState !== WebSocket.OPEN) {
            const errorMessage = "Target is not available";
            sendClientError(socket, envelope.requestId, errorMessage);
            sendEnvelope(socket, {
              type: "client.chatEvent",
              requestId: envelope.requestId,
              payload: {
                kind: "error",
                message: errorMessage,
                timestamp: Date.now(),
              } satisfies ChatEvent,
            });
            return;
          }

          sendEnvelope(socket, {
            type: "client.chatAccepted",
            requestId: envelope.requestId,
          });
          sendEnvelope(targetSocket, {
            type: "target.deliverChatMessage",
            requestId: envelope.requestId,
            payload: {
              message: parsedPayload.message,
              sentAt: Date.now(),
            },
          });
          return;
        }

        case "target.register": {
          const token = payload?.token;
          const target = payload?.target;

          if (!isValidToken(token, options.targetToken) || !isTargetMetadata(target)) {
            socket.close();
            return;
          }

          const previousTargetId = socketToTargetId.get(socket);

          if (previousTargetId && previousTargetId !== target.targetId) {
            unregisterSocketTarget(socket);
          }

          const existingSocket = targetIdToSocket.get(target.targetId);
          if (existingSocket && existingSocket !== socket) {
            socketToTargetId.delete(existingSocket);
            resolvePendingDeliveriesForSocket(existingSocket, "Target disconnected");
            existingSocket.close();
          }

          const registeredTarget: TargetMetadata = {
            ...target,
            lastSeenAt: Date.now(),
          };

          socketToTargetId.set(socket, target.targetId);
          targetIdToSocket.set(target.targetId, socket);
          state.registerTarget(registeredTarget, (selection, clientSocket) => {
            const deliveryRequestId = createRequestId();

            return new Promise<DeliveryResult>((resolve) => {
              const timeoutId = setTimeout(() => {
                settlePendingDelivery(
                  deliveryRequestId,
                  {
                    ok: false,
                    error: "Delivery timed out",
                  },
                  "Delivery timed out",
                );
              }, deliveryTimeoutMs);

              pendingDeliveries.set(deliveryRequestId, {
                clientSocket: clientSocket ?? socket,
                targetSocket: socket,
                timeoutId,
                resolve,
              });

              sendEnvelope(socket, {
                type: "target.deliverSelection",
                requestId: deliveryRequestId,
                payload: {
                  selection,
                },
              });
            });
          });

          sendEnvelope(socket, {
            type: "target.registered",
            requestId: envelope.requestId,
          });
          options.logger.info("broker.target.registered", { targetId: target.targetId });
          return;
        }

        case "target.heartbeat": {
          const targetId = socketToTargetId.get(socket);

          if (!targetId) {
            socket.close();
            return;
          }

          state.heartbeat(targetId, Date.now());
          return;
        }

        case "target.unregister": {
          unregisterSocketTarget(socket);
          socket.close();
          return;
        }

        case "target.chatEvent": {
          const targetId = socketToTargetId.get(socket);

          if (!targetId) {
            socket.close();
            return;
          }

          const validation = validateChatEvent(payload);

          if (!validation.ok) {
            socket.close();
            return;
          }

          forwardChatEvent(targetId, envelope.requestId, payload as ChatEvent);
          return;
        }

        case "target.sendSelectionResult": {
          if (typeof envelope.requestId !== "string") {
            socket.close();
            return;
          }

          const pendingDelivery = pendingDeliveries.get(envelope.requestId);

          if (!pendingDelivery) {
            pruneSettledDeliveryTombstones();
            const tombstone = settledDeliveryTombstones.get(envelope.requestId);

            if (tombstone?.targetSocket === socket) {
              options.logger.info("broker.target.late_selection_result_ignored", {
                requestId: envelope.requestId,
                reason: tombstone.reason,
                targetId: socketToTargetId.get(socket),
              });
              return;
            }

            socket.close();
            return;
          }

          if (pendingDelivery.targetSocket !== socket) {
            socket.close();
            return;
          }

          const resultPayload = payload ?? {};
          const result: DeliveryResult = {
            ok: resultPayload.ok === true,
            ...(typeof resultPayload.error === "string" ? { error: resultPayload.error } : {}),
          };
          settlePendingDelivery(envelope.requestId, result, result.ok ? "Target responded" : (result.error ?? "Target responded with failure"));
          return;
        }

        default:
          sendClientError(socket, envelope.requestId, `Unsupported message type: ${envelope.type}`);
      }
    });

    socket.on("close", () => {
      sockets.delete(socket);
      authenticatedClientSockets.delete(socket);
      authenticatedBrowserTokens.delete(socket);
      authenticatingClientSockets.delete(socket);
      clearBrowserSubscriptions(socket);

      if (socketToTargetId.has(socket)) {
        unregisterSocketTarget(socket);
        return;
      }

      resolvePendingDeliveriesForSocket(socket, "Client disconnected");
    });

    socket.on("error", (error) => {
      options.logger.warn("broker.socket.error", { error: toErrorMessage(error) });
    });
  });

  try {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        cleanup();
        reject(error);
      };

      const onListening = () => {
        cleanup();
        resolve();
      };

      const cleanup = () => {
        server.off("error", onError);
        webSocketServer.off("error", onError);
        server.off("listening", onListening);
      };

      server.once("error", onError);
      webSocketServer.once("error", onError);
      server.once("listening", onListening);
      server.listen(options.port, options.host);
    });

    const address = server.address();

    if (!address || typeof address === "string") {
      throw new Error("Broker server did not bind to a TCP port");
    }

    startStaleCleanupTimer();

    options.logger.info("broker.server.started", {
      host: options.host,
      port: address.port,
    });

    return {
      port: address.port,
      async close() {
        if (isClosing) {
          return;
        }

        isClosing = true;
        clearStaleCleanupTimer();

        for (const requestId of pendingDeliveries.keys()) {
          settlePendingDelivery(requestId, { ok: false, error: "Broker server is closing" }, "Broker server is closing");
        }

        for (const socket of sockets) {
          if (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN) {
            socket.close();
          }
        }

        await Promise.all([closeWebSocketServer(), closeHttpServer()]);

        options.logger.info("broker.server.closed");
      },
    };
  } catch (error) {
    await cleanupStartupFailure();
    throw error;
  }
}
