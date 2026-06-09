// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";

import { createSelectionOverlay } from "./selectionOverlay";

afterEach(() => {
  document.documentElement.innerHTML = "";
});

describe("createSelectionOverlay", () => {
  it("uses a translucent green highlight for the selection frame", () => {
    const overlay = createSelectionOverlay();
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
});
