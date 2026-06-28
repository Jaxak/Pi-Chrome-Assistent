// @vitest-environment jsdom

import { describe, expect, it } from "vitest";

import {
  createAgentWorkingElement,
  createChatMessageElement,
} from "./sidepanelRender";
import type { SidepanelChatMessage } from "./sidepanelState";

describe("sidepanelRender", () => {
  it("renders chat messages with markdown (innerHTML)", () => {
    const message: SidepanelChatMessage = {
      role: "assistant",
      messageId: "message-1",
      text: "Привет, это **жирный** текст и `код`",
      streaming: false,
      timestamp: 1_710_000_000_000,
    };

    const element = createChatMessageElement(message);

    expect(element.innerHTML).toContain("<strong>жирный</strong>");
    expect(element.innerHTML).toContain("<code>код</code>");
    expect(element.textContent).toContain("Привет, это жирный текст и код");
    expect(element.className).toContain("message-row");
  });

  it("escapes raw HTML in messages (XSS-safe)", () => {
    const message: SidepanelChatMessage = {
      role: "assistant",
      messageId: "message-2",
      text: "<script>alert('xss')</script>",
      streaming: false,
      timestamp: 1_710_000_000_000,
    };

    const element = createChatMessageElement(message);

    expect(element.innerHTML).toContain("&lt;script&gt;");
    expect(element.innerHTML).not.toContain("<script>");
  });

  it("renders the required minimal busy indicator", () => {
    const element = createAgentWorkingElement("Агент работает в фоне…");

    expect(element.getAttribute("role")).toBe("status");
    expect(element.getAttribute("aria-live")).toBe("polite");
    expect(element.className).toBe("agent-working");
    expect(element.querySelectorAll(".agent-working__dots i")).toHaveLength(3);
    expect(element.textContent).toContain("Агент работает в фоне…");
  });

  it("renders user messages with correct role class", () => {
    const message: SidepanelChatMessage = {
      role: "user",
      text: "Привет Pi",
      timestamp: 1_710_000_000_000,
    };

    const element = createChatMessageElement(message);
    expect(element.className).toContain("user");
    expect(element.textContent).toContain("Привет Pi");
  });
});
