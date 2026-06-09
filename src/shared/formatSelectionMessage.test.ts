import { MAX_SELECTED_HTML_BYTES, MAX_SELECTED_TEXT_BYTES } from "./constants";
import { describe, expect, it } from "vitest";
import { formatSelectionMessage } from "./formatSelectionMessage";
import type { SelectionPayload } from "./protocol";

const payload: SelectionPayload = {
  url: "https://example.com",
  title: "Example",
  selectedText: "const x = 1;",
  selectedHtml: "<pre>const x = 1;</pre>",
  selector: "pre",
  comment: "Explain this",
  capturedAt: 1710000000000,
};

describe("formatSelectionMessage", () => {
  it("includes source, comment, text and html", () => {
    const message = formatSelectionMessage(payload);
    expect(message).toContain("Пользователь отправил фрагмент страницы из браузера");
    expect(message).toContain("https://example.com");
    expect(message).toContain("Explain this");
    expect(message).toContain("```text");
    expect(message).toContain("```html");
  });

  it("handles missing comment", () => {
    const message = formatSelectionMessage({ ...payload, comment: "" });
    expect(message).toContain("Комментарий пользователя:");
    expect(message).toContain("не указан");
  });

  it("handles empty source and selection fields without crashing", () => {
    const message = formatSelectionMessage({
      ...payload,
      title: "",
      selectedText: "",
      selectedHtml: "",
      selector: "",
      comment: undefined,
    });

    expect(message).toContain("- Title: не указан");
    expect(message).toContain("- Selector: не указан");
    expect(message).toContain("```text\n\n```");
    expect(message).toContain("```html\n\n```");
  });

  it("uses longer markdown fences when selected text or html contains triple backticks", () => {
    const message = formatSelectionMessage({
      ...payload,
      selectedText: "before ``` after",
      selectedHtml: "<code>```</code>",
    });

    expect(message).toContain("````text");
    expect(message).toContain("````html");
    expect(message).toContain("````text\nbefore ``` after\n````");
    expect(message).toContain("````html\n<code>```</code>\n````");
    expect(message.split("\n")).not.toContain("```");
  });

  it("marks oversized text and html as truncated", () => {
    const longText = "😀".repeat(Math.ceil(MAX_SELECTED_TEXT_BYTES / 4) + 1);
    const longHtml = "a".repeat(MAX_SELECTED_HTML_BYTES + 1);

    const message = formatSelectionMessage({
      ...payload,
      selectedText: longText,
      selectedHtml: longHtml,
    });

    expect(message).toContain(`[truncated: original ${new TextEncoder().encode(longText).length} bytes, limit ${MAX_SELECTED_TEXT_BYTES} bytes]`);
    expect(message).toContain(`[truncated: original ${new TextEncoder().encode(longHtml).length} bytes, limit ${MAX_SELECTED_HTML_BYTES} bytes]`);
  });
});
