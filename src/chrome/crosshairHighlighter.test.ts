// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";

import { createCrosshairHighlighter } from "./crosshairHighlighter";

function mockRect(element: Element, rect: Partial<DOMRect>): void {
  vi.spyOn(element, "getBoundingClientRect").mockReturnValue({
    top: rect.top ?? 0,
    left: rect.left ?? 0,
    width: rect.width ?? 0,
    height: rect.height ?? 0,
    right: rect.right ?? (rect.left ?? 0) + (rect.width ?? 0),
    bottom: rect.bottom ?? (rect.top ?? 0) + (rect.height ?? 0),
    x: rect.x ?? rect.left ?? 0,
    y: rect.y ?? rect.top ?? 0,
    toJSON: () => ({}),
  } as DOMRect);
}

describe("createCrosshairHighlighter", () => {
  afterEach(() => {
    document.documentElement.innerHTML = "";
    vi.restoreAllMocks();
  });

  it("creates cursor nodes and styles only while active", () => {
    document.body.innerHTML = `<button id="target">Кнопка</button>`;
    const highlighter = createCrosshairHighlighter({ enabled: true, animate: false });

    expect(document.querySelector("[data-pi-crosshair-root]")).not.toBeNull();
    expect(document.querySelector("[data-pi-crosshair-dot]")).not.toBeNull();
    expect(document.querySelector("[data-pi-crosshair-outline]")).not.toBeNull();
    const style = document.querySelector("style[data-pi-crosshair-style]") as HTMLStyleElement;
    expect(style).not.toBeNull();
    expect(style.textContent).toContain("background: rgba(255, 0, 0, 0.14)");
    expect(style.textContent).toContain("border: 2px solid #ff0000");

    highlighter.cleanup();

    expect(document.querySelector("[data-pi-crosshair-root]")).toBeNull();
    expect(document.querySelector("style[data-pi-crosshair-style]")).toBeNull();
  });

  it("updates outline target from an element rect", () => {
    document.body.innerHTML = `<article id="target">Текст</article>`;
    const target = document.querySelector("#target") as HTMLElement;
    mockRect(target, { top: 10, left: 20, width: 100, height: 40 });

    const highlighter = createCrosshairHighlighter({ enabled: true, animate: false });
    highlighter.updateTarget(target, { selected: false });

    const outline = document.querySelector("[data-pi-crosshair-outline]") as HTMLElement;
    expect(outline.style.width).toBe("115px");
    expect(outline.style.height).toBe("50px");
    expect(outline.style.transform).toBe("translate(70px, 30px) translate(-50%, -50%) rotate(0deg)");

    highlighter.cleanup();
  });

  it("marks selected target and clears the target state", () => {
    document.body.innerHTML = `<article id="target">Текст</article>`;
    const target = document.querySelector("#target") as HTMLElement;
    mockRect(target, { top: 8, left: 12, width: 80, height: 30 });

    const highlighter = createCrosshairHighlighter({ enabled: true, animate: false });
    highlighter.updateTarget(target, { selected: true });

    const outline = document.querySelector("[data-pi-crosshair-outline]") as HTMLElement;
    expect(outline.dataset.piCrosshairSelected).toBe("true");

    highlighter.clearTarget();

    expect(outline.dataset.piCrosshairSelected).toBe("false");
    expect(outline.dataset.piCrosshairHovering).toBe("false");

    highlighter.cleanup();
  });
});
