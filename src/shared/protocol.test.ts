import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";
import {
  createRequestId,
  isProtocolEnvelope,
  parseProtocolEnvelope,
  validateChatEvent,
  validateSelectionPayload,
  validateSendChatMessagePayload,
  validateSubscribeTargetPayload,
  type BrowserClientHelloPayload,
  type BrowserClientSendChatMessagePayload,
  type BrowserClientSendSelectionPayload,
  type BrowserClientSubscribeTargetPayload,
  type ChatEvent,
  type SelectionPayload,
} from "./protocol";
import { BROWSER_NOT_AUTHORIZED_ERROR, BROWSER_TOKEN_STORAGE_KEY } from "./constants";

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



describe("browser auth protocol helpers", () => {
  it("exposes stable browser auth constants and payload shapes", () => {
    const helloPayload: BrowserClientHelloPayload = {
      token: "browser-token-1",
    };
    const sendSelectionPayload: BrowserClientSendSelectionPayload = {
      token: helloPayload.token,
      targetId: "target-1",
      selection: validSelection,
    };

    expect(BROWSER_TOKEN_STORAGE_KEY).toBe("browserToken");
    expect(BROWSER_NOT_AUTHORIZED_ERROR).toBe("Браузер не авторизован в Pi");
    expect(sendSelectionPayload).toMatchObject({
      token: "browser-token-1",
      targetId: "target-1",
      selection: validSelection,
    });
  });
});

describe("chat protocol validation", () => {
  it("accepts known chat message types as protocol envelopes", () => {
    expect(isProtocolEnvelope({ version: 1, type: "client.subscribeTarget", requestId: "sub-1" })).toBe(true);
    expect(isProtocolEnvelope({ version: 1, type: "client.unsubscribeTarget", requestId: "sub-2" })).toBe(true);
    expect(isProtocolEnvelope({ version: 1, type: "client.sendChatMessage", requestId: "chat-1" })).toBe(true);
    expect(isProtocolEnvelope({ version: 1, type: "client.chatAccepted", requestId: "chat-1" })).toBe(true);
    expect(isProtocolEnvelope({ version: 1, type: "client.chatEvent" })).toBe(true);
    expect(isProtocolEnvelope({ version: 1, type: "target.deliverChatMessage", requestId: "chat-1" })).toBe(true);
    expect(isProtocolEnvelope({ version: 1, type: "target.chatEvent" })).toBe(true);
  });

  it("rejects empty chat messages", () => {
    const payload: BrowserClientSendChatMessagePayload = {
      token: "browser-token-1",
      targetId: "target-1",
      message: "   ",
    };

    expect(validateSendChatMessagePayload(payload)).toEqual({ ok: false, error: "Missing message" });
  });

  it("rejects chat messages without targetId", () => {
    const payload = {
      token: "browser-token-1",
      targetId: "",
      message: "Привет",
    } satisfies BrowserClientSendChatMessagePayload;

    expect(validateSendChatMessagePayload(payload)).toEqual({ ok: false, error: "Missing targetId" });
  });

  it("accepts target subscriptions with token and targetId", () => {
    const payload: BrowserClientSubscribeTargetPayload = {
      token: "browser-token-1",
      targetId: "target-1",
    };

    expect(validateSubscribeTargetPayload(payload)).toEqual({ ok: true });
  });

  it("accepts assistant text delta chat events", () => {
    const event: ChatEvent = {
      kind: "assistant_text_delta",
      messageId: "message-1",
      delta: "Привет",
      timestamp: 1_710_000_000_000,
    };

    expect(validateChatEvent(event)).toEqual({ ok: true });
  });

  it("rejects unknown chat event kinds", () => {
    expect(validateChatEvent({ kind: "unknown", timestamp: 1_710_000_000_000 })).toEqual({
      ok: false,
      error: "Unknown chat event kind",
    });
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
