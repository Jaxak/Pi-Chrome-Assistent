import { once } from "node:events";

import WebSocket from "ws";
import { describe, expect, it, vi } from "vitest";

import { PROTOCOL_VERSION } from "../shared/constants";
import type {
  DeliveryResult,
  ProtocolEnvelope,
  SelectionPayload,
  TargetMetadata,
} from "../shared/protocol";
import { startBrokerServer, BrowserConnectBrokerState } from "./broker";
import { createMemoryLogger } from "./logging";

const targetToken = "target-token";
const browserToken = "browser-token-1";
const browserNotAuthorizedError = "Браузер не авторизован в Pi";

const target: TargetMetadata = {
  targetId: "target-1",
  alias: "frontend",
  cwd: "/repo",
  gitBranch: "main",
  pid: 123,
  connectedAt: 1000,
  lastSeenAt: 1000,
};

const otherTarget: TargetMetadata = {
  targetId: "target-2",
  alias: "backend",
  cwd: "/repo",
  gitBranch: "main",
  pid: 456,
  connectedAt: 1000,
  lastSeenAt: 1000,
};

const selectionPayload: SelectionPayload = {
  url: "https://example.com/article",
  title: "Article",
  selectedText: "Important excerpt",
  selectedHtml: "<p>Important excerpt</p>",
  capturedAt: 1500,
};

function createSocket(port: number): WebSocket {
  return new WebSocket(`ws://127.0.0.1:${port}`);
}

async function waitForOpen(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.OPEN) {
    return;
  }

  await once(socket, "open");
}

function sendEnvelope(socket: WebSocket, envelope: ProtocolEnvelope): void {
  socket.send(JSON.stringify(envelope));
}

async function waitForProtocolMessage<TPayload = unknown>(
  socket: WebSocket,
  type: string,
  timeoutMs = 1_000,
): Promise<ProtocolEnvelope<TPayload>> {
  return new Promise<ProtocolEnvelope<TPayload>>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for ${type}`));
    }, timeoutMs);

    const cleanup = () => {
      clearTimeout(timer);
      socket.off("message", onMessage);
      socket.off("close", onClose);
    };

    const onMessage = (rawMessage: WebSocket.RawData) => {
      const message = JSON.parse(rawMessage.toString()) as ProtocolEnvelope<TPayload>;

      if (message.type !== type) {
        return;
      }

      cleanup();
      resolve(message);
    };

    const onClose = () => {
      cleanup();
      reject(new Error(`Socket closed while waiting for ${type}`));
    };

    socket.on("message", onMessage);
    socket.on("close", onClose);
  });
}

async function expectNoProtocolMessage(
  socket: WebSocket,
  type: string,
  timeoutMs = 200,
): Promise<void> {
  await expect(waitForProtocolMessage(socket, type, timeoutMs)).rejects.toThrow(`Timed out waiting for ${type}`);
}

async function closeSocket(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.CLOSED) {
    return;
  }

  const closePromise = once(socket, "close").then(() => undefined);

  if (socket.readyState === WebSocket.CONNECTING) {
    socket.terminate();
  } else {
    socket.close();
  }

  await closePromise;
}

function authenticateClient(socket: WebSocket, requestId: string, token = browserToken): void {
  sendEnvelope(socket, {
    version: PROTOCOL_VERSION,
    type: "client.hello",
    requestId,
    payload: {
      token,
    },
  });
}

async function listTargets(socket: WebSocket, requestId: string): Promise<TargetMetadata[]> {
  sendEnvelope(socket, {
    version: PROTOCOL_VERSION,
    type: "client.listTargets",
    requestId,
  });

  const response = await waitForProtocolMessage<{ targets: TargetMetadata[] }>(socket, "client.targets");
  expect(response.requestId).toBe(requestId);
  return response.payload?.targets ?? [];
}

async function waitForTargets(
  socket: WebSocket,
  predicate: (targets: TargetMetadata[]) => boolean,
  options?: {
    timeoutMs?: number;
    pollIntervalMs?: number;
    requestIdPrefix?: string;
  },
): Promise<TargetMetadata[]> {
  const timeoutMs = options?.timeoutMs ?? 2_000;
  const pollIntervalMs = options?.pollIntervalMs ?? 25;
  const requestIdPrefix = options?.requestIdPrefix ?? "list-wait";
  const start = Date.now();
  let attempt = 0;
  let lastTargets: TargetMetadata[] = [];

  while (Date.now() - start <= timeoutMs) {
    lastTargets = await listTargets(socket, `${requestIdPrefix}-${attempt}`);

    if (predicate(lastTargets)) {
      return lastTargets;
    }

    attempt += 1;
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }

  throw new Error(`Timed out waiting for matching targets: ${JSON.stringify(lastTargets)}`);
}

describe("BrowserConnectBrokerState", () => {
  it("registers and lists targets", () => {
    const state = new BrowserConnectBrokerState();

    state.registerTarget(target, vi.fn());

    expect(state.listTargets()).toEqual([target]);
  });

  it("updates heartbeat timestamp", () => {
    const state = new BrowserConnectBrokerState();

    state.registerTarget(target, vi.fn());
    state.heartbeat("target-1", 2000);

    expect(state.listTargets()[0].lastSeenAt).toBe(2000);
  });

  it("removes stale targets", () => {
    const state = new BrowserConnectBrokerState();

    state.registerTarget(target, vi.fn());
    state.removeStaleTargets(20_000, 5_000);

    expect(state.listTargets()).toEqual([]);
  });

  it("unregisters targets from the active list", () => {
    const state = new BrowserConnectBrokerState();

    state.registerTarget(target, vi.fn());

    expect(state.unregisterTarget("target-1")).toBe(true);
    expect(state.listTargets()).toEqual([]);
  });

  it("returns error when delivering to missing target", async () => {
    const state = new BrowserConnectBrokerState();

    await expect(state.deliverSelection("missing", {} as never)).resolves.toEqual({
      ok: false,
      error: "Target is not available",
    });
  });

  it("returns delivered result from the registered target callback", async () => {
    const state = new BrowserConnectBrokerState();
    const result: DeliveryResult = { ok: true };
    const connection = vi.fn(async () => result);

    state.registerTarget(target, connection);

    await expect(state.deliverSelection("target-1", selectionPayload)).resolves.toEqual(result);
    expect(connection).toHaveBeenCalledOnce();
    expect(connection).toHaveBeenCalledWith(selectionPayload);
  });

  it("returns error when target delivery callback throws", async () => {
    const state = new BrowserConnectBrokerState();

    state.registerTarget(target, vi.fn(async () => {
      throw new Error("boom");
    }));

    await expect(state.deliverSelection("target-1", {} as never)).resolves.toEqual({
      ok: false,
      error: "boom",
    });
  });
});

describe("startBrokerServer", () => {
  it("rejects client.listTargets without prior successful auth", async () => {
    const broker = await startBrokerServer({
      host: "127.0.0.1",
      port: 0,
      targetToken,
      isBrowserTokenTrusted: async (token) => token === browserToken,
      logger: createMemoryLogger(),
    });

    const targetSocket = createSocket(broker.port);
    const clientSocket = createSocket(broker.port);

    try {
      await waitForOpen(targetSocket);
      sendEnvelope(targetSocket, {
        version: PROTOCOL_VERSION,
        type: "target.register",
        requestId: "register-list-unauth",
        payload: {
          token: targetToken,
          target,
        },
      });

      await expect(waitForProtocolMessage(targetSocket, "target.registered")).resolves.toEqual({
        version: PROTOCOL_VERSION,
        type: "target.registered",
        requestId: "register-list-unauth",
      });

      await waitForOpen(clientSocket);
      sendEnvelope(clientSocket, {
        version: PROTOCOL_VERSION,
        type: "client.listTargets",
        requestId: "list-unauthenticated",
      });

      await expect(waitForProtocolMessage<{ error: string }>(clientSocket, "client.error")).resolves.toEqual({
        version: PROTOCOL_VERSION,
        type: "client.error",
        requestId: "list-unauthenticated",
        payload: {
          error: "Client is not authenticated",
        },
      });
      await once(clientSocket, "close");
    } finally {
      await Promise.allSettled([
        closeSocket(clientSocket),
        closeSocket(targetSocket),
        broker.close(),
      ]);
    }
  });

  it("authenticates a client with client.hello before allowing listTargets", async () => {
    const broker = await startBrokerServer({
      host: "127.0.0.1",
      port: 0,
      targetToken,
      isBrowserTokenTrusted: async (token) => token === browserToken,
      logger: createMemoryLogger(),
    });

    const targetSocket = createSocket(broker.port);
    const clientSocket = createSocket(broker.port);

    try {
      await waitForOpen(targetSocket);
      const registeredAtStart = Date.now();
      sendEnvelope(targetSocket, {
        version: PROTOCOL_VERSION,
        type: "target.register",
        requestId: "register-list-authenticated",
        payload: {
          token: targetToken,
          target,
        },
      });

      await expect(waitForProtocolMessage(targetSocket, "target.registered")).resolves.toEqual({
        version: PROTOCOL_VERSION,
        type: "target.registered",
        requestId: "register-list-authenticated",
      });

      await waitForOpen(clientSocket);
      authenticateClient(clientSocket, "hello-list-authenticated");
      const targets = await listTargets(clientSocket, "list-authenticated");

      expect(targets).toHaveLength(1);
      expect(targets[0]).toMatchObject({
        ...target,
        lastSeenAt: expect.any(Number),
      });
      expect(targets[0].lastSeenAt).toBeGreaterThanOrEqual(registeredAtStart);
      expect(targets[0].lastSeenAt).toBeLessThanOrEqual(Date.now());
    } finally {
      await Promise.allSettled([
        closeSocket(clientSocket),
        closeSocket(targetSocket),
        broker.close(),
      ]);
    }
  });

  it("rejects invalid client.hello and keeps listTargets blocked", async () => {
    const broker = await startBrokerServer({
      host: "127.0.0.1",
      port: 0,
      targetToken,
      isBrowserTokenTrusted: async (token) => token === browserToken,
      logger: createMemoryLogger(),
    });

    const targetSocket = createSocket(broker.port);
    const clientSocket = createSocket(broker.port);

    try {
      await waitForOpen(targetSocket);
      sendEnvelope(targetSocket, {
        version: PROTOCOL_VERSION,
        type: "target.register",
        requestId: "register-list-invalid-hello",
        payload: {
          token: targetToken,
          target,
        },
      });

      await expect(waitForProtocolMessage(targetSocket, "target.registered")).resolves.toEqual({
        version: PROTOCOL_VERSION,
        type: "target.registered",
        requestId: "register-list-invalid-hello",
      });

      await waitForOpen(clientSocket);
      const unexpectedTargetsPromise = waitForProtocolMessage<{ targets: TargetMetadata[] }>(
        clientSocket,
        "client.targets",
        250,
      );

      sendEnvelope(clientSocket, {
        version: PROTOCOL_VERSION,
        type: "client.hello",
        requestId: "hello-invalid-list",
        payload: {
          token: "wrong-token",
        },
      });
      sendEnvelope(clientSocket, {
        version: PROTOCOL_VERSION,
        type: "client.listTargets",
        requestId: "list-after-invalid-hello",
      });

      await expect(waitForProtocolMessage<{ error: string }>(clientSocket, "client.error")).resolves.toEqual({
        version: PROTOCOL_VERSION,
        type: "client.error",
        requestId: "hello-invalid-list",
        payload: {
          error: browserNotAuthorizedError,
        },
      });
      await once(clientSocket, "close");
      await expect(unexpectedTargetsPromise).rejects.toThrow(/Timed out waiting for client.targets|Socket closed while waiting for client.targets/);
    } finally {
      await Promise.allSettled([
        closeSocket(clientSocket),
        closeSocket(targetSocket),
        broker.close(),
      ]);
    }
  });

  it("fails closed when browser trust check throws during client.hello", async () => {
    const logger = createMemoryLogger();
    const broker = await startBrokerServer({
      host: "127.0.0.1",
      port: 0,
      targetToken,
      isBrowserTokenTrusted: async () => {
        throw new Error("trusted browser store unavailable");
      },
      logger,
    });

    const clientSocket = createSocket(broker.port);

    try {
      await waitForOpen(clientSocket);
      authenticateClient(clientSocket, "hello-trust-check-throws");

      await expect(waitForProtocolMessage<{ error: string }>(clientSocket, "client.error")).resolves.toEqual({
        version: PROTOCOL_VERSION,
        type: "client.error",
        requestId: "hello-trust-check-throws",
        payload: {
          error: browserNotAuthorizedError,
        },
      });
      await once(clientSocket, "close");
      expect(logger.entries).toContainEqual(
        expect.objectContaining({
          level: "warn",
          message: "broker.client.browser_token_check_failed",
          details: expect.objectContaining({
            error: "trusted browser store unavailable",
          }),
        }),
      );
    } finally {
      await Promise.allSettled([closeSocket(clientSocket), broker.close()]);
    }
  });

  it("does not mark a socket as authenticated if it closes before async browser auth resolves", async () => {
    const logger = createMemoryLogger();
    let resolveTrustCheck!: (value: boolean) => void;
    const trustCheckPromise = new Promise<boolean>((resolve) => {
      resolveTrustCheck = resolve;
    });
    const broker = await startBrokerServer({
      host: "127.0.0.1",
      port: 0,
      targetToken,
      isBrowserTokenTrusted: async () => trustCheckPromise,
      logger,
    });

    const clientSocket = createSocket(broker.port);

    try {
      await waitForOpen(clientSocket);
      authenticateClient(clientSocket, "hello-delayed-auth-close");
      await closeSocket(clientSocket);
      resolveTrustCheck(true);
      await new Promise((resolve) => setTimeout(resolve, 25));

      expect(logger.entries).not.toContainEqual(
        expect.objectContaining({
          message: "broker.client.authenticated",
        }),
      );
    } finally {
      await broker.close();
    }
  });

  it("rejects overlapping client.hello requests on the same socket", async () => {
    const broker = await startBrokerServer({
      host: "127.0.0.1",
      port: 0,
      targetToken,
      isBrowserTokenTrusted: async () => true,
      logger: createMemoryLogger(),
    });

    const clientSocket = createSocket(broker.port);

    try {
      await waitForOpen(clientSocket);
      authenticateClient(clientSocket, "hello-first");
      authenticateClient(clientSocket, "hello-second");

      await expect(waitForProtocolMessage<{ error: string }>(clientSocket, "client.error")).resolves.toEqual({
        version: PROTOCOL_VERSION,
        type: "client.error",
        requestId: "hello-second",
        payload: {
          error: "Client authentication is already in progress",
        },
      });
      await once(clientSocket, "close");
    } finally {
      await Promise.allSettled([closeSocket(clientSocket), broker.close()]);
    }
  });

  it("reuses the authenticated browser token for client.sendSelection without a second trust lookup", async () => {
    let callCount = 0;
    const broker = await startBrokerServer({
      host: "127.0.0.1",
      port: 0,
      targetToken,
      isBrowserTokenTrusted: async (token) => {
        callCount += 1;
        if (callCount === 1) {
          return token === browserToken;
        }

        throw new Error("trusted browser store unavailable");
      },
      logger: createMemoryLogger(),
    });

    const targetSocket = createSocket(broker.port);
    const clientSocket = createSocket(broker.port);

    try {
      await waitForOpen(targetSocket);
      sendEnvelope(targetSocket, {
        version: PROTOCOL_VERSION,
        type: "target.register",
        requestId: "register-send-selection-authenticated-socket",
        payload: {
          token: targetToken,
          target,
        },
      });

      await expect(waitForProtocolMessage(targetSocket, "target.registered")).resolves.toEqual({
        version: PROTOCOL_VERSION,
        type: "target.registered",
        requestId: "register-send-selection-authenticated-socket",
      });

      await waitForOpen(clientSocket);
      authenticateClient(clientSocket, "hello-send-selection-authenticated-socket");
      await listTargets(clientSocket, "list-send-selection-authenticated-socket");

      sendEnvelope(clientSocket, {
        version: PROTOCOL_VERSION,
        type: "client.sendSelection",
        requestId: "send-selection-authenticated-socket",
        payload: {
          token: browserToken,
          targetId: target.targetId,
          selection: selectionPayload,
        },
      });

      const deliverMessage = await waitForProtocolMessage<{ selection: SelectionPayload }>(
        targetSocket,
        "target.deliverSelection",
      );
      expect(callCount).toBe(1);

      sendEnvelope(targetSocket, {
        version: PROTOCOL_VERSION,
        type: "target.sendSelectionResult",
        requestId: deliverMessage.requestId,
        payload: {
          ok: true,
        },
      });

      await expect(waitForProtocolMessage<DeliveryResult>(clientSocket, "client.sendResult")).resolves.toEqual({
        version: PROTOCOL_VERSION,
        type: "client.sendResult",
        requestId: "send-selection-authenticated-socket",
        payload: {
          ok: true,
        },
      });
    } finally {
      await Promise.allSettled([
        closeSocket(clientSocket),
        closeSocket(targetSocket),
        broker.close(),
      ]);
    }
  });

  it("delivers a client selection to the target and returns the result", async () => {
    const broker = await startBrokerServer({
      host: "127.0.0.1",
      port: 0,
      targetToken,
      isBrowserTokenTrusted: async (token) => token === browserToken,
      logger: createMemoryLogger(),
    });

    const targetSocket = createSocket(broker.port);
    const clientSocket = createSocket(broker.port);

    try {
      await waitForOpen(targetSocket);
      sendEnvelope(targetSocket, {
        version: PROTOCOL_VERSION,
        type: "target.register",
        requestId: "register-2",
        payload: {
          token: targetToken,
          target,
        },
      });

      await waitForOpen(clientSocket);
      sendEnvelope(clientSocket, {
        version: PROTOCOL_VERSION,
        type: "client.hello",
        requestId: "hello-2",
        payload: {
          token: browserToken,
        },
      });
      sendEnvelope(clientSocket, {
        version: PROTOCOL_VERSION,
        type: "client.sendSelection",
        requestId: "send-1",
        payload: {
          token: browserToken,
          targetId: target.targetId,
          selection: selectionPayload,
        },
      });

      const deliverMessage = await waitForProtocolMessage<{ selection: SelectionPayload }>(
        targetSocket,
        "target.deliverSelection",
      );

      expect(deliverMessage.payload).toEqual({
        selection: selectionPayload,
      });
      expect(deliverMessage.requestId).toBeTypeOf("string");

      sendEnvelope(targetSocket, {
        version: PROTOCOL_VERSION,
        type: "target.sendSelectionResult",
        requestId: deliverMessage.requestId,
        payload: {
          ok: true,
        },
      });

      await expect(waitForProtocolMessage<DeliveryResult>(clientSocket, "client.sendResult")).resolves.toEqual({
        version: PROTOCOL_VERSION,
        type: "client.sendResult",
        requestId: "send-1",
        payload: {
          ok: true,
        },
      });
    } finally {
      await Promise.allSettled([
        closeSocket(clientSocket),
        closeSocket(targetSocket),
        broker.close(),
      ]);
    }
  });

  it("re-registers a same target socket under a new target id without leaving the old target live", async () => {
    const broker = await startBrokerServer({
      host: "127.0.0.1",
      port: 0,
      targetToken,
      isBrowserTokenTrusted: async (token) => token === browserToken,
      logger: createMemoryLogger(),
    });

    const targetSocket = createSocket(broker.port);
    const clientSocket = createSocket(broker.port);

    try {
      await waitForOpen(targetSocket);
      sendEnvelope(targetSocket, {
        version: PROTOCOL_VERSION,
        type: "target.register",
        requestId: "register-same-socket-a",
        payload: {
          token: targetToken,
          target,
        },
      });
      const registeredAtStart = Date.now();
      sendEnvelope(targetSocket, {
        version: PROTOCOL_VERSION,
        type: "target.register",
        requestId: "register-same-socket-b",
        payload: {
          token: targetToken,
          target: otherTarget,
        },
      });

      await waitForOpen(clientSocket);
      authenticateClient(clientSocket, "hello-same-socket");
      const targets = await listTargets(clientSocket, "list-same-socket");

      expect(targets).toHaveLength(1);
      expect(targets[0]).toMatchObject({
        ...otherTarget,
        lastSeenAt: expect.any(Number),
      });
      expect(targets[0].lastSeenAt).toBeGreaterThanOrEqual(registeredAtStart);
      expect(targets[0].lastSeenAt).toBeLessThanOrEqual(Date.now());
    } finally {
      await Promise.allSettled([
        closeSocket(clientSocket),
        closeSocket(targetSocket),
        broker.close(),
      ]);
    }
  });

  it("settles a pending delivery when the original target socket is replaced", async () => {
    const broker = await startBrokerServer({
      host: "127.0.0.1",
      port: 0,
      targetToken,
      isBrowserTokenTrusted: async (token) => token === browserToken,
      logger: createMemoryLogger(),
    });

    const targetSocketA = createSocket(broker.port);
    const targetSocketB = createSocket(broker.port);
    const clientSocket = createSocket(broker.port);

    try {
      await waitForOpen(targetSocketA);
      sendEnvelope(targetSocketA, {
        version: PROTOCOL_VERSION,
        type: "target.register",
        requestId: "register-reconnect-a",
        payload: {
          token: targetToken,
          target,
        },
      });

      await waitForOpen(clientSocket);
      sendEnvelope(clientSocket, {
        version: PROTOCOL_VERSION,
        type: "client.hello",
        requestId: "hello-reconnect",
        payload: {
          token: browserToken,
        },
      });
      sendEnvelope(clientSocket, {
        version: PROTOCOL_VERSION,
        type: "client.sendSelection",
        requestId: "send-reconnect",
        payload: {
          token: browserToken,
          targetId: target.targetId,
          selection: selectionPayload,
        },
      });

      await waitForProtocolMessage(targetSocketA, "target.deliverSelection");
      const clientResultPromise = waitForProtocolMessage<DeliveryResult>(clientSocket, "client.sendResult");

      await waitForOpen(targetSocketB);
      sendEnvelope(targetSocketB, {
        version: PROTOCOL_VERSION,
        type: "target.register",
        requestId: "register-reconnect-b",
        payload: {
          token: targetToken,
          target,
        },
      });

      await once(targetSocketA, "close");

      await expect(clientResultPromise).resolves.toMatchObject({
        version: PROTOCOL_VERSION,
        type: "client.sendResult",
        requestId: "send-reconnect",
        payload: {
          ok: false,
          error: expect.any(String),
        },
      });
    } finally {
      await Promise.allSettled([
        closeSocket(clientSocket),
        closeSocket(targetSocketB),
        closeSocket(targetSocketA),
        broker.close(),
      ]);
    }
  });

  it("does not allow a different target socket to resolve a pending delivery", async () => {
    const broker = await startBrokerServer({
      host: "127.0.0.1",
      port: 0,
      targetToken,
      isBrowserTokenTrusted: async (token) => token === browserToken,
      logger: createMemoryLogger(),
    });

    const targetSocketA = createSocket(broker.port);
    const targetSocketB = createSocket(broker.port);
    const clientSocket = createSocket(broker.port);

    try {
      await waitForOpen(targetSocketA);
      sendEnvelope(targetSocketA, {
        version: PROTOCOL_VERSION,
        type: "target.register",
        requestId: "register-wrong-socket-a",
        payload: {
          token: targetToken,
          target,
        },
      });

      await waitForOpen(targetSocketB);
      sendEnvelope(targetSocketB, {
        version: PROTOCOL_VERSION,
        type: "target.register",
        requestId: "register-wrong-socket-b",
        payload: {
          token: targetToken,
          target: otherTarget,
        },
      });

      await waitForOpen(clientSocket);
      sendEnvelope(clientSocket, {
        version: PROTOCOL_VERSION,
        type: "client.hello",
        requestId: "hello-wrong-socket",
        payload: {
          token: browserToken,
        },
      });
      sendEnvelope(clientSocket, {
        version: PROTOCOL_VERSION,
        type: "client.sendSelection",
        requestId: "send-wrong-socket",
        payload: {
          token: browserToken,
          targetId: target.targetId,
          selection: selectionPayload,
        },
      });

      const deliverMessage = await waitForProtocolMessage<{ selection: SelectionPayload }>(
        targetSocketA,
        "target.deliverSelection",
      );

      sendEnvelope(targetSocketB, {
        version: PROTOCOL_VERSION,
        type: "target.sendSelectionResult",
        requestId: deliverMessage.requestId,
        payload: {
          ok: true,
        },
      });

      await expectNoProtocolMessage(clientSocket, "client.sendResult");

      sendEnvelope(targetSocketA, {
        version: PROTOCOL_VERSION,
        type: "target.sendSelectionResult",
        requestId: deliverMessage.requestId,
        payload: {
          ok: true,
        },
      });

      await expect(waitForProtocolMessage<DeliveryResult>(clientSocket, "client.sendResult")).resolves.toEqual({
        version: PROTOCOL_VERSION,
        type: "client.sendResult",
        requestId: "send-wrong-socket",
        payload: {
          ok: true,
        },
      });
    } finally {
      await Promise.allSettled([
        closeSocket(clientSocket),
        closeSocket(targetSocketB),
        closeSocket(targetSocketA),
        broker.close(),
      ]);
    }
  });

  it("settles a pending delivery when stale target cleanup removes the target", async () => {
    const broker = await startBrokerServer({
      host: "127.0.0.1",
      port: 0,
      targetToken,
      isBrowserTokenTrusted: async (token) => token === browserToken,
      logger: createMemoryLogger(),
      staleAfterMs: 10,
    });

    const targetSocket = createSocket(broker.port);
    const clientSocket = createSocket(broker.port);

    try {
      await waitForOpen(targetSocket);
      sendEnvelope(targetSocket, {
        version: PROTOCOL_VERSION,
        type: "target.register",
        requestId: "register-stale-cleanup",
        payload: {
          token: targetToken,
          target,
        },
      });

      await waitForOpen(clientSocket);
      sendEnvelope(clientSocket, {
        version: PROTOCOL_VERSION,
        type: "client.hello",
        requestId: "hello-stale-cleanup",
        payload: {
          token: browserToken,
        },
      });
      sendEnvelope(clientSocket, {
        version: PROTOCOL_VERSION,
        type: "client.sendSelection",
        requestId: "send-stale-cleanup",
        payload: {
          token: browserToken,
          targetId: target.targetId,
          selection: selectionPayload,
        },
      });

      await expect(
        waitForProtocolMessage<{ selection: SelectionPayload }>(targetSocket, "target.deliverSelection"),
      ).resolves.toMatchObject({
        payload: {
          selection: selectionPayload,
        },
      });

      await expect(waitForProtocolMessage<DeliveryResult>(clientSocket, "client.sendResult", 2_000)).resolves.toMatchObject(
        {
          version: PROTOCOL_VERSION,
          type: "client.sendResult",
          requestId: "send-stale-cleanup",
          payload: {
            ok: false,
            error: expect.stringMatching(/stale|not available|unavailable/i),
          },
        },
      );
    } finally {
      await Promise.allSettled([closeSocket(clientSocket), closeSocket(targetSocket), broker.close()]);
    }
  });

  it("does not let a future-skewed register timestamp keep a target immortal", async () => {
    const broker = await startBrokerServer({
      host: "127.0.0.1",
      port: 0,
      targetToken,
      isBrowserTokenTrusted: async (token) => token === browserToken,
      logger: createMemoryLogger(),
      staleAfterMs: 25,
    });

    const targetSocket = createSocket(broker.port);
    const clientSocket = createSocket(broker.port);

    try {
      await waitForOpen(targetSocket);
      sendEnvelope(targetSocket, {
        version: PROTOCOL_VERSION,
        type: "target.register",
        requestId: "register-future-skew",
        payload: {
          token: targetToken,
          target: {
            ...target,
            lastSeenAt: Date.now() + 60_000,
          },
        },
      });

      await waitForOpen(clientSocket);
      authenticateClient(clientSocket, "hello-future-skew");

      const initialTargets = await listTargets(clientSocket, "list-future-skew-initial");
      expect(initialTargets).toHaveLength(1);

      await expect(
        waitForTargets(clientSocket, (targets) => targets.length === 0, {
          timeoutMs: 2_000,
          requestIdPrefix: "list-future-skew",
        }),
      ).resolves.toEqual([]);
    } finally {
      await Promise.allSettled([closeSocket(clientSocket), closeSocket(targetSocket), broker.close()]);
    }
  });

  it("does not let a past-skewed register timestamp make a target immediately stale", async () => {
    const broker = await startBrokerServer({
      host: "127.0.0.1",
      port: 0,
      targetToken,
      isBrowserTokenTrusted: async (token) => token === browserToken,
      logger: createMemoryLogger(),
      staleAfterMs: 250,
    });

    const targetSocket = createSocket(broker.port);
    const clientSocket = createSocket(broker.port);

    try {
      await waitForOpen(targetSocket);
      const registeredAtStart = Date.now();
      sendEnvelope(targetSocket, {
        version: PROTOCOL_VERSION,
        type: "target.register",
        requestId: "register-past-skew",
        payload: {
          token: targetToken,
          target: {
            ...target,
            lastSeenAt: 0,
          },
        },
      });

      await waitForOpen(clientSocket);
      authenticateClient(clientSocket, "hello-past-skew");
      const targets = await listTargets(clientSocket, "list-past-skew");

      expect(targets).toHaveLength(1);
      expect(targets[0]).toMatchObject({
        ...target,
        lastSeenAt: expect.any(Number),
      });
      expect(targets[0].lastSeenAt).toBeGreaterThanOrEqual(registeredAtStart);
      expect(targets[0].lastSeenAt).toBeLessThanOrEqual(Date.now());
    } finally {
      await Promise.allSettled([closeSocket(clientSocket), closeSocket(targetSocket), broker.close()]);
    }
  });

  it("fails a pending delivery when the target never responds", async () => {
    const broker = await startBrokerServer({
      host: "127.0.0.1",
      port: 0,
      targetToken,
      isBrowserTokenTrusted: async (token) => token === browserToken,
      logger: createMemoryLogger(),
      deliveryTimeoutMs: 50,
    });

    const targetSocket = createSocket(broker.port);
    const clientSocket = createSocket(broker.port);

    try {
      await waitForOpen(targetSocket);
      sendEnvelope(targetSocket, {
        version: PROTOCOL_VERSION,
        type: "target.register",
        requestId: "register-delivery-timeout",
        payload: {
          token: targetToken,
          target,
        },
      });

      await waitForOpen(clientSocket);
      sendEnvelope(clientSocket, {
        version: PROTOCOL_VERSION,
        type: "client.hello",
        requestId: "hello-delivery-timeout",
        payload: {
          token: browserToken,
        },
      });
      sendEnvelope(clientSocket, {
        version: PROTOCOL_VERSION,
        type: "client.sendSelection",
        requestId: "send-delivery-timeout",
        payload: {
          token: browserToken,
          targetId: target.targetId,
          selection: selectionPayload,
        },
      });

      await expect(
        waitForProtocolMessage<{ selection: SelectionPayload }>(targetSocket, "target.deliverSelection"),
      ).resolves.toMatchObject({
        payload: {
          selection: selectionPayload,
        },
      });

      await expect(waitForProtocolMessage<DeliveryResult>(clientSocket, "client.sendResult", 1_000)).resolves.toEqual({
        version: PROTOCOL_VERSION,
        type: "client.sendResult",
        requestId: "send-delivery-timeout",
        payload: {
          ok: false,
          error: "Delivery timed out",
        },
      });
    } finally {
      await Promise.allSettled([closeSocket(clientSocket), closeSocket(targetSocket), broker.close()]);
    }
  });

  it("ignores a late target result after delivery timeout and keeps the target socket usable", async () => {
    const broker = await startBrokerServer({
      host: "127.0.0.1",
      port: 0,
      targetToken,
      isBrowserTokenTrusted: async (token) => token === browserToken,
      logger: createMemoryLogger(),
      deliveryTimeoutMs: 50,
    });

    const targetSocket = createSocket(broker.port);
    const clientSocket = createSocket(broker.port);

    try {
      await waitForOpen(targetSocket);
      sendEnvelope(targetSocket, {
        version: PROTOCOL_VERSION,
        type: "target.register",
        requestId: "register-late-timeout",
        payload: {
          token: targetToken,
          target,
        },
      });

      await waitForOpen(clientSocket);
      sendEnvelope(clientSocket, {
        version: PROTOCOL_VERSION,
        type: "client.hello",
        requestId: "hello-late-timeout",
        payload: {
          token: browserToken,
        },
      });
      sendEnvelope(clientSocket, {
        version: PROTOCOL_VERSION,
        type: "client.sendSelection",
        requestId: "send-late-timeout-1",
        payload: {
          token: browserToken,
          targetId: target.targetId,
          selection: selectionPayload,
        },
      });

      const firstDelivery = await waitForProtocolMessage<{ selection: SelectionPayload }>(
        targetSocket,
        "target.deliverSelection",
      );

      await expect(waitForProtocolMessage<DeliveryResult>(clientSocket, "client.sendResult", 1_000)).resolves.toEqual({
        version: PROTOCOL_VERSION,
        type: "client.sendResult",
        requestId: "send-late-timeout-1",
        payload: {
          ok: false,
          error: "Delivery timed out",
        },
      });

      const secondDeliveryPromise = waitForProtocolMessage<{ selection: SelectionPayload }>(
        targetSocket,
        "target.deliverSelection",
      );

      sendEnvelope(targetSocket, {
        version: PROTOCOL_VERSION,
        type: "target.sendSelectionResult",
        requestId: firstDelivery.requestId,
        payload: {
          ok: true,
        },
      });

      sendEnvelope(clientSocket, {
        version: PROTOCOL_VERSION,
        type: "client.sendSelection",
        requestId: "send-late-timeout-2",
        payload: {
          token: browserToken,
          targetId: target.targetId,
          selection: selectionPayload,
        },
      });

      const secondDelivery = await secondDeliveryPromise;
      expect(secondDelivery.payload).toEqual({
        selection: selectionPayload,
      });

      sendEnvelope(targetSocket, {
        version: PROTOCOL_VERSION,
        type: "target.sendSelectionResult",
        requestId: secondDelivery.requestId,
        payload: {
          ok: true,
        },
      });

      await expect(waitForProtocolMessage<DeliveryResult>(clientSocket, "client.sendResult", 1_000)).resolves.toEqual({
        version: PROTOCOL_VERSION,
        type: "client.sendResult",
        requestId: "send-late-timeout-2",
        payload: {
          ok: true,
        },
      });
    } finally {
      await Promise.allSettled([closeSocket(clientSocket), closeSocket(targetSocket), broker.close()]);
    }
  });

  it("ignores a late target result after client disconnect and keeps the target socket usable", async () => {
    const broker = await startBrokerServer({
      host: "127.0.0.1",
      port: 0,
      targetToken,
      isBrowserTokenTrusted: async (token) => token === browserToken,
      logger: createMemoryLogger(),
    });

    const targetSocket = createSocket(broker.port);
    const firstClientSocket = createSocket(broker.port);
    const secondClientSocket = createSocket(broker.port);

    try {
      await waitForOpen(targetSocket);
      sendEnvelope(targetSocket, {
        version: PROTOCOL_VERSION,
        type: "target.register",
        requestId: "register-late-client-disconnect",
        payload: {
          token: targetToken,
          target,
        },
      });

      await waitForOpen(firstClientSocket);
      sendEnvelope(firstClientSocket, {
        version: PROTOCOL_VERSION,
        type: "client.hello",
        requestId: "hello-late-client-disconnect-1",
        payload: {
          token: browserToken,
        },
      });
      sendEnvelope(firstClientSocket, {
        version: PROTOCOL_VERSION,
        type: "client.sendSelection",
        requestId: "send-late-client-disconnect-1",
        payload: {
          token: browserToken,
          targetId: target.targetId,
          selection: selectionPayload,
        },
      });

      const firstDelivery = await waitForProtocolMessage<{ selection: SelectionPayload }>(
        targetSocket,
        "target.deliverSelection",
      );

      await closeSocket(firstClientSocket);

      const secondDeliveryPromise = waitForProtocolMessage<{ selection: SelectionPayload }>(
        targetSocket,
        "target.deliverSelection",
      );

      sendEnvelope(targetSocket, {
        version: PROTOCOL_VERSION,
        type: "target.sendSelectionResult",
        requestId: firstDelivery.requestId,
        payload: {
          ok: true,
        },
      });

      await waitForOpen(secondClientSocket);
      sendEnvelope(secondClientSocket, {
        version: PROTOCOL_VERSION,
        type: "client.hello",
        requestId: "hello-late-client-disconnect-2",
        payload: {
          token: browserToken,
        },
      });
      sendEnvelope(secondClientSocket, {
        version: PROTOCOL_VERSION,
        type: "client.sendSelection",
        requestId: "send-late-client-disconnect-2",
        payload: {
          token: browserToken,
          targetId: target.targetId,
          selection: selectionPayload,
        },
      });

      const secondDelivery = await secondDeliveryPromise;
      expect(secondDelivery.payload).toEqual({
        selection: selectionPayload,
      });

      sendEnvelope(targetSocket, {
        version: PROTOCOL_VERSION,
        type: "target.sendSelectionResult",
        requestId: secondDelivery.requestId,
        payload: {
          ok: true,
        },
      });

      await expect(
        waitForProtocolMessage<DeliveryResult>(secondClientSocket, "client.sendResult", 1_000),
      ).resolves.toEqual({
        version: PROTOCOL_VERSION,
        type: "client.sendResult",
        requestId: "send-late-client-disconnect-2",
        payload: {
          ok: true,
        },
      });
    } finally {
      await Promise.allSettled([
        closeSocket(secondClientSocket),
        closeSocket(firstClientSocket),
        closeSocket(targetSocket),
        broker.close(),
      ]);
    }
  });

  it("rejects invalid tokens and does not register the target", async () => {
    const broker = await startBrokerServer({
      host: "127.0.0.1",
      port: 0,
      targetToken,
      isBrowserTokenTrusted: async (token) => token === browserToken,
      logger: createMemoryLogger(),
    });

    const invalidClientSocket = createSocket(broker.port);
    const invalidTargetSocket = createSocket(broker.port);
    const validClientSocket = createSocket(broker.port);

    try {
      await waitForOpen(invalidClientSocket);
      sendEnvelope(invalidClientSocket, {
        version: PROTOCOL_VERSION,
        type: "client.hello",
        requestId: "hello-invalid",
        payload: {
          token: "wrong-token",
        },
      });

      await expect(waitForProtocolMessage<{ error: string }>(invalidClientSocket, "client.error")).resolves.toEqual({
        version: PROTOCOL_VERSION,
        type: "client.error",
        requestId: "hello-invalid",
        payload: {
          error: browserNotAuthorizedError,
        },
      });
      await once(invalidClientSocket, "close");

      await waitForOpen(invalidTargetSocket);
      sendEnvelope(invalidTargetSocket, {
        version: PROTOCOL_VERSION,
        type: "target.register",
        requestId: "register-invalid",
        payload: {
          token: "wrong-token",
          target,
        },
      });
      await once(invalidTargetSocket, "close");

      await waitForOpen(validClientSocket);
      authenticateClient(validClientSocket, "hello-list-empty");
      sendEnvelope(validClientSocket, {
        version: PROTOCOL_VERSION,
        type: "client.listTargets",
        requestId: "list-empty",
      });

      await expect(
        waitForProtocolMessage<{ targets: TargetMetadata[] }>(validClientSocket, "client.targets"),
      ).resolves.toEqual({
        version: PROTOCOL_VERSION,
        type: "client.targets",
        requestId: "list-empty",
        payload: {
          targets: [],
        },
      });
    } finally {
      await Promise.allSettled([
        closeSocket(validClientSocket),
        closeSocket(invalidTargetSocket),
        closeSocket(invalidClientSocket),
        broker.close(),
      ]);
    }
  });

  it("rejects broker startup on an in-use port and allows the original server to shut down cleanly", async () => {
    const firstBroker = await startBrokerServer({
      host: "127.0.0.1",
      port: 0,
      targetToken,
      isBrowserTokenTrusted: async (token) => token === browserToken,
      logger: createMemoryLogger(),
    });

    try {
      await expect(
        startBrokerServer({
          host: "127.0.0.1",
          port: firstBroker.port,
          targetToken,
      isBrowserTokenTrusted: async (token) => token === browserToken,
      logger: createMemoryLogger(),
        }),
      ).rejects.toThrow();
    } finally {
      await firstBroker.close();
    }
  });
});
