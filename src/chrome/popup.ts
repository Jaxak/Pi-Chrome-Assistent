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

type StartDomPickerResponse = {
  ok?: boolean;
  error?: string;
};

type PopupElements = {
  statusText: HTMLSpanElement | null;
  sendButton: HTMLButtonElement | null;
  diagnosticsButton: HTMLButtonElement | null;
  diagnosticsOutput: HTMLElement | null;
  targetContainer: HTMLElement | null;
};

const SELECTED_TARGET_STORAGE_KEY = "selectedTargetId";
const BROKER_UNAVAILABLE_GUIDANCE = "Pi не подключён. Выполните /browser-connect в терминале.";
const NO_TARGETS_GUIDANCE = "Нет активных целей. Выполните /browser-connect в нужной сессии Pi.";
const SELECT_TARGET_PROMPT = "Выберите цель Pi, затем нажмите «Отправить в Pi».";
const TOKEN_REQUIRED_GUIDANCE = "Для отправки настройте brokerToken в chrome.storage.local.";
const START_PICKER_PROMPT = "Выберите элемент на странице, чтобы отправить его в Pi.";
const START_PICKER_BUTTON_LABEL = "Запустить DOM picker на активной вкладке";
const NO_TARGET_BUTTON_LABEL = "Выберите цель Pi, чтобы включить кнопку «Отправить в Pi»";
const POPUP_UNAVAILABLE_BUTTON_LABEL = "Сейчас состояние popup недоступно";

let currentTargets: TargetMetadata[] = [];
let currentSelectedTargetId: string | undefined;
let currentTokenConfigured: boolean | undefined;
let currentDiagnosticsBaseText = "Недавних диагностических сообщений нет.";
let currentRefreshRequestId = 0;

function getPopupElements(): PopupElements {
  return {
    statusText: document.querySelector<HTMLSpanElement>("#status-text"),
    sendButton: document.querySelector<HTMLButtonElement>("#send-button"),
    diagnosticsButton: document.querySelector<HTMLButtonElement>("#diagnostics-button"),
    diagnosticsOutput: document.querySelector<HTMLElement>("#diagnostics-output"),
    targetContainer: document.querySelector<HTMLElement>("#target-container"),
  };
}

function setStatus(elements: PopupElements, message: string): void {
  if (elements.statusText) {
    elements.statusText.textContent = message;
  }
}

function setDiagnostics(elements: PopupElements, message: string): void {
  if (elements.diagnosticsOutput) {
    elements.diagnosticsOutput.textContent = message;
  }
}

function setBaseDiagnostics(elements: PopupElements, message: string): void {
  currentDiagnosticsBaseText = message;
  setDiagnostics(elements, message);
}

function appendDiagnosticsNote(baseMessage: string, note: string): string {
  return `${baseMessage}\n\n${note}`;
}

function setPickerErrorDiagnostics(elements: PopupElements, errorMessage: string): void {
  setDiagnostics(elements, appendDiagnosticsNote(currentDiagnosticsBaseText, `Ошибка DOM picker: ${errorMessage}`));
}

function formatSelectedTargetStorageWarning(errorMessage: string): string {
  return `Предупреждение хранилища: не удалось сохранить выбранную цель. ${errorMessage}`;
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

function setSelectedTarget(
  elements: PopupElements,
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

function updateSendButton(elements: PopupElements): void {
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

function renderTargetPlaceholder(elements: PopupElements, message: string, tone: "default" | "warning" = "default"): void {
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

function renderTargetList(elements: PopupElements): void {
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

function appendBrokerError(diagnostics: DiagnosticEntry[], brokerError: string): string {
  const baseDiagnostics = formatDiagnostics(diagnostics);
  return `${baseDiagnostics}\n\nОшибка broker: ${brokerError}`;
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
    `brokerToken настроен: ${response.tokenConfigured ? "да" : "нет"}`,
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

function updateConnectedStatus(elements: PopupElements, response: ListTargetsResponse): void {
  if (response.tokenConfigured === false) {
    setStatus(elements, `${formatConnectionStatus(response)} · ${TOKEN_REQUIRED_GUIDANCE}`);
    return;
  }

  if (!findTargetById(currentSelectedTargetId, currentTargets)) {
    setStatus(elements, `${formatConnectionStatus(response)} · ${SELECT_TARGET_PROMPT}`);
    return;
  }

  setStatus(elements, formatConnectionStatus(response));
}

export async function refreshPopupState(elements = getPopupElements()): Promise<void> {
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

      renderTargetPlaceholder(elements, BROKER_UNAVAILABLE_GUIDANCE, "warning");
      updateSendButton(elements);
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
        // Ignore storage read failures so popup state stays responsive.
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
      elements.sendButton.title = POPUP_UNAVAILABLE_BUTTON_LABEL;
    }
  }
}

function initializePopup(): void {
  const elements = getPopupElements();

  updateSendButton(elements);

  elements.diagnosticsButton?.addEventListener("click", async () => {
    setStatus(elements, "Обновляем диагностику...");
    await refreshPopupState(elements);
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

      window.close();
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      setStatus(elements, "Не удалось запустить DOM picker");
      setPickerErrorDiagnostics(elements, errorMessage);
    } finally {
      updateSendButton(elements);
    }
  });

  void refreshPopupState(elements);
}

if (typeof document !== "undefined") {
  initializePopup();
}
