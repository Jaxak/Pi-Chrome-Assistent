import { describe, expect, it, vi } from "vitest";

import type { TargetMetadata } from "../shared/protocol";
import {
  BackgroundAssistantStateServer,
  type BackgroundStateServerStorage,
  type ChromeRuntimePortLike,
} from "./backgroundStateServer";

class FakePort implements ChromeRuntimePortLike {
  readonly name = "sidepanel";
  readonly postedMessages: unknown[] = [];
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
    this.values.delete(key);
  }
}

type FakeBrokerClientOptions = {
  onTargets?: (targets: TargetMetadata[]) => void;
};

class FakeBrokerClient {
  constructor(private readonly options: FakeBrokerClientOptions) {}

  connect(): void {}
  close(): void {}

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
    ...overrides,
  });

  return { server, storage, diagnostics, brokerClients };
}

async function flushAsyncWork(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("BackgroundAssistantStateServer", () => {
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
});
