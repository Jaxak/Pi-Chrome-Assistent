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
          showPanel: vi.fn(),
          hidePanel: vi.fn(),
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

    const startResponse = vi.fn();
    messageListeners[0]?.(
      { type: "startDomPicker", targetId: "target-123" },
      {} as chrome.runtime.MessageSender,
      startResponse,
    );

    const hoveredElement = document.querySelector("#start");
    hoveredElement?.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, cancelable: true }));

    expect(update).toHaveBeenCalledWith(mediumEl, false);
    expect(setNavigationState).toHaveBeenCalledWith({ canNarrow: true, canWiden: true, canGoUp: false, canGoDown: false });

    // Click to enter selected mode
    hoveredElement?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));

    overlayCallbacks?.onWiden();

    expect(update).toHaveBeenLastCalledWith(largeEl, true);
    expect(setNavigationState).toHaveBeenLastCalledWith({ canNarrow: true, canWiden: false, canGoUp: false, canGoDown: false });
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
          showPanel: vi.fn(),
          hidePanel: vi.fn(),
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

    const hoveredElement = document.querySelector("#start");
    hoveredElement?.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, cancelable: true }));

    // Click to enter selected mode so onWiden works
    hoveredElement?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));

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
    expect(update).toHaveBeenCalledWith(mediumEl, false);
    expect(setNavigationState).toHaveBeenCalledWith({ canNarrow: true, canWiden: true, canGoUp: false, canGoDown: false });
  });

  it("click fixes selection and shows the panel", async () => {
    let overlayCallbacks: {
      onNarrow(): void;
      onWiden(): void;
      onChange(): void;
      onConfirm(): void;
      onCancel(): void;
    };
    const update = vi.fn();
    const setNavigationState = vi.fn();
    const showPanel = vi.fn();
    const hidePanel = vi.fn();
    const showCommentModal = vi.fn(() => ({ close: vi.fn() }));
    const cleanup = vi.fn();
    const runtimeSendMessage = vi.fn(async () => ({ ok: true }));
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
      createSelectionOverlay: (callbacks: typeof overlayCallbacks) => {
        overlayCallbacks = callbacks;
        return {
          update,
          setNavigationState,
          showPanel,
          hidePanel,
          showCommentModal,
          cleanup,
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

    // First, a mousemove to set up candidates
    const startEl = document.querySelector("#start");
    startEl?.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, cancelable: true }));

    // Verify update was called (hover mode) but panel NOT shown
    expect(showPanel).not.toHaveBeenCalled();

    // Now click to fix selection
    update.mockClear();
    startEl?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));

    // After click: panel is shown, update called with selected=true
    expect(showPanel).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith(mediumEl, true);
  });

  it("ignores mousemove after click selection", async () => {
    let overlayCallbacks: {
      onNarrow(): void;
      onWiden(): void;
      onChange(): void;
      onConfirm(): void;
      onCancel(): void;
    };
    const update = vi.fn();
    const setNavigationState = vi.fn();
    const showPanel = vi.fn();
    const hidePanel = vi.fn();
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

    const smallEl = document.querySelector("#small") as Element;
    const mediumEl = document.querySelector("#medium") as Element;
    const largeEl = document.querySelector("#large") as Element;

    vi.doMock("./selectionOverlay", () => ({
      createSelectionOverlay: (callbacks: typeof overlayCallbacks) => {
        overlayCallbacks = callbacks;
        return {
          update,
          setNavigationState,
          showPanel,
          hidePanel,
          showCommentModal,
          cleanup,
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

  it("change button returns to hover mode", async () => {
    let overlayCallbacks: {
      onNarrow(): void;
      onWiden(): void;
      onChange(): void;
      onConfirm(): void;
      onCancel(): void;
    } | undefined;
    const update = vi.fn();
    const setNavigationState = vi.fn();
    const showPanel = vi.fn();
    const hidePanel = vi.fn();
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

    const smallEl = document.querySelector("#small") as Element;
    const mediumEl = document.querySelector("#medium") as Element;
    const largeEl = document.querySelector("#large") as Element;

    vi.doMock("./selectionOverlay", () => ({
      createSelectionOverlay: (callbacks: typeof overlayCallbacks) => {
        overlayCallbacks = callbacks;
        return {
          update,
          setNavigationState,
          showPanel,
          hidePanel,
          showCommentModal,
          cleanup,
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

    // click to fix selection
    startEl?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    update.mockClear();

    // onChange returns to hover mode
    overlayCallbacks?.onChange();
    expect(hidePanel).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith(mediumEl, false);
    update.mockClear();

    // subsequent mousemove works again
    const otherEl = document.querySelector("#other");
    otherEl?.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, cancelable: true }));
    expect(update).toHaveBeenCalledTimes(1);
  });

  it("narrow and widen work after selection", async () => {
    let overlayCallbacks: {
      onNarrow(): void;
      onWiden(): void;
      onChange(): void;
      onConfirm(): void;
      onCancel(): void;
    } | undefined;
    const update = vi.fn();
    const setNavigationState = vi.fn();
    const showPanel = vi.fn();
    const hidePanel = vi.fn();
    const showCommentModal = vi.fn(() => ({ close: vi.fn() }));
    const cleanup = vi.fn();
    const runtimeSendMessage = vi.fn(async () => ({ ok: true }));
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
      createSelectionOverlay: (callbacks: typeof overlayCallbacks) => {
        overlayCallbacks = callbacks;
        return {
          update,
          setNavigationState,
          showPanel,
          hidePanel,
          showCommentModal,
          cleanup,
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

    // click to fix selection
    startEl?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    update.mockClear();

    // narrow: mediumEl (index 1) -> smallEl (index 0)
    overlayCallbacks?.onNarrow();
    expect(update).toHaveBeenCalledWith(smallEl, true);
    update.mockClear();

    // widen: smallEl (index 0) -> mediumEl (index 1)
    overlayCallbacks?.onWiden();
    expect(update).toHaveBeenCalledWith(mediumEl, true);
    update.mockClear();

    // widen: mediumEl (index 1) -> largeEl (index 2)
    overlayCallbacks?.onWiden();
    expect(update).toHaveBeenCalledWith(largeEl, true);
  });
});
