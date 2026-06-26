import { BROWSER_NOT_AUTHORIZED_ERROR } from "../shared/constants";
import type { TargetMetadata } from "../shared/protocol";
import type { DiagnosticEntry } from "./diagnostics";

export type ListTargetsResponse = {
  ok?: boolean;
  error?: string;
  targets?: TargetMetadata[];
  selectedTargetId?: string;
  tokenConfigured?: boolean;
};

type GetDiagnosticsResponse = {
  ok?: boolean;
  diagnostics?: DiagnosticEntry[];
};

type BrowserAuthStateResponse = {
  ok?: boolean;
  error?: string;
  browserToken?: string;
  tokenConfigured?: boolean;
};

type StartDomPickerResponse = {
  ok?: boolean;
  error?: string;
};

type SidePanelTab = "assistant" | "sessions" | "auth";

type SidePanelElements = {
  assistantTabButton: HTMLButtonElement | null;
  sessionsTabButton: HTMLButtonElement | null;
  authorizationTabButton: HTMLButtonElement | null;
  assistantPanel: HTMLElement | null;
  sessionsPanel: HTMLElement | null;
  authorizationPanel: HTMLElement | null;
  statusText: HTMLSpanElement | null;
  sendButton: HTMLButtonElement | null;
  diagnosticsButton: HTMLButtonElement | null;
  diagnosticsOutput: HTMLElement | null;
  targetContainer: HTMLElement | null;
  authStatusText: HTMLElement | null;
  browserTokenOutput: HTMLElement | null;
  copyBrowserTokenButton: HTMLButtonElement | null;
  regenerateBrowserTokenButton: HTMLButtonElement | null;
  clearBrowserTokenButton: HTMLButtonElement | null;
};

const SELECTED_TARGET_STORAGE_KEY = "selectedTargetId";
const BROKER_UNAVAILABLE_GUIDANCE = "Pi не подключён. Выполните /chrome-assistent-connect в терминале.";
const NO_TARGETS_GUIDANCE = "Нет активных целей. Выполните /chrome-assistent-connect в нужной сессии Pi.";
const SELECT_TARGET_PROMPT = "Выберите цель Pi, затем нажмите «Отправить в Pi».";
const TOKEN_REQUIRED_GUIDANCE = "Для отправки настройте browserToken в chrome.storage.local.";
const AUTH_REQUIRED_GUIDANCE = "Браузер не авторизован в Pi. Выполните /chrome-assistent-auth в терминале.";
const START_PICKER_PROMPT = "Выберите элемент на странице, чтобы отправить его в Pi.";
const START_PICKER_BUTTON_LABEL = "Запустить DOM picker на активной вкладке";
const NO_TARGET_BUTTON_LABEL = "Выберите цель Pi, чтобы включить кнопку «Отправить в Pi»";
const SIDEPANEL_UNAVAILABLE_BUTTON_LABEL = "Сейчас состояние боковой панели недоступно";
const AUTH_TAB_LOADING_TEXT = "Загружаем токен браузера...";
const AUTH_TAB_READY_TEXT = "Скопируйте токен и выполните /chrome-assistent-auth в Pi.";
const AUTH_TAB_CLEARED_TEXT = "Токен удалён. Нажмите «Сгенерировать новый токен», чтобы создать новый.";
const AUTH_TAB_COPY_SUCCESS_TEXT = "Токен скопирован. Теперь выполните /chrome-assistent-auth в Pi.";
const AUTH_TAB_COPY_UNAVAILABLE_TEXT = "Не удалось скопировать токен автоматически. Скопируйте его вручную.";
const AUTH_TAB_ERROR_TEXT = "Не удалось загрузить состояние авторизации браузера.";
const TOKEN_REMOVED_LABEL = "Токен удалён.";
const TOKEN_NOT_LOADED_LABEL = "Токен ещё не загружен.";

let currentTargets: TargetMetadata[] = [];
let currentSelectedTargetId: string | undefined;
let currentTokenConfigured: boolean | undefined;
let currentDiagnosticsBaseText = "Недавних диагностических сообщений нет.";
let currentRefreshRequestId = 0;
let currentActiveTab: SidePanelTab = "assistant";
let currentBrowserAuthState: BrowserAuthStateResponse | undefined;
let authStateLoaded = false;
let authRequestId = 0;
let authMutationPending = false;

function getSidePanelElements(): SidePanelElements {
  return {
    assistantTabButton: document.querySelector<HTMLButtonElement>("#tab-assistant"),
    sessionsTabButton: document.querySelector<HTMLButtonElement>("#tab-sessions"),
    authorizationTabButton: document.querySelector<HTMLButtonElement>("#tab-auth"),
    assistantPanel: document.querySelector<HTMLElement>("#panel-assistant"),
    sessionsPanel: document.querySelector<HTMLElement>("#panel-sessions"),
    authorizationPanel: document.querySelector<HTMLElement>("#panel-auth"),
    statusText: document.querySelector<HTMLSpanElement>("#status-text"),
    sendButton: document.querySelector<HTMLButtonElement>("#send-button"),
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

function formatSelectedTargetStorageWarning(errorMessage: string): string {
  return `Предупреждение хранилища: не удалось сохранить выбранную цель. ${errorMessage}`;
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

function setPanelState(panel: HTMLElement | null, button: HTMLButtonElement | null, active: boolean): void {
  if (panel) {
    panel.hidden = !active;
  }

  if (button) {
    button.setAttribute("aria-selected", String(active));
    button.className = active ? "tab-button tab-button--active" : "tab-button";
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

function chooseSelectedTargetId(
  targets: TargetMetadata[],
  preferredTargetIds: Array<string | undefined>,
): string | undefined {
  for (const candidate of preferredTargetIds) {
    if (candidate && findTargetById(candidate, targets)) {
      return candidate;
    }
  }

  return undefined;
}

async function loadStoredSelectedTargetId(): Promise<string | undefined> {
  try {
    const storedValues = await chrome.storage.local.get(SELECTED_TARGET_STORAGE_KEY);
    const storedTargetId = storedValues[SELECTED_TARGET_STORAGE_KEY];
    return typeof storedTargetId === "string" && storedTargetId.trim().length > 0
      ? storedTargetId.trim()
      : undefined;
  } catch {
    return undefined;
  }
}

async function persistSelectedTargetId(targetId: string): Promise<void> {
  await chrome.storage.local.set({ [SELECTED_TARGET_STORAGE_KEY]: targetId });
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

function isBrowserAuthorizationError(error: string | undefined): boolean {
  return typeof error === "string" && error.includes(BROWSER_NOT_AUTHORIZED_ERROR);
}

function updateSendButton(elements: SidePanelElements): void {
  if (!elements.sendButton) {
    return;
  }

  const hasSelectedTarget = findTargetById(currentSelectedTargetId, currentTargets) !== undefined;
  const tokenReady = currentTokenConfigured !== false;
  const sendReady = hasSelectedTarget && tokenReady;

  elements.sendButton.disabled = !sendReady;
  elements.sendButton.setAttribute("aria-disabled", String(!sendReady));

  if (!hasSelectedTarget) {
    elements.sendButton.title = NO_TARGET_BUTTON_LABEL;
    return;
  }

  elements.sendButton.title = tokenReady ? START_PICKER_BUTTON_LABEL : TOKEN_REQUIRED_GUIDANCE;
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
      void setSelectedTarget(elements, target.targetId);
    });

    fragment.append(option);
  });

  elements.targetContainer.replaceChildren(fragment);
}

function setSelectedTarget(
  elements: SidePanelElements,
  targetId: string | undefined,
  options: { persist?: boolean } = {},
): void {
  currentSelectedTargetId = targetId;
  renderTargetList(elements);
  updateSendButton(elements);

  if (options.persist !== false && targetId) {
    void persistSelectedTargetId(targetId).catch(() => {
      // Preserve the in-memory selection even if storage is temporarily unavailable.
    });
  }
}

function appendBrokerError(diagnostics: DiagnosticEntry[], brokerError: string): string {
  const baseDiagnostics = formatDiagnostics(diagnostics);
  return `${baseDiagnostics}\n\nОшибка broker: ${brokerError}`;
}

function updateConnectedStatus(elements: SidePanelElements, response: ListTargetsResponse): void {
  if (response.tokenConfigured === false) {
    setStatus(elements, `${formatConnectionStatus(response)} · ${TOKEN_REQUIRED_GUIDANCE}`);
    return;
  }

  if (isBrowserAuthorizationError(response.error)) {
    setStatus(elements, AUTH_REQUIRED_GUIDANCE);
    return;
  }

  if (!findTargetById(currentSelectedTargetId, currentTargets)) {
    setStatus(elements, `${formatConnectionStatus(response)} · ${SELECT_TARGET_PROMPT}`);
    return;
  }

  setStatus(elements, formatConnectionStatus(response));
}

function setAuthButtonsPending(elements: SidePanelElements, pending: boolean): void {
  setButtonDisabled(elements.copyBrowserTokenButton, pending);
  setButtonDisabled(elements.regenerateBrowserTokenButton, pending);
  setButtonDisabled(elements.clearBrowserTokenButton, pending);
}

function renderBrowserAuthState(elements: SidePanelElements, response: BrowserAuthStateResponse): void {
  currentBrowserAuthState = response;
  authStateLoaded = true;
  authMutationPending = false;

  const token = typeof response.browserToken === "string" && response.browserToken.length > 0
    ? response.browserToken
    : undefined;

  if (!response.ok) {
    setAuthStatus(elements, response.error ?? AUTH_TAB_ERROR_TEXT);
    setBrowserTokenOutput(elements, TOKEN_NOT_LOADED_LABEL);
    setButtonDisabled(elements.copyBrowserTokenButton, true);
    setButtonDisabled(elements.clearBrowserTokenButton, true);
    setButtonDisabled(elements.regenerateBrowserTokenButton, false);
    return;
  }

  if (!response.tokenConfigured || !token) {
    setAuthStatus(elements, AUTH_TAB_CLEARED_TEXT);
    setBrowserTokenOutput(elements, TOKEN_REMOVED_LABEL);
    setButtonDisabled(elements.copyBrowserTokenButton, true);
    setButtonDisabled(elements.clearBrowserTokenButton, true);
    setButtonDisabled(elements.regenerateBrowserTokenButton, false);
    return;
  }

  setAuthStatus(elements, AUTH_TAB_READY_TEXT);
  setBrowserTokenOutput(elements, token);
  setButtonDisabled(elements.copyBrowserTokenButton, false);
  setButtonDisabled(elements.clearBrowserTokenButton, false);
  setButtonDisabled(elements.regenerateBrowserTokenButton, false);
}

function startAuthRequest(): number {
  authRequestId += 1;
  return authRequestId;
}

function isLatestAuthRequest(requestId: number): boolean {
  return requestId === authRequestId;
}

async function refreshBrowserAuthState(elements: SidePanelElements, force = false): Promise<void> {
  if (!force && authStateLoaded) {
    renderBrowserAuthState(elements, currentBrowserAuthState ?? { ok: true, tokenConfigured: false });
    return;
  }

  const requestId = startAuthRequest();
  authStateLoaded = false;
  setAuthStatus(elements, AUTH_TAB_LOADING_TEXT);
  setBrowserTokenOutput(elements, TOKEN_NOT_LOADED_LABEL);
  setButtonDisabled(elements.copyBrowserTokenButton, true);
  setButtonDisabled(elements.clearBrowserTokenButton, true);
  setButtonDisabled(elements.regenerateBrowserTokenButton, authMutationPending);

  try {
    const response = (await chrome.runtime.sendMessage({ type: "getBrowserAuthState" })) as BrowserAuthStateResponse | undefined;

    if (!isLatestAuthRequest(requestId)) {
      return;
    }

    renderBrowserAuthState(elements, response ?? { ok: false, error: AUTH_TAB_ERROR_TEXT, tokenConfigured: false });
  } catch (error) {
    if (!isLatestAuthRequest(requestId)) {
      return;
    }

    const errorMessage = error instanceof Error ? error.message : String(error);
    renderBrowserAuthState(elements, {
      ok: false,
      error: errorMessage || AUTH_TAB_ERROR_TEXT,
      tokenConfigured: false,
    });
  }
}

async function regenerateBrowserTokenForSidePanel(elements: SidePanelElements): Promise<void> {
  if (authMutationPending) {
    return;
  }

  const requestId = startAuthRequest();
  authMutationPending = true;
  setAuthStatus(elements, "Генерируем новый токен браузера...");
  setAuthButtonsPending(elements, true);

  try {
    const response = (await chrome.runtime.sendMessage({ type: "regenerateBrowserToken" })) as BrowserAuthStateResponse | undefined;

    if (!isLatestAuthRequest(requestId)) {
      return;
    }

    renderBrowserAuthState(elements, response ?? { ok: false, error: AUTH_TAB_ERROR_TEXT, tokenConfigured: false });
  } catch (error) {
    if (!isLatestAuthRequest(requestId)) {
      return;
    }

    renderBrowserAuthState(elements, {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      tokenConfigured: false,
    });
  }
}

async function clearBrowserTokenForSidePanel(elements: SidePanelElements): Promise<void> {
  if (authMutationPending) {
    return;
  }

  const requestId = startAuthRequest();
  authMutationPending = true;
  setAuthStatus(elements, "Удаляем токен браузера...");
  setAuthButtonsPending(elements, true);

  try {
    const response = (await chrome.runtime.sendMessage({ type: "clearBrowserToken" })) as BrowserAuthStateResponse | undefined;

    if (!isLatestAuthRequest(requestId)) {
      return;
    }

    renderBrowserAuthState(elements, response ?? { ok: true, tokenConfigured: false });
  } catch (error) {
    if (!isLatestAuthRequest(requestId)) {
      return;
    }

    renderBrowserAuthState(elements, {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      tokenConfigured: false,
    });
  }
}

async function copyBrowserToken(elements: SidePanelElements): Promise<void> {
  const token = currentBrowserAuthState?.browserToken;

  if (!token) {
    setAuthStatus(elements, AUTH_TAB_COPY_UNAVAILABLE_TEXT);
    return;
  }

  try {
    if (typeof navigator === "undefined" || !navigator.clipboard?.writeText) {
      throw new Error(AUTH_TAB_COPY_UNAVAILABLE_TEXT);
    }

    await navigator.clipboard.writeText(token);
    setAuthStatus(elements, AUTH_TAB_COPY_SUCCESS_TEXT);
  } catch {
    setAuthStatus(elements, AUTH_TAB_COPY_UNAVAILABLE_TEXT);
  }
}

function activateTab(elements: SidePanelElements, tab: SidePanelTab): void {
  currentActiveTab = tab;

  setPanelState(elements.assistantPanel, elements.assistantTabButton, tab === "assistant");
  setPanelState(elements.sessionsPanel, elements.sessionsTabButton, tab === "sessions");
  setPanelState(elements.authorizationPanel, elements.authorizationTabButton, tab === "auth");

  if (tab === "auth") {
    void refreshBrowserAuthState(elements);
  }
}

export async function refreshSidePanelState(elements = getSidePanelElements()): Promise<void> {
  updateSendButton(elements);
  const refreshRequestId = ++currentRefreshRequestId;

  try {
    const inMemorySelectedTargetId = currentSelectedTargetId;
    const [targetsResponse, diagnosticsResponse] = await Promise.all([
      chrome.runtime.sendMessage({ type: "listTargets" }) as Promise<ListTargetsResponse | undefined>,
      chrome.runtime.sendMessage({ type: "getDiagnostics" }) as Promise<GetDiagnosticsResponse | undefined>,
    ]);

    if (refreshRequestId !== currentRefreshRequestId) {
      return;
    }

    const diagnostics = diagnosticsResponse?.diagnostics ?? [];

    currentTargets = targetsResponse?.targets ?? [];
    currentSelectedTargetId = chooseSelectedTargetId(currentTargets, [
      inMemorySelectedTargetId,
      targetsResponse?.selectedTargetId,
    ]);
    currentTokenConfigured = targetsResponse?.tokenConfigured;

    setStatus(elements, formatConnectionStatus(targetsResponse ?? {}));

    if (!targetsResponse?.ok) {
      const baseDiagnostics = targetsResponse?.error
        ? appendBrokerError(diagnostics, targetsResponse.error)
        : formatDiagnostics(diagnostics);

      if (targetsResponse?.tokenConfigured === false) {
        renderTargetPlaceholder(elements, TOKEN_REQUIRED_GUIDANCE, "warning");
        updateSendButton(elements);
        setStatus(elements, TOKEN_REQUIRED_GUIDANCE);
        setBaseDiagnostics(elements, appendDiagnosticsNote(baseDiagnostics, TOKEN_REQUIRED_GUIDANCE));
        return;
      }

      if (isBrowserAuthorizationError(targetsResponse?.error)) {
        renderTargetPlaceholder(elements, AUTH_REQUIRED_GUIDANCE, "warning");
        updateSendButton(elements);
        setStatus(elements, AUTH_REQUIRED_GUIDANCE);
        setBaseDiagnostics(elements, appendDiagnosticsNote(baseDiagnostics, AUTH_REQUIRED_GUIDANCE));
        return;
      }

      renderTargetPlaceholder(elements, BROKER_UNAVAILABLE_GUIDANCE, "warning");
      updateSendButton(elements);
      setStatus(elements, BROKER_UNAVAILABLE_GUIDANCE);
      setBaseDiagnostics(elements, baseDiagnostics);
      return;
    }

    if (currentTargets.length === 0) {
      renderTargetPlaceholder(elements, NO_TARGETS_GUIDANCE);
      updateSendButton(elements);
      setBaseDiagnostics(elements, formatDiagnostics(diagnostics));
      return;
    }

    setSelectedTarget(elements, currentSelectedTargetId, { persist: false });
    setBaseDiagnostics(
      elements,
      targetsResponse.tokenConfigured === false
        ? appendDiagnosticsNote(formatDiagnostics(diagnostics), TOKEN_REQUIRED_GUIDANCE)
        : formatDiagnostics(diagnostics),
    );
    updateConnectedStatus(elements, targetsResponse);

    const selectedTargetIdBeforeStoredLoad = currentSelectedTargetId;

    void loadStoredSelectedTargetId()
      .then((storedSelectedTargetId) => {
        if (refreshRequestId !== currentRefreshRequestId) {
          return;
        }

        if (currentSelectedTargetId !== selectedTargetIdBeforeStoredLoad) {
          return;
        }

        const nextSelectedTargetId = chooseSelectedTargetId(currentTargets, [
          inMemorySelectedTargetId,
          storedSelectedTargetId,
          targetsResponse.selectedTargetId,
        ]);

        if (nextSelectedTargetId === currentSelectedTargetId) {
          return;
        }

        setSelectedTarget(elements, nextSelectedTargetId, { persist: false });
        updateConnectedStatus(elements, targetsResponse);
      })
      .catch(() => {
        // Ignore storage read failures so side panel state stays responsive.
      });
  } catch (error) {
    if (refreshRequestId !== currentRefreshRequestId) {
      return;
    }

    const errorMessage = error instanceof Error ? error.message : String(error);

    currentTargets = [];
    currentSelectedTargetId = undefined;
    currentTokenConfigured = undefined;
    renderTargetPlaceholder(elements, BROKER_UNAVAILABLE_GUIDANCE, "warning");
    updateSendButton(elements);
    setStatus(elements, "Фоновый скрипт недоступен");
    setBaseDiagnostics(elements, errorMessage);

    if (elements.sendButton) {
      elements.sendButton.title = SIDEPANEL_UNAVAILABLE_BUTTON_LABEL;
    }
  }
}

function initializeSidePanel(): void {
  const elements = getSidePanelElements();

  activateTab(elements, "assistant");
  updateSendButton(elements);
  renderBrowserAuthState(elements, { ok: true, tokenConfigured: false });
  authStateLoaded = false;

  elements.assistantTabButton?.addEventListener("click", () => {
    activateTab(elements, "assistant");
  });

  elements.sessionsTabButton?.addEventListener("click", () => {
    activateTab(elements, "sessions");
  });

  elements.authorizationTabButton?.addEventListener("click", () => {
    activateTab(elements, "auth");
  });

  elements.diagnosticsButton?.addEventListener("click", async () => {
    setStatus(elements, "Обновляем диагностику...");
    await refreshSidePanelState(elements);
  });

  elements.copyBrowserTokenButton?.addEventListener("click", () => {
    void copyBrowserToken(elements);
  });

  elements.regenerateBrowserTokenButton?.addEventListener("click", () => {
    void regenerateBrowserTokenForSidePanel(elements);
  });

  elements.clearBrowserTokenButton?.addEventListener("click", () => {
    void clearBrowserTokenForSidePanel(elements);
  });

  elements.sendButton?.addEventListener("click", async () => {
    const sendButton = elements.sendButton;
    const selectedTarget = findTargetById(currentSelectedTargetId, currentTargets);

    if (!sendButton || !selectedTarget || currentTokenConfigured === false) {
      if (currentTokenConfigured === false) {
        setStatus(elements, TOKEN_REQUIRED_GUIDANCE);
        setDiagnostics(elements, appendDiagnosticsNote(currentDiagnosticsBaseText, TOKEN_REQUIRED_GUIDANCE));
      }

      updateSendButton(elements);
      return;
    }

    try {
      sendButton.disabled = true;
      sendButton.setAttribute("aria-disabled", "true");
      setStatus(elements, `Запускаем DOM picker · ${formatTargetPrimaryLabel(selectedTarget)}`);

      let storageWarning: string | undefined;
      const selectedTargetId = selectedTarget.targetId;
      const storagePersistence = persistSelectedTargetId(selectedTargetId)
        .then(() => undefined)
        .catch((error) => {
          const errorMessage = error instanceof Error ? error.message : String(error);
          storageWarning = formatSelectedTargetStorageWarning(errorMessage);
          return storageWarning;
        });

      const response = (await chrome.runtime.sendMessage({
        type: "startDomPicker",
        targetId: selectedTargetId,
      })) as StartDomPickerResponse | undefined;

      if (!response?.ok) {
        const errorMessage = response?.error ?? "Не удалось запустить DOM picker.";
        setStatus(elements, "Не удалось запустить DOM picker");
        setPickerErrorDiagnostics(elements, errorMessage);
        return;
      }

      setStatus(elements, START_PICKER_PROMPT);
      setDiagnostics(
        elements,
        storageWarning ? appendDiagnosticsNote(currentDiagnosticsBaseText, storageWarning) : currentDiagnosticsBaseText,
      );

      void storagePersistence.then((resolvedStorageWarning) => {
        if (!resolvedStorageWarning) {
          return;
        }

        if (currentSelectedTargetId !== selectedTargetId) {
          return;
        }

        setDiagnostics(elements, appendDiagnosticsNote(currentDiagnosticsBaseText, resolvedStorageWarning));
      });

      // Боковая панель остаётся открытой, пока пользователь выбирает DOM-элемент на странице.
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      setStatus(elements, "Не удалось запустить DOM picker");
      setPickerErrorDiagnostics(elements, errorMessage);
    } finally {
      updateSendButton(elements);
    }
  });

  void refreshSidePanelState(elements);
}

if (typeof document !== "undefined") {
  initializeSidePanel();
}
