import { describe, expect, it, vi } from "vitest";

import type { TargetMetadata } from "../shared/protocol";
import type { BrowserAuthState } from "./browserToken";
import {
  BackgroundAssistantStateServer,
  type BackgroundStateServerStorage,
  type ChromeRuntimePortLike,
} from "./backgroundStateServer";
import { isChatSendDisabled } from "./assistantState";

class FakePort implements ChromeRuntimePortLike {
  readonly name = "sidepanel";
  readonly postedMessages: unknown[] = [];
  throwOnPost = false;
  private readonly messageListeners = new Set<(message: unknown) => void>();
  private readonly disconnectListeners = new Set<() => void>();

  readonly onMessage = {
    addListener: (listener: (message: unknown) => void): void => {
      this.messageListeners.add(listener);
    },
    removeListener: (listener: (message: unknown) => void): void => {
      this.messageListeners.delete(listener);
    },
  };

  readonly onDisconnect = {
    addListener: (listener: () => void): void => {
      this.disconnectListeners.add(listener);
    },
    removeListener: (listener: () => void): void => {
      this.disconnectListeners.delete(listener);
    },
  };

  postMessage(message: unknown): void {
    if (this.throwOnPost) {
      throw new Error("port closed");
    }

    this.postedMessages.push(message);
  }

  emitMessage(message: unknown): void {
    for (const listener of this.messageListeners) {
      listener(message);
    }
  }

  disconnect(): void {
    for (const listener of this.disconnectListeners) {
      listener();
    }
  }
}

class FakeStorage implements BackgroundStateServerStorage {
  readonly values = new Map<string, unknown>();
  readonly removedKeys: string[] = [];
  setError: unknown;

  async get<T>(key: string): Promise<T | undefined> {
    return this.values.get(key) as T | undefined;
  }

  async set<T>(key: string, value: T): Promise<void> {
    if (this.setError) {
      throw this.setError;
    }

    this.values.set(key, value);
  }

  async remove(key: string): Promise<void> {
    this.removedKeys.push(key);
    this.values.delete(key);
  }
}

type FakeBrokerClientOptions = {
  browserToken?: string;
  onTargets?: (targets: TargetMetadata[]) => void;
};

class FakeBrokerClient {
  readonly connect = vi.fn();
  readonly close = vi.fn();
  selectedTargetId: string | undefined;

  constructor(readonly options: FakeBrokerClientOptions) {}

  setSelectedTargetId(targetId: string | undefined): void {
    this.selectedTargetId = targetId;
  }

  emitTargets(targets: TargetMetadata[]): void {
    this.options.onTargets?.(targets);
  }
}

function createTarget(overrides: Partial<TargetMetadata> = {}): TargetMetadata {
  return {
    targetId: "target-1",
    alias: "Alpha",
    cwd: "/tmp/pi",
    gitBranch: "main",
    pid: 1234,
    sessionName: "session-a",
    connectedAt: 1_710_000_000_000,
    lastSeenAt: 1_710_000_000_100,
    ...overrides,
  };
}

function createServer(overrides: Partial<ConstructorParameters<typeof BackgroundAssistantStateServer>[0]> = {}) {
  const storage = new FakeStorage();
  const diagnostics: Array<{ phase: string; message: string }> = [];
  const brokerClients: FakeBrokerClient[] = [];
  const tokenHelpers = {
    ensureBrowserToken: vi.fn<() => Promise<string>>(async () => "token-initial"),
    getBrowserAuthState: vi.fn<() => Promise<BrowserAuthState>>(async () => ({
      browserToken: "token-initial",
      tokenConfigured: true,
    })),
    regenerateBrowserToken: vi.fn<() => Promise<string>>(async () => "token-regenerated"),
    clearBrowserToken: vi.fn<() => Promise<void>>(async () => undefined),
  };
  const server = new BackgroundAssistantStateServer({
    storage,
    runtimeClock: () => 1_710_000_000_123,
    brokerClientFactory: (options) => {
      const client = new FakeBrokerClient(options);
      brokerClients.push(client);
      return client;
    },
    recordDiagnostic: async (diagnostic) => {
      diagnostics.push({ phase: diagnostic.phase, message: diagnostic.message });
    },
    tokenHelpers,
    ...overrides,
  });

  return { server, storage, diagnostics, brokerClients, tokenHelpers };
}

async function flushAsyncWork(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });

  return { promise, resolve, reject };
}

describe("BackgroundAssistantStateServer", () => {
  it("loads or creates a browser token on startup and connects broker with it", async () => {
    const { server, brokerClients, tokenHelpers } = createServer();

    await server.start();

    expect(tokenHelpers.ensureBrowserToken).toHaveBeenCalledTimes(1);
    expect(brokerClients).toHaveLength(1);
    expect(brokerClients[0]?.options.browserToken).toBe("token-initial");
    expect(brokerClients[0]?.connect).toHaveBeenCalledTimes(1);
    expect(server.getSnapshot().auth).toMatchObject({ browserToken: "token-initial", tokenConfigured: true });
    expect(server.getSnapshot().connection.tokenConfigured).toBe(true);
  });

  it("closes the broker client and broadcasts token guidance when auth refresh finds no token", async () => {
    const { server, brokerClients, tokenHelpers } = createServer();
    const port = new FakePort();
    await server.start();
    server.connectPort(port);
    tokenHelpers.getBrowserAuthState.mockResolvedValueOnce({ tokenConfigured: false });

    port.emitMessage({ type: "assistant.auth.refresh" });
    await flushAsyncWork();

    expect(tokenHelpers.getBrowserAuthState).toHaveBeenCalledTimes(1);
    expect(brokerClients[0]?.close).toHaveBeenCalledTimes(1);
    expect(brokerClients).toHaveLength(1);
    expect(server.getSnapshot().auth).toMatchObject({ tokenConfigured: false });
    expect(server.getSnapshot().auth.browserToken).toBeUndefined();
    expect(server.getSnapshot().connection.lastError).toBe("Токен браузера не настроен. Сгенерируйте токен для подключения к Pi.");
    expect(port.postedMessages.at(-1)).toEqual({ type: "assistant.snapshot", state: server.getSnapshot() });
  });

  it("regenerates token with one epoch increment and recreates broker client once", async () => {
    const { server, brokerClients, tokenHelpers } = createServer();
    const port = new FakePort();
    await server.start();
    server.connectPort(port);
    const epochBefore = server.getSnapshot().epoch;

    port.emitMessage({ type: "assistant.auth.regenerateToken" });
    await flushAsyncWork();

    expect(tokenHelpers.regenerateBrowserToken).toHaveBeenCalledTimes(1);
    expect(server.getSnapshot().epoch).toBe(epochBefore + 1);
    expect(brokerClients[0]?.close).toHaveBeenCalledTimes(1);
    expect(brokerClients).toHaveLength(2);
    expect(brokerClients[1]?.options.browserToken).toBe("token-regenerated");
    expect(brokerClients[1]?.connect).toHaveBeenCalledTimes(1);
  });

  it("clears token, closes broker, clears targets and selection, and disables chat", async () => {
    const { server, brokerClients, tokenHelpers } = createServer();
    const port = new FakePort();
    await server.start();
    server.connectPort(port);
    brokerClients[0]?.emitTargets([createTarget()]);
    port.emitMessage({ type: "assistant.selectTarget", targetId: "target-1" });
    await flushAsyncWork();

    port.emitMessage({ type: "assistant.auth.clearToken" });
    await flushAsyncWork();

    expect(tokenHelpers.clearBrowserToken).toHaveBeenCalledTimes(1);
    expect(brokerClients[0]?.close).toHaveBeenCalledTimes(1);
    expect(server.getSnapshot().targets).toEqual([]);
    expect(server.getSnapshot().selectedTargetId).toBeUndefined();
    expect(server.getSnapshot().connection.tokenConfigured).toBe(false);
    expect(server.getSnapshot().connection.brokerOnline).toBe(false);
    expect(server.getSnapshot().connection.bridgeOnline).toBe(false);
    expect(server.getSnapshot().connection.browserAuthorized).toBeUndefined();
    expect(isChatSendDisabled(server.getSnapshot(), "сообщение")).toBe(true);
  });

  it("does not reconnect the broker client when auth refresh returns the same token", async () => {
    const { server, brokerClients, tokenHelpers } = createServer();
    const port = new FakePort();
    await server.start();
    server.connectPort(port);
    tokenHelpers.getBrowserAuthState.mockResolvedValueOnce({ browserToken: "token-initial", tokenConfigured: true });
    const epochBefore = server.getSnapshot().epoch;

    port.emitMessage({ type: "assistant.auth.refresh" });
    await flushAsyncWork();

    expect(tokenHelpers.getBrowserAuthState).toHaveBeenCalledTimes(1);
    expect(brokerClients).toHaveLength(1);
    expect(brokerClients[0]?.close).not.toHaveBeenCalled();
    expect(brokerClients[0]?.connect).toHaveBeenCalledTimes(1);
    expect(server.getSnapshot().epoch).toBe(epochBefore);
  });

  it.each([
    ["assistant.auth.refresh", "getBrowserAuthState", "Не удалось обновить токен браузера. Попробуйте ещё раз."],
    ["assistant.auth.regenerateToken", "regenerateBrowserToken", "Не удалось сгенерировать новый токен браузера. Попробуйте ещё раз."],
    ["assistant.auth.clearToken", "clearBrowserToken", "Не удалось удалить токен браузера. Попробуйте ещё раз."],
  ] as const)("handles %s token helper rejection without unhandled command rejection", async (commandType, helperName, expectedError) => {
    const { server, tokenHelpers, diagnostics } = createServer();
    const port = new FakePort();
    await server.start();
    server.connectPort(port);
    tokenHelpers[helperName].mockRejectedValueOnce(new Error("storage offline"));

    expect(() => port.emitMessage({ type: commandType })).not.toThrow();
    await flushAsyncWork();

    expect(server.getSnapshot().auth).toMatchObject({
      mutationPending: false,
      error: expectedError,
    });
    expect(diagnostics).toEqual([
      {
        phase: commandType,
        message: `${expectedError} storage offline`,
      },
    ]);
    expect(port.postedMessages.at(-1)).toEqual({ type: "assistant.snapshot", state: server.getSnapshot() });
  });

  it("allows retrying start after ensureBrowserToken fails", async () => {
    const { server, brokerClients, tokenHelpers, diagnostics } = createServer();
    tokenHelpers.ensureBrowserToken
      .mockRejectedValueOnce(new Error("vault locked"))
      .mockResolvedValueOnce("token-after-retry");

    await expect(server.start()).rejects.toThrow("vault locked");

    expect(server.getSnapshot().auth).toMatchObject({
      mutationPending: false,
      error: "Не удалось подготовить токен браузера. Попробуйте ещё раз.",
    });
    expect(server.getSnapshot().connection.connecting).toBe(false);
    expect(server.getSnapshot().connection.lastError).toBe("Не удалось подготовить токен браузера. Попробуйте ещё раз.");
    expect(diagnostics).toEqual([
      {
        phase: "assistant.start",
        message: "Не удалось подготовить токен браузера. Попробуйте ещё раз. vault locked",
      },
    ]);
    expect(brokerClients).toHaveLength(0);

    await server.start();

    expect(tokenHelpers.ensureBrowserToken).toHaveBeenCalledTimes(2);
    expect(server.getSnapshot().auth).toMatchObject({ browserToken: "token-after-retry", tokenConfigured: true });
    expect(brokerClients).toHaveLength(1);
    expect(brokerClients[0]?.connect).toHaveBeenCalledTimes(1);
  });

  it("does not create or connect a broker when stopped before delayed startup completes", async () => {
    const startup = createDeferred<string>();
    const { server, brokerClients, tokenHelpers } = createServer();
    tokenHelpers.ensureBrowserToken.mockReturnValueOnce(startup.promise);

    const startPromise = server.start();
    server.stop();
    startup.resolve("late-token");
    await startPromise;

    expect(brokerClients).toHaveLength(0);
    expect(server.getSnapshot().auth.browserToken).toBeUndefined();
    expect(server.getSnapshot().auth.tokenConfigured).toBe(false);
    expect(server.getSnapshot().connection.connecting).toBe(false);
    expect(server.getSnapshot().connection.lastError).toBe("Токен браузера не настроен. Сгенерируйте токен для подключения к Pi.");
  });

  it("immediately posts an assistant snapshot when a port connects", () => {
    const { server } = createServer();
    const port = new FakePort();

    server.connectPort(port);

    expect(port.postedMessages).toEqual([
      {
        type: "assistant.snapshot",
        state: server.getSnapshot(),
      },
    ]);
  });

  it("broadcasts the same snapshot to multiple ports after a state change", async () => {
    const { server, brokerClients } = createServer();
    const portA = new FakePort();
    const portB = new FakePort();
    await server.start();
    server.connectPort(portA);
    server.connectPort(portB);

    brokerClients[0]?.emitTargets([createTarget()]);

    const expected = { type: "assistant.snapshot", state: server.getSnapshot() };
    expect(portA.postedMessages.at(-1)).toEqual(expected);
    expect(portB.postedMessages.at(-1)).toEqual(expected);
  });

  it("removes disconnected ports from future broadcasts", async () => {
    const { server, brokerClients } = createServer();
    const connectedPort = new FakePort();
    const disconnectedPort = new FakePort();
    await server.start();
    server.connectPort(connectedPort);
    server.connectPort(disconnectedPort);
    disconnectedPort.disconnect();

    brokerClients[0]?.emitTargets([createTarget()]);

    expect(connectedPort.postedMessages).toHaveLength(2);
    expect(disconnectedPort.postedMessages).toHaveLength(1);
  });

  it("updates state and persists selectedTargetId for assistant.selectTarget", async () => {
    const { server, storage, brokerClients } = createServer();
    const port = new FakePort();
    await server.start();
    server.connectPort(port);
    brokerClients[0]?.emitTargets([createTarget()]);

    port.emitMessage({ type: "assistant.selectTarget", targetId: "target-1" });
    await flushAsyncWork();

    expect(server.getSnapshot().selectedTargetId).toBe("target-1");
    expect(storage.values.get("selectedTargetId")).toBe("target-1");
    expect(port.postedMessages.at(-1)).toEqual({ type: "assistant.snapshot", state: server.getSnapshot() });
  });

  it("removes persisted selectedTargetId when assistant.selectTarget clears the target", async () => {
    const { server, storage, brokerClients } = createServer();
    const port = new FakePort();
    await server.start();
    server.connectPort(port);
    brokerClients[0]?.emitTargets([createTarget()]);

    port.emitMessage({ type: "assistant.selectTarget", targetId: "target-1" });
    await flushAsyncWork();
    port.emitMessage({ type: "assistant.selectTarget", targetId: undefined });
    await flushAsyncWork();

    expect(server.getSnapshot().selectedTargetId).toBeUndefined();
    expect(storage.values.get("selectedTargetId")).toBeUndefined();
    expect(storage.removedKeys).toContain("selectedTargetId");
  });

  it("removes ports that throw on postMessage and continues broadcasting", async () => {
    const { server, brokerClients } = createServer();
    const throwingPort = new FakePort();
    const healthyPort = new FakePort();
    throwingPort.throwOnPost = true;
    await server.start();

    expect(() => server.connectPort(throwingPort)).not.toThrow();
    server.connectPort(healthyPort);

    brokerClients[0]?.emitTargets([createTarget()]);

    expect(healthyPort.postedMessages.at(-1)).toEqual({ type: "assistant.snapshot", state: server.getSnapshot() });
    expect(healthyPort.postedMessages).toHaveLength(2);
    expect(throwingPort.postedMessages).toHaveLength(0);
  });

  it("records a Russian diagnostic without rolling back in-memory selection when storage fails", async () => {
    const { server, storage, diagnostics, brokerClients } = createServer();
    const port = new FakePort();
    storage.setError = new Error("disk full");
    await server.start();
    server.connectPort(port);
    brokerClients[0]?.emitTargets([createTarget()]);

    port.emitMessage({ type: "assistant.selectTarget", targetId: "target-1" });
    await flushAsyncWork();

    expect(server.getSnapshot().selectedTargetId).toBe("target-1");
    expect(diagnostics).toEqual([
      {
        phase: "assistant.selectTarget",
        message: "Не удалось сохранить выбранную цель Pi: disk full",
      },
    ]);
  });

  it("keeps selection and does not reject async work when persistence and diagnostic recording fail", async () => {
    const { server, storage, brokerClients } = createServer({
      recordDiagnostic: async () => {
        throw new Error("diagnostic unavailable");
      },
    });
    const port = new FakePort();
    storage.setError = new Error("disk full");
    await server.start();
    server.connectPort(port);
    brokerClients[0]?.emitTargets([createTarget()]);

    expect(() => port.emitMessage({ type: "assistant.selectTarget", targetId: "target-1" })).not.toThrow();
    await expect(flushAsyncWork()).resolves.toBeUndefined();

    expect(server.getSnapshot().selectedTargetId).toBe("target-1");
  });
});
