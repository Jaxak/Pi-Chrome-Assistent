import {
  appendDiagnostic,
  chromeStorageAdapter,
  clearDiagnostics,
  listDiagnostics,
  type StorageAdapter,
} from "./diagnostics";
import { BackgroundAssistantStateServer } from "./backgroundStateServer";
import type { SelectionPayload } from "../shared/protocol";

const storage = chromeStorageAdapter();

export type StartDomPickerInput = {
  tabId?: number;
};

export type StartDomPickerDependencies = {
  storage?: StorageAdapter;
  now?: () => number;
  getActiveTab?: () => Promise<chrome.tabs.Tab | undefined>;
};

export type BackgroundMessageListenerDependencies = {
  storage?: StorageAdapter;
  getActiveTab?: () => Promise<chrome.tabs.Tab | undefined>;
  now?: () => number;
  sendSelection?: (selection: SelectionPayload) => { ok: true } | { ok: false; error: string };
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

function getActiveTab(): Promise<chrome.tabs.Tab | undefined> {
  return chrome.tabs.query({ active: true, currentWindow: true }).then((tabs) => tabs[0]);
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error && error.message.length > 0 ? error.message : String(error);
}

export function canInjectIntoTabUrl(url: string | undefined): boolean {
  return typeof url === "string" && /^https?:\/\//i.test(url);
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

export async function startDomPicker(
  input: StartDomPickerInput,
  dependencies: StartDomPickerDependencies = {},
): Promise<{ ok?: boolean; error?: string }> {
  const backgroundStorage = dependencies.storage ?? storage;
  const now = dependencies.now ?? Date.now;
  const activeTabGetter = dependencies.getActiveTab;

  // Resolve initial tabId candidate
  let tabId: number | undefined =
    typeof input.tabId === "number" && Number.isInteger(input.tabId)
      ? input.tabId
      : undefined;

  if (tabId === undefined) {
    if (activeTabGetter) {
      const tab = await activeTabGetter();
      if (tab?.id === undefined) {
        return { ok: false, error: "Не удалось определить вкладку для DOM picker." };
      }
      tabId = tab.id;
    } else {
      return { ok: false, error: "Не удалось определить вкладку для DOM picker." };
    }
  }

  // Try the resolved tabId
  const result = await tryInjectDomPicker(
    tabId,
    backgroundStorage,
    now,
  );

  if (result.ok !== false) {
    return result;
  }

  // Fallback: if the primary tabId failed (invalid tab or non-injectable),
  // try active tab — but only if it differs from the one we already tried.
  if (activeTabGetter) {
    const fallbackTab = await activeTabGetter();
    if (fallbackTab?.id !== undefined && fallbackTab.id !== tabId) {
      return tryInjectDomPicker(
        fallbackTab.id,
        backgroundStorage,
        now,
      );
    }
  }

  return result;
}

async function tryInjectDomPicker(
  tabId: number,
  backgroundStorage: StorageAdapter,
  now: () => number,
): Promise<{ ok?: boolean; error?: string }> {
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
  const sendSelectionDep = dependencies.sendSelection;

  return (
    message: unknown,
    _sender: chrome.runtime.MessageSender,
    sendResponse: (response?: unknown) => void,
  ) => {
    const requestMessage = message && typeof message === "object"
      ? (message as {
          type?: unknown;
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
          tabId: typeof requestMessage.tabId === "number" ? requestMessage.tabId : undefined,
        },
        {
          storage: backgroundStorage,
          now,
          getActiveTab: dependencies.getActiveTab,
        },
      ).then(sendResponse);

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
          sendResponse({ ok: false, error: "Некорректное сообщение pickerDiagnostic" });
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

    if (requestMessage.type === "sendSelection") {
      const selection = (requestMessage as { selection?: unknown }).selection;
      if (selection && typeof selection === "object") {
        const result = sendSelectionDep
          ? sendSelectionDep(selection as SelectionPayload)
          : { ok: false, error: "Pi-сессия не подключена." };
        sendResponse(result);
      } else {
        sendResponse({ ok: false, error: "Некорректное сообщение sendSelection" });
      }
      return false;
    }

    return false;  };
}

// --- Module side effects: instantiate state server, wire up chrome listeners ---

const stateServer = new BackgroundAssistantStateServer({
  storage,
  startDomPicker: (input) => startDomPicker(input, { storage, getActiveTab }),
});

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

  chrome.runtime.onMessage.addListener(createBackgroundMessageListener({
    sendSelection: (selection) => stateServer.sendSelection(selection),
  }));
}
