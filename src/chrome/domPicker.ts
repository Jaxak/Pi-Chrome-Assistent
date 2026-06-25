import { MAX_SELECTED_HTML_BYTES, MAX_SELECTED_TEXT_BYTES } from "../shared/constants";
import type { SelectionPayload } from "../shared/protocol";
import { truncateUtf8 } from "../shared/truncation";

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function getElementText(element: Element): string {
  const candidate = "innerText" in element && typeof element.innerText === "string"
    ? element.innerText
    : element.textContent ?? "";

  return normalizeWhitespace(candidate);
}

function escapeIdentifier(value: string): string {
  if (typeof globalThis.CSS?.escape === "function") {
    return globalThis.CSS.escape(value);
  }

  return value.replace(/(^-?\d)|[^a-zA-Z0-9_-]/g, (match, leadingDigit) => {
    if (leadingDigit) {
      return `\\3${leadingDigit} `;
    }

    return `\\${match}`;
  });
}

function isUniqueSelector(selector: string): boolean {
  try {
    return document.querySelectorAll(selector).length === 1;
  } catch {
    return false;
  }
}

export function createCssSelector(element: Element): string {
  if (element.id) {
    const idSelector = `#${escapeIdentifier(element.id)}`;

    if (isUniqueSelector(idSelector)) {
      return idSelector;
    }
  }

  const segments: string[] = [];
  let current: Element | null = element;

  while (current && current.nodeType === Node.ELEMENT_NODE) {
    if (current.id) {
      const idSelector = `#${escapeIdentifier(current.id)}`;

      if (isUniqueSelector(idSelector)) {
        segments.unshift(idSelector);
        break;
      }
    }

    const tagName = current.tagName.toLowerCase();
    const parent: Element | null = current.parentElement;

    if (!parent) {
      segments.unshift(tagName);
      break;
    }

    const sameTypeSiblings = Array.from(parent.children).filter(
      (child: Element) => child.tagName.toLowerCase() === tagName,
    );
    const index = sameTypeSiblings.indexOf(current) + 1;
    const segment = sameTypeSiblings.length > 1 ? `${tagName}:nth-of-type(${index})` : tagName;

    segments.unshift(segment);
    current = parent;
  }

  return segments.join(" > ");
}

export function buildSelectionPayload(element: Element, comment: string): SelectionPayload {
  const normalizedComment = comment.trim();
  const selectedText = truncateUtf8(getElementText(element), MAX_SELECTED_TEXT_BYTES).value;
  const selectedHtml = truncateUtf8(element.outerHTML, MAX_SELECTED_HTML_BYTES).value;

  return {
    url: window.location.href,
    title: document.title,
    selectedText,
    selectedHtml,
    selector: createCssSelector(element),
    ...(normalizedComment.length > 0 ? { comment: normalizedComment } : {}),
    capturedAt: Date.now(),
  };
}
