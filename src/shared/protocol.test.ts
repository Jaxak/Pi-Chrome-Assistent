import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";
import {
  createRequestId,
  isProtocolEnvelope,
  parseProtocolEnvelope,
  validateSelectionPayload,
  type SelectionPayload,
} from "./protocol";

const validSelection: SelectionPayload = {
  url: "https://example.com/page",
  title: "Example",
  selectedText: "hello",
  selectedHtml: "<p>hello</p>",
  selector: "p",
  comment: "explain",
  capturedAt: 1710000000000,
};

describe("protocol envelope", () => {
  it("accepts a valid protocol envelope", () => {
    expect(
      isProtocolEnvelope({ version: 1, type: "client.listTargets", requestId: "abc" }),
    ).toBe(true);
  });

  it("accepts target registration acknowledgements", () => {
    expect(
      isProtocolEnvelope({ version: 1, type: "target.registered", requestId: "register-1" }),
    ).toBe(true);
  });

  it("rejects envelopes with wrong version", () => {
    expect(isProtocolEnvelope({ version: 2, type: "client.listTargets" })).toBe(false);
  });

  it("rejects unknown message types", () => {
    expect(isProtocolEnvelope({ version: 1, type: "client.unknown" })).toBe(false);
    expect(parseProtocolEnvelope(JSON.stringify({ version: 1, type: "client.unknown" }))).toBeNull();
  });

  it("rejects envelopes with non-string requestId", () => {
    expect(isProtocolEnvelope({ version: 1, type: "client.listTargets", requestId: 123 })).toBe(false);
  });

  it("parses valid JSON into an envelope", () => {
    expect(parseProtocolEnvelope(JSON.stringify({ version: 1, type: "client.hello" }))).toEqual({
      version: 1,
      type: "client.hello",
    });
  });

  it("returns null for invalid JSON", () => {
    expect(parseProtocolEnvelope("not json")).toBeNull();
  });

  it("creates unique request ids", () => {
    expect(createRequestId()).not.toEqual(createRequestId());
  });

  it("does not import node:crypto in shared protocol source", () => {
    const source = readFileSync(new URL("./protocol.ts", import.meta.url), "utf8");
    expect(source).not.toContain('from "node:crypto"');
  });
});

describe("selection payload validation", () => {
  it("accepts a valid payload", () => {
    expect(validateSelectionPayload(validSelection).ok).toBe(true);
  });

  it("rejects missing URL", () => {
    const result = validateSelectionPayload({ ...validSelection, url: "" });
    expect(result.ok).toBe(false);
  });

  it("rejects non-string title", () => {
    const result = validateSelectionPayload({ ...validSelection, title: 123 });
    expect(result.ok).toBe(false);
  });

  it("rejects non-string selectedText", () => {
    const result = validateSelectionPayload({ ...validSelection, selectedText: 123 });
    expect(result.ok).toBe(false);
  });

  it("rejects non-string selectedHtml", () => {
    const result = validateSelectionPayload({ ...validSelection, selectedHtml: 123 });
    expect(result.ok).toBe(false);
  });

  it("rejects non-string comment", () => {
    const result = validateSelectionPayload({ ...validSelection, comment: 123 });
    expect(result.ok).toBe(false);
  });

  it("rejects non-string selector", () => {
    const result = validateSelectionPayload({ ...validSelection, selector: 123 });
    expect(result.ok).toBe(false);
  });

  it("rejects NaN capturedAt", () => {
    const result = validateSelectionPayload({ ...validSelection, capturedAt: Number.NaN });
    expect(result.ok).toBe(false);
  });

  it("rejects Infinity capturedAt", () => {
    const result = validateSelectionPayload({ ...validSelection, capturedAt: Number.POSITIVE_INFINITY });
    expect(result.ok).toBe(false);
  });

  it("rejects payload without text and html", () => {
    const result = validateSelectionPayload({ ...validSelection, selectedText: "", selectedHtml: "" });
    expect(result.ok).toBe(false);
  });
});
