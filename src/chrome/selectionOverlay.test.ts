// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";

import { createSelectionOverlay } from "./selectionOverlay";

afterEach(() => {
  document.documentElement.innerHTML = "";
});

describe("createSelectionOverlay", () => {
  it("uses a soft olive highlight for the selection frame", () => {
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
    expect((highlightBox as HTMLDivElement).style.border).toBe("2px solid rgb(111, 127, 58)");
    expect((highlightBox as HTMLDivElement).style.background).toBe("rgba(111, 127, 58, 0.18)");
    expect((highlightBox as HTMLDivElement).style.boxShadow).toContain("rgba(111, 127, 58, 0.28)");

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

  it("renders the control panel and comment modal in the light olive theme", () => {
    const overlay = createSelectionOverlay({
      onNarrow: vi.fn(),
      onWiden: vi.fn(),
      onConfirm: vi.fn(),
      onCancel: vi.fn(),
    });

    const root = document.querySelector("#pi-dom-picker-overlay-root");
    const panel = root?.lastElementChild as HTMLDivElement | null;

    expect(panel).not.toBeNull();
    expect(panel?.style.background).toBe("rgba(248, 250, 240, 0.96)");
    expect(panel?.style.border).toBe("1px solid rgb(196, 204, 168)");
    expect(panel?.style.color).toBe("rgb(47, 54, 28)");

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
