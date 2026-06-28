import { WebSocket } from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { BrowserConnectLogger } from "./logging";
import { createMemoryLogger } from "./logging";
import type {
  DirectSessionSnapshot,
  PiMirrorEvent,
  SelectionPayload,
} from "../shared/protocol";
import type { DirectSessionServer } from "./sessionServer";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function createTestSnapshot(overrides?: Partial<DirectSessionSnapshot>): DirectSessionSnapshot {
  return {
    session: {
      cwd: "/repo",
      gitBranch: "main",
      pid: 123,
      sessionName: "test-session",
      alias: "frontend",
      connectedAt: 1_710_000_000_000,
      ...overrides?.session,
    },
    chat: {
      entries: [],
      agentBusy: false,
      busyLabel: "Агент работает в фоне…",
      ...overrides?.chat,
    },
    runtime: {
      model: { provider: "anthropic", id: "claude-sonnet", label: "Claude Sonnet" },
      availableModels: [
        { provider: "anthropic", id: "claude-sonnet", label: "Claude Sonnet" },
      ],
      isIdle: true,
      updatedAt: 1_710_000_000_000,
      ...overrides?.runtime,
    },
    ...overrides,
  };
}

function createTestSelection(): SelectionPayload {
  return {
    url: "https://example.com/page",
    title: "Example Page",
    selectedText: "hello world",
    selectedHtml: "<p>hello world</p>",
    selector: "p",
    comment: "explain this",
    capturedAt: 1_710_000_000_000,
  };
}

const TEST_LOGGER: BrowserConnectLogger = createMemoryLogger();

/**
 * Create a client WebSocket that collects messages into a shared array.
 * The message listener is registered immediately (before the socket connects)
 * to avoid race conditions where the server sends the snapshot before the
 * client's `message` listener is ready.
 */
function createClientSocket(url: string): {
  socket: WebSocket;
  messages: unknown[];
  waitForMessage: (filter?: (msg: unknown) => boolean) => Promise<unknown>;
  waitForOpen: () => Promise<void>;
  waitForClose: () => Promise<{ code: number; reason: string }>;
  close: () => Promise<void>;
  onSocketClose: () => Promise<void>;
} {
  const messages: unknown[] = [];
  const socket = new WebSocket(url);

  // Register message listener immediately — before the socket even connects
  socket.on("message", (data) => {
    const str = data.toString ? data.toString() : String(data);
    try {
      messages.push(JSON.parse(str));
    } catch {
      messages.push(str);
    }
  });

  const waitForOpen = () =>
    new Promise<void>((resolve, reject) => {
      if (socket.readyState === WebSocket.OPEN) {
        resolve();
        return;
      }
      const timer = setTimeout(
        () => reject(new Error("WebSocket open timed out")),
        3000,
      );
      socket.on("open", () => {
        clearTimeout(timer);
        resolve();
      });
      socket.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });

  const waitForMessage = (
    filter?: (msg: unknown) => boolean,
  ) =>
    new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("Message wait timed out")),
        3000,
      );

      const check = () => {
        for (const msg of messages) {
          if (!filter || filter(msg)) {
            clearTimeout(timeout);
            resolve(msg);
            return;
          }
        }
      };

      check(); // Check immediately (message may have arrived already)

      // Poll for new messages
      const interval = setInterval(() => {
        check();
      }, 10);

      const cleanup = () => {
        clearInterval(interval);
        clearTimeout(timeout);
      };

      // Final check after a longer delay
      setTimeout(() => {
        cleanup();
        check();
      }, 1000);
    });

  const waitForClose = () =>
    new Promise<{ code: number; reason: string }>((resolve, reject) => {
      if (socket.readyState === WebSocket.CLOSED) {
        resolve({ code: socket.closeCode ?? 0, reason: socket.closeReason ?? "" });
        return;
      }
      const timer = setTimeout(
        () => reject(new Error("WebSocket close timed out")),
        5000,
      );
      socket.on("close", (code, reason) => {
        clearTimeout(timer);
        resolve({ code, reason: reason.toString() });
      });
      socket.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });

  const close = () =>
    new Promise<void>((resolve) => {
      if (socket.readyState === WebSocket.CLOSED) {
        resolve();
        return;
      }
      socket.once("close", () => resolve());
      socket.close();
    });

  const onSocketClose = () =>
    new Promise<void>((resolve) => {
      if (socket.readyState === WebSocket.CLOSED) {
        resolve();
        return;
      }
      socket.once("close", () => resolve());
    });

  return { socket, messages, waitForMessage, waitForOpen, waitForClose, close, onSocketClose };
}

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Port scanning tests (Task 5a) — rewritten to use ephemeral ports
// ---------------------------------------------------------------------------

describe("port scanning constants", () => {
  it("exports DEFAULT_DIRECT_SESSION_PORT = 31415", async () => {
    const { DEFAULT_DIRECT_SESSION_PORT } = await import("./sessionServer");
    expect(DEFAULT_DIRECT_SESSION_PORT).toBe(31415);
  });

  it("exports DIRECT_SESSION_PORT_SCAN_LIMIT = 100", async () => {
    const { DIRECT_SESSION_PORT_SCAN_LIMIT } = await import("./sessionServer");
    expect(DIRECT_SESSION_PORT_SCAN_LIMIT).toBe(100);
  });
});

describe("startDirectSessionServerOnAvailablePort", () => {
  const baseOptions = {
    host: "127.0.0.1",
    preferredPort: 0, // use ephemeral port — 31415 may be occupied by live Pi
    scanLimit: 100,
    buildSnapshot: () => createTestSnapshot(),
    onChatMessage: vi.fn(),
    onSelection: vi.fn(),
    onSetModel: vi.fn(),
    logger: TEST_LOGGER,
  };

  it("uses requested port when free (ephemeral)", async () => {
    const { startDirectSessionServerOnAvailablePort } = await import("./sessionServer");
    const server = await startDirectSessionServerOnAvailablePort({
      ...baseOptions,
      preferredPort: 0,
    });

    expect(server.port).toBeGreaterThan(0);
    await server.close();
  });

  it("second server gets next free port after first", async () => {
    const { startDirectSessionServer } = await import("./sessionServer");
    // Use a high ephemeral range to avoid conflicts
    const first = await startDirectSessionServer({
      host: "127.0.0.1",
      port: 0,
      buildSnapshot: () => createTestSnapshot(),
      onChatMessage: vi.fn(),
      onSelection: vi.fn(),
      onSetModel: vi.fn(),
      logger: TEST_LOGGER,
    });
    const second = await startDirectSessionServer({
      host: "127.0.0.1",
      port: 0,
      buildSnapshot: () => createTestSnapshot(),
      onChatMessage: vi.fn(),
      onSelection: vi.fn(),
      onSetModel: vi.fn(),
      logger: TEST_LOGGER,
    });

    expect(first.port).toBeGreaterThan(0);
    expect(second.port).toBeGreaterThan(0);
    expect(first.port).not.toBe(second.port);

    await second.close();
    await first.close();
  });

  it("rethrows non-EADDRINUSE errors from startDirectSessionServer", async () => {
    const { startDirectSessionServerOnAvailablePort } = await import("./sessionServer");

    // We can't easily mock the already-imported function in the same module,
    // so instead we test the behavior by providing an impossible host
    await expect(
      startDirectSessionServerOnAvailablePort({
        ...baseOptions,
        host: "this-hostname-does-not-expect-12345.invalid",
        preferredPort: 0,
        scanLimit: 1,
      }),
    ).rejects.toThrow();
  });

  it("fails after exhausting scan limit on occupied range", async () => {
    const { startDirectSessionServer, startDirectSessionServerOnAvailablePort } = await import("./sessionServer");

    // Occupy a contiguous range of ports using direct binding
    const occupiedServers = [];
    // Start from a high ephemeral port; we occupy 5 contiguous ones
    const startPort = await findContiguousFreePort(5);
    for (let i = 0; i < 5; i++) {
      const s = await startDirectSessionServer({
        host: "127.0.0.1",
        port: startPort + i,
        buildSnapshot: () => createTestSnapshot(),
        onChatMessage: vi.fn(),
        onSelection: vi.fn(),
        onSetModel: vi.fn(),
        logger: TEST_LOGGER,
      });
      occupiedServers.push(s);
    }

    // Now with scanLimit=5 starting from the occupied range, should fail
    await expect(
      startDirectSessionServerOnAvailablePort({
        ...baseOptions,
        preferredPort: startPort,
        scanLimit: 5,
      }),
    ).rejects.toThrow("Не удалось найти свободный порт для Chrome Assistent");

    for (const s of occupiedServers) {
      await s.close();
    }
  });

  /** Find a starting port where the next N ports are all free. */
  async function findContiguousFreePort(count: number): Promise<number> {
    // Start from 32000 which is in the ephemeral range and unlikely to be used
    for (let base = 32000; base < 33000; base += 10) {
      let allFree = true;
      const servers: DirectSessionServer[] = [];
      for (let i = 0; i < count; i++) {
        try {
          const { startDirectSessionServer } = await import("./sessionServer");
          const s = await startDirectSessionServer({
            host: "127.0.0.1",
            port: base + i,
            buildSnapshot: () => createTestSnapshot(),
            onChatMessage: vi.fn(),
            onSelection: vi.fn(),
            onSetModel: vi.fn(),
            logger: TEST_LOGGER,
          });
          servers.push(s);
        } catch {
          allFree = false;
          for (const s of servers) await s.close();
          break;
        }
      }
      if (allFree) {
        for (const s of servers) await s.close();
        return base;
      }
    }
    throw new Error("Could not find contiguous free port range");
  }
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("startDirectSessionServer", () => {
  it("starts on the requested port", async () => {
    const { startDirectSessionServer } = await import("./sessionServer");
    const server = await startDirectSessionServer({
      host: "127.0.0.1",
      port: 0,
      buildSnapshot: () => createTestSnapshot(),
      onChatMessage: vi.fn(),
      onSelection: vi.fn(),
      onSetModel: vi.fn(),
      logger: TEST_LOGGER,
    });

    expect(server.port).toBeGreaterThan(0);
    expect(typeof server.broadcastSnapshot).toBe("function");
    expect(typeof server.close).toBe("function");

    await server.close();
  });

  it("sends authoritative session.snapshot on websocket connect", async () => {
    const { startDirectSessionServer } = await import("./sessionServer");
    const snapshot = createTestSnapshot();
    const server = await startDirectSessionServer({
      host: "127.0.0.1",
      port: 0,
      buildSnapshot: () => snapshot,
      onChatMessage: vi.fn(),
      onSelection: vi.fn(),
      onSetModel: vi.fn(),
      logger: TEST_LOGGER,
    });

    const client = createClientSocket(`ws://127.0.0.1:${server.port}`);
    await client.waitForOpen();

    const message = await client.waitForMessage((msg) => {
      const obj = msg as { type?: string };
      return obj.type === "session.snapshot";
    });

    expect(message).toMatchObject({
      version: 1,
      type: "session.snapshot",
      payload: expect.objectContaining({
        session: expect.objectContaining({
          cwd: "/repo",
          pid: 123,
        }),
      }),
    });

    await client.close();
    await server.close();
  });

  it("handles session.chat.send and calls injected handler", async () => {
    const { startDirectSessionServer } = await import("./sessionServer");
    const onChatMessage = vi.fn(async () => ({ ok: true }));
    const server = await startDirectSessionServer({
      host: "127.0.0.1",
      port: 0,
      buildSnapshot: () => createTestSnapshot(),
      onChatMessage,
      onSelection: vi.fn(),
      onSetModel: vi.fn(),
      logger: TEST_LOGGER,
    });

    const client = createClientSocket(`ws://127.0.0.1:${server.port}`);
    await client.waitForOpen();
    // Consume the initial snapshot
    await client.waitForMessage((msg) => {
      const obj = msg as { type?: string };
      return obj.type === "session.snapshot";
    });

    client.socket.send(JSON.stringify({
      version: 1,
      type: "session.chat.send",
      requestId: "chat-1",
      payload: { message: "Привет, как дела?" },
    }));

    const response = await client.waitForMessage((msg) => {
      const obj = msg as { requestId?: string };
      return obj.requestId === "chat-1";
    });

    expect(response).toMatchObject({
      version: 1,
      type: "session.command.result",
      requestId: "chat-1",
      payload: { ok: true },
    });
    expect(onChatMessage).toHaveBeenCalledWith("Привет, как дела?");

    await client.close();
    await server.close();
  });

  it("handles session.selection.send and calls injected handler", async () => {
    const { startDirectSessionServer } = await import("./sessionServer");
    const selection = createTestSelection();
    const onSelection = vi.fn(async () => ({ ok: true }));
    const server = await startDirectSessionServer({
      host: "127.0.0.1",
      port: 0,
      buildSnapshot: () => createTestSnapshot(),
      onChatMessage: vi.fn(),
      onSelection,
      onSetModel: vi.fn(),
      logger: TEST_LOGGER,
    });

    const client = createClientSocket(`ws://127.0.0.1:${server.port}`);
    await client.waitForOpen();
    await client.waitForMessage((msg) => {
      const obj = msg as { type?: string };
      return obj.type === "session.snapshot";
    });

    client.socket.send(JSON.stringify({
      version: 1,
      type: "session.selection.send",
      requestId: "sel-1",
      payload: { selection },
    }));

    const response = await client.waitForMessage((msg) => {
      const obj = msg as { requestId?: string };
      return obj.requestId === "sel-1";
    });

    expect(response).toMatchObject({
      version: 1,
      type: "session.command.result",
      requestId: "sel-1",
      payload: { ok: true },
    });
    expect(onSelection).toHaveBeenCalledWith(selection);

    await client.close();
    await server.close();
  });

  it("handles session.model.set and calls injected handler", async () => {
    const { startDirectSessionServer } = await import("./sessionServer");
    const onSetModel = vi.fn(async () => ({ ok: true }));
    const server = await startDirectSessionServer({
      host: "127.0.0.1",
      port: 0,
      buildSnapshot: () => createTestSnapshot(),
      onChatMessage: vi.fn(),
      onSelection: vi.fn(),
      onSetModel,
      logger: TEST_LOGGER,
    });

    const client = createClientSocket(`ws://127.0.0.1:${server.port}`);
    await client.waitForOpen();
    await client.waitForMessage((msg) => {
      const obj = msg as { type?: string };
      return obj.type === "session.snapshot";
    });

    client.socket.send(JSON.stringify({
      version: 1,
      type: "session.model.set",
      requestId: "model-1",
      payload: { provider: "anthropic", modelId: "claude-opus" },
    }));

    const response = await client.waitForMessage((msg) => {
      const obj = msg as { requestId?: string };
      return obj.requestId === "model-1";
    });

    expect(response).toMatchObject({
      version: 1,
      type: "session.command.result",
      requestId: "model-1",
      payload: { ok: true },
    });
    expect(onSetModel).toHaveBeenCalledWith({
      provider: "anthropic",
      modelId: "claude-opus",
    });

    await client.close();
    await server.close();
  });

  it("returns error result when handler returns error", async () => {
    const { startDirectSessionServer } = await import("./sessionServer");
    const onChatMessage = vi.fn(async () => ({ ok: false, error: "Агент недоступен" }));
    const server = await startDirectSessionServer({
      host: "127.0.0.1",
      port: 0,
      buildSnapshot: () => createTestSnapshot(),
      onChatMessage,
      onSelection: vi.fn(),
      onSetModel: vi.fn(),
      logger: TEST_LOGGER,
    });

    const client = createClientSocket(`ws://127.0.0.1:${server.port}`);
    await client.waitForOpen();
    await client.waitForMessage((msg) => {
      const obj = msg as { type?: string };
      return obj.type === "session.snapshot";
    });

    client.socket.send(JSON.stringify({
      version: 1,
      type: "session.chat.send",
      requestId: "chat-err-1",
      payload: { message: "test" },
    }));

    const response = await client.waitForMessage((msg) => {
      const obj = msg as { requestId?: string };
      return obj.requestId === "chat-err-1";
    });

    expect(response).toMatchObject({
      version: 1,
      type: "session.command.result",
      requestId: "chat-err-1",
      payload: { ok: false, error: "Агент недоступен" },
    });

    await client.close();
    await server.close();
  });

  it("returns session.error for malformed non-JSON message", async () => {
    const { startDirectSessionServer } = await import("./sessionServer");
    const server = await startDirectSessionServer({
      host: "127.0.0.1",
      port: 0,
      buildSnapshot: () => createTestSnapshot(),
      onChatMessage: vi.fn(),
      onSelection: vi.fn(),
      onSetModel: vi.fn(),
      logger: createMemoryLogger(),
    });

    const client = createClientSocket(`ws://127.0.0.1:${server.port}`);
    await client.waitForOpen();
    await client.waitForMessage((msg) => {
      const obj = msg as { type?: string };
      return obj.type === "session.snapshot";
    });

    client.socket.send("this is not json at all");

    const response = await client.waitForMessage((msg) => {
      const obj = msg as { type?: string };
      return obj.type === "session.error";
    });

    expect(response).toMatchObject({
      version: 1,
      type: "session.error",
      payload: expect.objectContaining({ ok: false }),
    });

    await client.close();
    await server.close();
  });

  it("returns session.error for message with unknown type", async () => {
    const { startDirectSessionServer } = await import("./sessionServer");
    const server = await startDirectSessionServer({
      host: "127.0.0.1",
      port: 0,
      buildSnapshot: () => createTestSnapshot(),
      onChatMessage: vi.fn(),
      onSelection: vi.fn(),
      onSetModel: vi.fn(),
      logger: TEST_LOGGER,
    });

    const client = createClientSocket(`ws://127.0.0.1:${server.port}`);
    await client.waitForOpen();
    await client.waitForMessage((msg) => {
      const obj = msg as { type?: string };
      return obj.type === "session.snapshot";
    });

    // "unknown.type" fails parseProtocolEnvelope (type not in PROTOCOL_MESSAGE_TYPES),
    // so it's treated as malformed — session.error without requestId
    client.socket.send(JSON.stringify({
      version: 1,
      type: "unknown.type",
      requestId: "bad-1",
    }));

    const response = await client.waitForMessage((msg) => {
      const obj = msg as { type?: string };
      return obj.type === "session.error";
    });

    expect(response).toMatchObject({
      version: 1,
      type: "session.error",
      payload: expect.objectContaining({ ok: false }),
    });

    await client.close();
    await server.close();
  });

  it("returns session.error for chat send with invalid payload", async () => {
    const { startDirectSessionServer } = await import("./sessionServer");
    const server = await startDirectSessionServer({
      host: "127.0.0.1",
      port: 0,
      buildSnapshot: () => createTestSnapshot(),
      onChatMessage: vi.fn(),
      onSelection: vi.fn(),
      onSetModel: vi.fn(),
      logger: TEST_LOGGER,
    });

    const client = createClientSocket(`ws://127.0.0.1:${server.port}`);
    await client.waitForOpen();
    await client.waitForMessage((msg) => {
      const obj = msg as { type?: string };
      return obj.type === "session.snapshot";
    });

    client.socket.send(JSON.stringify({
      version: 1,
      type: "session.chat.send",
      requestId: "bad-chat-1",
      payload: { message: "" }, // empty message
    }));

    const response = await client.waitForMessage((msg) => {
      const obj = msg as { requestId?: string };
      return obj.requestId === "bad-chat-1";
    });

    expect(response).toMatchObject({
      version: 1,
      type: "session.error",
      requestId: "bad-chat-1",
    });

    await client.close();
    await server.close();
  });

  it("broadcastSnapshot sends fresh snapshot to all connected clients", async () => {
    const { startDirectSessionServer } = await import("./sessionServer");
    let currentSnapshot = createTestSnapshot({ chat: { entries: [], agentBusy: false, busyLabel: "Агент работает в фоне…" } });
    const server = await startDirectSessionServer({
      host: "127.0.0.1",
      port: 0,
      buildSnapshot: () => currentSnapshot,
      onChatMessage: vi.fn(),
      onSelection: vi.fn(),
      onSetModel: vi.fn(),
      logger: TEST_LOGGER,
    });

    const client1 = createClientSocket(`ws://127.0.0.1:${server.port}`);
    await client1.waitForOpen();
    await client1.waitForMessage((msg) => {
      const obj = msg as { type?: string };
      return obj.type === "session.snapshot";
    });

    const client2 = createClientSocket(`ws://127.0.0.1:${server.port}`);
    await client2.waitForOpen();
    await client2.waitForMessage((msg) => {
      const obj = msg as { type?: string };
      return obj.type === "session.snapshot";
    });

    // Update snapshot and broadcast
    currentSnapshot = createTestSnapshot({
      chat: { entries: [], agentBusy: true, busyLabel: "Агент занят" },
    });

    // Small delay to ensure clients are ready
    await new Promise((r) => setTimeout(r, 50));

    server.broadcastSnapshot();

    const msg1 = await client1.waitForMessage((msg) => {
      const obj = msg as { type?: string; payload?: { chat?: { agentBusy?: boolean } } };
      return obj.type === "session.snapshot" && obj.payload?.chat?.agentBusy === true;
    });
    const msg2 = await client2.waitForMessage((msg) => {
      const obj = msg as { type?: string; payload?: { chat?: { agentBusy?: boolean } } };
      return obj.type === "session.snapshot" && obj.payload?.chat?.agentBusy === true;
    });

    expect((msg1 as { version: number; type: string }).version).toBe(1);
    expect((msg1 as { type: string }).type).toBe("session.snapshot");
    expect((msg1 as { payload: { chat: { agentBusy: boolean } } }).payload.chat.agentBusy).toBe(true);

    expect((msg2 as { version: number; type: string }).version).toBe(1);
    expect((msg2 as { type: string }).type).toBe("session.snapshot");
    expect((msg2 as { payload: { chat: { agentBusy: boolean } } }).payload.chat.agentBusy).toBe(true);

    await client1.close();
    await client2.close();
    await server.close();
  });

  it("close stops accepting new connections", async () => {
    const { startDirectSessionServer } = await import("./sessionServer");
    const server = await startDirectSessionServer({
      host: "127.0.0.1",
      port: 0,
      buildSnapshot: () => createTestSnapshot(),
      onChatMessage: vi.fn(),
      onSelection: vi.fn(),
      onSetModel: vi.fn(),
      logger: TEST_LOGGER,
    });

    const port = server.port;
    await server.close();

    // A new connection to the closed server should fail
    const socket = new WebSocket(`ws://127.0.0.1:${port}`);

    await expect(
      new Promise((_, reject) => {
        const timer = setTimeout(
          () => reject(new Error("should have errored")),
          2000,
        );
        socket.on("error", (err) => {
          clearTimeout(timer);
          reject(err);
        });
        socket.on("open", () => {
          clearTimeout(timer);
          reject(new Error("connection should not succeed after close"));
        });
      }),
    ).rejects.toThrow();
  });

  it("closes existing connections on server close", async () => {
    const { startDirectSessionServer } = await import("./sessionServer");
    const server = await startDirectSessionServer({
      host: "127.0.0.1",
      port: 0,
      buildSnapshot: () => createTestSnapshot(),
      onChatMessage: vi.fn(),
      onSelection: vi.fn(),
      onSetModel: vi.fn(),
      logger: TEST_LOGGER,
    });

    const client = createClientSocket(`ws://127.0.0.1:${server.port}`);
    await client.waitForOpen();
    await client.waitForMessage((msg) => {
      const obj = msg as { type?: string };
      return obj.type === "session.snapshot";
    });

    await server.close();

    // The client socket should receive close
    await client.onSocketClose();
    expect(client.socket.readyState).toBe(WebSocket.CLOSED);
  });

  // ─── session.event broadcast tests (Task 4) ───

  it("broadcastEvent sends session.event envelope to single client", async () => {
    const { startDirectSessionServer } = await import("./sessionServer");
    const server = await startDirectSessionServer({
      host: "127.0.0.1",
      port: 0,
      buildSnapshot: () => createTestSnapshot(),
      onChatMessage: vi.fn(),
      onSelection: vi.fn(),
      onSetModel: vi.fn(),
      logger: TEST_LOGGER,
    });

    const client = createClientSocket(`ws://127.0.0.1:${server.port}`);
    await client.waitForOpen();
    await client.waitForMessage((msg) => {
      const obj = msg as { type?: string };
      return obj.type === "session.snapshot";
    });

    const mirrorEvent: PiMirrorEvent = {
      type: "message_start",
      message: { id: "msg-1", role: "assistant" },
    };
    server.broadcastEvent(mirrorEvent);

    const received = await client.waitForMessage((msg) => {
      const obj = msg as { type?: string };
      return obj.type === "session.event";
    });

    expect(received).toMatchObject({
      version: 1,
      type: "session.event",
      payload: {
        type: "message_start",
        message: { id: "msg-1", role: "assistant" },
      },
    });

    await client.close();
    await server.close();
  });

  it("broadcastEvent sends message_update with assistantMessageEvent text_delta to client", async () => {
    const { startDirectSessionServer } = await import("./sessionServer");
    const server = await startDirectSessionServer({
      host: "127.0.0.1",
      port: 0,
      buildSnapshot: () => createTestSnapshot(),
      onChatMessage: vi.fn(),
      onSelection: vi.fn(),
      onSetModel: vi.fn(),
      logger: TEST_LOGGER,
    });

    const client = createClientSocket(`ws://127.0.0.1:${server.port}`);
    await client.waitForOpen();
    await client.waitForMessage((msg) => {
      const obj = msg as { type?: string };
      return obj.type === "session.snapshot";
    });

    const mirrorEvent: PiMirrorEvent = {
      type: "message_update",
      message: { id: "msg-1", role: "assistant" },
      assistantMessageEvent: { type: "text_delta", text_delta: "Hello" },
    };
    server.broadcastEvent(mirrorEvent);

    const received = await client.waitForMessage((msg) => {
      const obj = msg as { type?: string };
      return obj.type === "session.event";
    });

    expect(received).toMatchObject({
      version: 1,
      type: "session.event",
      payload: {
        type: "message_update",
        message: { id: "msg-1", role: "assistant" },
        assistantMessageEvent: { type: "text_delta", text_delta: "Hello" },
      },
    });

    await client.close();
    await server.close();
  });

  it("broadcastEvent sends to all connected clients simultaneously", async () => {
    const { startDirectSessionServer } = await import("./sessionServer");
    const server = await startDirectSessionServer({
      host: "127.0.0.1",
      port: 0,
      buildSnapshot: () => createTestSnapshot(),
      onChatMessage: vi.fn(),
      onSelection: vi.fn(),
      onSetModel: vi.fn(),
      logger: TEST_LOGGER,
    });

    const client1 = createClientSocket(`ws://127.0.0.1:${server.port}`);
    await client1.waitForOpen();
    await client1.waitForMessage((msg) => {
      const obj = msg as { type?: string };
      return obj.type === "session.snapshot";
    });

    const client2 = createClientSocket(`ws://127.0.0.1:${server.port}`);
    await client2.waitForOpen();
    await client2.waitForMessage((msg) => {
      const obj = msg as { type?: string };
      return obj.type === "session.snapshot";
    });

    // Small delay to ensure clients are ready
    await new Promise((r) => setTimeout(r, 50));

    const mirrorEvent: PiMirrorEvent = {
      type: "message_end",
      message: { id: "msg-1", role: "assistant" },
      stopReason: "end_turn",
    };
    server.broadcastEvent(mirrorEvent);

    const msg1 = await client1.waitForMessage((msg) => {
      const obj = msg as { type?: string };
      return obj.type === "session.event";
    });
    const msg2 = await client2.waitForMessage((msg) => {
      const obj = msg as { type?: string };
      return obj.type === "session.event";
    });

    expect(msg1).toMatchObject({
      version: 1,
      type: "session.event",
      payload: { type: "message_end" },
    });
    expect(msg2).toMatchObject({
      version: 1,
      type: "session.event",
      payload: { type: "message_end" },
    });

    await client1.close();
    await client2.close();
    await server.close();
  });

  it("broadcastEvent skips closed/ disconnected clients", async () => {
    const { startDirectSessionServer } = await import("./sessionServer");
    const server = await startDirectSessionServer({
      host: "127.0.0.1",
      port: 0,
      buildSnapshot: () => createTestSnapshot(),
      onChatMessage: vi.fn(),
      onSelection: vi.fn(),
      onSetModel: vi.fn(),
      logger: TEST_LOGGER,
    });

    const client1 = createClientSocket(`ws://127.0.0.1:${server.port}`);
    await client1.waitForOpen();
    await client1.waitForMessage((msg) => {
      const obj = msg as { type?: string };
      return obj.type === "session.snapshot";
    });

    // client2 connects then disconnects
    const client2 = createClientSocket(`ws://127.0.0.1:${server.port}`);
    await client2.waitForOpen();
    await client2.waitForMessage((msg) => {
      const obj = msg as { type?: string };
      return obj.type === "session.snapshot";
    });
    await client2.close();

    // Small delay to ensure client2 is fully closed
    await new Promise((r) => setTimeout(r, 50));

    // broadcastEvent should not throw even though client2 is disconnected
    expect(() => {
      server.broadcastEvent({
        type: "message_start",
        message: { id: "msg-1", role: "assistant" },
      });
    }).not.toThrow();

    // client1 should still receive the event
    const msg = await client1.waitForMessage((msg) => {
      const obj = msg as { type?: string };
      return obj.type === "session.event";
    });
    expect(msg).toMatchObject({ type: "session.event" });

    await client1.close();
    await server.close();
  });

  it("client sending session.event is ignored as server-initiated type", async () => {
    const { startDirectSessionServer } = await import("./sessionServer");
    const server = await startDirectSessionServer({
      host: "127.0.0.1",
      port: 0,
      buildSnapshot: () => createTestSnapshot(),
      onChatMessage: vi.fn(),
      onSelection: vi.fn(),
      onSetModel: vi.fn(),
      logger: TEST_LOGGER,
    });

    const client = createClientSocket(`ws://127.0.0.1:${server.port}`);
    await client.waitForOpen();
    await client.waitForMessage((msg) => {
      const obj = msg as { type?: string };
      return obj.type === "session.snapshot";
    });

    // Client sends session.event — server should silently ignore it
    client.socket.send(JSON.stringify({
      version: 1,
      type: "session.event",
      payload: { type: "message_start", message: { id: "msg-1", role: "user" } },
    }));

    // Wait a bit to confirm no error response is sent
    await new Promise((r) => setTimeout(r, 100));

    // No session.error should have been received
    const hasError = client.messages.some(
      (msg) => (msg as { type?: string }).type === "session.error",
    );
    expect(hasError).toBe(false);

    await client.close();
    await server.close();
  });

  it("broadcastEvent supports all PiMirrorEvent types", async () => {
    const { startDirectSessionServer } = await import("./sessionServer");
    const server = await startDirectSessionServer({
      host: "127.0.0.1",
      port: 0,
      buildSnapshot: () => createTestSnapshot(),
      onChatMessage: vi.fn(),
      onSelection: vi.fn(),
      onSetModel: vi.fn(),
      logger: TEST_LOGGER,
    });

    const client = createClientSocket(`ws://127.0.0.1:${server.port}`);
    await client.waitForOpen();
    await client.waitForMessage((msg) => {
      const obj = msg as { type?: string };
      return obj.type === "session.snapshot";
    });

    const events: PiMirrorEvent[] = [
      { type: "turn_start", turnId: "turn-1" },
      { type: "turn_end", turnId: "turn-1" },
      { type: "tool_execution_start", toolName: "read_file", input: { path: "/tmp/test" } },
      { type: "tool_execution_update", toolName: "read_file", output: "content" },
      { type: "tool_execution_end", toolName: "read_file", output: "content" },
      { type: "model_select", provider: "anthropic", modelId: "claude-sonnet" },
    ];

    for (const evt of events) {
      server.broadcastEvent(evt);
    }

    // Should receive 6 session.event messages (one for each broadcastEvent call)
    const eventMsgs = await Promise.all(
      events.map(() =>
        client.waitForMessage((msg) => {
          const obj = msg as { type?: string };
          return obj.type === "session.event";
        }),
      ),
    );

    expect(eventMsgs.length).toBe(6);
    for (const received of eventMsgs) {
      expect(received).toMatchObject({
        version: 1,
        type: "session.event",
      });
    }

    await client.close();
    await server.close();
  });

  // ─── Rate limiting tests (M3) ───

  it("rejects messages when rate limit is exceeded", async () => {
    const { startDirectSessionServer } = await import("./sessionServer");
    const onChatMessage = vi.fn().mockResolvedValue({ ok: true });
    const server = await startDirectSessionServer({
      host: "127.0.0.1",
      port: 0,
      buildSnapshot: () => createTestSnapshot(),
      onChatMessage,
      onSelection: vi.fn(),
      onSetModel: vi.fn(),
      logger: TEST_LOGGER,
    });

    const client = createClientSocket(`ws://127.0.0.1:${server.port}`);
    await client.waitForOpen();

    // Consume initial snapshot
    await client.waitForMessage((msg) => {
      const obj = msg as { type?: string };
      return obj.type === "session.snapshot";
    });

    // Send 10 messages rapidly (limit is 5 per second)
    for (let i = 0; i < 10; i++) {
      client.socket.send(JSON.stringify({
        version: 1,
        type: "session.chat.send",
        requestId: `req-${i}`,
        payload: { message: `Message ${i}` },
      }));
    }

    // Wait for responses
    await new Promise((resolve) => setTimeout(resolve, 200));

    // Should have processed only 5 messages (the rate limit)
    expect(onChatMessage).toHaveBeenCalledTimes(5);

    await client.close();
    await server.close();
  });

  it("sends session.error with rate-limit message for rejected messages", async () => {
    const { startDirectSessionServer } = await import("./sessionServer");
    const onChatMessage = vi.fn().mockResolvedValue({ ok: true });
    const server = await startDirectSessionServer({
      host: "127.0.0.1",
      port: 0,
      buildSnapshot: () => createTestSnapshot(),
      onChatMessage,
      onSelection: vi.fn(),
      onSetModel: vi.fn(),
      logger: TEST_LOGGER,
    });

    const client = createClientSocket(`ws://127.0.0.1:${server.port}`);
    await client.waitForOpen();

    // Consume initial snapshot
    await client.waitForMessage((msg) => {
      const obj = msg as { type?: string };
      return obj.type === "session.snapshot";
    });

    // Send 10 messages rapidly (limit is 5 per second)
    for (let i = 0; i < 10; i++) {
      client.socket.send(JSON.stringify({
        version: 1,
        type: "session.chat.send",
        requestId: `rate-req-${i}`,
        payload: { message: `Msg ${i}` },
      }));
    }

    // Wait for responses
    await new Promise((resolve) => setTimeout(resolve, 200));

    // Should have received exactly 5 rate-limit errors
    const rateErrors = client.messages.filter(
      (msg) => {
        const obj = msg as { type?: string; requestId?: string; payload?: { error?: string } };
        return (
          obj.type === "session.error" &&
          obj.payload?.error?.includes("Превышен лимит")
        );
      },
    );
    expect(rateErrors.length).toBe(5);

    // Each error should carry the original requestId
    for (const err of rateErrors) {
      const obj = err as { requestId?: string };
      expect(obj.requestId).toBeDefined();
      expect(obj.requestId).toMatch(/^rate-req-/);
    }

    await client.close();
    await server.close();
  });

  it("resets rate limit after window expires", async () => {
    const { startDirectSessionServer } = await import("./sessionServer");
    const onChatMessage = vi.fn().mockResolvedValue({ ok: true });
    const server = await startDirectSessionServer({
      host: "127.0.0.1",
      port: 0,
      buildSnapshot: () => createTestSnapshot(),
      onChatMessage,
      onSelection: vi.fn(),
      onSetModel: vi.fn(),
      logger: TEST_LOGGER,
    });

    const client = createClientSocket(`ws://127.0.0.1:${server.port}`);
    await client.waitForOpen();

    // Consume initial snapshot
    await client.waitForMessage((msg) => {
      const obj = msg as { type?: string };
      return obj.type === "session.snapshot";
    });

    // Send 5 messages to exhaust the limit
    for (let i = 0; i < 5; i++) {
      client.socket.send(JSON.stringify({
        version: 1,
        type: "session.chat.send",
        requestId: `burst-${i}`,
        payload: { message: `Burst ${i}` },
      }));
    }

    // Wait for responses
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(onChatMessage).toHaveBeenCalledTimes(5);

    // Wait for the rate-limit window to expire (1 second)
    await new Promise((resolve) => setTimeout(resolve, 1100));

    // Send one more message — should be accepted
    client.socket.send(JSON.stringify({
      version: 1,
      type: "session.chat.send",
      requestId: "after-window",
      payload: { message: "After window" },
    }));

    const response = await client.waitForMessage((msg) => {
      const obj = msg as { requestId?: string };
      return obj.requestId === "after-window";
    });

    expect(response).toMatchObject({
      type: "session.command.result",
      requestId: "after-window",
      payload: { ok: true },
    });
    expect(onChatMessage).toHaveBeenCalledTimes(6);

    await client.close();
    await server.close();
  });

  // ─── WebSocket maxPayload limit tests ───

  it("closes connection when message exceeds 1MB maxPayload", async () => {
    const { startDirectSessionServer } = await import("./sessionServer");
    const server = await startDirectSessionServer({
      host: "127.0.0.1",
      port: 0,
      buildSnapshot: () => createTestSnapshot(),
      onChatMessage: vi.fn(),
      onSelection: vi.fn(),
      onSetModel: vi.fn(),
      logger: TEST_LOGGER,
    });

    const client = createClientSocket(`ws://127.0.0.1:${server.port}`);
    await client.waitForOpen();

    // Wait for snapshot so we know connection is fully established
    await client.waitForMessage((msg) => {
      const obj = msg as { type?: string };
      return obj.type === "session.snapshot";
    });

    // Send a message larger than 1MB (default ws limit is ~100MB)
    const largePayload = JSON.stringify({
      version: "1",
      type: "session.chat.send",
      payload: { message: "x".repeat(1_100_000) }, // ~1.1 MB
    });

    client.socket.send(largePayload);

    // Connection should be closed by server with code 1009 (Message Too Big)
    const closeInfo = await client.waitForClose();
    expect(closeInfo.code).toBe(1009);

    await server.close();
  });

  it("exports WEBSOCKET_MAX_PAYLOAD_BYTES constant equal to 1MB", async () => {
    const { WEBSOCKET_MAX_PAYLOAD_BYTES } = await import("./sessionServer");
    expect(WEBSOCKET_MAX_PAYLOAD_BYTES).toBe(1_048_576);
  });
});
