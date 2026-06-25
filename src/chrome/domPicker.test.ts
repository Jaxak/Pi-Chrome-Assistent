// @vitest-environment jsdom

import { MAX_SELECTED_HTML_BYTES, MAX_SELECTED_TEXT_BYTES } from "../shared/constants";
import { truncateUtf8 } from "../shared/truncation";
import { describe, expect, it } from "vitest";

import {
  buildSelectionPayload,
  createCssSelector,
  findBestVisibleChild,
  getParentElement,
  findSiblingElements,
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

describe("findSiblingElements", () => {
  it("returns visible siblings in DOM order with previous first", () => {
    document.body.innerHTML = `
      <div id="container">
        <div id="s1">First</div>
        <div id="s2">Second</div>
        <div id="target">Target</div>
        <div id="s3">Fourth</div>
        <div id="s4">Fifth</div>
      </div>
    `;
    const target = document.querySelector("#target")!;
    const result = findSiblingElements(target);
    expect(result.elements.map(e => e.id)).toEqual(["s2", "s1", "s3", "s4"]);
    expect(result.currentIndex).toBe(0); // first previous sibling
  });

  it("returns empty array when no siblings exist", () => {
    document.body.innerHTML = `
      <div id="only">Only child</div>
    `;
    const target = document.querySelector("#only")!;
    const result = findSiblingElements(target);
    expect(result.elements).toEqual([]);
    expect(result.currentIndex).toBe(-1);
  });

  it("skips hidden elements (display:none or zero dimensions)", () => {
    document.body.innerHTML = `
      <div>
        <div id="visible1">Visible</div>
        <div id="hidden" style="display:none">Hidden</div>
        <div id="target">Target</div>
        <div id="visible2">Also visible</div>
      </div>
    `;
    const target = document.querySelector("#target")!;
    const result = findSiblingElements(target);
    expect(result.elements.map(e => e.id)).toEqual(["visible1", "visible2"]);
    expect(result.elements.every(e => e.id !== "hidden")).toBe(true);
  });

  it("skips elements with visibility:hidden", () => {
    document.body.innerHTML = `
      <div>
        <div id="visible1">Visible</div>
        <div id="hidden" style="visibility:hidden">Hidden by visibility</div>
        <div id="target">Target</div>
        <div id="visible2">Also visible</div>
      </div>
    `;
    const target = document.querySelector("#target")!;
    const result = findSiblingElements(target);
    expect(result.elements.map(e => e.id)).toEqual(["visible1", "visible2"]);
    expect(result.elements.every(e => e.id !== "hidden")).toBe(true);
  });

  it("skips elements with opacity:0", () => {
    document.body.innerHTML = `
      <div>
        <div id="visible1">Visible</div>
        <div id="hidden" style="opacity:0">Hidden by opacity</div>
        <div id="target">Target</div>
        <div id="visible2">Also visible</div>
      </div>
    `;
    const target = document.querySelector("#target")!;
    const result = findSiblingElements(target);
    expect(result.elements.map(e => e.id)).toEqual(["visible1", "visible2"]);
    expect(result.elements.every(e => e.id !== "hidden")).toBe(true);
  });

  it("prefers previous sibling as initial selection when going up", () => {
    document.body.innerHTML = `
      <div>
        <div id="prev">Previous</div>
        <div id="target">Target</div>
        <div id="next">Next</div>
      </div>
    `;
    const target = document.querySelector("#target")!;
    const result = findSiblingElements(target);
    // First element should be the previous sibling (for "up" direction)
    expect(result.elements[0]?.id).toBe("prev");
  });

  it("orders siblings: previous first (closest to farthest), then next (closest to farthest)", () => {
    document.body.innerHTML = `
      <div>
        <div id="a">A</div>
        <div id="b">B</div>
        <div id="target">Target</div>
        <div id="c">C</div>
        <div id="d">D</div>
      </div>
    `;
    const target = document.querySelector("#target")!;
    const result = findSiblingElements(target);
    expect(result.elements.map(e => e.id)).toEqual(["b", "a", "c", "d"]);
  });
});

describe("findBestVisibleChild", () => {
  it("returns the best-scoring visible child", () => {
    document.body.innerHTML = `
      <div id="parent">
        <span id="small">x</span>
        <p id="best">This paragraph has enough text to score highest among children.</p>
        <div id="empty"></div>
      </div>
    `;
    const parent = document.querySelector("#parent")!;
    const result = findBestVisibleChild(parent);
    expect(result?.id).toBe("best");
  });

  it("returns null when there are no visible children", () => {
    document.body.innerHTML = `
      <div id="parent">
        <div id="hidden" style="display:none">Hidden</div>
      </div>
    `;
    const parent = document.querySelector("#parent")!;
    expect(findBestVisibleChild(parent)).toBeNull();
  });

  it("returns null when element has no children", () => {
    document.body.innerHTML = `
      <div id="leaf">Leaf</div>
    `;
    const leaf = document.querySelector("#leaf")!;
    expect(findBestVisibleChild(leaf)).toBeNull();
  });

  it("skips hidden children and picks among visible ones", () => {
    document.body.innerHTML = `
      <div id="parent">
        <div id="hidden" style="display:none">Hidden</div>
        <p id="visible">Visible content here.</p>
      </div>
    `;
    const parent = document.querySelector("#parent")!;
    const result = findBestVisibleChild(parent);
    expect(result?.id).toBe("visible");
  });
});

describe("getParentElement", () => {
  it("returns the parent element", () => {
    document.body.innerHTML = `
      <section id="outer">
        <div id="inner">Content</div>
      </section>
    `;
    const inner = document.querySelector("#inner")!;
    expect(getParentElement(inner)?.id).toBe("outer");
  });

  it("returns null when parent is body", () => {
    document.body.innerHTML = `
      <div id="direct">Content</div>
    `;
    const direct = document.querySelector("#direct")!;
    expect(getParentElement(direct)).toBeNull();
  });

  it("returns null when parent is html", () => {
    document.documentElement.innerHTML = `
      <div id="only">Only</div>
    `;
    const only = document.querySelector("#only")!;
    expect(getParentElement(only)).toBeNull();
  });
});
