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

type SendSelectionResponse = {
  ok?: boolean;
  error?: string;
};

type RuntimeMessageListener = (
  message: RuntimeMessage,
  sender: chrome.runtime.MessageSender,
  sendResponse: (response?: unknown) => void,
) => boolean | void;

type CommentModalOptions = {
  onSubmit(comment: string): void;
  onCancel(): void;
};

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

function installChromeMock(runtimeSendMessage: ReturnType<typeof vi.fn> = vi.fn(async () => ({ ok: true }))) {
  const messageListeners: RuntimeMessageListener[] = [];

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

  return { messageListeners, runtimeSendMessage };
}

function startPicker(messageListeners: RuntimeMessageListener[], targetId = "target-123") {
  const startResponse = vi.fn();

  messageListeners[0]?.(
    { type: "startDomPicker", targetId },
    {} as chrome.runtime.MessageSender,
    startResponse,
  );

  return startResponse;
}

function mockOverlay(overrides: Partial<{
  update: ReturnType<typeof vi.fn>;
  updatePointer: ReturnType<typeof vi.fn>;
  showCommentModal: ReturnType<typeof vi.fn>;
  cleanup: ReturnType<typeof vi.fn>;
  isPickerUiElement: (element: Element) => boolean;
}> = {}) {
  const controls = {
    update: overrides.update ?? vi.fn(),
    updatePointer: overrides.updatePointer ?? vi.fn(),
    showCommentModal: overrides.showCommentModal ?? vi.fn(() => ({ close: vi.fn() })),
    cleanup: overrides.cleanup ?? vi.fn(),
  };
  const isPickerUiElement = overrides.isPickerUiElement ?? (() => false);

  vi.doMock("./selectionOverlay", () => ({
    createSelectionOverlay: vi.fn(() => controls),
    isPickerUiElement,
  }));

  return controls;
}

function mockDomPicker(buildSelectionPayload = vi.fn(() => selectionPayload)) {
  vi.doMock("./domPicker", () => ({
    buildSelectionPayload,
  }));

  return { buildSelectionPayload };
}

describe("contentScript", () => {
  afterEach(() => {
    (window.__PI_DOM_PICKER_SESSION__ as { cleanup?: () => void } | undefined)?.cleanup?.();
    document.documentElement.innerHTML = "";
    delete (globalThis as Record<string, unknown>).chrome;
    delete window.__PI_CONTENT_SCRIPT_PLACEHOLDER_LISTENER_REGISTERED__;
    delete window.__PI_DOM_PICKER_SESSION__;
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it("starts picker with a valid target id and rejects missing target ids with diagnostics", async () => {
    const cleanup = vi.fn();
    const createSelectionOverlay = vi.fn(() => ({
      update: vi.fn(),
      updatePointer: vi.fn(),
      showCommentModal: vi.fn(() => ({ close: vi.fn() })),
      cleanup,
    }));
    const runtimeSendMessage = vi.fn(async () => ({ ok: true }));
    const { messageListeners } = installChromeMock(runtimeSendMessage);

    vi.doMock("./selectionOverlay", () => ({
      createSelectionOverlay,
      isPickerUiElement: () => false,
    }));
    mockDomPicker();
    vi.doMock("./toast", () => ({ showToast: vi.fn() }));

    await import("./contentScript");

    const validResponse = startPicker(messageListeners, " target-123 ");

    expect(validResponse).toHaveBeenCalledWith({ ok: true, source: "contentScript" });
    expect(createSelectionOverlay).toHaveBeenCalledTimes(1);
    expect(window.__PI_DOM_PICKER_SESSION__).toEqual(expect.objectContaining({ targetId: "target-123" }));

    const invalidResponse = vi.fn();
    messageListeners[0]?.(
      { type: "startDomPicker" },
      {} as chrome.runtime.MessageSender,
      invalidResponse,
    );
    await flushAsyncWork();

    expect(invalidResponse).toHaveBeenCalledWith({
      ok: false,
      error: "No selected target provided for DOM picker startup",
    });
    expect(runtimeSendMessage).toHaveBeenCalledWith({
      type: "pickerDiagnostic",
      phase: "startDomPicker",
      message: "No selected target provided for DOM picker startup",
      url: window.location.href,
    });
  });

  it("opens the comment modal immediately after clicking the hovered element", async () => {
    const update = vi.fn();
    const updatePointer = vi.fn();
    const showCommentModal = vi.fn(() => ({ close: vi.fn() }));
    const runtimeSendMessage = vi.fn(async () => ({ ok: true }));
    const { messageListeners } = installChromeMock(runtimeSendMessage);

    document.body.innerHTML = `<div id="start">Start</div>`;
    const startEl = document.querySelector("#start") as Element;

    const overlay = mockOverlay({ update, updatePointer, showCommentModal });
    mockDomPicker();
    vi.doMock("./toast", () => ({ showToast: vi.fn() }));

    await import("./contentScript");

    startPicker(messageListeners);

    startEl.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, cancelable: true, clientX: 42, clientY: 84 }));

    expect(updatePointer).toHaveBeenCalledWith(42, 84);
    expect(update).toHaveBeenCalledWith(startEl, false);

    const clickEvent = new MouseEvent("click", { bubbles: true, cancelable: true });
    const stopPropagation = vi.spyOn(clickEvent, "stopPropagation");

    startEl.dispatchEvent(clickEvent);

    expect(clickEvent.defaultPrevented).toBe(true);
    expect(stopPropagation).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith(startEl, true);
    expect(showCommentModal).toHaveBeenCalledTimes(1);
  });

  it("does not open selection modal or intercept clicks on picker UI elements", async () => {
    const update = vi.fn();
    const showCommentModal = vi.fn(() => ({ close: vi.fn() }));
    const { messageListeners } = installChromeMock();

    document.body.innerHTML = `<button id="picker-ui">Picker UI</button>`;
    const pickerUiEl = document.querySelector("#picker-ui") as Element;

    mockOverlay({
      update,
      showCommentModal,
      isPickerUiElement: (element) => element === pickerUiEl,
    });
    mockDomPicker();
    vi.doMock("./toast", () => ({ showToast: vi.fn() }));

    await import("./contentScript");

    startPicker(messageListeners);

    const clickEvent = new MouseEvent("click", { bubbles: true, cancelable: true });
    const stopPropagation = vi.spyOn(clickEvent, "stopPropagation");

    pickerUiEl.dispatchEvent(clickEvent);

    expect(clickEvent.defaultPrevented).toBe(false);
    expect(stopPropagation).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalledWith(pickerUiEl, true);
    expect(showCommentModal).not.toHaveBeenCalled();
  });

  it("blocks additional DOM picker clicks while selection submit is pending", async () => {
    let onSubmit: ((comment: string) => void) | undefined;
    let resolveSendSelection: ((response: SendSelectionResponse) => void) | undefined;

    const cleanup = vi.fn();
    const update = vi.fn();
    const showCommentModal = vi.fn(({ onSubmit: submit }: CommentModalOptions) => {
      onSubmit = submit;
      return { close: vi.fn() };
    });
    const buildSelectionPayload = vi.fn(() => selectionPayload);
    const runtimeSendMessage = vi.fn((message: RuntimeMessage) => {
      if (message.type === "sendSelection") {
        return new Promise<SendSelectionResponse>((resolve) => {
          resolveSendSelection = resolve;
        });
      }

      if (message.type === "pickerDiagnostic") {
        return Promise.resolve({ ok: true });
      }

      throw new Error(`Unexpected runtime message: ${message.type}`);
    });
    const { messageListeners } = installChromeMock(runtimeSendMessage);

    document.body.innerHTML = `
      <div id="first">First</div>
      <div id="second">Second</div>
    `;
    const firstEl = document.querySelector("#first") as Element;
    const secondEl = document.querySelector("#second") as Element;

    mockOverlay({ update, showCommentModal, cleanup });
    mockDomPicker(buildSelectionPayload);
    vi.doMock("./toast", () => ({ showToast: vi.fn() }));

    await import("./contentScript");

    startPicker(messageListeners);
    firstEl.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));

    expect(showCommentModal).toHaveBeenCalledTimes(1);
    expect(onSubmit).toBeTypeOf("function");

    onSubmit?.("First comment");
    await Promise.resolve();

    secondEl.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));

    expect(showCommentModal).toHaveBeenCalledTimes(1);
    expect(update).not.toHaveBeenCalledWith(secondEl, true);
    expect(buildSelectionPayload).toHaveBeenCalledTimes(1);
    expect(runtimeSendMessage).toHaveBeenCalledTimes(1);
    expect(runtimeSendMessage).toHaveBeenCalledWith({
      type: "sendSelection",
      targetId: "target-123",
      selection: selectionPayload,
    });
    expect(cleanup).not.toHaveBeenCalled();

    resolveSendSelection?.({ ok: true });
    await flushAsyncWork();

    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(window.__PI_DOM_PICKER_SESSION__).toBeUndefined();
  });

  it("sends payload for the exact clicked element from the comment modal", async () => {
    let onSubmit: ((comment: string) => void) | undefined;

    const update = vi.fn();
    const showCommentModal = vi.fn(({ onSubmit: submit }: CommentModalOptions) => {
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
    const { messageListeners } = installChromeMock(runtimeSendMessage);

    document.body.innerHTML = `
      <section id="outer">
        <article id="inner">
          <div id="hovered">Hovered</div>
          <div id="clicked"><span>Clicked</span></div>
        </article>
      </section>
    `;

    const hoveredEl = document.querySelector("#hovered") as Element;
    const clickedEl = document.querySelector("#clicked") as Element;

    const overlay = mockOverlay({ update, showCommentModal });
    mockDomPicker(buildSelectionPayload);
    vi.doMock("./toast", () => ({ showToast }));

    await import("./contentScript");

    startPicker(messageListeners);

    hoveredEl.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, cancelable: true }));
    clickedEl.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));

    expect(update).toHaveBeenCalledWith(clickedEl, true);
    expect(showCommentModal).toHaveBeenCalledTimes(1);
    expect(onSubmit).toBeTypeOf("function");

    onSubmit?.("Explain this");
    await flushAsyncWork();

    expect(buildSelectionPayload).toHaveBeenCalledWith(clickedEl, "Explain this");
    expect(buildSelectionPayload).not.toHaveBeenCalledWith(hoveredEl, "Explain this");
    expect(runtimeSendMessage).toHaveBeenCalledWith({
      type: "sendSelection",
      targetId: "target-123",
      selection: selectionPayload,
    });
    expect(showToast).toHaveBeenCalledWith("Отправлено в Pi", "success");
  });

  it("shows an error toast and reports diagnostics when sending selection fails", async () => {
    let onSubmit: ((comment: string) => void) | undefined;

    const cleanup = vi.fn();
    const showCommentModal = vi.fn(({ onSubmit: submit }: CommentModalOptions) => {
      onSubmit = submit;
      return { close: vi.fn() };
    });
    const showToast = vi.fn();
    const runtimeSendMessage = vi.fn(async (message: RuntimeMessage) => {
      if (message.type === "sendSelection") {
        return { ok: false, error: "Pi API unavailable" };
      }

      if (message.type === "pickerDiagnostic") {
        return { ok: true };
      }

      throw new Error(`Unexpected runtime message: ${message.type}`);
    });
    const { messageListeners } = installChromeMock(runtimeSendMessage);

    document.body.innerHTML = `<div id="start">Start</div>`;
    const startEl = document.querySelector("#start") as Element;

    mockOverlay({ showCommentModal, cleanup });
    mockDomPicker();
    vi.doMock("./toast", () => ({ showToast }));

    await import("./contentScript");

    startPicker(messageListeners);
    startEl.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, cancelable: true }));
    startEl.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));

    expect(onSubmit).toBeTypeOf("function");

    onSubmit?.("Explain this");
    await flushAsyncWork();

    expect(showToast).toHaveBeenCalledWith("Не удалось отправить в Pi: Pi API unavailable.", "error");
    expect(runtimeSendMessage).toHaveBeenCalledWith({
      type: "pickerDiagnostic",
      phase: "sendSelection",
      message: "Pi API unavailable",
      url: window.location.href,
    });
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(window.__PI_DOM_PICKER_SESSION__).toBeUndefined();
  });

  it("removes picker overlay and clears session when modal is cancelled", async () => {
    let onCancel: (() => void) | undefined;

    const cleanup = vi.fn();
    const showCommentModal = vi.fn(({ onCancel: cancel }: CommentModalOptions) => {
      onCancel = cancel;
      return { close: vi.fn() };
    });
    const { messageListeners } = installChromeMock();

    document.body.innerHTML = `<button id="start">Start</button><button id="other">Other</button>`;
    const startEl = document.querySelector("#start") as Element;
    const otherEl = document.querySelector("#other") as Element;

    mockOverlay({ showCommentModal, cleanup });
    mockDomPicker();
    vi.doMock("./toast", () => ({ showToast: vi.fn() }));

    await import("./contentScript");

    startPicker(messageListeners);
    startEl.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, cancelable: true }));
    startEl.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));

    expect(onCancel).toBeTypeOf("function");

    onCancel?.();

    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(window.__PI_DOM_PICKER_SESSION__).toBeUndefined();

    startEl.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, cancelable: true }));
    otherEl.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));

    expect(showCommentModal).toHaveBeenCalledTimes(1);
  });

  it("cleans up the active picker when Escape is pressed", async () => {
    const cleanup = vi.fn();
    const { messageListeners } = installChromeMock();

    document.body.innerHTML = `<div id="start">Start</div>`;

    mockOverlay({ cleanup });
    mockDomPicker();
    vi.doMock("./toast", () => ({ showToast: vi.fn() }));

    await import("./contentScript");

    startPicker(messageListeners);

    const escapeEvent = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    const stopPropagation = vi.spyOn(escapeEvent, "stopPropagation");

    document.dispatchEvent(escapeEvent);

    expect(escapeEvent.defaultPrevented).toBe(true);
    expect(stopPropagation).toHaveBeenCalledTimes(1);
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(window.__PI_DOM_PICKER_SESSION__).toBeUndefined();
  });

  it("ignores mousemove after click selection", async () => {
    const update = vi.fn();
    const showCommentModal = vi.fn(() => ({ close: vi.fn() }));
    const { messageListeners } = installChromeMock();

    document.body.innerHTML = `
      <div id="start">Start</div>
      <div id="other">Other</div>
    `;

    mockOverlay({ update, showCommentModal });
    mockDomPicker();
    vi.doMock("./toast", () => ({ showToast: vi.fn() }));

    await import("./contentScript");

    startPicker(messageListeners);

    const startEl = document.querySelector("#start");
    startEl?.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, cancelable: true }));
    update.mockClear();

    startEl?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    update.mockClear();

    const otherEl = document.querySelector("#other");
    otherEl?.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, cancelable: true }));

    expect(update).not.toHaveBeenCalled();
  });

  it("перехватывает клик выбора, чтобы страница не выполнила действие элемента", async () => {
    const update = vi.fn();
    const showCommentModal = vi.fn(() => ({ close: vi.fn() }));
    const { messageListeners } = installChromeMock();

    document.body.innerHTML = `<a id="start" href="#target">Start</a>`;

    mockOverlay({ update, showCommentModal });
    mockDomPicker();
    vi.doMock("./toast", () => ({ showToast: vi.fn() }));

    await import("./contentScript");

    startPicker(messageListeners);

    const startEl = document.querySelector("#start");
    const clickEvent = new MouseEvent("click", { bubbles: true, cancelable: true });

    startEl?.dispatchEvent(clickEvent);

    expect(clickEvent.defaultPrevented).toBe(true);
    expect(showCommentModal).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith(startEl, true);
  });
});
