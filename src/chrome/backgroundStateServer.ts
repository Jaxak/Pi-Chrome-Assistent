import type { TargetMetadata } from "../shared/protocol";
import {
  createInitialAssistantState,
  reduceAssistantState,
  type BackgroundAssistantState,
} from "./assistantState";
import { BrokerClient } from "./brokerClient";
import {
  clearBrowserToken,
  ensureBrowserToken,
  getBrowserAuthState,
  regenerateBrowserToken,
  type BrowserAuthState,
} from "./browserToken";
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
  browserToken: string;
  selectedTargetId?: string;
  onTargets?: (targets: TargetMetadata[]) => void;
};

export type BackgroundStateServerTokenHelpers = {
  ensureBrowserToken(storage: BackgroundStateServerStorage): Promise<string>;
  getBrowserAuthState(storage: BackgroundStateServerStorage): Promise<BrowserAuthState>;
  regenerateBrowserToken(storage: BackgroundStateServerStorage): Promise<string>;
  clearBrowserToken(storage: BackgroundStateServerStorage): Promise<void>;
};

export type BackgroundAssistantStateServerDependencies = {
  storage?: BackgroundStateServerStorage;
  runtimeClock?: () => number;
  brokerClientFactory?: (options: BackgroundStateServerBrokerClientOptions) => BackgroundStateServerBrokerClient;
  recordDiagnostic?: (diagnostic: BackgroundStateServerDiagnostic) => Promise<void> | void;
  tokenHelpers?: BackgroundStateServerTokenHelpers;
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
  private readonly tokenHelpers: BackgroundStateServerTokenHelpers;
  private readonly ports = new Map<ChromeRuntimePortLike, ConnectedPort>();
  private state: BackgroundAssistantState = createInitialAssistantState();
  private brokerClient: BackgroundStateServerBrokerClient | undefined;
  private started = false;
  private startupGeneration = 0;

  constructor(dependencies: BackgroundAssistantStateServerDependencies = {}) {
    this.storage = dependencies.storage ?? chromeStorageAdapter();
    this.runtimeClock = dependencies.runtimeClock ?? Date.now;
    this.brokerClientFactory = dependencies.brokerClientFactory ?? ((options) => new BrokerClient({
      browserToken: options.browserToken,
      selectedTargetId: options.selectedTargetId,
      onTargets: options.onTargets,
    }));
    this.recordDiagnosticEntry = dependencies.recordDiagnostic ?? (async (diagnostic) => {
      await appendDiagnostic(this.storage, diagnostic);
    });
    this.tokenHelpers = dependencies.tokenHelpers ?? {
      ensureBrowserToken,
      getBrowserAuthState,
      regenerateBrowserToken,
      clearBrowserToken,
    };
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
    const startupGeneration = ++this.startupGeneration;

    try {
      const browserToken = await this.tokenHelpers.ensureBrowserToken(this.storage);

      if (!this.started || startupGeneration !== this.startupGeneration) {
        return;
      }

      this.applyBrowserToken(browserToken);
    } catch (error) {
      if (startupGeneration === this.startupGeneration) {
        this.started = false;
        await this.handleAuthCommandError(
          "assistant.start",
          "Не удалось подготовить токен браузера. Попробуйте ещё раз.",
          error,
        );
      }

      throw error;
    }
  }

  stop(): void {
    this.started = false;
    this.startupGeneration += 1;
    this.applyBrowserToken(undefined);

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

    if (command?.type === "assistant.auth.refresh") {
      void this.refreshBrowserToken().catch((error) => {
        void this.handleAuthCommandError(
          "assistant.auth.refresh",
          "Не удалось обновить токен браузера. Попробуйте ещё раз.",
          error,
        );
      });
      return;
    }

    if (command?.type === "assistant.auth.regenerateToken") {
      void this.regenerateBrowserToken().catch((error) => {
        void this.handleAuthCommandError(
          "assistant.auth.regenerateToken",
          "Не удалось сгенерировать новый токен браузера. Попробуйте ещё раз.",
          error,
        );
      });
      return;
    }

    if (command?.type === "assistant.auth.clearToken") {
      void this.clearBrowserToken().catch((error) => {
        void this.handleAuthCommandError(
          "assistant.auth.clearToken",
          "Не удалось удалить токен браузера. Попробуйте ещё раз.",
          error,
        );
      });
      return;
    }

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
    void this.persistSelectedTargetId(this.state.selectedTargetId).catch(() => undefined);
  }

  private async refreshBrowserToken(): Promise<void> {
    const authState = await this.tokenHelpers.getBrowserAuthState(this.storage);
    this.applyBrowserToken(authState.browserToken);
  }

  private async regenerateBrowserToken(): Promise<void> {
    const browserToken = await this.tokenHelpers.regenerateBrowserToken(this.storage);
    this.applyBrowserToken(browserToken);
  }

  private async clearBrowserToken(): Promise<void> {
    await this.tokenHelpers.clearBrowserToken(this.storage);
    this.applyBrowserToken(undefined);
  }

  private async handleAuthCommandError(phase: string, userMessage: string, error: unknown): Promise<void> {
    this.state = reduceAssistantState(
      reduceAssistantState(this.state, {
        kind: "auth_updated",
        auth: {
          mutationPending: false,
          error: userMessage,
        },
      }),
      { kind: "epoch_incremented" },
    );
    this.broadcastSnapshot();

    await this.recordDiagnostic(phase, `${userMessage} ${getErrorMessage(error)}`);
  }

  private applyBrowserToken(nextToken: string | undefined): void {
    const currentToken = this.state.auth.browserToken;

    if (currentToken === nextToken) {
      return;
    }

    this.brokerClient?.close();
    this.brokerClient = undefined;

    const tokenConfigured = nextToken !== undefined;
    let nextState = reduceAssistantState(this.state, {
      kind: "auth_updated",
      auth: {
        browserToken: nextToken,
        tokenConfigured,
        mutationPending: false,
        error: undefined,
      },
    });

    nextState = reduceAssistantState(nextState, {
      kind: "connection_updated",
      connection: tokenConfigured
        ? {
            tokenConfigured: true,
            connecting: true,
            lastError: undefined,
          }
        : {
            brokerOnline: false,
            bridgeOnline: false,
            connecting: false,
            tokenConfigured: false,
            browserAuthorized: undefined,
            lastError: "Токен браузера не настроен. Сгенерируйте токен для подключения к Pi.",
          },
    });

    if (!tokenConfigured) {
      nextState = reduceAssistantState(nextState, { kind: "targets_updated", targets: [] });
      nextState = reduceAssistantState(nextState, { kind: "select_target", targetId: undefined });
    }

    this.state = reduceAssistantState(nextState, { kind: "epoch_incremented" });

    if (nextToken !== undefined) {
      this.brokerClient = this.brokerClientFactory({
        browserToken: nextToken,
        selectedTargetId: this.state.selectedTargetId,
        onTargets: (targets) => {
          this.applyState({ kind: "targets_updated", targets });
        },
      });
      this.brokerClient.connect();
    }

    this.broadcastSnapshot();
  }

  private async persistSelectedTargetId(selectedTargetId: string | undefined): Promise<void> {
    try {
      if (selectedTargetId === undefined) {
        await this.storage.remove(SELECTED_TARGET_STORAGE_KEY);
      } else {
        await this.storage.set(SELECTED_TARGET_STORAGE_KEY, selectedTargetId);
      }
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

    try {
      await this.recordDiagnosticEntry(diagnostic);
    } catch {
      // Diagnostic persistence is best-effort: the in-memory diagnostic above is enough for this lifecycle.
    }
  }

  private applyState(event: Parameters<typeof reduceAssistantState>[1]): void {
    this.state = reduceAssistantState(reduceAssistantState(this.state, event), { kind: "epoch_incremented" });
    this.broadcastSnapshot();
  }

  private broadcastSnapshot(): void {
    for (const { port } of Array.from(this.ports.values())) {
      this.postSnapshot(port);
    }
  }

  private postSnapshot(port: ChromeRuntimePortLike): void {
    try {
      port.postMessage({
        type: "assistant.snapshot",
        state: this.getSnapshot(),
      });
    } catch {
      this.removePort(port);
    }
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
