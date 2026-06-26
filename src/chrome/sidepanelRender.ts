import type { SidepanelChatMessage } from "./sidepanelState";

export type ChatSendDisabledInput = {
  selectedTargetId?: string;
  tokenConfigured: boolean;
  bridgeOnline: boolean;
  text: string;
};

function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString("ru-RU", {
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function createChatMessageElement(message: SidepanelChatMessage): HTMLElement {
  const row = document.createElement("div");
  row.className = message.role === "user" ? "message-row user" : `message-row ${message.role}`;

  const bubble = document.createElement("div");
  bubble.className = `bubble ${message.role}`;

  const text = document.createElement("div");
  text.className = "message-text";
  text.textContent = message.text;

  const meta = document.createElement("div");
  meta.className = "message-meta";
  meta.textContent = `${message.role === "user" ? "Вы" : message.role === "assistant" ? "Pi" : "Система"} · ${formatTime(message.timestamp)}`;

  bubble.append(text, meta);
  row.append(bubble);
  return row;
}

export function createAgentWorkingElement(label: string): HTMLElement {
  const element = document.createElement("div");
  element.className = "agent-working";
  element.setAttribute("role", "status");
  element.setAttribute("aria-live", "polite");

  const dots = document.createElement("span");
  dots.className = "agent-working__dots";
  dots.append(document.createElement("i"), document.createElement("i"), document.createElement("i"));

  element.append(dots, document.createTextNode(label));
  return element;
}

export function isChatSendDisabled(input: ChatSendDisabledInput): boolean {
  return !input.selectedTargetId || !input.tokenConfigured || !input.bridgeOnline || input.text.trim().length === 0;
}
