import { MAX_SELECTED_HTML_BYTES, MAX_SELECTED_TEXT_BYTES } from "./constants";
import type { SelectionPayload } from "./protocol";
import { truncateUtf8 } from "./truncation";

function formatOptionalValue(value: string | undefined): string {
  return value && value.trim().length > 0 ? value : "не указан";
}

function getMarkdownFence(content: string): string {
  const backtickRuns = content.match(/`+/g);
  const longestBacktickRun = backtickRuns?.reduce((max, run) => Math.max(max, run.length), 0) ?? 0;
  return "`".repeat(Math.max(3, longestBacktickRun + 1));
}

function formatFencedBlock(content: string, language: string): string[] {
  const fence = getMarkdownFence(content);
  return [`${fence}${language}`, content, fence];
}

export function formatSelectionMessage(payload: SelectionPayload): string {
  const text = truncateUtf8(payload.selectedText ?? "", MAX_SELECTED_TEXT_BYTES);
  const html = truncateUtf8(payload.selectedHtml ?? "", MAX_SELECTED_HTML_BYTES);

  return [
    "Пользователь отправил фрагмент страницы из браузера.",
    "",
    "Источник:",
    `- URL: ${formatOptionalValue(payload.url)}`,
    `- Title: ${formatOptionalValue(payload.title)}`,
    `- Selector: ${formatOptionalValue(payload.selector)}`,
    "",
    "Комментарий пользователя:",
    formatOptionalValue(payload.comment),
    "",
    "Выбранный текст:",
    ...formatFencedBlock(text.value, "text"),
    "",
    "HTML-фрагмент:",
    ...formatFencedBlock(html.value, "html"),
  ].join("\n");
}
