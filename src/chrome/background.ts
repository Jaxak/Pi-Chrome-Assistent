import {
  DEFAULT_BROKER_HOST,
  DEFAULT_BROKER_PORT,
  PROTOCOL_VERSION,
} from "../shared/constants";
import {
  BROWSER_TOKEN_STORAGE_KEY,
  clearBrowserToken,
  ensureBrowserToken,
  getBrowserAuthState,
  regenerateBrowserToken,
} from "./browserToken";
import {
  createRequestId,
  parseProtocolEnvelope,
  validateSelectionPayload,
  type BrowserClientSendSelectionPayload,
  type DeliveryResult,
  type ProtocolEnvelope,
  type SelectionPayload,
  type TargetMetadata,
} from "../shared/protocol";
import {
  appendDiagnostic,
  chromeStorageAdapter,
  clearDiagnostics,
  listDiagnostics,
  type StorageAdapter,
} from "./diagnostics";
import { BackgroundAssistantStateServer } from "./backgroundStateServer";

const storage = chromeStorageAdapter();
const stateServer = new BackgroundAssistantStateServer({
  storage,
  startDomPicker: (input) => startDomPicker(input, { storage }),
});
const SELECTED_TARGET_STORAGE_KEY = "selectedTargetId";
const BROKER_URL = `ws://${DEFAULT_BROKER_HOST}:${DEFAULT_BROKER_PORT}`;
const SOCKET_CONNECTING = 0;
const SOCKET_OPEN = 1;

export const DEFAULT_BROKER_OPEN_TIMEOUT_MS = 1_000;
export const DEFAULT_BROKER_RESPONSE_TIMEOUT_MS = 5_000;

type BrokerSocketEventName = "open" | "message" | "error" | "close";
type BrokerSocketEventListener = (event?: { data?: string }) => void;

export interface BrokerSocket {
  readyState: number;
  send(data: string): void;
  close(): void;
  addEventListener(
    eventName: BrokerSocketEventName,
    listener: BrokerSocketEventListener,
    options?: { once?: boolean },
  ): void;
  removeEventListener(eventName: BrokerSocketEventName, listener: BrokerSocketEventListener): void;
}

export type BrokerWebSocketFactory = (url: string) => BrokerSocket;

export type BrokerRequestOptions = {
  brokerUrl?: string;
  openTimeoutMs?: number;
  responseTimeoutMs?: number;
  webSocketFactory?: BrokerWebSocketFactory;
  requestIdFactory?: () => string;
};

export type BackgroundMessageListenerDependencies = BrokerRequestOptions & {
  storage?: StorageAdapter;
  getActiveTab?: () => Promise<chrome.tabs.Tab | undefined>;
  now?: () => number;
};

export type StartDomPickerInput = {
  targetId?: string;
  tabId?: number;
};

export type StartDomPickerDependencies = {
  storage?: StorageAdapter;
  now?: () => number;
};

export type BackgroundMessageListener = (
  message: unknown,
  sender: chrome.runtime.MessageSender,
  sendResponse: (response?: unknown) => void,
) => boolean;

type SidePanelChromeApi = {
  action: {
    onClicked: {
      addListener(listener: (tab: chrome.tabs.Tab) => void): void;
    };
  };
  sidePanel: {
    setPanelBehavior(options: { openPanelOnActionClick: boolean }): Promise<void>;
    open(options: { windowId: number }): Promise<void>;
  };
};

function createBrowserWebSocket(url: string): BrokerSocket {
  return new WebSocket(url) as unknown as BrokerSocket;
}

function getActiveTab(): Promise<chrome.tabs.Tab | undefined> {
  return chrome.tabs.query({ active: true, currentWindow: true }).then((tabs) => tabs[0]);
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error && error.message.length > 0 ? error.message : String(error);
}

export function canInjectIntoTabUrl(url: string | undefined): boolean {
  return typeof url === "string" && /^https?:\/\//i.test(url);
}

function closeSocket(socket: BrokerSocket): void {
  if (socket.readyState === SOCKET_CONNECTING || socket.readyState === SOCKET_OPEN) {
    socket.close();
  }
}

function clearTimer(timerId: ReturnType<typeof setTimeout> | undefined): void {
  if (timerId !== undefined) {
    clearTimeout(timerId);
  }
}

function sendEnvelope(
  socket: BrokerSocket,
  envelope: {
    type: ProtocolEnvelope["type"];
    requestId?: string;
    payload?: unknown;
  },
): void {
  socket.send(
    JSON.stringify({
      version: PROTOCOL_VERSION,
      type: envelope.type,
      requestId: envelope.requestId,
      payload: envelope.payload,
    }),
  );
}

async function recordDiagnostic(
  diagnosticStorage: StorageAdapter,
  now: () => number,
  phase: string,
  error: unknown,
): Promise<string> {
  const message = getErrorMessage(error);

  await appendDiagnostic(diagnosticStorage, {
    timestamp: now(),
    phase,
    message,
  });

  return message;
}

async function getStoredString(
  diagnosticStorage: StorageAdapter,
  key: string,
): Promise<string | undefined> {
  const value = await diagnosticStorage.get<unknown>(key);
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

async function maybePersistBrokerSettings(
  diagnosticStorage: StorageAdapter,
  message: {
    targetId?: unknown;
  },
): Promise<void> {
  if (typeof message.targetId === "string" && message.targetId.trim().length > 0) {
    await diagnosticStorage.set(SELECTED_TARGET_STORAGE_KEY, message.targetId.trim());
  }
}

export async function startDomPicker(
  input: StartDomPickerInput,
  dependencies: StartDomPickerDependencies = {},
): Promise<{ ok?: boolean; error?: string }> {
  const backgroundStorage = dependencies.storage ?? storage;
  const now = dependencies.now ?? Date.now;
  const tabId = typeof input.tabId === "number" && Number.isInteger(input.tabId)
    ? input.tabId
    : undefined;

  if (tabId === undefined) {
    return { ok: false, error: "Не удалось определить вкладку для DOM picker." };
  }

  const targetId = typeof input.targetId === "string" && input.targetId.trim().length > 0
    ? input.targetId.trim()
    : undefined;

  if (!targetId) {
    return { ok: false, error: "Не выбрана цель Pi для DOM picker." };
  }

  try {
    const tab = await chrome.tabs.get(tabId);

    if (!canInjectIntoTabUrl(tab.url)) {
      const userMessage = "DOM picker можно запускать только на обычных http/https страницах.";
      await recordDiagnostic(
        backgroundStorage,
        now,
        "startDomPicker",
        `${userMessage} URL: ${tab.url ?? "неизвестен"}`,
      );
      return { ok: false, error: userMessage };
    }

    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ["contentScript.js"],
      });
    } catch (error) {
      const errorMessage = await recordDiagnostic(backgroundStorage, now, "startDomPicker", error);
      return { ok: false, error: `Не удалось запустить DOM picker: ${errorMessage}` };
    }

    const pickerResponse = (await chrome.tabs.sendMessage(tabId, {
      type: "startDomPicker",
      targetId,
    })) as { ok?: boolean; error?: unknown } | undefined;

    if (pickerResponse?.ok === false) {
      return {
        ok: false,
        error:
          typeof pickerResponse.error === "string" && pickerResponse.error.length > 0
            ? pickerResponse.error
            : "Не удалось запустить DOM picker.",
      };
    }

    console.info("DOM picker placeholder requested for tab", tabId);
    return { ok: true };
  } catch (error) {
    const errorMessage = await recordDiagnostic(backgroundStorage, now, "startDomPicker", error);
    return { ok: false, error: `Не удалось запустить DOM picker: ${errorMessage}` };
  }
}

type BrokerResponse<TPayload> = {
  type: ProtocolEnvelope["type"];
  payload: TPayload;
};

type BrokerRequestDescriptor<TPayload> = {
  type: ProtocolEnvelope["type"];
  payload?: unknown;
  accept: (envelope: ProtocolEnvelope) => BrokerResponse<TPayload> | null;
};

type ResolvedBrokerRequestOptions = {
  brokerUrl: string;
  openTimeoutMs: number;
  responseTimeoutMs: number;
  webSocketFactory: BrokerWebSocketFactory;
  requestIdFactory: () => string;
};

function resolveBrokerRequestOptions(options: BrokerRequestOptions = {}): ResolvedBrokerRequestOptions {
  return {
    brokerUrl: options.brokerUrl ?? BROKER_URL,
    openTimeoutMs: options.openTimeoutMs ?? DEFAULT_BROKER_OPEN_TIMEOUT_MS,
    responseTimeoutMs: options.responseTimeoutMs ?? DEFAULT_BROKER_RESPONSE_TIMEOUT_MS,
    webSocketFactory: options.webSocketFactory ?? createBrowserWebSocket,
    requestIdFactory: options.requestIdFactory ?? createRequestId,
  };
}

async function openBrokerSocket(options: ResolvedBrokerRequestOptions): Promise<BrokerSocket> {
  const socket = options.webSocketFactory(options.brokerUrl);

  try {
    await new Promise<void>((resolve, reject) => {
      let timeoutId: ReturnType<typeof setTimeout> | undefined;

      const cleanup = () => {
        clearTimer(timeoutId);
        socket.removeEventListener("open", onOpen);
        socket.removeEventListener("error", onError);
        socket.removeEventListener("close", onClose);
      };

      const onOpen = () => {
        cleanup();
        resolve();
      };
      const onError = () => {
        cleanup();
        reject(new Error(`Unable to connect to broker at ${options.brokerUrl}`));
      };
      const onClose = () => {
        cleanup();
        reject(new Error(`Broker closed before request started: ${options.brokerUrl}`));
      };
      const onTimeout = () => {
        cleanup();
        closeSocket(socket);
        reject(new Error(`Broker connection timed out: ${options.brokerUrl}`));
      };

      timeoutId = setTimeout(onTimeout, options.openTimeoutMs);
      socket.addEventListener("open", onOpen, { once: true });
      socket.addEventListener("error", onError, { once: true });
      socket.addEventListener("close", onClose, { once: true });
    });

    return socket;
  } catch (error) {
    closeSocket(socket);
    throw error;
  }
}

async function sendBrokerRequestOverSocket<TPayload>(
  socket: BrokerSocket,
  request: BrokerRequestDescriptor<TPayload>,
  options: ResolvedBrokerRequestOptions,
  authenticatedToken?: string,
): Promise<TPayload> {
  return new Promise<TPayload>((resolve, reject) => {
    const requestId = options.requestIdFactory();
    const authRequestId = authenticatedToken ? options.requestIdFactory() : undefined;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;

    const cleanup = () => {
      clearTimer(timeoutId);
      socket.removeEventListener("message", onMessage);
      socket.removeEventListener("error", onError);
      socket.removeEventListener("close", onClose);
    };

    const onError = () => {
      cleanup();
      reject(new Error(`Broker request failed: ${request.type}`));
    };

    const onClose = () => {
      cleanup();
      reject(new Error(`Broker closed during request: ${request.type}`));
    };

    const onTimeout = () => {
      cleanup();
      closeSocket(socket);
      reject(new Error(`Broker response timed out during ${request.type}`));
    };

    const onMessage = (event?: { data?: string }) => {
      if (typeof event?.data !== "string") {
        return;
      }

      const envelope = parseProtocolEnvelope(event.data);

      if (!envelope) {
        return;
      }

      if (envelope.requestId === authRequestId && envelope.type === "client.error") {
        cleanup();
        reject(new Error(getProtocolErrorMessage(envelope.payload, "client.hello")));
        return;
      }

      if (envelope.requestId !== requestId) {
        return;
      }

      if (envelope.type === "client.error") {
        cleanup();
        reject(new Error(getProtocolErrorMessage(envelope.payload, request.type)));
        return;
      }

      const accepted = request.accept(envelope);

      if (!accepted) {
        return;
      }

      cleanup();
      resolve(accepted.payload);
    };

    timeoutId = setTimeout(onTimeout, options.responseTimeoutMs);
    socket.addEventListener("message", onMessage);
    socket.addEventListener("error", onError, { once: true });
    socket.addEventListener("close", onClose, { once: true });

    if (authenticatedToken) {
      sendEnvelope(socket, {
        type: "client.hello",
        requestId: authRequestId,
        payload: {
          token: authenticatedToken,
        },
      });
    }

    sendEnvelope(socket, {
      type: request.type,
      requestId,
      payload: request.payload,
    });
  });
}

export async function brokerRequest<TPayload>(
  request: BrokerRequestDescriptor<TPayload>,
  options: BrokerRequestOptions = {},
): Promise<TPayload> {
  const resolvedOptions = resolveBrokerRequestOptions(options);
  const socket = await openBrokerSocket(resolvedOptions);

  try {
    return await sendBrokerRequestOverSocket(socket, request, resolvedOptions);
  } finally {
    closeSocket(socket);
  }
}

async function authenticatedBrokerRequest<TPayload>(
  token: string,
  request: BrokerRequestDescriptor<TPayload>,
  options: BrokerRequestOptions = {},
): Promise<TPayload> {
  const resolvedOptions = resolveBrokerRequestOptions(options);
  const socket = await openBrokerSocket(resolvedOptions);

  try {
    return await sendBrokerRequestOverSocket(socket, request, resolvedOptions, token);
  } finally {
    closeSocket(socket);
  }
}

function getProtocolErrorMessage(payload: unknown, phase: string): string {
  const error = (payload as { error?: unknown } | undefined)?.error;
  return typeof error === "string" && error.length > 0
    ? error
    : `Broker returned an error during ${phase}`;
}

async function listBrokerTargets(
  browserToken: string,
  options: BrokerRequestOptions = {},
): Promise<TargetMetadata[]> {
  const payload = await authenticatedBrokerRequest<{ targets?: unknown }>(
    browserToken,
    {
      type: "client.listTargets",
      accept: (envelope) => {
        if (envelope.type !== "client.targets") {
          return null;
        }

        return {
          type: envelope.type,
          payload: (envelope.payload as { targets?: unknown } | undefined) ?? {},
        };
      },
    },
    options,
  );

  const targets = payload.targets;

  if (!Array.isArray(targets)) {
    return [];
  }

  return targets.filter(isTargetMetadata);
}

async function deliverSelection(
  browserToken: string,
  targetId: string,
  selection: SelectionPayload,
  options: BrokerRequestOptions = {},
): Promise<DeliveryResult> {
  const payload = await authenticatedBrokerRequest<DeliveryResult>(
    browserToken,
    {
      type: "client.sendSelection",
      payload: {
        token: browserToken,
        targetId,
        selection,
      } satisfies BrowserClientSendSelectionPayload,
      accept: (envelope) => {
        if (envelope.type !== "client.sendResult") {
          return null;
        }

        const resultPayload = envelope.payload as { ok?: unknown; error?: unknown } | undefined;

        return {
          type: envelope.type,
          payload: {
            ok: resultPayload?.ok === true,
            ...(typeof resultPayload?.error === "string" ? { error: resultPayload.error } : {}),
          },
        };
      },
    },
    options,
  );

  return payload;
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

export function configureSidePanelOnActionClick(chromeApi: SidePanelChromeApi = chrome): void {
  void chromeApi.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch((error: unknown) => {
      console.warn("Не удалось настроить открытие side panel по клику на иконку", error);
    });

  chromeApi.action.onClicked.addListener((tab) => {
    const windowId = tab.windowId;

    if (typeof windowId !== "number") {
      return;
    }

    void chromeApi.sidePanel.open({ windowId });
  });
}

export function createBackgroundMessageListener(
  dependencies: BackgroundMessageListenerDependencies = {},
): BackgroundMessageListener {
  const backgroundStorage = dependencies.storage ?? storage;
  const now = dependencies.now ?? Date.now;
  const activeTabGetter = dependencies.getActiveTab ?? getActiveTab;
  const brokerRequestOptions: BrokerRequestOptions = {
    brokerUrl: dependencies.brokerUrl,
    openTimeoutMs: dependencies.openTimeoutMs,
    responseTimeoutMs: dependencies.responseTimeoutMs,
    webSocketFactory: dependencies.webSocketFactory,
    requestIdFactory: dependencies.requestIdFactory,
  };

  return (
    message: unknown,
    _sender: chrome.runtime.MessageSender,
    sendResponse: (response?: unknown) => void,
  ) => {
    const requestMessage = message && typeof message === "object"
      ? (message as {
          type?: unknown;
          token?: unknown;
          targetId?: unknown;
          selection?: unknown;
          phase?: unknown;
          message?: unknown;
          url?: unknown;
          tabId?: unknown;
        })
      : {};

    if (requestMessage.type === "ping") {
      sendResponse({ ok: true, source: "background" });
      return false;
    }

    if (requestMessage.type === "startDomPicker") {
      void startDomPicker(
        {
          targetId: typeof requestMessage.targetId === "string" ? requestMessage.targetId : undefined,
          tabId: typeof requestMessage.tabId === "number" ? requestMessage.tabId : undefined,
        },
        { storage: backgroundStorage, now },
      ).then(sendResponse);

      return true;
    }

    if (requestMessage.type === "getBrowserAuthState") {
      void (async () => {
        try {
          const browserToken = await ensureBrowserToken(backgroundStorage);
          sendResponse({
            ok: true,
            browserToken,
            tokenConfigured: true,
          });
        } catch (error) {
          const errorMessage = await recordDiagnostic(backgroundStorage, now, "getBrowserAuthState", error);
          sendResponse({
            ok: false,
            error: errorMessage,
            tokenConfigured: false,
          });
        }
      })();

      return true;
    }

    if (requestMessage.type === "regenerateBrowserToken") {
      void (async () => {
        try {
          const browserToken = await regenerateBrowserToken(backgroundStorage);
          sendResponse({
            ok: true,
            browserToken,
            tokenConfigured: true,
          });
        } catch (error) {
          const errorMessage = await recordDiagnostic(backgroundStorage, now, "regenerateBrowserToken", error);
          sendResponse({
            ok: false,
            error: errorMessage,
            tokenConfigured: false,
          });
        }
      })();

      return true;
    }

    if (requestMessage.type === "clearBrowserToken") {
      void (async () => {
        try {
          await clearBrowserToken(backgroundStorage);
          sendResponse({
            ok: true,
            ...(await getBrowserAuthState(backgroundStorage)),
          });
        } catch (error) {
          const errorMessage = await recordDiagnostic(backgroundStorage, now, "clearBrowserToken", error);
          sendResponse({
            ok: false,
            error: errorMessage,
            tokenConfigured: false,
          });
        }
      })();

      return true;
    }

    if (requestMessage.type === "listTargets") {
      void (async () => {
        try {
          await maybePersistBrokerSettings(backgroundStorage, requestMessage);
          const selectedTargetId = await getStoredString(backgroundStorage, SELECTED_TARGET_STORAGE_KEY);
          const browserToken = await getStoredString(backgroundStorage, BROWSER_TOKEN_STORAGE_KEY);

          if (!browserToken) {
            throw new Error("No browser token configured in chrome.storage.local");
          }

          const targets = await listBrokerTargets(browserToken, brokerRequestOptions);

          sendResponse({
            ok: true,
            targets,
            selectedTargetId,
            tokenConfigured: true,
          });
        } catch (error) {
          const errorMessage = await recordDiagnostic(backgroundStorage, now, "listTargets", error);
          const selectedTargetId = await getStoredString(backgroundStorage, SELECTED_TARGET_STORAGE_KEY);
          const browserToken = await getStoredString(backgroundStorage, BROWSER_TOKEN_STORAGE_KEY);

          sendResponse({
            ok: false,
            error: errorMessage,
            targets: [],
            selectedTargetId,
            tokenConfigured: browserToken !== undefined,
          });
        }
      })();

      return true;
    }

    if (requestMessage.type === "sendSelection") {
      void (async () => {
        try {
          await maybePersistBrokerSettings(backgroundStorage, requestMessage);

          const selectionValidation = validateSelectionPayload(requestMessage.selection);

          if (!selectionValidation.ok) {
            sendResponse({ ok: false, error: selectionValidation.error });
            return;
          }

          const browserToken = await getStoredString(backgroundStorage, BROWSER_TOKEN_STORAGE_KEY);

          if (!browserToken) {
            throw new Error("No browser token configured in chrome.storage.local");
          }

          const targetId =
            (typeof requestMessage.targetId === "string" && requestMessage.targetId.trim().length > 0
              ? requestMessage.targetId.trim()
              : await getStoredString(backgroundStorage, SELECTED_TARGET_STORAGE_KEY));

          if (!targetId) {
            throw new Error("No selected target configured in chrome.storage.local");
          }

          await backgroundStorage.set(SELECTED_TARGET_STORAGE_KEY, targetId);

          const result = await deliverSelection(
            browserToken,
            targetId,
            requestMessage.selection as SelectionPayload,
            brokerRequestOptions,
          );

          if (!result.ok) {
            await recordDiagnostic(
              backgroundStorage,
              now,
              "sendSelection",
              result.error ?? "Selection delivery failed",
            );
          }

          sendResponse(result);
        } catch (error) {
          const errorMessage = await recordDiagnostic(backgroundStorage, now, "sendSelection", error);
          sendResponse({ ok: false, error: errorMessage });
        }
      })();

      return true;
    }

    if (requestMessage.type === "pickerDiagnostic") {
      void (async () => {
        if (
          typeof requestMessage.phase !== "string" ||
          requestMessage.phase.length === 0 ||
          typeof requestMessage.message !== "string" ||
          requestMessage.message.length === 0
        ) {
          sendResponse({ ok: false, error: "Invalid pickerDiagnostic message" });
          return;
        }

        const diagnosticMessage =
          typeof requestMessage.url === "string" && requestMessage.url.length > 0
            ? `${requestMessage.message} (${requestMessage.url})`
            : requestMessage.message;

        await appendDiagnostic(backgroundStorage, {
          timestamp: now(),
          phase: `picker:${requestMessage.phase}`,
          message: diagnosticMessage,
        });

        sendResponse({ ok: true });
      })();

      return true;
    }

    if (requestMessage.type === "getDiagnostics") {
      void (async () => {
        const diagnostics = await listDiagnostics(backgroundStorage);
        sendResponse({ ok: true, diagnostics });
      })();

      return true;
    }

    if (requestMessage.type === "clearDiagnostics") {
      void (async () => {
        await clearDiagnostics(backgroundStorage);
        sendResponse({ ok: true });
      })();

      return true;
    }

    return false;
  };
}

if (typeof chrome !== "undefined") {
  chrome.runtime.onInstalled.addListener(() => {
    console.info("Pi Chrome Assistent background service worker installed");
  });

  configureSidePanelOnActionClick();
  chrome.runtime.onConnect.addListener((port) => {
    if (port.name === "sidepanel") {
      void stateServer.start().catch((error: unknown) => {
        console.warn("Не удалось запустить сервер состояния ассистента", error);
      });
      stateServer.connectPort(port);
    }
  });
  chrome.runtime.onMessage.addListener(createBackgroundMessageListener());
}
