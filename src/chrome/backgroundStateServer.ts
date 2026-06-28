import type { DirectSessionSnapshot, PiMirrorEvent, SelectionPayload } from "../shared/protocol";
import {
  createInitialAssistantState,
  isChatSendDisabled,
  reduceAssistantState,
  type BackgroundAssistantState,
} from "./assistantState";
import { SessionClient, type SessionClientOptions, type SessionConnectionState } from "./sessionClient";
import {
  appendDiagnostic,
  chromeStorageAdapter,
  listDiagnostics,
  type DiagnosticEntry,
} from "./diagnostics";

const SESSION_PORT_STORAGE_KEY = "sessionPort";
const DEFAULT_DIRECT_SESSION_PORT = 31415;

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

export type BackgroundStateServerSessionClient = {
  connect(): void;
  close(): void;
  reconnectToPort?(port: number): void;
  sendChatMessage?(message: string): boolean;
  sendSelection?(selection: SelectionPayload): boolean;
  setModel?(input: { provider: string; modelId: string }): boolean;
};

export type BackgroundStateServerSessionClientOptions = {
  port: number;
  onSnapshot?: (snapshot: DirectSessionSnapshot) => void;
  onConnectionState?: (state: SessionConnectionState) => void;
  onSessionEvent?: (event: PiMirrorEvent) => void;
};

export type BackgroundAssistantStateServerDependencies = {
  storage?: BackgroundStateServerStorage;
  runtimeClock?: () => number;
  sessionClientFactory?: (options: BackgroundStateServerSessionClientOptions) => BackgroundStateServerSessionClient;
  recordDiagnostic?: (diagnostic: BackgroundStateServerDiagnostic) => Promise<void> | void;
  startDomPicker?: (input: { tabId?: number }) => Promise<{ ok?: boolean; error?: string }>;
  stopDomPicker?: () => Promise<void>;
};

type ConnectedPort = {
  port: ChromeRuntimePortLike;
  onMessage: (message: unknown) => void;
  onDisconnect: () => void;
};

export class BackgroundAssistantStateServer {
  private readonly storage: BackgroundStateServerStorage;
  private readonly runtimeClock: () => number;
  private readonly sessionClientFactory: (options: BackgroundStateServerSessionClientOptions) => BackgroundStateServerSessionClient;
  private readonly recordDiagnosticEntry: (diagnostic: BackgroundStateServerDiagnostic) => Promise<void> | void;
  private readonly startDomPickerCommand: ((input: { tabId?: number }) => Promise<{ ok?: boolean; error?: string }>) | undefined;
  private readonly stopDomPickerCommand: (() => Promise<void>) | undefined;
  private readonly ports = new Map<ChromeRuntimePortLike, ConnectedPort>();
  private state: BackgroundAssistantState = createInitialAssistantState();
  private sessionClient: BackgroundStateServerSessionClient | undefined;
  private started = false;

  constructor(dependencies: BackgroundAssistantStateServerDependencies = {}) {
    this.storage = dependencies.storage ?? chromeStorageAdapter();
    this.runtimeClock = dependencies.runtimeClock ?? Date.now;
    this.sessionClientFactory = dependencies.sessionClientFactory ?? ((options) => new SessionClient({
      port: options.port,
      onSnapshot: options.onSnapshot ?? (() => {}),
      onConnectionState: options.onConnectionState ?? (() => {}),
      onSessionEvent: options.onSessionEvent,
    }));
    this.recordDiagnosticEntry = dependencies.recordDiagnostic ?? (async (diagnostic) => {
      await appendDiagnostic(this.storage, diagnostic);
    });
    this.startDomPickerCommand = dependencies.startDomPicker;
    this.stopDomPickerCommand = dependencies.stopDomPicker;
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

    if (isFirstPort) {
      this.tryRestoreSavedPort();
    }
  }

  async start(): Promise<void> {
    if (this.started) {
      return;
    }

    this.started = true;
  }

  stop(): void {
    this.started = false;

    this.sessionClient?.close();
    this.sessionClient = undefined;

    for (const { port } of this.ports.values()) {
      this.removePort(port);
    }
  }

  getSnapshot(): BackgroundAssistantState {
    return structuredClone(this.state);
  }

  applySessionSnapshot(snapshot: DirectSessionSnapshot): void {
    this.applyState({ kind: "session_snapshot", snapshot });
  }

  sendSelection(selection: SelectionPayload): { ok: true } | { ok: false; error: string } {
    const sent = this.sessionClient?.sendSelection?.(selection);
    if (sent === true) {
      return { ok: true };
    }
    return { ok: false, error: "Pi-сессия не подключена." };
  }

  private handlePortMessage(message: unknown): void {
    const command = message && typeof message === "object"
      ? (message as { type?: unknown; port?: unknown; message?: unknown; provider?: unknown; modelId?: unknown; tabId?: unknown })
      : undefined;

    if (command?.type === "assistant.session.connect") {
      const portValue = (command as { port?: unknown }).port;
      const port = typeof portValue === "number" && Number.isInteger(portValue) ? portValue : undefined;
      this.handleSessionConnect(port);
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
      this.setModel(provider, modelId);
      return;
    }

    if (command?.type === "assistant.diagnostics.refresh") {
      void this.refreshDiagnostics();
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

    if (command?.type === "assistant.stopDomPicker") {
      void this.stopDomPicker();
      return;
    }
  }

  private handleSessionConnect(port: number | undefined): void {
    if (port === undefined || port < 1 || port > 65535) {
      this.applyState({
        kind: "connection_updated",
        connection: {
          online: false,
          connecting: false,
          lastError: "Введите порт от 1 до 65535.",
        },
      });
      return;
    }

    // Close existing session client
    this.sessionClient?.close();
    this.sessionClient = undefined;

    // Reset state to initial when connecting to a new session
    // This clears chat history from the previous session
    this.state = createInitialAssistantState();
    this.state.connection.configuredPort = port;
    this.state.connection.connecting = true;
    this.broadcastSnapshot();

    // Create new session client
    this.sessionClient = this.sessionClientFactory({
      port,
      onSnapshot: (snapshot) => {
        this.applyState({ kind: "session_snapshot", snapshot });
      },
      onConnectionState: (connectionState) => {
        this.applyConnectionState(connectionState);
      },
      onSessionEvent: (event) => {
        this.applyState({ kind: "session.event", event });
      },
    });

    this.sessionClient.connect();
    void this.persistSessionPort(port);
  }

  private applyConnectionState(connectionState: SessionConnectionState): void {
    const connection: Partial<BackgroundAssistantState["connection"]> = {
      online: connectionState.online,
      connecting: connectionState.connecting,
      lastError: connectionState.online
        ? undefined
        : (connectionState.statusText ?? this.state.connection.lastError),
    };

    this.applyState({ kind: "connection_updated", connection });

  }

  private sendChatMessage(message: string): void {
    const text = message.trim();

    if (text.length === 0) {
      return;
    }

    if (isChatSendDisabled(this.state, text)) {
      if (!this.state.connection.online) {
        this.applyState({
          kind: "chat_event",
          event: {
            kind: "error",
            message: "Pi-сессия не подключена.",
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

    if (this.sessionClient?.sendChatMessage?.(text) !== true) {
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

  private setModel(provider: string, modelId: string): void {
    const normalizedProvider = provider.trim();
    const normalizedModelId = modelId.trim();

    if (!this.state.connection.online || normalizedProvider.length === 0 || normalizedModelId.length === 0) {
      this.applyState({
        kind: "runtime_updated",
        runtime: {
          modelMutationPending: false,
          modelError: !this.state.connection.online
            ? "Pi-сессия не подключена."
            : "Выберите модель.",
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

    const sent = this.sessionClient?.setModel?.({
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

  private async startDomPicker(tabId: number | undefined): Promise<void> {
    if (!this.state.connection.online) {
      await this.handleDomPickerError("Pi-сессия не подключена.");
      return;
    }

    if (!this.startDomPickerCommand) {
      await this.handleDomPickerError("DOM picker недоступен в фоновом сервисе.");
      return;
    }

    const response = await this.startDomPickerCommand({ tabId });

    if (response?.ok) {
      return;
    }

    await this.handleDomPickerError(response?.error ?? "Не удалось запустить DOM picker.");
  }

  private async stopDomPicker(): Promise<void> {
    if (this.stopDomPickerCommand) {
      await this.stopDomPickerCommand();
      return;
    }
    // Fallback to direct Chrome API call for production
    try {
      const tab = (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
      if (tab?.id !== undefined) {
        await chrome.tabs.sendMessage(tab.id, { type: "stopDomPicker" });
      }
    } catch {
      // Best-effort: content script may not be loaded on the tab
    }
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

  private async refreshDiagnostics(): Promise<void> {
    try {
      const diagnostics = await listDiagnostics(this.storage);
      this.applyState({ kind: "diagnostics_updated", diagnostics });
    } catch (error) {
      await this.recordDiagnostic(
        "assistant.diagnostics.refresh",
        `Не удалось обновить диагностику: ${getErrorMessage(error)}`,
      );
    }
  }

  private async tryRestoreSavedPort(): Promise<void> {
    try {
      const savedPort = await this.storage.get<number>(SESSION_PORT_STORAGE_KEY);
      if (typeof savedPort === "number" && Number.isInteger(savedPort) && savedPort >= 1 && savedPort <= 65535) {
        // Only restore the port value in UI — do NOT auto-connect.
        // The user must click «Подключить» to establish a connection.
        this.applyState({
          kind: "connection_updated",
          connection: { configuredPort: savedPort },
        });
      }
    } catch {
      // Best-effort
    }
  }

  private async persistSessionPort(port: number): Promise<void> {
    try {
      await this.storage.set(SESSION_PORT_STORAGE_KEY, port);
    } catch {
      // Best-effort
    }
  }

  private async recordDiagnostic(phase: string, message: string): Promise<void> {
    const diagnostic: DiagnosticEntry = {
      timestamp: this.runtimeClock(),
      phase,
      message,
    };

    this.applyState({
      kind: "diagnostics_updated",
      diagnostics: [...this.state.diagnostics, diagnostic],
    });

    try {
      await this.recordDiagnosticEntry(diagnostic);
    } catch {
      // Diagnostic persistence is best-effort
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
