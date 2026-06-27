export const SEND_SELECTION_SUCCESS_TOAST_MESSAGE = "Отправлено в Pi";
export const GENERAL_FAILURE_TOAST_PREFIX = "Не удалось отправить в Pi";
export const DIRECT_UNAVAILABLE_TOAST_MESSAGE = "Pi-сессия не подключена.";

const FALLBACK_GENERIC_REASON = "без подробностей";
const USELESS_ERROR_PATTERNS = [
  /^unable to send selection to pi\.?$/i,
  /^selection delivery failed\.?$/i,
  /^error\.?$/i,
];
const DIRECT_UNAVAILABLE_ERROR_PATTERNS = [
  /pi-сессия не подключена/i,
  /pi недоступен/i,
  /not connected/i,
  /\b(connection|connect|websocket closed)\b/i,
];
const INTERNAL_ERROR_PATTERNS = [
  /chrome\.storage\.local/i,
  /ws:\/\//i,
  /\bclient\.[a-z]+/i,
  /\brequestid\b/i,
];
const GENERIC_REASON_MAPPINGS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /timed out/i, reason: "истекло время ожидания" },
  { pattern: /\b(close|closed)\b/i, reason: "соединение было закрыто" },
  { pattern: /\b(connect|connection|network|socket)\b/i, reason: "нет соединения с Pi" },
  { pattern: /\b(selection|payload)\b/i, reason: "не удалось обработать выделение" },
];

function ensureSentence(text: string): string {
  return /[.!?…]$/.test(text) ? text : `${text}.`;
}

function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text;
  }

  return `${text.slice(0, maxLength - 1).trimEnd()}…`;
}

function normalizeErrorMessage(error: unknown): string {
  const message = error instanceof Error && error.message.length > 0
    ? error.message
    : typeof error === "string"
      ? error
      : error == null
        ? ""
        : String(error);

  return message.trim().replace(/^Error:\s*/i, "").replace(/\s+/g, " ");
}

function hasPattern(message: string, patterns: readonly RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(message));
}

function formatGenericFailure(reason: string): string {
  return `${GENERAL_FAILURE_TOAST_PREFIX}: ${ensureSentence(reason)}`;
}

function sanitizeGenericReason(rawMessage: string): string {
  if (rawMessage.length === 0 || hasPattern(rawMessage, USELESS_ERROR_PATTERNS)) {
    return FALLBACK_GENERIC_REASON;
  }

  const colonReason = rawMessage.match(/^[^:]{1,40}:\s*(.+)$/)?.[1]?.trim();
  const candidate = colonReason && !hasPattern(colonReason, INTERNAL_ERROR_PATTERNS)
    ? colonReason
    : rawMessage;

  if (hasPattern(candidate, INTERNAL_ERROR_PATTERNS)) {
    for (const { pattern, reason } of GENERIC_REASON_MAPPINGS) {
      if (pattern.test(candidate)) {
        return reason;
      }
    }

    return "внутренняя ошибка";
  }

  return truncate(candidate, 80);
}

export function formatSendSelectionErrorToastMessage(error: unknown): string {
  const rawMessage = normalizeErrorMessage(error);

  if (hasPattern(rawMessage, DIRECT_UNAVAILABLE_ERROR_PATTERNS)) {
    return DIRECT_UNAVAILABLE_TOAST_MESSAGE;
  }

  return formatGenericFailure(sanitizeGenericReason(rawMessage));
}
