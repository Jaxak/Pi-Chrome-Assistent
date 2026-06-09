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
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it("uses the picker target id from startup when sending a selection", async () => {
    let onSubmit: ((comment: string) => void) | undefined;
    const showToast = vi.fn();
    const runtimeSendMessage = vi.fn(async (message: RuntimeMessage) => {
      if (message.type === "sendSelection") {
        return { ok: true };
      }

      if (message.type === "pickerDiagnostic") {
        return { ok: true };
      }

      throw new Error(`Unexpected runtime message: ${message.type}`);
    });
    const storageGet = vi.fn(async () => ({ selectedTargetId: "stale-target" }));
    const messageListeners: RuntimeMessageListener[] = [];

    vi.doMock("./selectionOverlay", () => ({
      createSelectionOverlay: () => ({
        update: vi.fn(),
        showCommentModal: ({ onSubmit: submit }: { onSubmit(comment: string): void; onCancel(): void }) => {
          onSubmit = submit;
          return { close: vi.fn() };
        },
        cleanup: vi.fn(),
      }),
      isPickerUiElement: () => false,
    }));
    vi.doMock("./domPicker", () => ({
      buildSelectionPayload: vi.fn(() => selectionPayload),
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
      storage: {
        local: {
          get: storageGet,
        },
      },
    };

    document.body.innerHTML = `<article id="selected">Selected text</article>`;

    await import("./contentScript");

    expect(messageListeners).toHaveLength(1);

    const startResponse = vi.fn();
    messageListeners[0]?.(
      { type: "startDomPicker", targetId: "target-123" },
      {} as chrome.runtime.MessageSender,
      startResponse,
    );

    expect(startResponse).toHaveBeenCalledWith({ ok: true, source: "contentScript" });

    const selectedElement = document.querySelector("#selected");
    expect(selectedElement).not.toBeNull();

    selectedElement?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(onSubmit).toBeTypeOf("function");

    onSubmit?.("Explain this");
    await flushAsyncWork();

    expect(runtimeSendMessage).toHaveBeenCalledWith({
      type: "sendSelection",
      targetId: "target-123",
      selection: selectionPayload,
    });
    expect(storageGet).not.toHaveBeenCalled();
    expect(showToast).toHaveBeenCalledWith("Отправлено в Pi", "success");
  });
});
