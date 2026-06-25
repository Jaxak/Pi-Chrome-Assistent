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

  it("sends payload for the exact clicked element from the comment modal", async () => {
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
      <section id="outer">
        <article id="inner">
          <div id="start">Start</div>
        </article>
      </section>
    `;

    const startEl = document.querySelector("#start") as Element;

    vi.doMock("./selectionOverlay", () => ({
      createSelectionOverlay: () => ({
        update,
        updatePointer: vi.fn(),
        setNavigationState,
        showCommentModal,
        cleanup: vi.fn(),
      }),
      isPickerUiElement: () => false,
    }));
    vi.doMock("./domPicker", () => ({
      buildSelectionPayload,
      findBestVisibleChild: vi.fn(() => null),
      getParentElement: vi.fn(() => null),
      findSiblingElements: vi.fn(() => ({ elements: [], currentIndex: -1 })),
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

    startEl.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, cancelable: true }));
    startEl.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));

    expect(showCommentModal).toHaveBeenCalledTimes(1);
    expect(onSubmit).toBeTypeOf("function");

    onSubmit?.("Explain this");
    await flushAsyncWork();

    expect(buildSelectionPayload).toHaveBeenCalledWith(startEl, "Explain this");
    expect(runtimeSendMessage).toHaveBeenCalledWith({
      type: "sendSelection",
      targetId: "target-123",
      selection: selectionPayload,
    });
    expect(showToast).toHaveBeenCalledWith("Отправлено в Pi", "success");
    expect(update).toHaveBeenCalledWith(startEl, false);
    expect(setNavigationState).toHaveBeenCalledWith({ canNarrow: false, canWiden: false, canGoUp: false, canGoDown: false });
  });

  it("opens the comment modal immediately after clicking the hovered element", async () => {
    const update = vi.fn();
    const updatePointer = vi.fn();
    const setNavigationState = vi.fn();
    const showCommentModal = vi.fn(() => ({ close: vi.fn() }));
    const runtimeSendMessage = vi.fn(async () => ({ ok: true }));
    const messageListeners: RuntimeMessageListener[] = [];

    document.body.innerHTML = `<div id="start">Start</div>`;

    const startEl = document.querySelector("#start") as Element;

    vi.doMock("./selectionOverlay", () => ({
      createSelectionOverlay: () => ({
        update,
        updatePointer,
        setNavigationState,
        showCommentModal,
        cleanup: vi.fn(),
      }),
      isPickerUiElement: () => false,
    }));
    vi.doMock("./domPicker", () => ({
      buildSelectionPayload: vi.fn(() => selectionPayload),
      findBestVisibleChild: vi.fn(() => null),
      getParentElement: vi.fn(() => null),
      findSiblingElements: vi.fn(() => ({ elements: [], currentIndex: -1 })),
    }));
    vi.doMock("./toast", () => ({ showToast: vi.fn() }));

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

    messageListeners[0]?.(
      { type: "startDomPicker", targetId: "target-123" },
      {} as chrome.runtime.MessageSender,
      vi.fn(),
    );

    startEl.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, cancelable: true, clientX: 42, clientY: 84 }));

    expect(updatePointer).toHaveBeenCalledWith(42, 84);
    expect(update).toHaveBeenCalledWith(startEl, false);

    const clickEvent = new MouseEvent("click", { bubbles: true, cancelable: true });
    const stopPropagation = vi.spyOn(clickEvent, "stopPropagation");

    startEl.dispatchEvent(clickEvent);

    expect(clickEvent.defaultPrevented).toBe(true);
    expect(stopPropagation).toHaveBeenCalledTimes(1);
    expect(showCommentModal).toHaveBeenCalledTimes(1);
    expect(setNavigationState).toHaveBeenCalledWith({ canNarrow: false, canWiden: false, canGoUp: false, canGoDown: false });
  });

  it("ignores mousemove after click selection", async () => {
    const update = vi.fn();
    const setNavigationState = vi.fn();
    const showCommentModal = vi.fn(() => ({ close: vi.fn() }));
    const cleanup = vi.fn();
    const runtimeSendMessage = vi.fn(async () => ({ ok: true }));
    const messageListeners: RuntimeMessageListener[] = [];

    document.body.innerHTML = `
      <div id="small">Small</div>
      <article id="medium">Medium</article>
      <section id="large">Large</section>
      <div id="start">Start</div>
      <div id="other">Other</div>
    `;

    vi.doMock("./selectionOverlay", () => ({
      createSelectionOverlay: () => ({
        update,
        updatePointer: vi.fn(),
        setNavigationState,
        showCommentModal,
        cleanup,
      }),
      isPickerUiElement: () => false,
    }));
    vi.doMock("./domPicker", () => ({
      buildSelectionPayload: vi.fn(() => selectionPayload),
      findBestVisibleChild: vi.fn(() => null),
      getParentElement: vi.fn(() => null),
      findSiblingElements: vi.fn(() => ({ elements: [], currentIndex: -1 })),
    }));
    vi.doMock("./toast", () => ({ showToast: vi.fn() }));

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

    // mousemove to set up candidates
    const startEl = document.querySelector("#start");
    startEl?.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, cancelable: true }));
    update.mockClear();

    // click to fix selection
    startEl?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    update.mockClear();

    // mousemove on a different element after fix — should be ignored
    const otherEl = document.querySelector("#other");
    otherEl?.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, cancelable: true }));

    expect(update).not.toHaveBeenCalled();
  });

  it("перехватывает клик выбора, чтобы страница не выполнила действие элемента", async () => {
    const update = vi.fn();
    const showCommentModal = vi.fn(() => ({ close: vi.fn() }));
    const messageListeners: RuntimeMessageListener[] = [];

    document.body.innerHTML = `<a id="start" href="#target">Start</a>`;

    vi.doMock("./selectionOverlay", () => ({
      createSelectionOverlay: () => ({
        update,
        updatePointer: vi.fn(),
        setNavigationState: vi.fn(),
        showCommentModal,
        cleanup: vi.fn(),
      }),
      isPickerUiElement: () => false,
    }));
    vi.doMock("./domPicker", () => ({
      buildSelectionPayload: vi.fn(() => selectionPayload),
      findBestVisibleChild: vi.fn(() => null),
      getParentElement: vi.fn(() => null),
      findSiblingElements: vi.fn(() => ({ elements: [], currentIndex: -1 })),
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

    messageListeners[0]?.(
      { type: "startDomPicker", targetId: "target-123" },
      {} as chrome.runtime.MessageSender,
      vi.fn(),
    );

    const startEl = document.querySelector("#start");
    const clickEvent = new MouseEvent("click", { bubbles: true, cancelable: true });

    startEl?.dispatchEvent(clickEvent);

    expect(clickEvent.defaultPrevented).toBe(true);
    expect(showCommentModal).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith(startEl, false);
  });


});
