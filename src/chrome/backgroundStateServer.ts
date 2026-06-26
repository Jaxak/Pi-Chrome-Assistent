import type { ChatEvent, TargetMetadata } from "../shared/protocol";
import {
  createInitialAssistantState,
  isChatSendDisabled,
  reduceAssistantState,
  type BackgroundAssistantState,
} from "./assistantState";
import { BrokerClient, type BrokerConnectionState } from "./brokerClient";
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
  sendChatMessage?(message: string): boolean;
};

export type BackgroundStateServerBrokerClientOptions = {
  browserToken: string;
  selectedTargetId?: string;
  onTargets?: (targets: TargetMetadata[]) => void;
  onChatEvent?: (event: ChatEvent) => void;
  onConnectionState?: (state: BrokerConnectionState) => void;
};

export type BackgroundStateServerTokenHelpers = {
  ensureBrowserToken(storage: BackgroundStateServerStorage): Promise<string>;
  getBrowserAuthState(storage: BackgroundStateServerStorage): Promise<BrowserAuthState>;
  regenerateBrowserToken(storage: BackgroundStateServerStorage): Promise<string>;
  clearBrowserToken(storage: BackgroundStateServerStorage): Promise<void>;
};

export type BackgroundStateServerStartDomPicker = (input: {
  targetId: string;
  tabId?: number;
}) => Promise<{ ok?: boolean; error?: string }>;

export type BackgroundAssistantStateServerDependencies = {
  storage?: BackgroundStateServerStorage;
  runtimeClock?: () => number;
  brokerClientFactory?: (options: BackgroundStateServerBrokerClientOptions) => BackgroundStateServerBrokerClient;
  recordDiagnostic?: (diagnostic: BackgroundStateServerDiagnostic) => Promise<void> | void;
  tokenHelpers?: BackgroundStateServerTokenHelpers;
  startDomPicker?: BackgroundStateServerStartDomPicker;
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
  private readonly startDomPickerCommand: BackgroundStateServerStartDomPicker | undefined;
  private readonly ports = new Map<ChromeRuntimePortLike, ConnectedPort>();
  private state: BackgroundAssistantState = createInitialAssistantState();
  private brokerClient: BackgroundStateServerBrokerClient | undefined;
  private started = false;
  private startupGeneration = 0;
  private brokerGeneration = 0;

  constructor(dependencies: BackgroundAssistantStateServerDependencies = {}) {
    this.storage = dependencies.storage ?? chromeStorageAdapter();
    this.runtimeClock = dependencies.runtimeClock ?? Date.now;
    this.brokerClientFactory = dependencies.brokerClientFactory ?? ((options) => new BrokerClient({
      browserToken: options.browserToken,
      selectedTargetId: options.selectedTargetId,
      onTargets: options.onTargets,
      onChatEvent: options.onChatEvent,
      onConnectionState: options.onConnectionState,
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
    this.startDomPickerCommand = dependencies.startDomPicker;
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
        const userMessage = "Не удалось подготовить токен браузера. Попробуйте ещё раз.";
        this.state = reduceAssistantState(this.state, {
          kind: "connection_updated",
          connection: {
            brokerOnline: false,
            bridgeOnline: false,
            connecting: false,
            tokenConfigured: false,
            browserAuthorized: undefined,
            lastError: userMessage,
          },
        });
        await this.handleAuthCommandError(
          "assistant.start",
          userMessage,
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

    if (command?.type === "assistant.sendChatMessage") {
      const messageText = typeof (command as { message?: unknown }).message === "string"
        ? (command as { message: string }).message
        : "";
      this.sendChatMessage(messageText);
      return;
    }

    if (command?.type === "assistant.startDomPicker") {
      const commandTabId = (command as { tabId?: unknown }).tabId;
      const tabId = typeof commandTabId === "number" && Number.isInteger(commandTabId)
        ? commandTabId
        : undefined;
      void this.startDomPicker(tabId).catch((error) => {
        void this.handleDomPickerError(
          `Не удалось запустить DOM picker: ${getErrorMessage(error)}`,
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

  private async startDomPicker(tabId: number | undefined): Promise<void> {
    const targetId = this.state.selectedTargetId;

    if (!targetId) {
      await this.handleDomPickerError("Выберите цель Pi для DOM picker.");
      return;
    }

    if (!this.startDomPickerCommand) {
      await this.handleDomPickerError("DOM picker недоступен в фоновом сервисе.");
      return;
    }

    const response = await this.startDomPickerCommand({ targetId, tabId });

    if (response?.ok) {
      return;
    }

    await this.handleDomPickerError(response?.error ?? "Не удалось запустить DOM picker.");
  }

  private async handleDomPickerError(message: string): Promise<void> {
    this.applyState({
      kind: "chat_event",
      event: {
        kind: "error",
        message,
        timestamp: this.runtimeClock(),
      },
    });
    await this.recordDiagnostic("assistant.startDomPicker", message);
  }

  private sendChatMessage(message: string): void {
    const text = message.trim();

    if (text.length === 0) {
      return;
    }

    if (isChatSendDisabled(this.state, text)) {
      if (!this.state.selectedTargetId) {
        this.applyState({
          kind: "chat_event",
          event: {
            kind: "error",
            message: "Выберите цель Pi для отправки сообщения.",
            timestamp: this.runtimeClock(),
          },
        });
        return;
      }

      if (this.state.chat.sending || this.state.chat.agentBusy) {
        return;
      }

      this.applyState({
        kind: "chat_event",
        event: {
          kind: "error",
          message: "Pi недоступен",
          timestamp: this.runtimeClock(),
        },
      });
      return;
    }

    this.applyState({
      kind: "chat_event",
      event: {
        kind: "user_message",
        text,
        timestamp: this.runtimeClock(),
      },
    });

    if (this.brokerClient?.sendChatMessage?.(text) !== true) {
      this.applyState({
        kind: "chat_event",
        event: {
          kind: "error",
          message: "Pi недоступен",
          timestamp: this.runtimeClock(),
        },
      });
    }
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

  private applyTargets(targets: TargetMetadata[]): void {
    const previousSelectedTargetId = this.state.selectedTargetId;
    const nextState = reduceAssistantState(this.state, { kind: "targets_updated", targets });

    this.state = reduceAssistantState(nextState, { kind: "epoch_incremented" });

    if (this.state.selectedTargetId !== undefined || this.state.selectedTargetId !== previousSelectedTargetId) {
      this.brokerClient?.setSelectedTargetId?.(this.state.selectedTargetId);
    }

    if (this.state.selectedTargetId !== previousSelectedTargetId) {
      void this.persistSelectedTargetId(this.state.selectedTargetId).catch(() => undefined);
    }

    this.broadcastSnapshot();
  }

  private applyBrokerConnectionState(connectionState: BrokerConnectionState): void {
    const isConnecting = connectionState.statusText === "Подключаемся к Pi…";
    const isBrowserAuthError = connectionState.statusText.startsWith("Браузер не авторизован");
    const tokenConfigured = this.state.auth.tokenConfigured;
    const connection = connectionState.online
      ? {
          brokerOnline: true,
          bridgeOnline: true,
          connecting: false,
          tokenConfigured,
          browserAuthorized: true,
          lastError: undefined,
        }
      : isConnecting
        ? {
            brokerOnline: false,
            bridgeOnline: false,
            connecting: true,
            tokenConfigured,
            browserAuthorized: undefined,
            lastError: undefined,
          }
        : isBrowserAuthError
          ? {
              brokerOnline: false,
              bridgeOnline: false,
              connecting: false,
              tokenConfigured,
              browserAuthorized: false,
              lastError: connectionState.statusText,
            }
          : {
              brokerOnline: false,
              bridgeOnline: false,
              connecting: false,
              tokenConfigured,
              browserAuthorized: undefined,
              lastError: connectionState.statusText,
            };

    this.applyState({ kind: "connection_updated", connection });
  }

  private async refreshBrowserToken(): Promise<void> {
    await this.runAuthMutation(
      "assistant.auth.refresh",
      "Не удалось обновить токен браузера. Попробуйте ещё раз.",
      async () => {
        const authState = await this.tokenHelpers.getBrowserAuthState(this.storage);
        this.applyBrowserToken(authState.browserToken);
      },
    );
  }

  private async regenerateBrowserToken(): Promise<void> {
    await this.runAuthMutation(
      "assistant.auth.regenerateToken",
      "Не удалось сгенерировать новый токен браузера. Попробуйте ещё раз.",
      async () => {
        const browserToken = await this.tokenHelpers.regenerateBrowserToken(this.storage);
        this.applyBrowserToken(browserToken);
      },
    );
  }

  private async clearBrowserToken(): Promise<void> {
    await this.runAuthMutation(
      "assistant.auth.clearToken",
      "Не удалось удалить токен браузера. Попробуйте ещё раз.",
      async () => {
        await this.tokenHelpers.clearBrowserToken(this.storage);
        this.applyBrowserToken(undefined);
      },
    );
  }

  private async runAuthMutation(phase: string, userMessage: string, operation: () => Promise<void>): Promise<void> {
    if (!this.beginAuthMutation()) {
      return;
    }

    try {
      await operation();
      this.finishAuthMutationSuccessIfNeeded();
    } catch (error) {
      await this.handleAuthCommandError(phase, userMessage, error);
    }
  }

  private beginAuthMutation(): boolean {
    if (this.state.auth.mutationPending) {
      return false;
    }

    this.state = reduceAssistantState(
      reduceAssistantState(this.state, {
        kind: "auth_updated",
        auth: {
          mutationPending: true,
          error: undefined,
        },
      }),
      { kind: "epoch_incremented" },
    );
    this.broadcastSnapshot();
    return true;
  }

  private finishAuthMutationSuccessIfNeeded(): void {
    if (!this.state.auth.mutationPending) {
      return;
    }

    this.state = reduceAssistantState(
      reduceAssistantState(this.state, {
        kind: "auth_updated",
        auth: {
          mutationPending: false,
          error: undefined,
        },
      }),
      { kind: "epoch_incremented" },
    );
    this.broadcastSnapshot();
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
      if (nextToken === undefined) {
        this.applyMissingBrowserTokenStateIfNeeded();
      }

      return;
    }

    this.brokerClient?.close();
    this.brokerClient = undefined;
    this.brokerGeneration += 1;

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
            brokerOnline: false,
            bridgeOnline: false,
            connecting: true,
            tokenConfigured: true,
            browserAuthorized: undefined,
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
      const brokerGeneration = this.brokerGeneration;
      this.brokerClient = this.brokerClientFactory({
        browserToken: nextToken,
        onTargets: (targets) => {
          if (this.brokerGeneration !== brokerGeneration) {
            return;
          }

          this.applyTargets(targets);
        },
        onChatEvent: (event) => {
          if (this.brokerGeneration !== brokerGeneration) {
            return;
          }

          this.applyState({ kind: "chat_event", event });
        },
        onConnectionState: (connectionState) => {
          if (this.brokerGeneration !== brokerGeneration) {
            return;
          }

          this.applyBrokerConnectionState(connectionState);
        },
      });
      this.brokerClient.connect();

      if (this.state.selectedTargetId !== undefined) {
        this.brokerClient.setSelectedTargetId?.(this.state.selectedTargetId);
      }
    }

    this.broadcastSnapshot();
  }

  private applyMissingBrowserTokenStateIfNeeded(): void {
    const missingTokenConnection = {
      brokerOnline: false,
      bridgeOnline: false,
      connecting: false,
      tokenConfigured: false,
      browserAuthorized: undefined,
      lastError: "Токен браузера не настроен. Сгенерируйте токен для подключения к Pi.",
    };

    const connection = this.state.connection;
    const alreadyApplied = connection.brokerOnline === missingTokenConnection.brokerOnline
      && connection.bridgeOnline === missingTokenConnection.bridgeOnline
      && connection.connecting === missingTokenConnection.connecting
      && connection.tokenConfigured === missingTokenConnection.tokenConfigured
      && connection.browserAuthorized === missingTokenConnection.browserAuthorized
      && connection.lastError === missingTokenConnection.lastError;

    if (alreadyApplied) {
      return;
    }

    this.state = reduceAssistantState(
      reduceAssistantState(this.state, {
        kind: "connection_updated",
        connection: missingTokenConnection,
      }),
      { kind: "epoch_incremented" },
    );
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
