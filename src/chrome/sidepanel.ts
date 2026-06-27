import {
  isChatSendDisabled,
  type BackgroundAssistantState,
} from "./assistantState";
import type { DiagnosticEntry } from "./diagnostics";
import {
  createAgentWorkingElement,
  createChatMessageElement,
  updateAgentWorkingElement,
} from "./sidepanelRender";

type AssistantSnapshotMessage = { type: "assistant.snapshot"; state: BackgroundAssistantState };

type SidePanelTab = "assistant" | "sessions";

type SidePanelElements = {
  assistantTabButton: HTMLButtonElement | null;
  sessionsTabButton: HTMLButtonElement | null;
  devlogBackButton: HTMLButtonElement | null;
  assistantPanel: HTMLElement | null;
  sessionsPanel: HTMLElement | null;
  sendButton: HTMLButtonElement | null;
  chatInput: HTMLTextAreaElement | null;
  chatSendButton: HTMLButtonElement | null;
  messageList: HTMLElement | null;
  messagesScroll: HTMLElement | null;
  agentWorking: HTMLElement | null;
  headerMenuButton: HTMLButtonElement | null;
  headerMenu: HTMLElement | null;
  headerDevlogButton: HTMLButtonElement | null;
  composerMenuButton: HTMLButtonElement | null;
  composerMenu: HTMLElement | null;
  diagnosticsButton: HTMLButtonElement | null;
  diagnosticsOutput: HTMLElement | null;
  sessionPortInput: HTMLInputElement | null;
  connectSessionButton: HTMLButtonElement | null;
  sessionConnectionStatus: HTMLElement | null;
  modelButton: HTMLButtonElement | null;
  modelMenu: HTMLElement | null;
  contextUsage: HTMLElement | null;
};

const START_PICKER_PROMPT = "Выберите элемент на странице, чтобы отправить его в Pi.";
const SIDEPANEL_UNAVAILABLE_TEXT = "Состояние боковой панели недоступно.";
const SIDEPANEL_RECONNECTING_TEXT = "Переподключаем боковую панель…";
const SIDEPANEL_RECONNECT_DELAYS_MS = [250, 1000, 2000] as const;
const PORT_ERROR_TEXT = "Введите порт от 1 до 65535.";
const DEFAULT_PORT = 31415;

let assistantPort: chrome.runtime.Port | undefined;
let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
let reconnectAttempt = 0;
let currentSnapshot: BackgroundAssistantState | undefined;
let currentActiveTab: SidePanelTab = "assistant";
let userEditingPort = false;

function getSidePanelElements(): SidePanelElements {
  return {
    assistantTabButton: document.querySelector<HTMLButtonElement>("#tab-assistant"),
    sessionsTabButton: document.querySelector<HTMLButtonElement>("#tab-sessions"),
    devlogBackButton: document.querySelector<HTMLButtonElement>("#devlog-back-button"),
    assistantPanel: document.querySelector<HTMLElement>("#panel-assistant"),
    sessionsPanel: document.querySelector<HTMLElement>("#panel-sessions"),
    sendButton: document.querySelector<HTMLButtonElement>("#send-button"),
    chatInput: document.querySelector<HTMLTextAreaElement>("#chat-input"),
    chatSendButton: document.querySelector<HTMLButtonElement>("#chat-send-button"),
    messageList: document.querySelector<HTMLElement>("#message-list"),
    messagesScroll: document.querySelector<HTMLElement>("#messages-scroll"),
    agentWorking: document.querySelector<HTMLElement>("#agent-working"),
    headerMenuButton: document.querySelector<HTMLButtonElement>("#header-menu-button"),
    headerMenu: document.querySelector<HTMLElement>("#header-menu"),
    headerDevlogButton: document.querySelector<HTMLButtonElement>("#header-devlog-button"),
    composerMenuButton: document.querySelector<HTMLButtonElement>("#composer-menu-button"),
    composerMenu: document.querySelector<HTMLElement>("#composer-menu"),
    diagnosticsButton: document.querySelector<HTMLButtonElement>("#diagnostics-button"),
    diagnosticsOutput: document.querySelector<HTMLElement>("#diagnostics-output"),
    sessionPortInput: document.querySelector<HTMLInputElement>("#session-port-input"),
    connectSessionButton: document.querySelector<HTMLButtonElement>("#connect-session-button"),
    sessionConnectionStatus: document.querySelector<HTMLElement>("#session-connection-status"),
    modelButton: document.querySelector<HTMLButtonElement>("#model-button"),
    modelMenu: document.querySelector<HTMLElement>("#model-menu"),
    contextUsage: document.querySelector<HTMLElement>("#context-usage"),
  };
}

function setDiagnostics(elements: SidePanelElements, message: string): void {
  if (elements.diagnosticsOutput) {
    elements.diagnosticsOutput.textContent = message;
  }
}

function setBaseDiagnostics(elements: SidePanelElements, message: string): void {
  setDiagnostics(elements, message);
}

function setPickerErrorDiagnostics(elements: SidePanelElements, errorMessage: string): void {
  setDiagnostics(elements, `Ошибка DOM picker: ${errorMessage}`);
}

function setButtonDisabled(button: HTMLButtonElement | null, disabled: boolean): void {
  if (!button) {
    return;
  }

  button.disabled = disabled;
  button.setAttribute("aria-disabled", String(disabled));
}

function setMenuOpen(button: HTMLButtonElement | null, menu: HTMLElement | null, open: boolean): void {
  if (menu) {
    menu.hidden = !open;
  }

  if (button) {
    button.setAttribute("aria-expanded", String(open));
  }
}

function setPanelState(panel: HTMLElement | null, button: HTMLButtonElement | null, active: boolean): void {
  if (panel) {
    panel.hidden = !active;
  }

  if (button) {
    button.setAttribute("aria-selected", String(active));
  }
}

function postAssistantCommand(message: unknown): void {
  if (!assistantPort) {
    return;
  }

  try {
    assistantPort.postMessage(message);
  } catch {
    assistantPort = undefined;
  }
}

function getPortInputValue(elements: SidePanelElements): number | undefined {
  const raw = elements.sessionPortInput?.value?.trim();
  if (!raw) return undefined;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return undefined;
  return port;
}

function renderSessionConnection(elements: SidePanelElements, state: BackgroundAssistantState): void {
  const port = state.connection.configuredPort;

  // Update port input only if user is not actively editing
  if (elements.sessionPortInput && !userEditingPort) {
    elements.sessionPortInput.value = String(port);
  }

  // Determine status tone and text
  let tone: "warning" | "success" | "error" | "info";
  let statusText: string;

  if (state.connection.connecting) {
    tone = "info";
    statusText = `🔄 Подключаемся к 127.0.0.1:${port}…`;
  } else if (state.connection.online) {
    tone = "success";
    const sessionLabel = state.session
      ? `${state.session.alias ?? state.session.cwd.split("/").pop()} · `
      : "";
    statusText = `✅ ${sessionLabel}Подключено к 127.0.0.1:${port}`;
  } else if (state.connection.lastError) {
    tone = "error";
    statusText = `❌ ${state.connection.lastError}`;
  } else {
    tone = "warning";
    statusText = `⚠️ Введите порт Pi-сессии и нажмите «Подключить». `;
  }

  // Update connection status element
  if (elements.sessionConnectionStatus) {
    elements.sessionConnectionStatus.textContent = statusText;
    elements.sessionConnectionStatus.dataset.tone = tone;
  }

  updateDirectSendButtons(elements);
}

function updateDirectSendButtons(elements: SidePanelElements): void {
  const online = currentSnapshot?.connection.online ?? false;
  setButtonDisabled(elements.sendButton, !online);
}

let lastRenderedMessageCount = 0;
let lastRenderedMessageTimestamps: number[] = [];

function formatNumberRu(value: number): string {
  return new Intl.NumberFormat("ru-RU").format(value).replace(/\u00a0/g, " ");
}

function renderRuntimeInfo(elements: SidePanelElements): void {
  const runtime = currentSnapshot?.runtime;
  const model = runtime?.model;
  const modelLabel = model?.label ?? (model ? `${model.provider}/${model.id}` : "—");

  if (elements.modelButton) {
    elements.modelButton.textContent = runtime?.modelMutationPending ? "Меняем модель…" : `Модель: ${modelLabel}`;
    elements.modelButton.disabled = !currentSnapshot || runtime?.availableModels.length === 0 || runtime?.modelMutationPending === true;
    elements.modelButton.setAttribute("aria-disabled", String(elements.modelButton.disabled));
  }

  const usage = runtime?.contextUsage;
  if (elements.contextUsage) {
    if (runtime?.modelError) {
      elements.contextUsage.textContent = `Ошибка модели: ${runtime.modelError}`;
    } else if (usage) {
      elements.contextUsage.textContent = `Контекст: ${formatNumberRu(usage.tokens ?? 0)} / ${formatNumberRu(usage.maxTokens)} токенов · ${Math.round(usage.percent ?? 0)}%`;
    } else {
      elements.contextUsage.textContent = "Контекст: —";
    }
  }
}

function renderModelMenu(elements: SidePanelElements): void {
  if (!elements.modelMenu) {
    return;
  }

  const models = currentSnapshot?.runtime.availableModels ?? [];
  const fragment = document.createDocumentFragment();

  for (const model of models) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "model-menu__item";
    button.dataset.provider = model.provider;
    button.dataset.modelId = model.id;
    button.textContent = model.label ?? `${model.provider}/${model.id}`;
    button.addEventListener("click", () => {
      setMenuOpen(elements.modelButton, elements.modelMenu, false);
      postAssistantCommand({
        type: "assistant.model.set",
        provider: model.provider,
        modelId: model.id,
      });
    });
    fragment.append(button);
  }

  elements.modelMenu.replaceChildren(fragment);
}

function renderChat(elements: SidePanelElements): void {
  const chat = currentSnapshot?.chat;
  const messages = chat?.messages ?? [];

  if (elements.messageList) {
    const currentTimestamps = messages.map((m) => m.timestamp);
    const needsFullRender = messages.length !== lastRenderedMessageCount ||
      !currentTimestamps.every((ts, i) => ts === lastRenderedMessageTimestamps[i]);

    if (needsFullRender) {
      const fragment = document.createDocumentFragment();
      for (const message of messages) {
        fragment.append(createChatMessageElement(message));
      }
      elements.messageList.replaceChildren(fragment);
      lastRenderedMessageCount = messages.length;
      lastRenderedMessageTimestamps = currentTimestamps;

      if (elements.messagesScroll) {
        elements.messagesScroll.scrollTop = elements.messagesScroll.scrollHeight;
      }
    }
  }

  if (elements.agentWorking) {
    const busyLabel = chat?.busyLabel ?? "Агент работает в фоне…";
    const agentBusy = chat?.agentBusy ?? false;
    updateAgentWorkingElement(elements.agentWorking, busyLabel, agentBusy);
  }

  renderRuntimeInfo(elements);
  renderModelMenu(elements);
  updateChatSendButton(elements);
}

function updateChatSendButton(elements: SidePanelElements): void {
  const disabled = !currentSnapshot || isChatSendDisabled(currentSnapshot, elements.chatInput?.value ?? "");
  setButtonDisabled(elements.chatSendButton, disabled);
}

function formatDiagnostics(diagnostics: DiagnosticEntry[]): string {
  if (diagnostics.length === 0) {
    return "Недавних диагностических сообщений нет.";
  }

  return diagnostics
    .slice()
    .reverse()
    .map((entry) => `${new Date(entry.timestamp).toISOString()} [${entry.phase}] ${entry.message}`)
    .join("\n");
}

function renderAssistantSnapshot(elements: SidePanelElements, state: BackgroundAssistantState): void {
  currentSnapshot = state;

  setBaseDiagnostics(elements, formatDiagnostics(state.diagnostics));
  renderSessionConnection(elements, state);
  renderChat(elements);
  updateDirectSendButtons(elements);
  updateChatSendButton(elements);
}

function renderAssistantUnavailable(elements: SidePanelElements): void {
  currentSnapshot = undefined;
  lastRenderedMessageCount = 0;
  lastRenderedMessageTimestamps = [];

  setBaseDiagnostics(elements, SIDEPANEL_UNAVAILABLE_TEXT);
  if (elements.sessionConnectionStatus) {
    elements.sessionConnectionStatus.textContent = "⚠️ Состояние боковой панели недоступно.";
    elements.sessionConnectionStatus.dataset.tone = "warning";
  }
  renderChat(elements);
  updateDirectSendButtons(elements);
  updateChatSendButton(elements);
}

function isAssistantSnapshotMessage(message: unknown): message is AssistantSnapshotMessage {
  return Boolean(
    message &&
      typeof message === "object" &&
      (message as { type?: unknown }).type === "assistant.snapshot" &&
      typeof (message as { state?: unknown }).state === "object" &&
      (message as { state?: unknown }).state !== null,
  );
}

function clearReconnectTimer(): void {
  if (reconnectTimer === undefined) {
    return;
  }

  clearTimeout(reconnectTimer);
  reconnectTimer = undefined;
}

function renderAssistantReconnecting(elements: SidePanelElements): void {
  setBaseDiagnostics(elements, SIDEPANEL_RECONNECTING_TEXT);

  if (elements.sessionConnectionStatus) {
    const port = currentSnapshot?.connection.configuredPort ?? DEFAULT_PORT;
    elements.sessionConnectionStatus.textContent = `🔄 Переподключаемся к 127.0.0.1:${port}…`;
    elements.sessionConnectionStatus.dataset.tone = "info";
  }

  setButtonDisabled(elements.sendButton, true);
  setButtonDisabled(elements.chatSendButton, true);
}

function scheduleAssistantPortReconnect(elements: SidePanelElements): void {
  if (reconnectTimer !== undefined || assistantPort !== undefined) {
    return;
  }

  const delay = SIDEPANEL_RECONNECT_DELAYS_MS[Math.min(reconnectAttempt, SIDEPANEL_RECONNECT_DELAYS_MS.length - 1)];
  reconnectAttempt += 1;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = undefined;
    connectAssistantPort(elements);
  }, delay);
}

function connectAssistantPort(elements: SidePanelElements): void {
  if (assistantPort !== undefined) {
    return;
  }

  clearReconnectTimer();
  const port = chrome.runtime.connect({ name: "sidepanel" });
  assistantPort = port;
  port.onMessage.addListener((message: unknown) => {
    if (!isAssistantSnapshotMessage(message) || assistantPort !== port) {
      return;
    }

    reconnectAttempt = 0;
    clearReconnectTimer();
    renderAssistantSnapshot(elements, message.state);
  });
  port.onDisconnect.addListener(() => {
    if (assistantPort !== port) {
      return;
    }

    assistantPort = undefined;
    renderAssistantReconnecting(elements);
    scheduleAssistantPortReconnect(elements);
  });
}

function activateTab(elements: SidePanelElements, tab: SidePanelTab): void {
  const previousTab = currentActiveTab;
  currentActiveTab = tab;

  setPanelState(elements.assistantPanel, elements.assistantTabButton, tab === "assistant");
  setPanelState(elements.sessionsPanel, elements.sessionsTabButton, tab === "sessions");
}

function initializeSidePanel(): void {
  const elements = getSidePanelElements();

  currentSnapshot = undefined;
  currentActiveTab = "assistant";
  userEditingPort = false;
  lastRenderedMessageCount = 0;
  lastRenderedMessageTimestamps = [];
  clearReconnectTimer();
  reconnectAttempt = 0;

  connectAssistantPort(elements);
  activateTab(elements, "assistant");
  updateDirectSendButtons(elements);
  updateChatSendButton(elements);

  // Set default port value
  if (elements.sessionPortInput) {
    elements.sessionPortInput.value = String(DEFAULT_PORT);
  }

  elements.assistantTabButton?.addEventListener("click", () => {
    activateTab(elements, "assistant");
  });

  elements.sessionsTabButton?.addEventListener("click", () => {
    activateTab(elements, "sessions");
  });

  elements.devlogBackButton?.addEventListener("click", () => {
    activateTab(elements, "assistant");
  });

  elements.headerMenuButton?.addEventListener("click", () => {
    setMenuOpen(elements.headerMenuButton, elements.headerMenu, elements.headerMenu?.hidden !== false);
  });

  elements.composerMenuButton?.addEventListener("click", () => {
    setMenuOpen(elements.composerMenuButton, elements.composerMenu, elements.composerMenu?.hidden !== false);
  });

  elements.modelButton?.addEventListener("click", () => {
    setMenuOpen(elements.modelButton, elements.modelMenu, elements.modelMenu?.hidden !== false);
  });

  elements.headerDevlogButton?.addEventListener("click", () => {
    setMenuOpen(elements.headerMenuButton, elements.headerMenu, false);
    activateTab(elements, "sessions");
  });

  elements.chatInput?.addEventListener("input", () => {
    updateChatSendButton(elements);
  });

  elements.chatInput?.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" || event.shiftKey) {
      return;
    }

    event.preventDefault();
    elements.chatSendButton?.click();
  });

  elements.chatSendButton?.addEventListener("click", () => {
    const text = elements.chatInput?.value.trim() ?? "";

    if (!currentSnapshot || isChatSendDisabled(currentSnapshot, text)) {
      updateChatSendButton(elements);
      return;
    }

    postAssistantCommand({ type: "assistant.sendChatMessage", message: text });

    if (elements.chatInput) {
      elements.chatInput.value = "";
    }
    updateChatSendButton(elements);
  });

  elements.diagnosticsButton?.addEventListener("click", () => {
    postAssistantCommand({ type: "assistant.diagnostics.refresh" });
  });

  // Port input tracking for user editing
  elements.sessionPortInput?.addEventListener("focus", () => {
    userEditingPort = true;
  });
  elements.sessionPortInput?.addEventListener("blur", () => {
    userEditingPort = false;
  });

  // Connect button
  elements.connectSessionButton?.addEventListener("click", () => {
    const port = getPortInputValue(elements);
    if (port === undefined) {
      if (elements.sessionConnectionStatus) {
        elements.sessionConnectionStatus.textContent = PORT_ERROR_TEXT;
      }
      return;
    }
    userEditingPort = false;
    postAssistantCommand({ type: "assistant.session.connect", port });
  });

  elements.sendButton?.addEventListener("click", async () => {
    setMenuOpen(elements.composerMenuButton, elements.composerMenu, false);
    const sendButton = elements.sendButton;

    if (!sendButton || !currentSnapshot?.connection.online) {
      updateDirectSendButtons(elements);
      return;
    }

    try {
      sendButton.disabled = true;
      sendButton.setAttribute("aria-disabled", "true");
      const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
      postAssistantCommand({
        type: "assistant.startDomPicker",
        tabId: activeTab?.id,
      });

      setDiagnostics(elements, START_PICKER_PROMPT);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      setPickerErrorDiagnostics(elements, errorMessage);
    } finally {
      updateDirectSendButtons(elements);
    }
  });
}

if (typeof document !== "undefined") {
  initializeSidePanel();
}
