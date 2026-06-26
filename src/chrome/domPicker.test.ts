// @vitest-environment jsdom

import { MAX_SELECTED_HTML_BYTES, MAX_SELECTED_TEXT_BYTES } from "../shared/constants";
import { truncateUtf8 } from "../shared/truncation";
import { describe, expect, it } from "vitest";

import {
  buildSelectionPayload,
  createCssSelector,
} from "./domPicker";

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

describe("createCssSelector", () => {
  it("creates a stable enough selector for a simple document", () => {
    document.body.innerHTML = `
      <main id="page">
        <article>
          <p>First</p>
          <p id="selected">Second</p>
        </article>
      </main>
    `;

    const selected = document.querySelector("#selected");

    expect(selected).not.toBeNull();
    expect(createCssSelector(selected as Element)).toBe("#selected");
    expect(document.querySelector(createCssSelector(selected as Element))).toBe(selected);
  });
});

describe("buildSelectionPayload", () => {
  it("builds a selection payload from the chosen element", () => {
    document.title = "Example page";
    document.body.innerHTML = `<article id="selected"><p>Hello world</p></article>`;

    const element = document.querySelector("#selected");
    expect(element).not.toBeNull();

    expect(buildSelectionPayload(element as Element, "Explain this")).toMatchObject({
      url: window.location.href,
      title: "Example page",
      selectedText: "Hello world",
      selectedHtml: '<article id="selected"><p>Hello world</p></article>',
      selector: "#selected",
      comment: "Explain this",
      capturedAt: expect.any(Number),
    });
  });

  it("truncates oversized text and html using the shared truncation marker", () => {
    document.title = "Large example";
    const longText = "A".repeat(MAX_SELECTED_TEXT_BYTES + 128);
    const longHtmlText = "B".repeat(MAX_SELECTED_HTML_BYTES + 256);
    document.body.innerHTML = `<article id="selected"><p>${longText}</p><div>${longHtmlText}</div></article>`;

    const element = document.querySelector("#selected");
    expect(element).not.toBeNull();

    const payload = buildSelectionPayload(element as Element, "");
    const rawText = normalizeWhitespace((element as Element).textContent ?? "");
    const rawHtml = (element as Element).outerHTML;

    expect(payload.selectedText).toBe(truncateUtf8(rawText, MAX_SELECTED_TEXT_BYTES).value);
    expect(payload.selectedHtml).toBe(truncateUtf8(rawHtml, MAX_SELECTED_HTML_BYTES).value);
    expect(new TextEncoder().encode(payload.selectedText).length).toBeLessThanOrEqual(MAX_SELECTED_TEXT_BYTES);
    expect(new TextEncoder().encode(payload.selectedHtml).length).toBeLessThanOrEqual(MAX_SELECTED_HTML_BYTES);
    expect(payload.selectedText).toContain(`[truncated: original ${new TextEncoder().encode(rawText).length} bytes, limit ${MAX_SELECTED_TEXT_BYTES} bytes]`);
    expect(payload.selectedHtml).toContain(`[truncated: original ${new TextEncoder().encode(rawHtml).length} bytes, limit ${MAX_SELECTED_HTML_BYTES} bytes]`);
  });
});
