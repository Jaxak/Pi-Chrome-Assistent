import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";
import {
  createRequestId,
  isProtocolEnvelope,
  parseProtocolEnvelope,
  validateChatEvent,
  validateSelectionPayload,
  validateDirectSendChatPayload,
  validateDirectSendSelectionPayload,
  validateDirectSetModelPayload,
  type ChatEvent,
  type DirectSendChatPayload,
  type DirectSendSelectionPayload,
  type DirectSetModelPayload,
  type DirectSessionSnapshot,
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
  it("accepts a valid protocol envelope with direct message type", () => {
    expect(
      isProtocolEnvelope({ version: 1, type: "session.snapshot", requestId: "abc" }),
    ).toBe(true);
  });

  it("accepts direct session message types", () => {
    expect(isProtocolEnvelope({ version: 1, type: "session.snapshot" })).toBe(true);
    expect(isProtocolEnvelope({ version: 1, type: "session.chat.send" })).toBe(true);
    expect(isProtocolEnvelope({ version: 1, type: "session.selection.send" })).toBe(true);
    expect(isProtocolEnvelope({ version: 1, type: "session.model.set" })).toBe(true);
    expect(isProtocolEnvelope({ version: 1, type: "session.command.result" })).toBe(true);
    expect(isProtocolEnvelope({ version: 1, type: "session.error" })).toBe(true);
  });

  it("rejects envelopes with wrong version", () => {
    expect(isProtocolEnvelope({ version: 2, type: "session.snapshot" })).toBe(false);
  });

  it("rejects unknown message types", () => {
    expect(isProtocolEnvelope({ version: 1, type: "unknown.type" })).toBe(false);
    expect(parseProtocolEnvelope(JSON.stringify({ version: 1, type: "unknown.type" }))).toBeNull();
  });

  it("rejects envelopes with non-string requestId", () => {
    expect(isProtocolEnvelope({ version: 1, type: "session.snapshot", requestId: 123 })).toBe(false);
  });

  it("parses valid JSON into an envelope", () => {
    expect(parseProtocolEnvelope(JSON.stringify({ version: 1, type: "session.snapshot" }))).toEqual({
      version: 1,
      type: "session.snapshot",
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

describe("direct session protocol validation", () => {
  it("accepts a valid direct chat send payload", () => {
    const payload: DirectSendChatPayload = { message: "Привет" };
    expect(validateDirectSendChatPayload(payload)).toEqual({ ok: true });
  });

  it("rejects empty chat message", () => {
    const payload: DirectSendChatPayload = { message: "   " };
    expect(validateDirectSendChatPayload(payload)).toEqual({ ok: false, error: "Missing message" });
  });

  it("rejects missing message", () => {
    expect(validateDirectSendChatPayload({ message: "" })).toEqual({ ok: false, error: "Missing message" });
  });

  it("accepts a valid direct selection send payload", () => {
    const payload: DirectSendSelectionPayload = { selection: validSelection };
    expect(validateDirectSendSelectionPayload(payload)).toEqual({ ok: true });
  });

  it("rejects selection payload with invalid selection", () => {
    const payload: DirectSendSelectionPayload = { selection: { ...validSelection, url: "" } };
    expect(validateDirectSendSelectionPayload(payload).ok).toBe(false);
  });

  it("accepts a valid direct model set payload", () => {
    const payload: DirectSetModelPayload = { provider: "anthropic", modelId: "claude-sonnet" };
    expect(validateDirectSetModelPayload(payload)).toEqual({ ok: true });
  });

  it("rejects model set payload with missing provider", () => {
    expect(validateDirectSetModelPayload({ provider: "", modelId: "claude" }))
      .toEqual({ ok: false, error: "Missing provider" });
  });

  it("rejects model set payload with missing modelId", () => {
    expect(validateDirectSetModelPayload({ provider: "anthropic", modelId: "" }))
      .toEqual({ ok: false, error: "Missing modelId" });
  });
});

describe("direct session snapshot shape", () => {
  it("exposes valid snapshot payload shape", () => {
    const snapshot: DirectSessionSnapshot = {
      session: {
        cwd: "/repo",
        gitBranch: "main",
        pid: 123,
        sessionName: "test-session",
        alias: "frontend",
        connectedAt: 1_710_000_000_000,
      },
      chat: {
        events: [
          { kind: "user_message", text: "Привет", timestamp: 1_710_000_000_000 },
        ],
        agentBusy: false,
        busyLabel: "Агент работает в фоне…",
      },
      runtime: {
        model: { provider: "anthropic", id: "claude-sonnet", label: "Claude Sonnet" },
        availableModels: [
          { provider: "anthropic", id: "claude-sonnet", label: "Claude Sonnet" },
        ],
        contextUsage: { tokens: 1234, maxTokens: 200000, percent: 1 },
        isIdle: true,
        updatedAt: 1_710_000_000_000,
      },
    };

    expect(snapshot).toMatchObject({
      session: { cwd: "/repo", pid: 123 },
      chat: { agentBusy: false },
      runtime: { isIdle: true },
    });
  });
});

describe("chat event validation", () => {
  it("accepts user message chat event", () => {
    const event: ChatEvent = {
      kind: "user_message",
      text: "Привет",
      timestamp: 1_710_000_000_000,
    };
    expect(validateChatEvent(event)).toEqual({ ok: true });
  });

  it("accepts agent_busy chat event", () => {
    const event: ChatEvent = {
      kind: "agent_busy",
      busy: true,
      label: "Агент работает в фоне…",
      timestamp: 1_710_000_000_000,
    };
    expect(validateChatEvent(event)).toEqual({ ok: true });
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
