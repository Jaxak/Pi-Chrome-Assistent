const DEFAULT_BUSY_LABEL = "Агент работает в фоне…";

export type SidepanelChatMessage =
  | { role: "user"; text: string; timestamp: number }
  | { role: "assistant"; messageId: string; text: string; streaming: boolean; timestamp: number }
  | { role: "system"; text: string; tone: "info" | "warning" | "error"; timestamp: number };

export type SidePanelState = {
  bridgeOnline: boolean;
  messages: SidepanelChatMessage[];
  agentBusy: boolean;
  busyLabel: string;
  sending: boolean;
  error?: string;
};

export type SidePanelChatEvent =
  | { kind: "user_message"; text: string; timestamp: number }
  | { kind: "agent_busy"; busy: boolean; label: string; timestamp: number }
  | { kind: "assistant_message_start"; messageId: string; timestamp: number }
  | { kind: "assistant_text_delta"; messageId: string; delta: string; timestamp: number }
  | { kind: "assistant_message_end"; messageId: string; timestamp: number }
  | { kind: "error"; message: string; timestamp: number };

export function createInitialSidePanelState(): SidePanelState {
  return {
    bridgeOnline: false,
    messages: [],
    agentBusy: false,
    busyLabel: DEFAULT_BUSY_LABEL,
    sending: false,
  };
}

export function startSendingUserMessage(
  state: SidePanelState,
  message: string,
  timestamp: number,
): SidePanelState {
  const text = message.trim();

  if (!text) {
    return state;
  }

  return {
    ...state,
    messages: [
      ...state.messages,
      {
        role: "user",
        text,
        timestamp,
      },
    ],
    agentBusy: true,
    busyLabel: DEFAULT_BUSY_LABEL,
    sending: true,
    error: undefined,
  };
}

export function reduceSidePanelChatEvent(state: SidePanelState, event: SidePanelChatEvent): SidePanelState {
  switch (event.kind) {
    case "user_message":
      return startSendingUserMessage(state, event.text, event.timestamp);

    case "agent_busy":
      return {
        ...state,
        agentBusy: event.busy,
        busyLabel: event.label.trim() || DEFAULT_BUSY_LABEL,
        ...(event.busy ? {} : { sending: false }),
      };

    case "assistant_message_start":
      return {
        ...state,
        messages: [
          ...state.messages,
          {
            role: "assistant",
            messageId: event.messageId,
            text: "",
            streaming: true,
            timestamp: event.timestamp,
          },
        ],
        agentBusy: true,
        busyLabel: DEFAULT_BUSY_LABEL,
        sending: false,
        error: undefined,
      };

    case "assistant_text_delta":
      return {
        ...state,
        messages: state.messages.map((message) => {
          if (message.role !== "assistant" || message.messageId !== event.messageId) {
            return message;
          }

          return {
            ...message,
            text: `${message.text}${event.delta}`,
          };
        }),
      };

    case "assistant_message_end":
      return {
        ...state,
        messages: state.messages.map((message) => {
          if (message.role !== "assistant" || message.messageId !== event.messageId) {
            return message;
          }

          return {
            ...message,
            streaming: false,
          };
        }),
        agentBusy: false,
        sending: false,
      };

    case "error":
      return {
        ...state,
        messages: [
          ...state.messages,
          {
            role: "system",
            text: event.message,
            tone: "error",
            timestamp: event.timestamp,
          },
        ],
        agentBusy: false,
        sending: false,
        error: event.message,
      };
  }
}
