import type { TargetMetadata } from "../shared/protocol";
import {
  createInitialAssistantState,
  reduceAssistantState,
  type BackgroundAssistantState,
} from "./assistantState";
import { BrokerClient } from "./brokerClient";
import { appendDiagnostic, chromeStorageAdapter, type DiagnosticEntry } from "./diagnostics";

const SELECTED_TARGET_STORAGE_KEY = "selectedTargetId";

export type ChromeRuntimePortLike = {
  name?: string;
  postMessage(message: unknown): void;
  onMessage: {
    addListener(listener: (message: unknown) => void): void;
    removeListener?(listener: (message: unknown) => void): void;
  };
  onDisconnect: {
    addListener(listener: () => void): void;
    removeListener?(listener: () => void): void;
  };
};

export type BackgroundStateServerStorage = {
  get<T>(key: string): Promise<T | undefined>;
  set<T>(key: string, value: T): Promise<void>;
  remove(key: string): Promise<void>;
};

export type BackgroundStateServerDiagnostic = {
  timestamp: number;
  phase: string;
  message: string;
};

export type BackgroundStateServerBrokerClient = {
  connect(): void;
  close(): void;
  setSelectedTargetId?(targetId: string | undefined): void;
};

export type BackgroundStateServerBrokerClientOptions = {
  selectedTargetId?: string;
  onTargets?: (targets: TargetMetadata[]) => void;
};

export type BackgroundAssistantStateServerDependencies = {
  storage?: BackgroundStateServerStorage;
  runtimeClock?: () => number;
  brokerClientFactory?: (options: BackgroundStateServerBrokerClientOptions) => BackgroundStateServerBrokerClient;
  recordDiagnostic?: (diagnostic: BackgroundStateServerDiagnostic) => Promise<void> | void;
};

type ConnectedPort = {
  port: ChromeRuntimePortLike;
  onMessage: (message: unknown) => void;
  onDisconnect: () => void;
};

export class BackgroundAssistantStateServer {
  private readonly storage: BackgroundStateServerStorage;
  private readonly runtimeClock: () => number;
  private readonly brokerClientFactory: (options: BackgroundStateServerBrokerClientOptions) => BackgroundStateServerBrokerClient;
  private readonly recordDiagnosticEntry: (diagnostic: BackgroundStateServerDiagnostic) => Promise<void> | void;
  private readonly ports = new Map<ChromeRuntimePortLike, ConnectedPort>();
  private state: BackgroundAssistantState = createInitialAssistantState();
  private brokerClient: BackgroundStateServerBrokerClient | undefined;
  private started = false;

  constructor(dependencies: BackgroundAssistantStateServerDependencies = {}) {
    this.storage = dependencies.storage ?? chromeStorageAdapter();
    this.runtimeClock = dependencies.runtimeClock ?? Date.now;
    this.brokerClientFactory = dependencies.brokerClientFactory ?? ((options) => new BrokerClient({
      browserToken: "",
      selectedTargetId: options.selectedTargetId,
      onTargets: options.onTargets,
    }));
    this.recordDiagnosticEntry = dependencies.recordDiagnostic ?? (async (diagnostic) => {
      await appendDiagnostic(this.storage, diagnostic);
    });
  }

  connectPort(port: ChromeRuntimePortLike): void {
    const onMessage = (message: unknown) => {
      this.handlePortMessage(message);
    };
    const onDisconnect = () => {
      this.removePort(port);
    };

    this.ports.set(port, { port, onMessage, onDisconnect });
    port.onMessage.addListener(onMessage);
    port.onDisconnect.addListener(onDisconnect);
    this.postSnapshot(port);
  }

  async start(): Promise<void> {
    if (this.started) {
      return;
    }

    this.started = true;
    this.brokerClient = this.brokerClientFactory({
      selectedTargetId: this.state.selectedTargetId,
      onTargets: (targets) => {
        this.applyState({ kind: "targets_updated", targets });
      },
    });
    this.brokerClient.connect();
  }

  stop(): void {
    this.started = false;
    this.brokerClient?.close();
    this.brokerClient = undefined;

    for (const { port } of this.ports.values()) {
      this.removePort(port);
    }
  }

  getSnapshot(): BackgroundAssistantState {
    return structuredClone(this.state);
  }

  private handlePortMessage(message: unknown): void {
    const command = message && typeof message === "object"
      ? (message as { type?: unknown; targetId?: unknown })
      : undefined;

    if (command?.type !== "assistant.selectTarget") {
      return;
    }

    const targetId = typeof command.targetId === "string" && command.targetId.trim().length > 0
      ? command.targetId.trim()
      : undefined;

    this.selectTarget(targetId);
  }

  private selectTarget(targetId: string | undefined): void {
    const previousSelectedTargetId = this.state.selectedTargetId;
    const nextState = reduceAssistantState(this.state, { kind: "select_target", targetId });

    if (nextState.selectedTargetId === previousSelectedTargetId) {
      return;
    }

    this.state = reduceAssistantState(nextState, { kind: "epoch_incremented" });
    this.brokerClient?.setSelectedTargetId?.(this.state.selectedTargetId);
    this.broadcastSnapshot();
    void this.persistSelectedTargetId(this.state.selectedTargetId);
  }

  private async persistSelectedTargetId(selectedTargetId: string | undefined): Promise<void> {
    try {
      await this.storage.set(SELECTED_TARGET_STORAGE_KEY, selectedTargetId);
    } catch (error) {
      const message = `Не удалось сохранить выбранную цель Pi: ${getErrorMessage(error)}`;
      await this.recordDiagnostic("assistant.selectTarget", message);
    }
  }

  private async recordDiagnostic(phase: string, message: string): Promise<void> {
    const diagnostic: DiagnosticEntry = {
      timestamp: this.runtimeClock(),
      phase,
      message,
    };

    this.state = reduceAssistantState(
      reduceAssistantState(this.state, {
        kind: "diagnostics_updated",
        diagnostics: [...this.state.diagnostics, diagnostic],
      }),
      { kind: "epoch_incremented" },
    );
    this.broadcastSnapshot();
    await this.recordDiagnosticEntry(diagnostic);
  }

  private applyState(event: Parameters<typeof reduceAssistantState>[1]): void {
    this.state = reduceAssistantState(reduceAssistantState(this.state, event), { kind: "epoch_incremented" });
    this.broadcastSnapshot();
  }

  private broadcastSnapshot(): void {
    for (const { port } of this.ports.values()) {
      this.postSnapshot(port);
    }
  }

  private postSnapshot(port: ChromeRuntimePortLike): void {
    port.postMessage({
      type: "assistant.snapshot",
      state: this.getSnapshot(),
    });
  }

  private removePort(port: ChromeRuntimePortLike): void {
    const connectedPort = this.ports.get(port);

    if (!connectedPort) {
      return;
    }

    port.onMessage.removeListener?.(connectedPort.onMessage);
    port.onDisconnect.removeListener?.(connectedPort.onDisconnect);
    this.ports.delete(port);
  }
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error && error.message.length > 0 ? error.message : String(error);
}
