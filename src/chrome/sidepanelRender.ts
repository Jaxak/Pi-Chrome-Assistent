import type { SidepanelChatMessage } from "./sidepanelState";
import { renderMarkdown } from "./markdown";

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
  text.innerHTML = renderMarkdown(message.text);

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

  const labelSpan = document.createElement("span");
  labelSpan.className = "agent-working__label";
  labelSpan.textContent = label;

  element.append(dots, labelSpan);
  return element;
}

export function updateAgentWorkingElement(
  element: HTMLElement,
  label: string,
  visible: boolean,
  activeToolsCount?: number,
): void {
  if (element.hidden !== !visible) {
    element.hidden = !visible;
  }

  const labelSpan = element.querySelector<HTMLElement>(".agent-working__label");
  if (labelSpan) {
    // Show tools counter if there are active tools
    const toolsInfo = activeToolsCount && activeToolsCount > 0
      ? ` · Вызов инструментов (${activeToolsCount})`
      : "";
    const fullLabel = `${label}${toolsInfo}`;
    
    if (labelSpan.textContent !== fullLabel) {
      labelSpan.textContent = fullLabel;
    }
  }
}


