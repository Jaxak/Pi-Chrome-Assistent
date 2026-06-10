// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";

import { createSelectionOverlay } from "./selectionOverlay";

afterEach(() => {
  document.documentElement.innerHTML = "";
});

describe("createSelectionOverlay", () => {
  it("uses a translucent green highlight for the selection frame", () => {
    const overlay = createSelectionOverlay({
      onNarrow: vi.fn(),
      onWiden: vi.fn(),
      onConfirm: vi.fn(),
      onCancel: vi.fn(),
    });
    const root = document.querySelector("#pi-dom-picker-overlay-root");
    const highlightBox = root?.firstElementChild;

    expect(root).not.toBeNull();
    expect(highlightBox).not.toBeNull();
    expect(highlightBox).toBeInstanceOf(HTMLDivElement);
    expect((highlightBox as HTMLDivElement).style.border).toBe("2px solid rgb(34, 197, 94)");
    expect((highlightBox as HTMLDivElement).style.background).toBe("rgba(34, 197, 94, 0.16)");
    expect((highlightBox as HTMLDivElement).style.boxShadow).toContain("rgba(34, 197, 94, 0.28)");

    overlay.cleanup();
  });

  it("renders picker controls with Russian labels", () => {
    const overlay = createSelectionOverlay({
      onNarrow: vi.fn(),
      onWiden: vi.fn(),
      onConfirm: vi.fn(),
      onCancel: vi.fn(),
    });

    expect(document.body.textContent).toContain("Выбор блока");
    expect(document.body.textContent).toContain("Мельче");
    expect(document.body.textContent).toContain("Крупнее");
    expect(document.body.textContent).toContain("Отправить");
    expect(document.body.textContent).toContain("Отмена");

    overlay.cleanup();
  });

  it("disables the narrow button at the smallest candidate", () => {
    const overlay = createSelectionOverlay({
      onNarrow: vi.fn(),
      onWiden: vi.fn(),
      onConfirm: vi.fn(),
      onCancel: vi.fn(),
    });

    overlay.setNavigationState({ canNarrow: false, canWiden: true });

    const narrowButton = document.querySelector('[data-testid="picker-narrow"]');
    const widenButton = document.querySelector('[data-testid="picker-widen"]');

    expect(narrowButton).toBeInstanceOf(HTMLButtonElement);
    expect(widenButton).toBeInstanceOf(HTMLButtonElement);
    expect((narrowButton as HTMLButtonElement).disabled).toBe(true);
    expect((widenButton as HTMLButtonElement).disabled).toBe(false);

    overlay.cleanup();
  });
});
