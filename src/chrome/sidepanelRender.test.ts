// @vitest-environment jsdom

import { describe, expect, it } from "vitest";

import {
  createAgentWorkingElement,
  createChatMessageElement,
  isChatSendDisabled,
} from "./sidepanelRender";
import type { SidepanelChatMessage } from "./sidepanelState";

describe("sidepanelRender", () => {
  it("renders chat messages as textContent without innerHTML", () => {
    const message: SidepanelChatMessage = {
      role: "assistant",
      messageId: "message-1",
      text: "<strong>Привет</strong>",
      streaming: false,
      timestamp: 1_710_000_000_000,
    };

    const element = createChatMessageElement(message);

    expect(element.textContent).toContain("<strong>Привет</strong>");
    expect(element.innerHTML).not.toContain("<strong>Привет</strong>");
    expect(element.className).toContain("message-row");
  });

  it("renders the required minimal busy indicator", () => {
    const element = createAgentWorkingElement("Агент работает в фоне…");

    expect(element.getAttribute("role")).toBe("status");
    expect(element.getAttribute("aria-live")).toBe("polite");
    expect(element.className).toBe("agent-working");
    expect(element.querySelectorAll(".agent-working__dots i")).toHaveLength(3);
    expect(element.textContent).toContain("Агент работает в фоне…");
  });

  it("disables chat send when target token connection or text is missing", () => {
    expect(isChatSendDisabled({ selectedTargetId: "target-1", tokenConfigured: true, bridgeOnline: true, text: "Привет" })).toBe(false);
    expect(isChatSendDisabled({ selectedTargetId: undefined, tokenConfigured: true, bridgeOnline: true, text: "Привет" })).toBe(true);
    expect(isChatSendDisabled({ selectedTargetId: "target-1", tokenConfigured: false, bridgeOnline: true, text: "Привет" })).toBe(true);
    expect(isChatSendDisabled({ selectedTargetId: "target-1", tokenConfigured: true, bridgeOnline: false, text: "Привет" })).toBe(true);
    expect(isChatSendDisabled({ selectedTargetId: "target-1", tokenConfigured: true, bridgeOnline: true, text: "   " })).toBe(true);
  });
});
