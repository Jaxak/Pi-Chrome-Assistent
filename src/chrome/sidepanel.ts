import type { TargetMetadata } from "../shared/protocol";
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

export type ListTargetsResponse = {
  ok?: boolean;
  error?: string;
  targets?: TargetMetadata[];
  selectedTargetId?: string;
  tokenConfigured?: boolean;
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
  refreshSessionsButton: HTMLButtonElement | null;
  sessionStaleGuidance: HTMLElement | null;
  modelButton: HTMLButtonElement | null;
  modelMenu: HTMLElement | null;
  contextUsage: HTMLElement | null;
  targetContainer: HTMLElement | null;
  authStatusText: HTMLElement | null;
  browserTokenOutput: HTMLElement | null;
  copyBrowserTokenButton: HTMLButtonElement | null;
  regenerateBrowserTokenButton: HTMLButtonElement | null;
  clearBrowserTokenButton: HTMLButtonElement | null;
};

const BROKER_UNAVAILABLE_GUIDANCE = "Pi не подключён. Выполните /chrome-assistent-connect в терминале.";
const NO_TARGETS_GUIDANCE = "Нет активных целей. Выполните /chrome-assistent-connect в нужной сессии Pi.";
const STALE_TARGETS_GUIDANCE = "Список может быть устаревшим. Нажмите «Обновить».";
const REFRESHING_TARGETS_GUIDANCE = "Обновляем список сессий…";
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
const SIDEPANEL_RECONNECTING_TEXT = "Переподключаем боковую панель…";
const SIDEPANEL_RECONNECT_DELAYS_MS = [250, 1000, 2000] as const;

let assistantPort: chrome.runtime.Port | undefined;
let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
let reconnectAttempt = 0;
let currentSnapshot: BackgroundAssistantState | undefined;
let currentTargets: TargetMetadata[] = [];
let currentSelectedTargetId: string | undefined;
let localSelectionChanged = false;
let sessionsRefreshPending = false;
let targetListUpdateMode: "initial" | "manual" | "availability" | "frozen" = "initial";
let currentTokenConfigured: boolean | undefined;
let currentBrowserToken: string | undefined;
let currentDiagnosticsBaseText = "Недавних диагностических сообщений нет.";
let currentActiveTab: SidePanelTab = "assistant";
let lastRenderedConnectionKey = "";
let lastRenderedTargetIds: string[] = [];
let forceNextSnapshotTargetRender = false;

function getSidePanelElements(): SidePanelElements {
  return {
    assistantTabButton: document.querySelector<HTMLButtonElement>("#tab-assistant"),
    sessionsTabButton: document.querySelector<HTMLButtonElement>("#tab-sessions"),
    devlogBackButton: document.querySelector<HTMLButtonElement>("#devlog-back-button"),
    authorizationTabButton: document.querySelector<HTMLButtonElement>("#tab-auth"),
    assistantPanel: document.querySelector<HTMLElement>("#panel-assistant"),
    sessionsPanel: document.querySelector<HTMLElement>("#panel-sessions"),
    authorizationPanel: document.querySelector<HTMLElement>("#panel-auth"),
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
    refreshSessionsButton: document.querySelector<HTMLButtonElement>("#refresh-sessions-button"),
    sessionStaleGuidance: document.querySelector<HTMLElement>("#session-stale-guidance"),
    modelButton: document.querySelector<HTMLButtonElement>("#model-button"),
    modelMenu: document.querySelector<HTMLElement>("#model-menu"),
    contextUsage: document.querySelector<HTMLElement>("#context-usage"),
    targetContainer: document.querySelector<HTMLElement>("#target-container"),
    authStatusText: document.querySelector<HTMLElement>("#auth-status-text"),
    browserTokenOutput: document.querySelector<HTMLElement>("#browser-token-output"),
    copyBrowserTokenButton: document.querySelector<HTMLButtonElement>("#copy-browser-token-button"),
    regenerateBrowserTokenButton: document.querySelector<HTMLButtonElement>("#regenerate-browser-token-button"),
    clearBrowserTokenButton: document.querySelector<HTMLButtonElement>("#clear-browser-token-button"),
  };
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

  const className = tone === "warning"
    ? "target-placeholder target-placeholder--warning"
    : "target-placeholder";
  const existingPlaceholder = elements.targetContainer.firstElementChild instanceof HTMLElement &&
    elements.targetContainer.firstElementChild.classList.contains("target-placeholder") &&
    elements.targetContainer.childElementCount === 1
    ? elements.targetContainer.firstElementChild
    : undefined;

  if (existingPlaceholder) {
    if (existingPlaceholder.className !== className) {
      existingPlaceholder.className = className;
    }

    setTextIfChanged(existingPlaceholder, message);
    return;
  }

  const placeholder = document.createElement("div");
  placeholder.className = className;
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
  const liveSelectedTargetReady = currentSnapshot?.selectedTargetId === currentSelectedTargetId &&
    findTargetById(currentSelectedTargetId, currentSnapshot?.targets ?? []) !== undefined;
  const tokenReady = currentTokenConfigured === true;
  const sendReady = hasSelectedTarget && liveSelectedTargetReady && tokenReady;

  elements.sendButton.disabled = !sendReady;
  elements.sendButton.setAttribute("aria-disabled", String(!sendReady));

  if (!currentSnapshot) {
    elements.sendButton.title = SIDEPANEL_UNAVAILABLE_BUTTON_LABEL;
    return;
  }

  if (!hasSelectedTarget || !liveSelectedTargetReady) {
    elements.sendButton.title = NO_TARGET_BUTTON_LABEL;
    return;
  }

  elements.sendButton.title = tokenReady ? START_PICKER_BUTTON_LABEL : TOKEN_REQUIRED_GUIDANCE;
}

function updateChatSendButton(elements: SidePanelElements): void {
  const disabled = !currentSnapshot || isChatSendDisabled(currentSnapshot, elements.chatInput?.value ?? "");
  setButtonDisabled(elements.chatSendButton, disabled);
}

let lastRenderedMessageCount = 0;
let lastRenderedMessageTimestamps: number[] = [];

function formatNumberRu(value: number): string {
  return new Intl.NumberFormat("ru-RU").format(value).replace(/\u00a0/g, " ");
}

function renderRuntimeInfo(elements: SidePanelElements): void {
  const runtime = currentSnapshot?.runtime;
  const selectedRuntime = runtime?.selectedTargetRuntime;
  const model = selectedRuntime?.model;
  const modelLabel = model?.label ?? (model ? `${model.provider}/${model.id}` : "—");

  if (elements.modelButton) {
    elements.modelButton.textContent = runtime?.modelMutationPending ? "Меняем модель…" : `Модель: ${modelLabel}`;
    elements.modelButton.disabled = !currentSnapshot || runtime?.availableModels.length === 0 || runtime?.modelMutationPending === true;
    elements.modelButton.setAttribute("aria-disabled", String(elements.modelButton.disabled));
  }

  const usage = selectedRuntime?.contextUsage;
  if (elements.contextUsage) {
    elements.contextUsage.textContent = usage
      ? `Контекст: ${formatNumberRu(usage.tokens ?? 0)} / ${formatNumberRu(usage.maxTokens)} токенов · ${Math.round(usage.percent ?? 0)}%`
      : "Контекст: —";
  }

  if (runtime?.modelError && elements.contextUsage) {
    elements.contextUsage.textContent = `Ошибка модели: ${runtime.modelError}`;
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
    // Оптимизация: проверяем, изменились ли сообщения
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

      // Прокрутка только при изменении сообщений
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

function renderTargetSelectionOnly(elements: SidePanelElements): void {
  const selectedTargetId = currentSelectedTargetId;
  elements.targetContainer?.querySelectorAll<HTMLButtonElement>(".target-option").forEach((option) => {
    const selected = option.dataset.targetId === selectedTargetId;
    const selectedText = String(selected);

    if (option.classList.contains("target-option--selected") !== selected) {
      option.classList.toggle("target-option--selected", selected);
    }

    if (option.getAttribute("aria-selected") !== selectedText) {
      option.setAttribute("aria-selected", selectedText);
    }
  });
}

function setTextIfChanged(element: HTMLElement | null, text: string): void {
  if (element && element.textContent !== text) {
    element.textContent = text;
  }
}

function updateTargetOptionLabels(option: HTMLButtonElement, target: TargetMetadata): void {
  setTextIfChanged(option.querySelector<HTMLElement>(".target-option__primary"), formatTargetPrimaryLabel(target));
  setTextIfChanged(option.querySelector<HTMLElement>(".target-option__secondary"), formatTargetSecondaryLabel(target));
}

function createTargetOption(elements: SidePanelElements, target: TargetMetadata): HTMLButtonElement {
  const option = document.createElement("button");
  option.type = "button";
  option.className = "target-option";
  option.setAttribute("role", "option");
  option.dataset.targetId = target.targetId;

  const primary = document.createElement("span");
  primary.className = "target-option__primary";

  const secondary = document.createElement("span");
  secondary.className = "target-option__secondary";

  option.append(primary, secondary);
  updateTargetOptionLabels(option, target);
  option.addEventListener("click", () => {
    currentSelectedTargetId = option.dataset.targetId;
    localSelectionChanged = true;
    renderTargetSelectionOnly(elements);
    updateSendButton(elements);
    postAssistantCommand({ type: "assistant.selectTarget", targetId: option.dataset.targetId });
  });

  return option;
}

function renderTargetList(elements: SidePanelElements): void {
  if (!elements.targetContainer) {
    return;
  }

  const existingOptions = Array.from(elements.targetContainer.querySelectorAll<HTMLButtonElement>(".target-option"));
  const existingIds = existingOptions.map((option) => option.dataset.targetId ?? "");
  const nextIds = currentTargets.map((target) => target.targetId);
  const sameTargetOrder = existingIds.length === nextIds.length && existingIds.every((id, index) => id === nextIds[index]);

  if (!sameTargetOrder) {
    const fragment = document.createDocumentFragment();
    currentTargets.forEach((target) => {
      fragment.append(createTargetOption(elements, target));
    });
    elements.targetContainer.replaceChildren(fragment);
  } else {
    currentTargets.forEach((target, index) => {
      const option = existingOptions[index];
      if (option) {
        updateTargetOptionLabels(option, target);
      }
    });
  }

  renderTargetSelectionOnly(elements);
}

function renderSessionGuidance(elements: SidePanelElements, state: BackgroundAssistantState): void {
  if (!elements.sessionStaleGuidance) {
    return;
  }

  const message = sessionsRefreshPending
    ? REFRESHING_TARGETS_GUIDANCE
    : state.targets.length > 0 && state.connection.targetsStale
      ? STALE_TARGETS_GUIDANCE
      : undefined;

  elements.sessionStaleGuidance.hidden = message === undefined;
  elements.sessionStaleGuidance.textContent = message ?? "";
}

function requestSessionsRefresh(elements: SidePanelElements): void {
  if (currentSnapshot?.connection.tokenConfigured === false) {
    postAssistantCommand({ type: "assistant.sessions.refresh" });
    return;
  }

  sessionsRefreshPending = true;
  targetListUpdateMode = "manual";
  if (currentSnapshot) {
    renderSessionGuidance(elements, currentSnapshot);
  }
  postAssistantCommand({ type: "assistant.sessions.refresh" });
}

function getConnectionDisplayKey(state: BackgroundAssistantState): string {
  // Ключ для определения, изменилось ли отображение состояния подключения
  if (state.connection.tokenConfigured === false) {
    return "token-required";
  }
  if (state.connection.browserAuthorized === false) {
    return "auth-required";
  }
  if (state.targets.length > 0) {
    return "has-targets";
  }
  if (!state.connection.brokerOnline && !state.connection.connecting) {
    return "broker-unavailable";
  }
  // Подключаемся или нет целей - один и тот же placeholder
  return "no-targets";
}

function renderTargetsFromSnapshot(elements: SidePanelElements, state: BackgroundAssistantState): void {
  const connectionKey = getConnectionDisplayKey(state);
  const targetIds = state.targets.map((t) => t.targetId);
  const targetIdsChanged = targetIds.length !== lastRenderedTargetIds.length ||
    !targetIds.every((id, i) => id === lastRenderedTargetIds[i]);

  // Если визуально ничего не изменилось, пропускаем перерисовку
  if (connectionKey === lastRenderedConnectionKey && !targetIdsChanged) {
    renderSessionGuidance(elements, state);
    renderTargetSelectionOnly(elements);
    return;
  }

  lastRenderedConnectionKey = connectionKey;
  lastRenderedTargetIds = targetIds;

  renderSessionGuidance(elements, state);

  if (state.connection.tokenConfigured === false) {
    renderTargetPlaceholder(elements, TOKEN_REQUIRED_GUIDANCE, "warning");
    return;
  }

  if (state.connection.browserAuthorized === false) {
    renderTargetPlaceholder(elements, AUTH_REQUIRED_GUIDANCE, "warning");
    return;
  }

  if (state.targets.length > 0) {
    renderTargetList(elements);
    return;
  }

  if (!state.connection.brokerOnline && !state.connection.connecting) {
    renderTargetPlaceholder(elements, BROKER_UNAVAILABLE_GUIDANCE, "warning");
    return;
  }

  renderTargetPlaceholder(elements, NO_TARGETS_GUIDANCE);
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
  const previousSnapshot = currentSnapshot;
  currentSnapshot = state;

  const recoveringFromUnavailable = previousSnapshot !== undefined &&
    (previousSnapshot.connection.tokenConfigured === false || previousSnapshot.connection.browserAuthorized === false) &&
    state.connection.tokenConfigured !== false &&
    state.connection.browserAuthorized !== false;

  if (recoveringFromUnavailable) {
    targetListUpdateMode = "availability";
  }

  const availabilityChanged = previousSnapshot !== undefined && (
    previousSnapshot.connection.tokenConfigured !== state.connection.tokenConfigured ||
    previousSnapshot.connection.browserAuthorized !== state.connection.browserAuthorized
  );
  const availabilityRequiresRender = availabilityChanged ||
    state.connection.tokenConfigured === false ||
    state.connection.browserAuthorized === false;
  const shouldUpdateTargetList = forceNextSnapshotTargetRender || targetListUpdateMode !== "frozen" || availabilityRequiresRender;

  if (shouldUpdateTargetList) {
    currentTargets = state.connection.tokenConfigured === false || state.connection.browserAuthorized === false
      ? []
      : state.targets;

    const localTargetStillExists = currentSelectedTargetId !== undefined &&
      currentTargets.some((target) => target.targetId === currentSelectedTargetId);

    if (!localSelectionChanged || !localTargetStillExists) {
      currentSelectedTargetId = state.connection.tokenConfigured === false || state.connection.browserAuthorized === false
        ? undefined
        : state.selectedTargetId;
      localSelectionChanged = false;
    } else if (state.selectedTargetId === currentSelectedTargetId) {
      localSelectionChanged = false;
    }
  }

  const manualRefreshFinished = targetListUpdateMode === "manual" && !state.connection.targetsRefreshPending;

  const initialSnapshotFinished = targetListUpdateMode === "initial" &&
    state.epoch > 0 &&
    !state.connection.targetsRefreshPending &&
    (state.targets.length > 0 || !state.connection.connecting);
  const availabilityRefreshFinished = targetListUpdateMode === "availability" && (
    state.targets.length > 0 ||
    state.connection.tokenConfigured === false ||
    state.connection.browserAuthorized === false ||
    (!state.connection.connecting && !state.connection.brokerOnline)
  );

  if (initialSnapshotFinished || manualRefreshFinished || availabilityRefreshFinished) {
    targetListUpdateMode = "frozen";
  }

  sessionsRefreshPending = targetListUpdateMode === "manual" && state.connection.connecting;
  currentTokenConfigured = state.connection.tokenConfigured;

  setBaseDiagnostics(elements, formatDiagnostics(state.diagnostics));
  if (shouldUpdateTargetList) {
    if (forceNextSnapshotTargetRender) {
      lastRenderedConnectionKey = "";
      lastRenderedTargetIds = [];
    }
    renderTargetsFromSnapshot(elements, state);
    forceNextSnapshotTargetRender = false;
  } else {
    renderSessionGuidance(elements, state);
    renderTargetSelectionOnly(elements);
  }
  renderChat(elements);
  renderBrowserAuthSnapshot(elements, state);
  updateSendButton(elements);
  updateChatSendButton(elements);
}

function renderAssistantUnavailable(elements: SidePanelElements): void {
  currentSnapshot = undefined;
  currentTargets = [];
  currentSelectedTargetId = undefined;
  localSelectionChanged = false;
  sessionsRefreshPending = false;
  targetListUpdateMode = "initial";
  currentTokenConfigured = undefined;
  currentBrowserToken = undefined;
  lastRenderedMessageCount = 0;
  lastRenderedMessageTimestamps = [];
  lastRenderedConnectionKey = "";
  lastRenderedTargetIds = [];
  forceNextSnapshotTargetRender = false;

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

function clearReconnectTimer(): void {
  if (reconnectTimer === undefined) {
    return;
  }

  clearTimeout(reconnectTimer);
  reconnectTimer = undefined;
}

function renderAssistantReconnecting(elements: SidePanelElements): void {
  setBaseDiagnostics(elements, SIDEPANEL_RECONNECTING_TEXT);

  if (!currentSnapshot) {
    renderTargetPlaceholder(elements, SIDEPANEL_RECONNECTING_TEXT, "warning");
    renderChat(elements);
    setAuthStatus(elements, SIDEPANEL_RECONNECTING_TEXT);
    setBrowserTokenOutput(elements, TOKEN_NOT_LOADED_LABEL);
  }

  setAuthButtonsPending(elements, true);
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
    forceNextSnapshotTargetRender = true;
    renderAssistantReconnecting(elements);
    scheduleAssistantPortReconnect(elements);
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

function initializeSidePanel(): void {
  const elements = getSidePanelElements();

  currentSnapshot = undefined;
  currentTargets = [];
  currentSelectedTargetId = undefined;
  localSelectionChanged = false;
  sessionsRefreshPending = false;
  targetListUpdateMode = "initial";
  currentTokenConfigured = undefined;
  currentBrowserToken = undefined;
  currentDiagnosticsBaseText = "Недавних диагностических сообщений нет.";
  currentActiveTab = "assistant";
  lastRenderedMessageCount = 0;
  lastRenderedMessageTimestamps = [];
  lastRenderedConnectionKey = "";
  lastRenderedTargetIds = [];
  forceNextSnapshotTargetRender = false;
  clearReconnectTimer();
  reconnectAttempt = 0;

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

  elements.modelButton?.addEventListener("click", () => {
    setMenuOpen(elements.modelButton, elements.modelMenu, elements.modelMenu?.hidden !== false);
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
    postAssistantCommand({ type: "assistant.diagnostics.refresh" });
  });

  elements.refreshSessionsButton?.addEventListener("click", () => {
    requestSessionsRefresh(elements);
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
    const liveSelectedTargetReady = currentSnapshot?.selectedTargetId === currentSelectedTargetId &&
      findTargetById(currentSelectedTargetId, currentSnapshot?.targets ?? []) !== undefined;

    if (!sendButton || !selectedTarget || !liveSelectedTargetReady || currentTokenConfigured !== true) {
      updateSendButton(elements);
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

      setDiagnostics(elements, appendDiagnosticsNote(currentDiagnosticsBaseText, START_PICKER_PROMPT));
      // Боковая панель остаётся открытой, пока пользователь выбирает DOM-элемент на странице.
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      setPickerErrorDiagnostics(elements, errorMessage);
    } finally {
      updateSendButton(elements);
    }
  });
}

if (typeof document !== "undefined") {
  initializeSidePanel();
}
