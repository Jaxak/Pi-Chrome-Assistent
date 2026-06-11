import { buildSelectionPayload, getSelectionCandidates } from "./domPicker";
import {
  formatSendSelectionErrorToastMessage,
  SEND_SELECTION_SUCCESS_TOAST_MESSAGE,
} from "./contentScriptMessages";
import { createSelectionOverlay, isPickerUiElement } from "./selectionOverlay";
import { showToast } from "./toast";

const CONTENT_SCRIPT_LISTENER_GUARD = "__PI_CONTENT_SCRIPT_PLACEHOLDER_LISTENER_REGISTERED__";
const PICKER_SESSION_KEY = "__PI_DOM_PICKER_SESSION__";

type PickerSessionState = {
  cleanup: () => void;
  targetId: string;
};

type PickerWindow = Window & {
  [CONTENT_SCRIPT_LISTENER_GUARD]?: boolean;
  [PICKER_SESSION_KEY]?: PickerSessionState | undefined;
};

type SendSelectionResponse = {
  ok?: boolean;
  error?: string;
};

const pickerWindow = window as PickerWindow;

function getErrorMessage(error: unknown): string {
  return error instanceof Error && error.message.length > 0 ? error.message : String(error);
}

function normalizeTargetId(targetId: unknown): string | undefined {
  return typeof targetId === "string" && targetId.trim().length > 0 ? targetId.trim() : undefined;
}

async function reportPickerFailure(phase: string, error: unknown): Promise<void> {
  const message = getErrorMessage(error);

  try {
    await chrome.runtime.sendMessage({
      type: "pickerDiagnostic",
      phase,
      message,
      url: window.location.href,
    });
  } catch {
    console.error(`[Pi DOM picker] ${phase}: ${message}`);
  }
}

function stopActivePicker(): void {
  pickerWindow[PICKER_SESSION_KEY]?.cleanup();
  pickerWindow[PICKER_SESSION_KEY] = undefined;
}

function startDomPicker(targetId: string): void {
  stopActivePicker();

  let isActive = true;
  let modalOpen = false;
  let state: 'hover' | 'selected' = 'hover';
  let currentCandidates: Element[] = [];
  let currentIndex = 0;

  const overlay = createSelectionOverlay({
    onNarrow: () => {
      if (state !== 'selected' || !isActive || modalOpen || currentIndex <= 0) {
        return;
      }

      currentIndex -= 1;
      updateCurrentSelection();
    },
    onChange: () => {
      if (!isActive) return;
      state = 'hover';
      overlay.hidePanel();
      const current = getCurrentSelection();
      if (current) overlay.update(current, false);
    },
    onWiden: () => {
      if (state !== 'selected' || !isActive || modalOpen || currentIndex >= currentCandidates.length - 1) {
        return;
      }

      currentIndex += 1;
      updateCurrentSelection();
    },
    onConfirm: () => {
      if (!isActive || modalOpen) {
        return;
      }

      const logicalSelection = getCurrentSelection();

      if (!logicalSelection) {
        return;
      }

      modalOpen = true;
      overlay.showCommentModal({
        onCancel: () => {
          cleanup();
        },
        onSubmit: (comment) => {
          modalOpen = false;

          void (async () => {
            try {
              const activeTargetId = pickerWindow[PICKER_SESSION_KEY]?.targetId;

              if (!activeTargetId) {
                throw new Error("No selected target configured for picker session");
              }

              const selection = buildSelectionPayload(logicalSelection, comment);
              const response = (await chrome.runtime.sendMessage({
                type: "sendSelection",
                targetId: activeTargetId,
                selection,
              })) as SendSelectionResponse;

              if (response?.ok) {
                showToast(SEND_SELECTION_SUCCESS_TOAST_MESSAGE, "success");
              } else {
                const rawErrorMessage = response?.error ?? "Unable to send selection to Pi.";
                showToast(formatSendSelectionErrorToastMessage(rawErrorMessage), "error");
                await reportPickerFailure("sendSelection", rawErrorMessage);
              }
            } catch (error) {
              showToast(formatSendSelectionErrorToastMessage(error), "error");
              await reportPickerFailure("sendSelection", error);
            } finally {
              cleanup();
            }
          })();
        },
      });
    },
    onCancel: () => {
      cleanup();
    },
    onUp: () => {
      // Up navigation will be implemented in a follow-up task
    },
    onDown: () => {
      // Down navigation will be implemented in a follow-up task
    },
  });

  function getCurrentSelection(): Element | undefined {
    return currentCandidates[currentIndex];
  }

  function updateCurrentSelection(): void {
    const currentSelection = getCurrentSelection();

    if (!currentSelection) {
      overlay.setNavigationState({ canNarrow: false, canWiden: false, canGoUp: false, canGoDown: false });
      return;
    }

    overlay.update(currentSelection, state === 'selected');
    overlay.setNavigationState({
      canNarrow: currentIndex > 0,
      canWiden: currentIndex < currentCandidates.length - 1,
      canGoUp: false,
      canGoDown: false,
    });
  }

  function applyCandidates(hovered: Element): void {
    const result = getSelectionCandidates(hovered);
    currentCandidates = result.candidates.length > 0 ? result.candidates : [hovered];
    currentIndex = Math.min(Math.max(result.recommendedIndex, 0), currentCandidates.length - 1);
    updateCurrentSelection();
  }

  const cleanup = () => {
    if (!isActive) {
      return;
    }

    isActive = false;
    modalOpen = false;
    document.removeEventListener("mousemove", handleMouseMove, true);
    document.removeEventListener("click", handleClick, true);
    document.removeEventListener("keydown", handleKeyDown, true);
    overlay.cleanup();

    if (pickerWindow[PICKER_SESSION_KEY]?.cleanup === cleanup) {
      pickerWindow[PICKER_SESSION_KEY] = undefined;
    }
  };

  const handleMouseMove = (event: MouseEvent) => {
    if (state !== 'hover' || !isActive || modalOpen) {
      return;
    }

    const hovered = event.target instanceof Element
      ? event.target
      : document.elementFromPoint(event.clientX, event.clientY);

    if (!hovered || isPickerUiElement(hovered)) {
      return;
    }

    applyCandidates(hovered);
  };

  const handleClick = (event: MouseEvent) => {
    if (state !== 'hover' || !isActive || modalOpen) return;
    const target = event.target instanceof Element ? event.target : null;
    if (!target || isPickerUiElement(target)) return;

    state = 'selected';
    applyCandidates(target);
    overlay.showPanel();
  };

  const handleKeyDown = (event: KeyboardEvent) => {
    if (!isActive) {
      return;
    }

    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      cleanup();
    }
  };

  document.addEventListener("mousemove", handleMouseMove, true);
  document.addEventListener("click", handleClick, true);
  document.addEventListener("keydown", handleKeyDown, true);
  pickerWindow[PICKER_SESSION_KEY] = {
    cleanup,
    targetId,
  };
}

if (!pickerWindow[CONTENT_SCRIPT_LISTENER_GUARD]) {
  pickerWindow[CONTENT_SCRIPT_LISTENER_GUARD] = true;

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== "startDomPicker") {
      return false;
    }

    try {
      const targetId = normalizeTargetId((message as { targetId?: unknown }).targetId);

      if (!targetId) {
        throw new Error("No selected target provided for DOM picker startup");
      }

      startDomPicker(targetId);
      sendResponse({ ok: true, source: "contentScript" });
    } catch (error) {
      const errorMessage = getErrorMessage(error);
      void reportPickerFailure("startDomPicker", error);
      sendResponse({ ok: false, error: errorMessage });
    }

    return false;
  });
}
