import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";
import {
  createRequestId,
  isProtocolEnvelope,
  parseProtocolEnvelope,
  validatePiMirrorEvent,
  validateSelectionPayload,
  validateDirectSendChatPayload,
  validateDirectSendSelectionPayload,
  validateDirectSetModelPayload,
  type DirectSendChatPayload,
  type DirectSendSelectionPayload,
  type DirectSetModelPayload,
  type DirectSessionSnapshot,
  type PiMirrorEvent,
  type SelectionPayload,
} from "./protocol";
import { validateSidePanelChatEvent } from "../chrome/sidepanelState";

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
    expect(isProtocolEnvelope({ version: 1, type: "session.event" })).toBe(true);
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
        entries: [
          {
            type: "message",
            id: "entry-1",
            timestamp: "2026-06-28T04:00:00.000Z",
            message: {
              role: "user",
              content: "Привет",
            },
          },
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

describe("mirror event validation", () => {
  it("accepts message_update mirror event with text_delta payload", () => {
    const event: PiMirrorEvent = {
      type: "message_update",
      message: { id: "message-1", role: "assistant" },
      assistantMessageEvent: { type: "text_delta", text_delta: "Привет" },
    };

    expect(validatePiMirrorEvent(event)).toEqual({ ok: true });
  });

  it("accepts message_start mirror event", () => {
    const event: PiMirrorEvent = {
      type: "message_start",
      message: { id: "message-1", role: "assistant" },
    };

    expect(validatePiMirrorEvent(event)).toEqual({ ok: true });
  });

  it("accepts message_end mirror event with stopReason", () => {
    const event: PiMirrorEvent = {
      type: "message_end",
      message: { id: "message-1", role: "assistant" },
      stopReason: "end_turn",
    };

    expect(validatePiMirrorEvent(event)).toEqual({ ok: true });
  });

  it("accepts turn_start mirror event", () => {
    const event: PiMirrorEvent = { type: "turn_start", turnId: "turn-1" };
    expect(validatePiMirrorEvent(event)).toEqual({ ok: true });
  });

  it("accepts turn_end mirror event", () => {
    const event: PiMirrorEvent = { type: "turn_end", turnId: "turn-1" };
    expect(validatePiMirrorEvent(event)).toEqual({ ok: true });
  });

  it("accepts tool_execution_start mirror event", () => {
    const event: PiMirrorEvent = { type: "tool_execution_start", toolName: "read_file", input: { path: "/tmp/test" } };
    expect(validatePiMirrorEvent(event)).toEqual({ ok: true });
  });

  it("accepts tool_execution_update mirror event", () => {
    const event: PiMirrorEvent = { type: "tool_execution_update", toolName: "read_file", output: "content" };
    expect(validatePiMirrorEvent(event)).toEqual({ ok: true });
  });

  it("accepts tool_execution_end mirror event", () => {
    const event: PiMirrorEvent = { type: "tool_execution_end", toolName: "read_file", output: "content", error: "timeout" };
    expect(validatePiMirrorEvent(event)).toEqual({ ok: true });
  });

  it("accepts model_select mirror event", () => {
    const event: PiMirrorEvent = { type: "model_select", provider: "anthropic", modelId: "claude-sonnet" };
    expect(validatePiMirrorEvent(event)).toEqual({ ok: true });
  });

  it("rejects message_update without message.id", () => {
    expect(validatePiMirrorEvent({ type: "message_update", message: { role: "assistant" } })).toEqual({
      ok: false,
      error: "Missing message.id",
    });
  });

  it("rejects message_update with invalid assistantMessageEvent type", () => {
    expect(
      validatePiMirrorEvent({
        type: "message_update",
        message: { id: "msg-1", role: "assistant" },
        assistantMessageEvent: { type: "unknown_type", text_delta: "x" },
      }),
    ).toEqual({ ok: false, error: "Unsupported assistantMessageEvent type" });
  });

  it("rejects unknown mirror event types", () => {
    expect(validatePiMirrorEvent({ type: "unknown" })).toEqual({
      ok: false,
      error: "Unknown mirror event type: unknown",
    });
  });

  it("session.event envelope with PiMirrorEvent survives parseProtocolEnvelope roundtrip", () => {
    const envelope = {
      version: 1,
      type: "session.event" as const,
      payload: {
        type: "message_update" as const,
        message: { id: "msg-1", role: "assistant" as const },
        assistantMessageEvent: { type: "text_delta" as const, text_delta: "Hello world" },
      },
    };

    const json = JSON.stringify(envelope);
    const parsed = parseProtocolEnvelope(json);

    expect(parsed).not.toBeNull();
    expect(parsed!.type).toBe("session.event");
    expect(parsed!.payload).toMatchObject({
      type: "message_update",
      message: { id: "msg-1", role: "assistant" },
      assistantMessageEvent: { type: "text_delta", text_delta: "Hello world" },
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

describe("validateSidePanelChatEvent", () => {
  it("should reject non-object payload", () => {
    expect(validateSidePanelChatEvent(null).ok).toBe(false);
    expect(validateSidePanelChatEvent(undefined).ok).toBe(false);
    expect(validateSidePanelChatEvent("string").ok).toBe(false);
  });

  it("should reject missing timestamp", () => {
    expect(validateSidePanelChatEvent({ kind: "user_message", text: "hi" }).ok).toBe(false);
  });

  it("should validate user_message", () => {
    expect(validateSidePanelChatEvent({ kind: "user_message", text: "hi", timestamp: 123 }).ok).toBe(true);
    expect(validateSidePanelChatEvent({ kind: "user_message", text: "", timestamp: 123 }).ok).toBe(false);
    expect(validateSidePanelChatEvent({ kind: "user_message", timestamp: 123 }).ok).toBe(false);
  });

  it("should validate agent_busy", () => {
    expect(validateSidePanelChatEvent({ kind: "agent_busy", busy: true, label: "Working", timestamp: 123 }).ok).toBe(true);
    expect(validateSidePanelChatEvent({ kind: "agent_busy", busy: true, timestamp: 123 }).ok).toBe(false);
    expect(validateSidePanelChatEvent({ kind: "agent_busy", label: "X", timestamp: 123 }).ok).toBe(false);
  });

  it("should validate assistant_message_start", () => {
    expect(validateSidePanelChatEvent({ kind: "assistant_message_start", messageId: "abc", timestamp: 123 }).ok).toBe(true);
    expect(validateSidePanelChatEvent({ kind: "assistant_message_start", messageId: "", timestamp: 123 }).ok).toBe(false);
  });

  it("should validate assistant_message_end", () => {
    expect(validateSidePanelChatEvent({ kind: "assistant_message_end", messageId: "abc", timestamp: 123 }).ok).toBe(true);
  });

  it("should validate assistant_text_delta", () => {
    expect(validateSidePanelChatEvent({ kind: "assistant_text_delta", messageId: "abc", delta: "hi", timestamp: 123 }).ok).toBe(true);
    expect(validateSidePanelChatEvent({ kind: "assistant_text_delta", messageId: "", delta: "hi", timestamp: 123 }).ok).toBe(false);
    expect(validateSidePanelChatEvent({ kind: "assistant_text_delta", messageId: "abc", timestamp: 123 }).ok).toBe(false);
  });

  it("should validate error", () => {
    expect(validateSidePanelChatEvent({ kind: "error", message: "oops", timestamp: 123 }).ok).toBe(true);
    expect(validateSidePanelChatEvent({ kind: "error", message: "", timestamp: 123 }).ok).toBe(false);
  });

  it("should reject unknown event kind", () => {
    expect(validateSidePanelChatEvent({ kind: "unknown_kind", timestamp: 123 }).ok).toBe(false);
  });
});
