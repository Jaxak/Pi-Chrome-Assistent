// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";

type RuntimeMessage = {
  type?: string;
  targetId?: string;
  selection?: unknown;
  phase?: string;
  message?: string;
  url?: string;
};

type RuntimeMessageListener = (
  message: RuntimeMessage,
  sender: chrome.runtime.MessageSender,
  sendResponse: (response?: unknown) => void,
) => boolean | void;

declare global {
  interface Window {
    __PI_CONTENT_SCRIPT_PLACEHOLDER_LISTENER_REGISTERED__?: boolean;
    __PI_DOM_PICKER_SESSION__?: unknown;
  }
}

const selectionPayload = {
  url: "https://example.com/article",
  title: "Example article",
  selectedText: "Selected text",
  selectedHtml: "<article>Selected text</article>",
  selector: "#selected",
  capturedAt: 1_710_000_000_000,
};

function flushAsyncWork(): Promise<void> {
  return Promise.resolve().then(() => Promise.resolve()).then(() => Promise.resolve());
}

describe("contentScript", () => {
  afterEach(() => {
    document.documentElement.innerHTML = "";
    delete (globalThis as Record<string, unknown>).chrome;
    delete window.__PI_CONTENT_SCRIPT_PLACEHOLDER_LISTENER_REGISTERED__;
    delete window.__PI_DOM_PICKER_SESSION__;
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it("uses the recommended candidate first and widens selection on overlay request", async () => {
    let overlayCallbacks:
      | {
        onNarrow(): void;
        onWiden(): void;
        onConfirm(): void;
        onCancel(): void;
      }
      | undefined;

    const update = vi.fn();
    const setNavigationState = vi.fn();
    const messageListeners: RuntimeMessageListener[] = [];

    document.body.innerHTML = `
      <div id="small">Small</div>
      <article id="medium">Medium</article>
      <section id="large">Large</section>
      <div id="start">Start</div>
    `;

    const smallEl = document.querySelector("#small") as Element;
    const mediumEl = document.querySelector("#medium") as Element;
    const largeEl = document.querySelector("#large") as Element;

    vi.doMock("./selectionOverlay", () => ({
      createSelectionOverlay: (callbacks: NonNullable<typeof overlayCallbacks>) => {
        overlayCallbacks = callbacks;
        return {
          update,
          setNavigationState,
          showCommentModal: vi.fn(() => ({ close: vi.fn() })),
          cleanup: vi.fn(),
        };
      },
      isPickerUiElement: () => false,
    }));
    vi.doMock("./domPicker", () => ({
      getSelectionCandidates: vi.fn(() => ({
        candidates: [smallEl, mediumEl, largeEl],
        recommendedIndex: 1,
      })),
      buildSelectionPayload: vi.fn(() => selectionPayload),
      findLogicalSelectionElement: vi.fn((element: Element) => element),
    }));
    vi.doMock("./toast", () => ({ showToast: vi.fn() }));

    (globalThis as Record<string, unknown>).chrome = {
      runtime: {
        onMessage: {
          addListener: vi.fn((listener: RuntimeMessageListener) => {
            messageListeners.push(listener);
          }),
        },
        sendMessage: vi.fn(async () => ({ ok: true })),
      },
    };

    await import("./contentScript");

    const startResponse = vi.fn();
    messageListeners[0]?.(
      { type: "startDomPicker", targetId: "target-123" },
      {} as chrome.runtime.MessageSender,
      startResponse,
    );

    const hoveredElement = document.querySelector("#start");
    hoveredElement?.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, cancelable: true }));

    expect(update).toHaveBeenCalledWith(mediumEl);
    expect(setNavigationState).toHaveBeenCalledWith({ canNarrow: true, canWiden: true });

    overlayCallbacks?.onWiden();

    expect(update).toHaveBeenLastCalledWith(largeEl);
    expect(setNavigationState).toHaveBeenLastCalledWith({ canNarrow: true, canWiden: false });
  });

  it("sends payload for the current candidate after confirm", async () => {
    let overlayCallbacks:
      | {
        onNarrow(): void;
        onWiden(): void;
        onConfirm(): void;
        onCancel(): void;
      }
      | undefined;
    let onSubmit: ((comment: string) => void) | undefined;

    const update = vi.fn();
    const setNavigationState = vi.fn();
    const showCommentModal = vi.fn(({ onSubmit: submit }: { onSubmit(comment: string): void; onCancel(): void }) => {
      onSubmit = submit;
      return { close: vi.fn() };
    });
    const showToast = vi.fn();
    const buildSelectionPayload = vi.fn(() => selectionPayload);
    const runtimeSendMessage = vi.fn(async (message: RuntimeMessage) => {
      if (message.type === "sendSelection") {
        return { ok: true };
      }

      if (message.type === "pickerDiagnostic") {
        return { ok: true };
      }

      throw new Error(`Unexpected runtime message: ${message.type}`);
    });
    const messageListeners: RuntimeMessageListener[] = [];

    document.body.innerHTML = `
      <div id="small">Small</div>
      <article id="medium">Medium</article>
      <section id="large">Large</section>
      <div id="start">Start</div>
    `;

    const smallEl = document.querySelector("#small") as Element;
    const mediumEl = document.querySelector("#medium") as Element;
    const largeEl = document.querySelector("#large") as Element;

    vi.doMock("./selectionOverlay", () => ({
      createSelectionOverlay: (callbacks: NonNullable<typeof overlayCallbacks>) => {
        overlayCallbacks = callbacks;
        return {
          update,
          setNavigationState,
          showCommentModal,
          cleanup: vi.fn(),
        };
      },
      isPickerUiElement: () => false,
    }));
    vi.doMock("./domPicker", () => ({
      getSelectionCandidates: vi.fn(() => ({
        candidates: [smallEl, mediumEl, largeEl],
        recommendedIndex: 1,
      })),
      buildSelectionPayload,
      findLogicalSelectionElement: vi.fn((element: Element) => element),
    }));
    vi.doMock("./toast", () => ({ showToast }));

    (globalThis as Record<string, unknown>).chrome = {
      runtime: {
        onMessage: {
          addListener: vi.fn((listener: RuntimeMessageListener) => {
            messageListeners.push(listener);
          }),
        },
        sendMessage: runtimeSendMessage,
      },
    };

    await import("./contentScript");

    const startResponse = vi.fn();
    messageListeners[0]?.(
      { type: "startDomPicker", targetId: "target-123" },
      {} as chrome.runtime.MessageSender,
      startResponse,
    );

    const hoveredElement = document.querySelector("#start");
    hoveredElement?.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, cancelable: true }));
    overlayCallbacks?.onWiden();
    overlayCallbacks?.onConfirm();

    expect(showCommentModal).toHaveBeenCalledTimes(1);
    expect(onSubmit).toBeTypeOf("function");

    onSubmit?.("Explain this");
    await flushAsyncWork();

    expect(buildSelectionPayload).toHaveBeenCalledWith(largeEl, "Explain this");
    expect(runtimeSendMessage).toHaveBeenCalledWith({
      type: "sendSelection",
      targetId: "target-123",
      selection: selectionPayload,
    });
    expect(showToast).toHaveBeenCalledWith("Отправлено в Pi", "success");
    expect(update).toHaveBeenCalledWith(mediumEl);
    expect(setNavigationState).toHaveBeenCalledWith({ canNarrow: true, canWiden: true });
  });
});
