const DEFAULT_BUSY_LABEL = "Агент работает в фоне…";
const BROKER_UNAVAILABLE_STATUS = "Pi не подключён. Выполните /chrome-assistent-connect в терминале.";
const TOKEN_REQUIRED_STATUS = "Для отправки настройте browserToken в chrome.storage.local.";
const AUTH_REQUIRED_STATUS = "Браузер не авторизован в Pi. Выполните /chrome-assistent-auth в терминале.";

export type SidePanelConnectionStatus = {
  brokerOnline: boolean;
  bridgeOnline: boolean;
  tokenConfigured: boolean | undefined;
  browserAuthorized: boolean | undefined;
  targetsCount: number;
  selectedTargetId?: string;
  selectedTargetAvailable: boolean;
  lastError?: string;
  connecting: boolean;
};

export function chooseSidePanelSelectedTargetId(
  targets: Array<{ targetId: string }>,
  preferredTargetIds: Array<string | undefined>,
): string | undefined {
  const availableTargetIds = new Set(targets.map((target) => target.targetId));

  for (const candidate of preferredTargetIds) {
    if (candidate && availableTargetIds.has(candidate)) {
      return candidate;
    }
  }

  return undefined;
}

export function formatSidePanelStatus(status: SidePanelConnectionStatus): string {
  if (status.connecting) {
    return "Подключаемся к Pi…";
  }

  if (status.tokenConfigured === false) {
    return TOKEN_REQUIRED_STATUS;
  }

  if (status.browserAuthorized === false) {
    return AUTH_REQUIRED_STATUS;
  }

  if (!status.brokerOnline) {
    return BROKER_UNAVAILABLE_STATUS;
  }

  if (status.targetsCount === 0) {
    return "Pi подключён · нет активных целей";
  }

  if (status.selectedTargetId && !status.selectedTargetAvailable) {
    return "Pi подключён · выбранная сессия закрыта";
  }

  return `Pi подключён · целей: ${status.targetsCount}`;
}

export type SidepanelChatMessage =
  | { role: "user"; text: string; timestamp: number }
  | { role: "assistant"; messageId: string; text: string; streaming: boolean; timestamp: number }
  | { role: "system"; text: string; tone: "info" | "warning" | "error"; timestamp: number };

export type SidePanelState = {
  bridgeOnline: boolean;
  selectedTargetId?: string;
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
