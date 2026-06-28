import { buildSelectionPayload } from "./domPicker";
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

function startDomPicker(): void {
  stopActivePicker();

  let isActive = true;
  let modalOpen = false;
  let currentSelection: Element | undefined;

  const overlay = createSelectionOverlay();

  function openCommentModal(logicalSelection: Element): void {
    if (!isActive || modalOpen) return;

    modalOpen = true;
    overlay.update(logicalSelection, true);

    overlay.showCommentModal({
      onCancel: () => {
        cleanup();
      },
      onSubmit: (comment) => {
        void (async () => {
          try {
            const selection = buildSelectionPayload(logicalSelection, comment);
            const response = (await chrome.runtime.sendMessage({
              type: "sendSelection",
              selection,
            })) as SendSelectionResponse;

            if (response?.ok) {
              showToast(SEND_SELECTION_SUCCESS_TOAST_MESSAGE, "success");
            } else {
              const rawErrorMessage = response?.error ?? "Не удалось отправить выделение в Pi.";
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
  }

  function applySelection(target: Element, selected = false): void {
    currentSelection = target;
    overlay.update(target, selected);
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
    document.removeEventListener("visibilitychange", handleVisibilityChange, true);
    overlay.cleanup();

    if (pickerWindow[PICKER_SESSION_KEY]?.cleanup === cleanup) {
      pickerWindow[PICKER_SESSION_KEY] = undefined;
    }
  };

  const handleMouseMove = (event: MouseEvent) => {
    if (!isActive || modalOpen) {
      return;
    }

    overlay.updatePointer(event.clientX, event.clientY);

    const hovered = event.target instanceof Element
      ? event.target
      : document.elementFromPoint(event.clientX, event.clientY);

    if (!hovered || isPickerUiElement(hovered)) {
      return;
    }

    applySelection(hovered);
  };

  const handleClick = (event: MouseEvent) => {
    if (!isActive || modalOpen) return;
    const target = event.target instanceof Element ? event.target : currentSelection;
    if (!target || isPickerUiElement(target)) return;

    event.preventDefault();
    event.stopPropagation();

    applySelection(target, true);
    openCommentModal(target);
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

  const handleVisibilityChange = () => {
    if (document.hidden) {
      cleanup();
    }
  };

  document.addEventListener("mousemove", handleMouseMove, true);
  document.addEventListener("click", handleClick, true);
  document.addEventListener("keydown", handleKeyDown, true);
  document.addEventListener("visibilitychange", handleVisibilityChange, true);
  pickerWindow[PICKER_SESSION_KEY] = {
    cleanup,
  };
}

if (!pickerWindow[CONTENT_SCRIPT_LISTENER_GUARD]) {
  pickerWindow[CONTENT_SCRIPT_LISTENER_GUARD] = true;

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "ping") {
      sendResponse({ ok: true, source: "contentScript" });
      return false;
    }

    if (message?.type === "stopDomPicker") {
      stopActivePicker();
      sendResponse({ ok: true, source: "contentScript" });
      return false;
    }

    if (message?.type !== "startDomPicker") {
      return false;
    }

    try {
      startDomPicker();
      sendResponse({ ok: true, source: "contentScript" });
    } catch (error) {
      const errorMessage = getErrorMessage(error);
      void reportPickerFailure("startDomPicker", error);
      sendResponse({ ok: false, error: errorMessage });
    }

    return false;
  });
}
