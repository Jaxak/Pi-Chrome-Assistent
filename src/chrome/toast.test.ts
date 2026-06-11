// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";

import { showToast } from "./toast";

afterEach(() => {
  document.documentElement.innerHTML = "";
});

describe("showToast", () => {
  it("renders success toast in the light olive theme", () => {
    const cleanup = showToast("Фрагмент отправлен", "success");

    const root = document.querySelector("#pi-dom-picker-toast-root");
    const toast = root?.firstElementChild;

    expect(root).not.toBeNull();
    expect(toast).toBeInstanceOf(HTMLDivElement);
    expect((toast as HTMLDivElement).style.background).toBe("rgba(111, 127, 58, 0.96)");
    expect((toast as HTMLDivElement).style.color).toBe("rgb(248, 250, 240)");
    expect((toast as HTMLDivElement).style.boxShadow).toContain("rgba(78, 87, 39, 0.2)");

    cleanup();
  });
});
