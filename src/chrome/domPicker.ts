import { MAX_SELECTED_HTML_BYTES, MAX_SELECTED_TEXT_BYTES } from "../shared/constants";
import type { SelectionPayload } from "../shared/protocol";
import { truncateUtf8 } from "../shared/truncation";

const HIGH_PRIORITY_TAG_SCORES: Record<string, number> = {
  pre: 160,
  code: 150,
  table: 145,
  blockquote: 140,
};

const SEMANTIC_TAG_SCORES: Record<string, number> = {
  article: 110,
  main: 95,
  section: 80,
  aside: 70,
  figure: 65,
  figcaption: 45,
  header: 35,
  footer: 20,
  nav: 15,
  ul: 35,
  ol: 35,
  li: 20,
};

const INLINE_TAG_PENALTIES: Record<string, number> = {
  a: -8,
  b: -6,
  em: -6,
  i: -6,
  small: -10,
  span: -28,
  strong: -6,
};

const MEANINGFUL_ARIA_ROLE_SCORES: Record<string, number> = {
  article: 110,
  main: 95,
  region: 80,
  table: 145,
  code: 150,
  log: 70,
};

const MAX_SELECTION_CANDIDATE_DEPTH = 8;

export type SelectionCandidates = {
  candidates: Element[];
  recommendedIndex: number;
};

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function getElementText(element: Element): string {
  const candidate = "innerText" in element && typeof element.innerText === "string"
    ? element.innerText
    : element.textContent ?? "";

  return normalizeWhitespace(candidate);
}

function getTextLengthScore(textLength: number): number {
  if (textLength === 0) {
    return -200;
  }

  if (textLength < 8) {
    return -60;
  }

  if (textLength < 20) {
    return -15;
  }

  return Math.min(90, Math.floor(textLength / 2));
}

function getMeaningfulRoleScore(element: Element): number {
  const roleAttribute = element.getAttribute("role");
  if (!roleAttribute) {
    return 0;
  }

  return roleAttribute
    .split(/\s+/)
    .reduce((maxScore, role) => Math.max(maxScore, MEANINGFUL_ARIA_ROLE_SCORES[role.toLowerCase()] ?? 0), 0);
}

function getRectScore(element: Element): number {
  if (typeof element.getBoundingClientRect !== "function") {
    return 0;
  }

  const rect = element.getBoundingClientRect();
  const width = Number.isFinite(rect.width) ? rect.width : 0;
  const height = Number.isFinite(rect.height) ? rect.height : 0;
  const area = width * height;

  if (area <= 0) {
    return 0;
  }

  if (width < 16 || height < 12 || area < 320) {
    return -35;
  }

  const viewportWidth = typeof window !== "undefined" && window.innerWidth > 0 ? window.innerWidth : undefined;
  const viewportHeight = typeof window !== "undefined" && window.innerHeight > 0 ? window.innerHeight : undefined;

  if (viewportWidth && viewportHeight) {
    const viewportArea = viewportWidth * viewportHeight;

    if (area > viewportArea * 0.92) {
      return -30;
    }
  }

  return 22;
}

function getTextDensityScore(element: Element, textLength: number): number {
  const childCount = element.children.length;

  if (textLength === 0) {
    return childCount > 0 ? -24 : 0;
  }

  if (childCount === 0) {
    return textLength >= 20 ? 14 : 6;
  }

  const density = textLength / Math.max(1, childCount);

  if (density >= 28) {
    return 26;
  }

  if (density >= 16) {
    return 14;
  }

  if (density >= 8) {
    return 4;
  }

  return -10;
}

function getWrapperPenalty(element: Element, textLength: number): number {
  if (textLength === 0) {
    return 0;
  }

  const childCount = element.children.length;

  if (childCount === 1 && textLength >= 20) {
    return -20;
  }

  if (childCount >= 10) {
    return -16;
  }

  if (childCount >= 5) {
    return -8;
  }

  return 0;
}

function scoreElement(element: Element): number {
  const tagName = element.tagName.toLowerCase();
  const text = getElementText(element);
  const textLength = text.length;

  let score = getTextLengthScore(textLength);
  score += HIGH_PRIORITY_TAG_SCORES[tagName] ?? 0;
  score += SEMANTIC_TAG_SCORES[tagName] ?? 0;
  score += INLINE_TAG_PENALTIES[tagName] ?? 0;
  score += getMeaningfulRoleScore(element);

  if (tagName === "body") {
    score -= 260;
  }

  if (tagName === "html") {
    score -= 320;
  }

  if (element.children.length === 0 && textLength < 30) {
    score -= 8;
  }

  score += getTextDensityScore(element, textLength);
  score += getWrapperPenalty(element, textLength);
  score += getRectScore(element);

  return score;
}

function shouldIncludeSelectionCandidate(element: Element): boolean {
  const tagName = element.tagName.toLowerCase();
  return tagName !== "body" && tagName !== "html";
}

function collectCandidateChain(start: Element): Element[] {
  const candidates: Element[] = [];
  let current: Element | null = start;
  let depth = 0;

  while (current && depth < MAX_SELECTION_CANDIDATE_DEPTH) {
    if (shouldIncludeSelectionCandidate(current)) {
      candidates.push(current);
    }

    current = current.parentElement;
    depth += 1;
  }

  return candidates;
}

function dedupeCandidates(candidates: Element[]): Element[] {
  return candidates.filter((candidate, index) => candidates.indexOf(candidate) === index);
}

function chooseRecommendedCandidateIndex(candidates: Element[]): number {
  if (candidates.length === 0) {
    return 0;
  }

  let bestIndex = 0;
  let bestScore = Number.NEGATIVE_INFINITY;

  for (const [index, candidate] of candidates.entries()) {
    const score = scoreElement(candidate);

    if (score > bestScore) {
      bestScore = score;
      bestIndex = index;
    }
  }

  return bestIndex;
}

export function getSelectionCandidates(start: Element): SelectionCandidates {
  const candidates = dedupeCandidates(collectCandidateChain(start));
  const recommendedIndex = chooseRecommendedCandidateIndex(candidates);

  return {
    candidates: candidates.length > 0 ? candidates : [start],
    recommendedIndex: candidates.length > 0 ? recommendedIndex : 0,
  };
}

export function findLogicalSelectionElement(start: Element): Element {
  const { candidates, recommendedIndex } = getSelectionCandidates(start);
  return candidates[recommendedIndex] ?? start;
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
