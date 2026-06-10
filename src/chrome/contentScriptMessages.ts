export const SEND_SELECTION_SUCCESS_TOAST_MESSAGE = "Отправлено в Pi";
export const GENERAL_FAILURE_TOAST_PREFIX = "Не удалось отправить в Pi";
export const MISSING_TARGET_TOAST_MESSAGE = "Выбранный терминал Pi недоступен. Выберите другой.";
export const BROKER_UNAVAILABLE_TOAST_MESSAGE = "Pi не подключён. Выполните /chrome-assistent-connect в терминале.";
export const MISSING_BROWSER_TOKEN_TOAST_MESSAGE = "Для отправки настройте browserToken в chrome.storage.local.";
export const BROWSER_AUTH_REQUIRED_TOAST_MESSAGE = "Браузер не авторизован в Pi. Выполните /chrome-assistent-auth в терминале.";

const FALLBACK_GENERIC_REASON = "без подробностей";
const USELESS_ERROR_PATTERNS = [
  /^unable to send selection to pi\.?$/i,
  /^selection delivery failed\.?$/i,
  /^error\.?$/i,
];
const MISSING_TARGET_ERROR_PATTERNS = [
  /no selected target configured/i,
  /missing selected target/i,
  /selected target.*(missing|not found|unavailable|invalid)/i,
  /target.*(not found|unavailable|missing|inactive)/i,
];
const MISSING_BROWSER_TOKEN_ERROR_PATTERNS = [
  /no browser token configured/i,
  /no broker token configured/i,
];
const BROWSER_AUTH_REQUIRED_ERROR_PATTERNS = [
  /браузер не авторизован в pi/i,
  /browser is not authorized/i,
];
const BROKER_UNAVAILABLE_ERROR_PATTERNS = [
  /unable to connect to broker/i,
  /broker connection timed out/i,
  /broker closed before request started/i,
  /broker closed during request/i,
  /broker request failed/i,
  /broker unavailable/i,
];
const INTERNAL_ERROR_PATTERNS = [
  /chrome\.storage\.local/i,
  /ws:\/\//i,
  /\bclient\.[a-z]+/i,
  /\brequestid\b/i,
  /broker returned an error during/i,
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

  if (hasPattern(rawMessage, MISSING_TARGET_ERROR_PATTERNS)) {
    return MISSING_TARGET_TOAST_MESSAGE;
  }

  if (hasPattern(rawMessage, MISSING_BROWSER_TOKEN_ERROR_PATTERNS)) {
    return MISSING_BROWSER_TOKEN_TOAST_MESSAGE;
  }

  if (hasPattern(rawMessage, BROWSER_AUTH_REQUIRED_ERROR_PATTERNS)) {
    return BROWSER_AUTH_REQUIRED_TOAST_MESSAGE;
  }

  if (hasPattern(rawMessage, BROKER_UNAVAILABLE_ERROR_PATTERNS)) {
    return BROKER_UNAVAILABLE_TOAST_MESSAGE;
  }

  return formatGenericFailure(sanitizeGenericReason(rawMessage));
}
