/**
 * Lightweight markdown renderer for chat messages.
 * Supports: code blocks, inline code, bold, italic, links.
 * XSS-safe: escapes HTML entities before processing markdown.
 */

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

export function renderMarkdown(text: string): string {
  // Escape HTML first for XSS safety
  let html = escapeHtml(text);

  // Code blocks: ```lang\ncode\n```
  html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => {
    const langClass = lang ? ` class="language-${lang}"` : "";
    return `<pre><code${langClass}>${code.trim()}</code></pre>`;
  });

  // Inline code: `code`
  html = html.replace(/`([^`]+)`/g, "<code>$1</code>");

  // Bold: **text**
  html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");

  // Italic: *text* (but not inside words)
  html = html.replace(/(?<!\w)\*([^*]+)\*(?!\w)/g, "<em>$1</em>");

  // Links: [text](url)
  html = html.replace(
    /\[([^\]]+)\]\(([^)]+)\)/g,
    '<a href="$2" target="_blank" rel="noopener">$1</a>',
  );

  // Paragraphs: double newlines
  html = html.replace(/\n\n+/g, "</p><p>");

  // Single newlines to <br> (but not inside pre)
  html = html.replace(/(?<!<\/code>)\n(?!<pre)/g, "<br>");

  return `<p>${html}</p>`;
}
