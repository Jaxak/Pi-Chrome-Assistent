// @vitest-environment jsdom

import { MAX_SELECTED_HTML_BYTES, MAX_SELECTED_TEXT_BYTES } from "../shared/constants";
import { truncateUtf8 } from "../shared/truncation";
import { describe, expect, it } from "vitest";

import {
  buildSelectionPayload,
  createCssSelector,
  findLogicalSelectionElement,
  findSiblingElements,
  getSelectionCandidates,
} from "./domPicker";

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

describe("getSelectionCandidates", () => {
  it("returns ordered selection candidates from smaller to larger blocks", () => {
    document.body.innerHTML = `
      <section id="shell">
        <article id="card">
          <h3>Заголовок карточки</h3>
          <p id="start">Осмысленный текст внутри карточки.</p>
        </article>
      </section>
    `;

    const start = document.querySelector("#start");

    expect(start).not.toBeNull();

    const result = getSelectionCandidates(start as Element);

    expect(result.candidates.map((element) => element.id)).toEqual(["start", "card", "shell"]);
    expect(result.recommendedIndex).toBe(1);
  });

  it("prefers a compact text block over a large layout wrapper", () => {
    document.body.innerHTML = `
      <div id="app">
        <div id="layout">
          <div id="card">
            <div class="title">Сводка</div>
            <div id="start">Нужный локальный текстовый блок для отправки.</div>
          </div>
        </div>
      </div>
    `;

    const start = document.querySelector("#start");

    expect(start).not.toBeNull();

    const result = getSelectionCandidates(start as Element);

    expect(result.candidates[result.recommendedIndex]?.id).toBe("card");
    expect(findLogicalSelectionElement(start as Element)).toBe(document.querySelector("#card"));
  });

  it("prefers a table cell or row over the whole table wrapper", () => {
    document.body.innerHTML = `
      <div id="table-shell">
        <table>
          <tbody>
            <tr id="row">
              <td id="cell"><span id="start">Критичный статус</span></td>
            </tr>
          </tbody>
        </table>
      </div>
    `;

    const start = document.querySelector("#start");

    expect(start).not.toBeNull();
    expect(findLogicalSelectionElement(start as Element).id).toBe("cell");
  });

  it("does not escalate to a giant dashboard wrapper when a card exists", () => {
    document.body.innerHTML = `
      <div id="dashboard">
        <div id="column">
          <section id="card">
            <h2>Платёж</h2>
            <p id="start">Просрочен на 3 дня</p>
          </section>
        </div>
      </div>
    `;

    const start = document.querySelector("#start");

    expect(start).not.toBeNull();
    expect(findLogicalSelectionElement(start as Element).id).toBe("card");
  });
});

describe("findLogicalSelectionElement", () => {
  it("prefers pre/code blocks for code-heavy content", () => {
    document.body.innerHTML = `
      <main>
        <article>
          <p>Intro text</p>
          <pre id="snippet"><code><span>const answer = 42;</span></code></pre>
        </article>
      </main>
    `;

    const start = document.querySelector("span");

    expect(start).not.toBeNull();
    expect(findLogicalSelectionElement(start as Element)).toBe(document.querySelector("#snippet"));
  });

  it("selects a semantic article over a tiny child span", () => {
    document.body.innerHTML = `
      <article id="story">
        <h1>Longer heading for the selected story</h1>
        <p>This article contains enough meaningful text to be a logical selection target.</p>
        <span id="tiny">ok</span>
      </article>
    `;

    const start = document.querySelector("#tiny");

    expect(start).not.toBeNull();
    expect(findLogicalSelectionElement(start as Element)).toBe(document.querySelector("#story"));
  });

  it("avoids body when a reasonable container exists", () => {
    document.body.innerHTML = `
      <main>
        <section id="target">
          <h2>Useful section</h2>
          <p>This section should be chosen instead of the whole document body.</p>
        </section>
      </main>
      <footer>Footer text</footer>
    `;

    const start = document.querySelector("h2");

    expect(start).not.toBeNull();
    expect(findLogicalSelectionElement(start as Element)).not.toBe(document.body);
    expect(["main", "section"]).toContain(findLogicalSelectionElement(start as Element).tagName.toLowerCase());
  });

  it("prefers meaningful ARIA roles over a generic parent when scores are otherwise close", () => {
    document.body.innerHTML = `
      <div id="outer">
        <div id="content" role="article">
          <p id="start">Meaningful role content that should beat the generic wrapper.</p>
        </div>
      </div>
    `;

    const start = document.querySelector("#start");

    expect(start).not.toBeNull();
    expect(findLogicalSelectionElement(start as Element)).toBe(document.querySelector("#content"));
  });
});

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
