// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";

import { createSelectionOverlay, isPickerUiElement } from "./selectionOverlay";

afterEach(() => {
  document.documentElement.innerHTML = "";
});

describe("createSelectionOverlay", () => {
  it("creates a managed Crosshair selection frame and removes it on cleanup", () => {
    const overlay = createSelectionOverlay();

    const root = document.querySelector("#pi-dom-picker-overlay-root") as HTMLDivElement | null;
    expect(root).not.toBeNull();
    expect(root?.getAttribute("data-pi-picker-ui")).toBe("true");
    expect(root?.style.pointerEvents).toBe("none");
    expect(document.querySelector("[data-pi-crosshair-root]")).not.toBeNull();
    expect(document.querySelector("[data-pi-crosshair-outline]")).not.toBeNull();
    expect(document.querySelector("style[data-pi-crosshair-style]")).not.toBeNull();

    overlay.cleanup();

    expect(document.querySelector("#pi-dom-picker-overlay-root")).toBeNull();
    expect(document.querySelector("[data-pi-crosshair-root]")).toBeNull();
    expect(document.querySelector("style[data-pi-crosshair-style]")).toBeNull();
  });

  it("renders the comment modal with Russian labels and dark theme", () => {
    const overlay = createSelectionOverlay();

    overlay.showCommentModal({
      onSubmit: vi.fn(),
      onCancel: vi.fn(),
    });

    const modalRoot = document.querySelector("#pi-dom-picker-modal-root") as HTMLDivElement | null;
    const modalPanel = modalRoot?.firstElementChild as HTMLDivElement | null;
    const textarea = modalPanel?.querySelector("textarea") as HTMLTextAreaElement | null;

    expect(document.body.textContent).toContain("Добавьте комментарий (необязательно)");
    expect(document.body.textContent).toContain("Отправить в Pi");
    expect(document.body.textContent).toContain("Отмена");
    expect(modalPanel).not.toBeNull();
    expect(modalPanel?.style.background).toBe("rgb(31, 31, 31)");
    expect(modalPanel?.style.border).toBe("1px solid rgba(255, 255, 255, 0.1)");
    expect(modalPanel?.style.color).toBe("rgb(232, 232, 232)");
    expect(textarea?.placeholder).toBe("Комментарий...");
    expect(textarea?.style.background).toBe("rgb(42, 42, 42)");

    overlay.cleanup();
  });

  it("marks the Crosshair outline as selected when update receives selected=true", () => {
    const div = document.createElement("div");
    document.body.appendChild(div);
    vi.spyOn(div, "getBoundingClientRect").mockReturnValue({
      top: 10,
      left: 20,
      width: 100,
      height: 40,
      right: 120,
      bottom: 50,
      x: 20,
      y: 10,
      toJSON: () => ({}),
    } as DOMRect);

    const overlay = createSelectionOverlay();

    overlay.update(div);
    const outline = document.querySelector("[data-pi-crosshair-outline]") as HTMLElement;
    expect(outline.dataset.piCrosshairSelected).toBe("false");
    expect(outline.style.width).toBe("115px");

    overlay.update(div, true);
    expect(outline.dataset.piCrosshairSelected).toBe("true");

    overlay.cleanup();
  });

  it("calls onCancel when Escape is pressed in the comment modal textarea", () => {
    const onCancel = vi.fn();
    const onSubmit = vi.fn();

    const overlay = createSelectionOverlay();

    overlay.showCommentModal({
      onSubmit,
      onCancel,
    });

    const textarea = document.querySelector("textarea") as HTMLTextAreaElement;
    expect(textarea).not.toBeNull();

    const escapeEvent = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    textarea.dispatchEvent(escapeEvent);

    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(escapeEvent.defaultPrevented).toBe(true);

    overlay.cleanup();
  });

  it("does not call onCancel for non-Escape keydown in the comment modal", () => {
    const onCancel = vi.fn();
    const onSubmit = vi.fn();

    const overlay = createSelectionOverlay();

    overlay.showCommentModal({
      onSubmit,
      onCancel,
    });

    const textarea = document.querySelector("textarea") as HTMLTextAreaElement;

    const typeEvent = new KeyboardEvent("keydown", { key: "A", bubbles: true, cancelable: true });
    textarea.dispatchEvent(typeEvent);

    expect(onCancel).not.toHaveBeenCalled();
    expect(onSubmit).not.toHaveBeenCalled();

    overlay.cleanup();
  });

  it("recognizes overlay and modal UI elements", () => {
    const overlay = createSelectionOverlay();
    const root = document.querySelector("#pi-dom-picker-overlay-root");

    expect(isPickerUiElement(root)).toBe(true);

    overlay.showCommentModal({
      onSubmit: vi.fn(),
      onCancel: vi.fn(),
    });

    const textarea = document.querySelector("#pi-dom-picker-modal-root textarea");
    const pageElement = document.createElement("div");
    document.body.append(pageElement);

    expect(isPickerUiElement(textarea)).toBe(true);
    expect(isPickerUiElement(pageElement)).toBe(false);
    expect(isPickerUiElement(null)).toBe(false);

    overlay.cleanup();
  });

  it("locks page scroll when the comment modal is open", () => {
    const overlay = createSelectionOverlay();
    expect(document.body.style.overflow).toBe("");

    overlay.showCommentModal({
      onSubmit: vi.fn(),
      onCancel: vi.fn(),
    });

    expect(document.body.style.overflow).toBe("hidden");

    overlay.cleanup();
    expect(document.body.style.overflow).toBe("");
  });

  it("restores original body overflow when modal is closed", () => {
    document.body.style.overflow = "auto";
    const overlay = createSelectionOverlay();

    overlay.showCommentModal({
      onSubmit: vi.fn(),
      onCancel: vi.fn(),
    });

    expect(document.body.style.overflow).toBe("hidden");

    overlay.cleanup();
    expect(document.body.style.overflow).toBe("auto");

    document.body.style.overflow = "";
  });

  it("traps focus: Tab from last element wraps to first", () => {
    const overlay = createSelectionOverlay();
    overlay.showCommentModal({
      onSubmit: vi.fn(),
      onCancel: vi.fn(),
    });

    const sendButton = document.querySelector(
      "#pi-dom-picker-modal-root button:last-of-type"
    ) as HTMLButtonElement;
    expect(sendButton).not.toBeNull();

    sendButton.focus();
    expect(document.activeElement).toBe(sendButton);

    const tabEvent = new KeyboardEvent("keydown", {
      key: "Tab",
      bubbles: true,
      cancelable: true,
    });
    sendButton.dispatchEvent(tabEvent);

    expect(tabEvent.defaultPrevented).toBe(true);
    const textarea = document.querySelector("#pi-dom-picker-modal-root textarea");
    expect(document.activeElement).toBe(textarea);

    overlay.cleanup();
  });

  it("traps focus: Shift+Tab from first element wraps to last", () => {
    const overlay = createSelectionOverlay();
    overlay.showCommentModal({
      onSubmit: vi.fn(),
      onCancel: vi.fn(),
    });

    const textarea = document.querySelector(
      "#pi-dom-picker-modal-root textarea"
    ) as HTMLTextAreaElement;
    textarea.focus();
    expect(document.activeElement).toBe(textarea);

    const shiftTabEvent = new KeyboardEvent("keydown", {
      key: "Tab",
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    });
    textarea.dispatchEvent(shiftTabEvent);

    expect(shiftTabEvent.defaultPrevented).toBe(true);
    const sendButton = document.querySelector(
      "#pi-dom-picker-modal-root button:last-of-type"
    ) as HTMLButtonElement;
    expect(document.activeElement).toBe(sendButton);

    overlay.cleanup();
  });
});
