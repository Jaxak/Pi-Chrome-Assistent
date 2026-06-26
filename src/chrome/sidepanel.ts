import type { TargetMetadata } from "../shared/protocol";
import {
  formatAssistantStatus,
  isChatSendDisabled,
  type BackgroundAssistantState,
} from "./assistantState";
import type { DiagnosticEntry } from "./diagnostics";
import {
  createAgentWorkingElement,
  createChatMessageElement,
} from "./sidepanelRender";

export type ListTargetsResponse = {
  ok?: boolean;
  error?: string;
  targets?: TargetMetadata[];
  selectedTargetId?: string;
  tokenConfigured?: boolean;
};

type StartDomPickerResponse = {
  ok?: boolean;
  error?: string;
};

type AssistantSnapshotMessage = { type: "assistant.snapshot"; state: BackgroundAssistantState };

type SidePanelTab = "assistant" | "sessions" | "auth";

type SidePanelElements = {
  assistantTabButton: HTMLButtonElement | null;
  sessionsTabButton: HTMLButtonElement | null;
  devlogBackButton: HTMLButtonElement | null;
  authorizationTabButton: HTMLButtonElement | null;
  assistantPanel: HTMLElement | null;
  sessionsPanel: HTMLElement | null;
  authorizationPanel: HTMLElement | null;
  statusText: HTMLSpanElement | null;
  sendButton: HTMLButtonElement | null;
  chatInput: HTMLTextAreaElement | null;
  chatSendButton: HTMLButtonElement | null;
  messageList: HTMLElement | null;
  messagesScroll: HTMLElement | null;
  agentWorking: HTMLElement | null;
  headerMenuButton: HTMLButtonElement | null;
  headerMenu: HTMLElement | null;
  headerAuthButton: HTMLButtonElement | null;
  headerDevlogButton: HTMLButtonElement | null;
  composerMenuButton: HTMLButtonElement | null;
  composerMenu: HTMLElement | null;
  diagnosticsButton: HTMLButtonElement | null;
  diagnosticsOutput: HTMLElement | null;
  targetContainer: HTMLElement | null;
  authStatusText: HTMLElement | null;
  browserTokenOutput: HTMLElement | null;
  copyBrowserTokenButton: HTMLButtonElement | null;
  regenerateBrowserTokenButton: HTMLButtonElement | null;
  clearBrowserTokenButton: HTMLButtonElement | null;
};

const BROKER_UNAVAILABLE_GUIDANCE = "Pi не подключён. Выполните /chrome-assistent-connect в терминале.";
const NO_TARGETS_GUIDANCE = "Нет активных целей. Выполните /chrome-assistent-connect в нужной сессии Pi.";
const TOKEN_REQUIRED_GUIDANCE = "Для отправки настройте browserToken в chrome.storage.local.";
const AUTH_REQUIRED_GUIDANCE = "Браузер не авторизован в Pi. Выполните /chrome-assistent-auth в терминале.";
const START_PICKER_PROMPT = "Выберите элемент на странице, чтобы отправить его в Pi.";
const START_PICKER_BUTTON_LABEL = "Запустить DOM picker на активной вкладке";
const NO_TARGET_BUTTON_LABEL = "Выберите цель Pi, чтобы включить кнопку «Отправить в Pi»";
const SIDEPANEL_UNAVAILABLE_TEXT = "Состояние боковой панели недоступно.";
const SIDEPANEL_UNAVAILABLE_BUTTON_LABEL = "Сейчас состояние боковой панели недоступно";
const AUTH_TAB_READY_TEXT = "Скопируйте токен и выполните /chrome-assistent-auth в Pi.";
const AUTH_TAB_CLEARED_TEXT = "Токен удалён. Нажмите «Сгенерировать новый токен», чтобы создать новый.";
const AUTH_TAB_COPY_SUCCESS_TEXT = "Токен скопирован. Теперь выполните /chrome-assistent-auth в Pi.";
const AUTH_TAB_COPY_UNAVAILABLE_TEXT = "Не удалось скопировать токен автоматически. Скопируйте его вручную.";
const AUTH_TAB_ERROR_TEXT = "Не удалось загрузить состояние авторизации браузера.";
const TOKEN_REMOVED_LABEL = "Токен удалён.";
const TOKEN_NOT_LOADED_LABEL = "Токен ещё не загружен.";

let assistantPort: chrome.runtime.Port | undefined;
let currentSnapshot: BackgroundAssistantState | undefined;
let currentTargets: TargetMetadata[] = [];
let currentSelectedTargetId: string | undefined;
let currentTokenConfigured: boolean | undefined;
let currentBrowserToken: string | undefined;
let currentDiagnosticsBaseText = "Недавних диагностических сообщений нет.";
let currentActiveTab: SidePanelTab = "assistant";

function getSidePanelElements(): SidePanelElements {
  return {
    assistantTabButton: document.querySelector<HTMLButtonElement>("#tab-assistant"),
    sessionsTabButton: document.querySelector<HTMLButtonElement>("#tab-sessions"),
    devlogBackButton: document.querySelector<HTMLButtonElement>("#devlog-back-button"),
    authorizationTabButton: document.querySelector<HTMLButtonElement>("#tab-auth"),
    assistantPanel: document.querySelector<HTMLElement>("#panel-assistant"),
    sessionsPanel: document.querySelector<HTMLElement>("#panel-sessions"),
    authorizationPanel: document.querySelector<HTMLElement>("#panel-auth"),
    statusText: document.querySelector<HTMLSpanElement>("#status-text"),
    sendButton: document.querySelector<HTMLButtonElement>("#send-button"),
    chatInput: document.querySelector<HTMLTextAreaElement>("#chat-input"),
    chatSendButton: document.querySelector<HTMLButtonElement>("#chat-send-button"),
    messageList: document.querySelector<HTMLElement>("#message-list"),
    messagesScroll: document.querySelector<HTMLElement>("#messages-scroll"),
    agentWorking: document.querySelector<HTMLElement>("#agent-working"),
    headerMenuButton: document.querySelector<HTMLButtonElement>("#header-menu-button"),
    headerMenu: document.querySelector<HTMLElement>("#header-menu"),
    headerAuthButton: document.querySelector<HTMLButtonElement>("#header-auth-button"),
    headerDevlogButton: document.querySelector<HTMLButtonElement>("#header-devlog-button"),
    composerMenuButton: document.querySelector<HTMLButtonElement>("#composer-menu-button"),
    composerMenu: document.querySelector<HTMLElement>("#composer-menu"),
    diagnosticsButton: document.querySelector<HTMLButtonElement>("#diagnostics-button"),
    diagnosticsOutput: document.querySelector<HTMLElement>("#diagnostics-output"),
    targetContainer: document.querySelector<HTMLElement>("#target-container"),
    authStatusText: document.querySelector<HTMLElement>("#auth-status-text"),
    browserTokenOutput: document.querySelector<HTMLElement>("#browser-token-output"),
    copyBrowserTokenButton: document.querySelector<HTMLButtonElement>("#copy-browser-token-button"),
    regenerateBrowserTokenButton: document.querySelector<HTMLButtonElement>("#regenerate-browser-token-button"),
    clearBrowserTokenButton: document.querySelector<HTMLButtonElement>("#clear-browser-token-button"),
  };
}

function setStatus(elements: SidePanelElements, message: string): void {
  if (elements.statusText) {
    elements.statusText.textContent = message;
  }
}

function setDiagnostics(elements: SidePanelElements, message: string): void {
  if (elements.diagnosticsOutput) {
    elements.diagnosticsOutput.textContent = message;
  }
}

function setBaseDiagnostics(elements: SidePanelElements, message: string): void {
  currentDiagnosticsBaseText = message;
  setDiagnostics(elements, message);
}

function appendDiagnosticsNote(baseMessage: string, note: string): string {
  return `${baseMessage}\n\n${note}`;
}

function setPickerErrorDiagnostics(elements: SidePanelElements, errorMessage: string): void {
  setDiagnostics(elements, appendDiagnosticsNote(currentDiagnosticsBaseText, `Ошибка DOM picker: ${errorMessage}`));
}

function setAuthStatus(elements: SidePanelElements, message: string): void {
  if (elements.authStatusText) {
    elements.authStatusText.textContent = message;
  }
}

function setBrowserTokenOutput(elements: SidePanelElements, message: string): void {
  if (elements.browserTokenOutput) {
    elements.browserTokenOutput.textContent = message;
  }
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

function getCwdBasename(cwd: string): string {
  const segments = cwd.split(/[\\/]/).filter((segment) => segment.length > 0);
  return segments.at(-1) ?? cwd;
}

function normalizeOptionalString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function findTargetById(targetId: string | undefined, targets: TargetMetadata[]): TargetMetadata | undefined {
  return targets.find((target) => target.targetId === targetId);
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

function renderTargetPlaceholder(elements: SidePanelElements, message: string, tone: "default" | "warning" = "default"): void {
  if (!elements.targetContainer) {
    return;
  }

  const placeholder = document.createElement("div");
  placeholder.className = tone === "warning"
    ? "target-placeholder target-placeholder--warning"
    : "target-placeholder";
  placeholder.textContent = message;

  elements.targetContainer.replaceChildren(placeholder);
}

export function formatConnectionStatus(response: ListTargetsResponse): string {
  if (!response.ok) {
    return "Pi недоступен";
  }

  const targetCount = response.targets?.length ?? 0;
  return targetCount > 0 ? `Pi подключён · целей: ${targetCount}` : "Pi подключён · нет активных целей";
}

export function formatLastErrorSummary(diagnostics: DiagnosticEntry[]): string {
  const lastDiagnostic = diagnostics.at(-1);

  if (!lastDiagnostic) {
    return "Последняя ошибка: нет";
  }

  return `Последняя ошибка: ${lastDiagnostic.phase} — ${lastDiagnostic.message}`;
}

export function formatSummary(response: ListTargetsResponse, diagnostics: DiagnosticEntry[]): string {
  const targetCount = response.targets?.length ?? 0;
  const selectedTargetId = response.selectedTargetId;
  const hasSelectedTarget = typeof selectedTargetId === "string" && selectedTargetId.length > 0;
  const sendEnabled = response.ok && response.tokenConfigured !== false && targetCount > 0 && hasSelectedTarget;

  return [
    `Доступно целей: ${targetCount}`,
    `Выбранная цель: ${hasSelectedTarget ? selectedTargetId : "нет"}`,
    `browserToken настроен: ${response.tokenConfigured ? "да" : "нет"}`,
    `Отправка доступна: ${sendEnabled ? "да" : "нет"}`,
    formatLastErrorSummary(diagnostics),
  ].join("\n");
}

export function formatDiagnostics(diagnostics: DiagnosticEntry[]): string {
  if (diagnostics.length === 0) {
    return "Недавних диагностических сообщений нет.";
  }

  return diagnostics
    .slice()
    .reverse()
    .map((entry) => `${new Date(entry.timestamp).toISOString()} [${entry.phase}] ${entry.message}`)
    .join("\n");
}

export function formatTargetPrimaryLabel(target: TargetMetadata): string {
  const alias = normalizeOptionalString(target.alias);

  if (alias) {
    return alias;
  }

  const cwdBasename = getCwdBasename(target.cwd);
  const gitBranch = normalizeOptionalString(target.gitBranch);

  if (gitBranch) {
    return `${cwdBasename} · ${gitBranch}`;
  }

  return cwdBasename || target.targetId;
}

export function formatTargetSecondaryLabel(target: TargetMetadata): string {
  const details = [target.cwd];
  const gitBranch = normalizeOptionalString(target.gitBranch);
  const sessionName = normalizeOptionalString(target.sessionName);

  if (gitBranch) {
    details.push(`ветка ${gitBranch}`);
  }

  if (sessionName) {
    details.push(`сессия ${sessionName}`);
  }

  details.push(`pid ${target.pid}`);
  return details.join(" · ");
}

function updateSendButton(elements: SidePanelElements): void {
  if (!elements.sendButton) {
    return;
  }

  const hasSelectedTarget = findTargetById(currentSelectedTargetId, currentTargets) !== undefined;
  const tokenReady = currentTokenConfigured === true;
  const sendReady = hasSelectedTarget && tokenReady;

  elements.sendButton.disabled = !sendReady;
  elements.sendButton.setAttribute("aria-disabled", String(!sendReady));

  if (!currentSnapshot) {
    elements.sendButton.title = SIDEPANEL_UNAVAILABLE_BUTTON_LABEL;
    return;
  }

  if (!hasSelectedTarget) {
    elements.sendButton.title = NO_TARGET_BUTTON_LABEL;
    return;
  }

  elements.sendButton.title = tokenReady ? START_PICKER_BUTTON_LABEL : TOKEN_REQUIRED_GUIDANCE;
}

function updateChatSendButton(elements: SidePanelElements): void {
  const disabled = !currentSnapshot || isChatSendDisabled(currentSnapshot, elements.chatInput?.value ?? "");
  setButtonDisabled(elements.chatSendButton, disabled);
}

function renderChat(elements: SidePanelElements): void {
  const chat = currentSnapshot?.chat;

  if (elements.messageList) {
    const fragment = document.createDocumentFragment();
    for (const message of chat?.messages ?? []) {
      fragment.append(createChatMessageElement(message));
    }
    elements.messageList.replaceChildren(fragment);
  }

  if (elements.agentWorking) {
    const agentWorking = createAgentWorkingElement(chat?.busyLabel ?? "Агент работает в фоне…");
    agentWorking.id = "agent-working";
    agentWorking.hidden = !chat?.agentBusy;
    elements.agentWorking.replaceWith(agentWorking);
    elements.agentWorking = agentWorking;
  }

  if (elements.messagesScroll) {
    elements.messagesScroll.scrollTop = elements.messagesScroll.scrollHeight;
  }

  updateChatSendButton(elements);
}

function renderTargetList(elements: SidePanelElements): void {
  if (!elements.targetContainer) {
    return;
  }

  const fragment = document.createDocumentFragment();

  currentTargets.forEach((target) => {
    const option = document.createElement("button");
    option.type = "button";
    option.className = target.targetId === currentSelectedTargetId
      ? "target-option target-option--selected"
      : "target-option";
    option.setAttribute("role", "option");
    option.setAttribute("aria-selected", String(target.targetId === currentSelectedTargetId));
    option.dataset.targetId = target.targetId;

    const primary = document.createElement("span");
    primary.className = "target-option__primary";
    primary.textContent = formatTargetPrimaryLabel(target);

    const secondary = document.createElement("span");
    secondary.className = "target-option__secondary";
    secondary.textContent = formatTargetSecondaryLabel(target);

    option.append(primary, secondary);
    option.addEventListener("click", () => {
      postAssistantCommand({ type: "assistant.selectTarget", targetId: target.targetId });
    });

    fragment.append(option);
  });

  elements.targetContainer.replaceChildren(fragment);
}

function renderTargetsFromSnapshot(elements: SidePanelElements, state: BackgroundAssistantState): void {
  if (state.connection.tokenConfigured === false) {
    renderTargetPlaceholder(elements, TOKEN_REQUIRED_GUIDANCE, "warning");
    return;
  }

  if (state.connection.browserAuthorized === false) {
    renderTargetPlaceholder(elements, AUTH_REQUIRED_GUIDANCE, "warning");
    return;
  }

  if (!state.connection.brokerOnline && !state.connection.connecting) {
    renderTargetPlaceholder(elements, BROKER_UNAVAILABLE_GUIDANCE, "warning");
    return;
  }

  if (state.targets.length === 0) {
    renderTargetPlaceholder(elements, NO_TARGETS_GUIDANCE);
    return;
  }

  renderTargetList(elements);
}

function setAuthButtonsPending(elements: SidePanelElements, pending: boolean): void {
  setButtonDisabled(elements.copyBrowserTokenButton, pending);
  setButtonDisabled(elements.regenerateBrowserTokenButton, pending);
  setButtonDisabled(elements.clearBrowserTokenButton, pending);
}

function renderBrowserAuthSnapshot(elements: SidePanelElements, state: BackgroundAssistantState): void {
  currentBrowserToken = typeof state.auth.browserToken === "string" && state.auth.browserToken.length > 0
    ? state.auth.browserToken
    : undefined;

  if (state.auth.mutationPending) {
    setAuthStatus(elements, "Обновляем состояние авторизации браузера...");
    setAuthButtonsPending(elements, true);
    return;
  }

  if (state.auth.error) {
    setAuthStatus(elements, state.auth.error || AUTH_TAB_ERROR_TEXT);
    setBrowserTokenOutput(elements, TOKEN_NOT_LOADED_LABEL);
    setButtonDisabled(elements.copyBrowserTokenButton, true);
    setButtonDisabled(elements.clearBrowserTokenButton, true);
    setButtonDisabled(elements.regenerateBrowserTokenButton, false);
    return;
  }

  if (!state.auth.tokenConfigured || !currentBrowserToken) {
    setAuthStatus(elements, AUTH_TAB_CLEARED_TEXT);
    setBrowserTokenOutput(elements, TOKEN_REMOVED_LABEL);
    setButtonDisabled(elements.copyBrowserTokenButton, true);
    setButtonDisabled(elements.clearBrowserTokenButton, true);
    setButtonDisabled(elements.regenerateBrowserTokenButton, false);
    return;
  }

  setAuthStatus(elements, AUTH_TAB_READY_TEXT);
  setBrowserTokenOutput(elements, currentBrowserToken);
  setButtonDisabled(elements.copyBrowserTokenButton, false);
  setButtonDisabled(elements.clearBrowserTokenButton, false);
  setButtonDisabled(elements.regenerateBrowserTokenButton, false);
}

function renderAssistantSnapshot(elements: SidePanelElements, state: BackgroundAssistantState): void {
  currentSnapshot = state;
  currentTargets = state.targets;
  currentSelectedTargetId = state.selectedTargetId;
  currentTokenConfigured = state.connection.tokenConfigured;

  setStatus(elements, formatAssistantStatus(state));
  setBaseDiagnostics(elements, formatDiagnostics(state.diagnostics));
  renderTargetsFromSnapshot(elements, state);
  renderChat(elements);
  renderBrowserAuthSnapshot(elements, state);
  updateSendButton(elements);
  updateChatSendButton(elements);
}

function renderAssistantUnavailable(elements: SidePanelElements): void {
  currentSnapshot = undefined;
  currentTargets = [];
  currentSelectedTargetId = undefined;
  currentTokenConfigured = undefined;
  currentBrowserToken = undefined;

  setStatus(elements, SIDEPANEL_UNAVAILABLE_TEXT);
  setBaseDiagnostics(elements, SIDEPANEL_UNAVAILABLE_TEXT);
  renderTargetPlaceholder(elements, SIDEPANEL_UNAVAILABLE_TEXT, "warning");
  renderChat(elements);
  setAuthStatus(elements, SIDEPANEL_UNAVAILABLE_TEXT);
  setBrowserTokenOutput(elements, TOKEN_NOT_LOADED_LABEL);
  setAuthButtonsPending(elements, true);
  updateSendButton(elements);
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

function connectAssistantPort(elements: SidePanelElements): void {
  const port = chrome.runtime.connect({ name: "sidepanel" });
  assistantPort = port;
  port.onMessage.addListener((message: unknown) => {
    if (!isAssistantSnapshotMessage(message)) {
      return;
    }

    renderAssistantSnapshot(elements, message.state);
  });
  port.onDisconnect.addListener(() => {
    if (assistantPort !== port) {
      return;
    }

    assistantPort = undefined;
    renderAssistantUnavailable(elements);
  });
}

async function copyBrowserToken(elements: SidePanelElements): Promise<void> {
  if (!currentBrowserToken) {
    setAuthStatus(elements, AUTH_TAB_COPY_UNAVAILABLE_TEXT);
    return;
  }

  try {
    if (typeof navigator === "undefined" || !navigator.clipboard?.writeText) {
      throw new Error(AUTH_TAB_COPY_UNAVAILABLE_TEXT);
    }

    await navigator.clipboard.writeText(currentBrowserToken);
    setAuthStatus(elements, AUTH_TAB_COPY_SUCCESS_TEXT);
  } catch {
    setAuthStatus(elements, AUTH_TAB_COPY_UNAVAILABLE_TEXT);
  }
}

function activateTab(elements: SidePanelElements, tab: SidePanelTab): void {
  const previousTab = currentActiveTab;
  currentActiveTab = tab;

  setPanelState(elements.assistantPanel, elements.assistantTabButton, tab === "assistant");
  setPanelState(elements.sessionsPanel, elements.sessionsTabButton, tab === "sessions");
  setPanelState(elements.authorizationPanel, elements.authorizationTabButton, tab === "auth");

  if (tab === "auth" && previousTab !== "auth") {
    postAssistantCommand({ type: "assistant.auth.refresh" });
  }
}

export async function refreshSidePanelState(): Promise<void> {
  postAssistantCommand({ type: "assistant.diagnostics.refresh" });
}

function initializeSidePanel(): void {
  const elements = getSidePanelElements();

  currentSnapshot = undefined;
  currentTargets = [];
  currentSelectedTargetId = undefined;
  currentTokenConfigured = undefined;
  currentBrowserToken = undefined;
  currentDiagnosticsBaseText = "Недавних диагностических сообщений нет.";
  currentActiveTab = "assistant";

  connectAssistantPort(elements);
  activateTab(elements, "assistant");
  updateSendButton(elements);
  updateChatSendButton(elements);
  setAuthStatus(elements, TOKEN_NOT_LOADED_LABEL);
  setBrowserTokenOutput(elements, TOKEN_NOT_LOADED_LABEL);
  setButtonDisabled(elements.copyBrowserTokenButton, true);
  setButtonDisabled(elements.clearBrowserTokenButton, true);

  elements.assistantTabButton?.addEventListener("click", () => {
    activateTab(elements, "assistant");
  });

  elements.sessionsTabButton?.addEventListener("click", () => {
    activateTab(elements, "sessions");
  });

  elements.devlogBackButton?.addEventListener("click", () => {
    activateTab(elements, "assistant");
  });

  elements.authorizationTabButton?.addEventListener("click", () => {
    activateTab(elements, "auth");
  });

  elements.headerMenuButton?.addEventListener("click", () => {
    setMenuOpen(elements.headerMenuButton, elements.headerMenu, elements.headerMenu?.hidden !== false);
  });

  elements.composerMenuButton?.addEventListener("click", () => {
    setMenuOpen(elements.composerMenuButton, elements.composerMenu, elements.composerMenu?.hidden !== false);
  });

  elements.headerAuthButton?.addEventListener("click", () => {
    setMenuOpen(elements.headerMenuButton, elements.headerMenu, false);
    activateTab(elements, "auth");
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
    void refreshSidePanelState();
  });

  elements.copyBrowserTokenButton?.addEventListener("click", () => {
    void copyBrowserToken(elements);
  });

  elements.regenerateBrowserTokenButton?.addEventListener("click", () => {
    postAssistantCommand({ type: "assistant.auth.regenerateToken" });
  });

  elements.clearBrowserTokenButton?.addEventListener("click", () => {
    postAssistantCommand({ type: "assistant.auth.clearToken" });
  });

  elements.sendButton?.addEventListener("click", async () => {
    setMenuOpen(elements.composerMenuButton, elements.composerMenu, false);
    const sendButton = elements.sendButton;
    const selectedTarget = findTargetById(currentSelectedTargetId, currentTargets);

    if (!sendButton || !selectedTarget || currentTokenConfigured !== true) {
      updateSendButton(elements);
      return;
    }

    try {
      sendButton.disabled = true;
      sendButton.setAttribute("aria-disabled", "true");
      setStatus(elements, `Запускаем DOM picker · ${formatTargetPrimaryLabel(selectedTarget)}`);

      const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
      const response = (await chrome.runtime.sendMessage({
        type: "startDomPicker",
        targetId: selectedTarget.targetId,
        tabId: activeTab?.id,
      })) as StartDomPickerResponse | undefined;

      if (!response?.ok) {
        const errorMessage = response?.error ?? "Не удалось запустить DOM picker.";
        setStatus(elements, "Не удалось запустить DOM picker");
        setPickerErrorDiagnostics(elements, errorMessage);
        return;
      }

      setStatus(elements, START_PICKER_PROMPT);
      setDiagnostics(elements, currentDiagnosticsBaseText);
      // Боковая панель остаётся открытой, пока пользователь выбирает DOM-элемент на странице.
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      setStatus(elements, "Не удалось запустить DOM picker");
      setPickerErrorDiagnostics(elements, errorMessage);
    } finally {
      updateSendButton(elements);
    }
  });
}

if (typeof document !== "undefined") {
  initializeSidePanel();
}
