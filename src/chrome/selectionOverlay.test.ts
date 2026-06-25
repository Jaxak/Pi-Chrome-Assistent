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

  it("renders the comment modal with Russian labels and light olive theme", () => {
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
    expect(modalPanel?.style.background).toBe("rgb(250, 249, 242)");
    expect(modalPanel?.style.border).toBe("1px solid rgb(209, 216, 182)");
    expect(modalPanel?.style.color).toBe("rgb(47, 54, 28)");
    expect(textarea?.placeholder).toBe("Добавьте комментарий (необязательно)");
    expect(textarea?.style.background).toBe("rgb(255, 255, 250)");

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
});
