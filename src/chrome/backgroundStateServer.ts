import type { ChatEvent, DeliveryResult, TargetMetadata, TargetModelSummary, TargetRuntimeState } from "../shared/protocol";
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
import { appendDiagnostic, chromeStorageAdapter, listDiagnostics, type DiagnosticEntry } from "./diagnostics";

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
  setTargetModel?(input: { targetId?: string; provider: string; modelId: string }): boolean;
};

export type BackgroundStateServerBrokerClientOptions = {
  browserToken: string;
  selectedTargetId?: string;
  onTargets?: (targets: TargetMetadata[]) => void;
  onChatEvent?: (event: ChatEvent) => void;
  onRuntimeState?: (state: TargetRuntimeState) => void;
  onAvailableModels?: (models: TargetModelSummary[], targetId: string) => void;
  onModelSetResult?: (result: DeliveryResult) => void;
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

export type BackgroundStateServerListTargets = (browserToken: string) => Promise<{
  ok: boolean;
  targets: TargetMetadata[];
  error?: string;
}>;

export type BackgroundAssistantStateServerDependencies = {
  storage?: BackgroundStateServerStorage;
  runtimeClock?: () => number;
  brokerClientFactory?: (options: BackgroundStateServerBrokerClientOptions) => BackgroundStateServerBrokerClient;
  recordDiagnostic?: (diagnostic: BackgroundStateServerDiagnostic) => Promise<void> | void;
  tokenHelpers?: BackgroundStateServerTokenHelpers;
  startDomPicker?: BackgroundStateServerStartDomPicker;
  listTargets?: BackgroundStateServerListTargets;
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
  private readonly listTargetsCommand: BackgroundStateServerListTargets | undefined;
  private readonly ports = new Map<ChromeRuntimePortLike, ConnectedPort>();
  private state: BackgroundAssistantState = createInitialAssistantState();
  private brokerClient: BackgroundStateServerBrokerClient | undefined;
  private preferredSelectedTargetId: string | undefined;
  private started = false;
  private startupGeneration = 0;
  private brokerGeneration = 0;
  private sessionsRefreshPending = false;

  constructor(dependencies: BackgroundAssistantStateServerDependencies = {}) {
    this.storage = dependencies.storage ?? chromeStorageAdapter();
    this.runtimeClock = dependencies.runtimeClock ?? Date.now;
    this.brokerClientFactory = dependencies.brokerClientFactory ?? ((options) => new BrokerClient({
      browserToken: options.browserToken,
      selectedTargetId: options.selectedTargetId,
      onTargets: options.onTargets,
      onChatEvent: options.onChatEvent,
      onRuntimeState: options.onRuntimeState,
      onAvailableModels: options.onAvailableModels,
      onModelSetResult: options.onModelSetResult,
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
    this.listTargetsCommand = dependencies.listTargets;
  }

  connectPort(port: ChromeRuntimePortLike): void {
    const isFirstPort = this.ports.size === 0;
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

    // Автоматически запрашиваем сессии при открытии панели (если токен уже готов и есть listTargets)
    if (isFirstPort && this.state.auth.browserToken !== undefined && this.listTargetsCommand) {
      this.refreshSessionsViaListTargets();
    }
  }

  async start(): Promise<void> {
    if (this.started) {
      return;
    }

    this.started = true;
    const startupGeneration = ++this.startupGeneration;

    try {
      await this.restorePreferredSelectedTargetId(startupGeneration);

      if (!this.started || startupGeneration !== this.startupGeneration) {
        return;
      }

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

    if (command?.type === "assistant.model.set") {
      const provider = typeof (command as { provider?: unknown }).provider === "string"
        ? (command as { provider: string }).provider
        : "";
      const modelId = typeof (command as { modelId?: unknown }).modelId === "string"
        ? (command as { modelId: string }).modelId
        : "";
      this.setTargetModel(provider, modelId);
      return;
    }

    if (command?.type === "assistant.diagnostics.refresh") {
      void this.refreshDiagnostics();
      return;
    }

    if (command?.type === "assistant.sessions.refresh") {
      this.handleSessionsRefresh();
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

  private setTargetModel(provider: string, modelId: string): void {
    const normalizedProvider = provider.trim();
    const normalizedModelId = modelId.trim();

    if (!this.state.selectedTargetId || normalizedProvider.length === 0 || normalizedModelId.length === 0) {
      this.applyState({
        kind: "runtime_updated",
        runtime: {
          modelMutationPending: false,
          modelError: "Выберите модель и сессию Pi.",
        },
      });
      return;
    }

    this.applyState({
      kind: "runtime_updated",
      runtime: {
        modelMutationPending: true,
        modelError: undefined,
      },
    });

    const sent = this.brokerClient?.setTargetModel?.({
      targetId: this.state.selectedTargetId,
      provider: normalizedProvider,
      modelId: normalizedModelId,
    }) === true;

    if (!sent) {
      this.applyState({
        kind: "runtime_updated",
        runtime: {
          modelMutationPending: false,
          modelError: "Pi недоступен",
        },
      });
    }
  }

  private selectTarget(targetId: string | undefined): void {
    this.preferredSelectedTargetId = undefined;
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
    let nextState = reduceAssistantState(this.state, { kind: "targets_updated", targets });
    const preferredSelectedTargetId = this.preferredSelectedTargetId;

    if (
      nextState.selectedTargetId === undefined &&
      preferredSelectedTargetId !== undefined &&
      targets.some((target) => target.targetId === preferredSelectedTargetId)
    ) {
      nextState = reduceAssistantState(nextState, { kind: "select_target", targetId: preferredSelectedTargetId });
      this.preferredSelectedTargetId = undefined;
    }

    // Сбрасываем targetsStale и targetsRefreshPending при получении targets
    nextState = reduceAssistantState(nextState, {
      kind: "connection_updated",
      connection: { targetsStale: false, targetsRefreshPending: false },
    });

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

    if (
      !connectionState.online &&
      isConnecting &&
      !this.state.connection.brokerOnline &&
      !this.state.connection.connecting &&
      this.state.connection.lastError
    ) {
      return;
    }

    const isBrowserAuthError = connectionState.statusText.startsWith("Браузер не авторизован");
    const tokenConfigured = this.state.auth.tokenConfigured;
    const targetsStale = this.state.targets.length > 0;
    const targetsRefreshPending = this.state.connection.targetsRefreshPending;
    const connection = connectionState.online
      ? {
          brokerOnline: true,
          bridgeOnline: true,
          connecting: false,
          tokenConfigured,
          browserAuthorized: true,
          targetsStale: this.state.connection.targetsStale && this.state.targets.length > 0,
          targetsRefreshPending,
          lastError: undefined,
        }
      : isConnecting
        ? {
            brokerOnline: false,
            bridgeOnline: false,
            connecting: true,
            tokenConfigured,
            browserAuthorized: undefined,
            targetsStale,
            targetsRefreshPending,
            lastError: undefined,
          }
        : isBrowserAuthError
          ? {
              brokerOnline: false,
              bridgeOnline: false,
              connecting: false,
              tokenConfigured,
              browserAuthorized: false,
              targetsStale,
              targetsRefreshPending: false,
              lastError: connectionState.statusText,
            }
          : {
              brokerOnline: false,
              bridgeOnline: false,
              connecting: false,
              tokenConfigured,
              browserAuthorized: undefined,
              targetsStale,
              targetsRefreshPending: false,
              lastError: connectionState.statusText,
            };

    const currentConnection = this.state.connection;
    if (
      currentConnection.brokerOnline === connection.brokerOnline &&
      currentConnection.bridgeOnline === connection.bridgeOnline &&
      currentConnection.connecting === connection.connecting &&
      currentConnection.tokenConfigured === connection.tokenConfigured &&
      currentConnection.browserAuthorized === connection.browserAuthorized &&
      currentConnection.targetsStale === connection.targetsStale &&
      currentConnection.targetsRefreshPending === connection.targetsRefreshPending &&
      currentConnection.lastError === connection.lastError
    ) {
      return;
    }

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

  private async refreshDiagnostics(): Promise<void> {
    try {
      const diagnostics = await listDiagnostics(this.storage);
      this.state = reduceAssistantState(
        reduceAssistantState(this.state, { kind: "diagnostics_updated", diagnostics }),
        { kind: "epoch_incremented" },
      );
      this.broadcastSnapshot();
    } catch (error) {
      await this.recordDiagnostic(
        "assistant.diagnostics.refresh",
        `Не удалось обновить диагностику: ${getErrorMessage(error)}`,
      );
    }
  }

  private handleSessionsRefresh(): void {
    // Если есть listTargets, используем одноразовый запрос
    if (this.listTargetsCommand) {
      this.refreshSessionsViaListTargets();
      return;
    }
    // Иначе используем старый метод через BrokerClient
    this.refreshSessionsViaBrokerClient();
  }

  private refreshSessionsViaListTargets(): void {
    const browserToken = this.state.auth.browserToken;

    if (browserToken === undefined) {
      this.applyMissingBrowserTokenStateIfNeeded();
      return;
    }

    if (this.sessionsRefreshPending) {
      return;
    }

    this.sessionsRefreshPending = true;
    const liveBrokerOnline = this.state.connection.brokerOnline && this.state.connection.bridgeOnline;
    this.state = reduceAssistantState(
      reduceAssistantState(this.state, {
        kind: "connection_updated",
        connection: {
          brokerOnline: liveBrokerOnline,
          bridgeOnline: liveBrokerOnline,
          connecting: !liveBrokerOnline,
          tokenConfigured: true,
          browserAuthorized: liveBrokerOnline ? true : undefined,
          targetsStale: this.state.targets.length > 0,
          targetsRefreshPending: true,
          lastError: undefined,
        },
      }),
      { kind: "epoch_incremented" },
    );
    this.broadcastSnapshot();

    void this.executeListTargets(browserToken);
  }

  private async executeListTargets(browserToken: string): Promise<void> {
    try {
      const result = await this.listTargetsCommand!(browserToken);
      this.sessionsRefreshPending = false;

      if (!result.ok) {
        const isBrowserAuthError = result.error?.startsWith("Браузер не авторизован") ?? false;
        this.applyState({
          kind: "connection_updated",
          connection: {
            brokerOnline: false,
            bridgeOnline: false,
            connecting: false,
            tokenConfigured: true,
            browserAuthorized: isBrowserAuthError ? false : undefined,
            targetsStale: this.state.targets.length > 0,
            targetsRefreshPending: false,
            lastError: result.error ?? "Pi недоступен",
          },
        });
        return;
      }

      this.applyTargets(result.targets);
      this.applyState({
        kind: "connection_updated",
        connection: {
          brokerOnline: true,
          bridgeOnline: true,
          connecting: false,
          tokenConfigured: true,
          browserAuthorized: true,
          targetsStale: false,
          targetsRefreshPending: false,
          lastError: undefined,
        },
      });
    } catch (error) {
      this.sessionsRefreshPending = false;
      const errorMessage = getErrorMessage(error);
      await this.recordDiagnostic("assistant.sessions.refresh", errorMessage);
      this.applyState({
        kind: "connection_updated",
        connection: {
          brokerOnline: false,
          bridgeOnline: false,
          connecting: false,
          tokenConfigured: true,
          browserAuthorized: undefined,
          targetsStale: this.state.targets.length > 0,
          targetsRefreshPending: false,
          lastError: "Pi недоступен",
        },
      });
    }
  }

  private refreshSessionsViaBrokerClient(): void {
    const browserToken = this.state.auth.browserToken;

    if (browserToken === undefined) {
      this.applyMissingBrowserTokenStateIfNeeded();
      return;
    }

    this.brokerClient?.close();
    this.brokerClient = undefined;
    this.brokerGeneration += 1;

    this.state = reduceAssistantState(
      reduceAssistantState(this.state, {
        kind: "connection_updated",
        connection: {
          brokerOnline: false,
          bridgeOnline: false,
          connecting: true,
          tokenConfigured: true,
          browserAuthorized: undefined,
          targetsStale: this.state.targets.length > 0,
          targetsRefreshPending: true,
          lastError: undefined,
        },
      }),
      { kind: "epoch_incremented" },
    );

    this.connectBrokerClient(browserToken);
    this.broadcastSnapshot();
  }

  private connectBrokerClient(browserToken: string): void {
    const brokerGeneration = this.brokerGeneration;
    this.brokerClient = this.brokerClientFactory({
      browserToken,
      selectedTargetId: this.state.selectedTargetId,
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
      onRuntimeState: (runtimeState) => {
        if (this.brokerGeneration !== brokerGeneration || runtimeState.targetId !== this.state.selectedTargetId) {
          return;
        }
        this.applyState({
          kind: "runtime_updated",
          runtime: { selectedTargetRuntime: runtimeState },
        });
      },
      onAvailableModels: (models, targetId) => {
        if (this.brokerGeneration !== brokerGeneration || targetId !== this.state.selectedTargetId) {
          return;
        }
        this.applyState({
          kind: "runtime_updated",
          runtime: { availableModels: models },
        });
      },
      onModelSetResult: (result) => {
        if (this.brokerGeneration !== brokerGeneration) {
          return;
        }
        this.applyState({
          kind: "runtime_updated",
          runtime: {
            modelMutationPending: false,
            modelError: result.ok ? undefined : (result.error ?? "Не удалось сменить модель."),
          },
        });
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
            targetsStale: this.state.targets.length > 0,
            targetsRefreshPending: this.listTargetsCommand === undefined,
            lastError: undefined,
          }
        : {
            brokerOnline: false,
            bridgeOnline: false,
            connecting: false,
            tokenConfigured: false,
            browserAuthorized: undefined,
            targetsStale: false,
            targetsRefreshPending: false,
            lastError: "Токен браузера не настроен. Сгенерируйте токен для подключения к Pi.",
          },
    });

    if (!tokenConfigured) {
      nextState = reduceAssistantState(nextState, { kind: "targets_updated", targets: [] });
      nextState = reduceAssistantState(nextState, { kind: "select_target", targetId: undefined });
    }

    this.state = reduceAssistantState(nextState, { kind: "epoch_incremented" });

    if (nextToken !== undefined) {
      this.connectBrokerClient(nextToken);
    }

    this.broadcastSnapshot();

    // Автоматически запрашиваем сессии при установке токена, если есть порты и listTargets.
    // One-shot refresh дополняет live BrokerClient, но не заменяет его: chat/subscription
    // требуют постоянного канала к broker.
    if (nextToken !== undefined && this.listTargetsCommand && this.ports.size > 0) {
      this.refreshSessionsViaListTargets();
    }
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

  private async restorePreferredSelectedTargetId(startupGeneration: number): Promise<void> {
    try {
      const storedSelectedTargetId = await this.storage.get<unknown>(SELECTED_TARGET_STORAGE_KEY);

      if (!this.started || startupGeneration !== this.startupGeneration) {
        return;
      }

      this.preferredSelectedTargetId = typeof storedSelectedTargetId === "string" && storedSelectedTargetId.trim().length > 0
        ? storedSelectedTargetId.trim()
        : undefined;
    } catch (error) {
      await this.recordDiagnostic(
        "assistant.start",
        `Не удалось восстановить выбранную цель Pi: ${getErrorMessage(error)}`,
      );
    }
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
