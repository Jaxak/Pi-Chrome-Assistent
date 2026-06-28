// @vitest-environment node

import { describe, expect, it } from "vitest";
import { renderMarkdown } from "./markdown";

describe("renderMarkdown", () => {
  it("should escape HTML entities", () => {
    const result = renderMarkdown("<script>alert('xss')</script>");
    expect(result).toContain("&lt;script&gt;");
    expect(result).not.toContain("<script>");
  });

  it("should render code blocks with language", () => {
    const result = renderMarkdown("```js\nconst x = 1;\n```");
    expect(result).toContain("<pre><code");
    expect(result).toContain('language-js');
    expect(result).toContain("const x = 1;");
  });

  it("should render code blocks without language", () => {
    const result = renderMarkdown("```\nsome code\n```");
    expect(result).toContain("<pre><code>");
    expect(result).toContain("some code");
  });

  it("should render inline code", () => {
    const result = renderMarkdown("Use `npm install` to install");
    expect(result).toContain("<code>npm install</code>");
  });

  it("should render bold", () => {
    const result = renderMarkdown("This is **bold** text");
    expect(result).toContain("<strong>bold</strong>");
  });

  it("should render italic", () => {
    const result = renderMarkdown("This is *italic* text");
    expect(result).toContain("<em>italic</em>");
  });

  it("should render links", () => {
    const result = renderMarkdown("[Google](https://google.com)");
    expect(result).toContain('<a href="https://google.com"');
    expect(result).toContain('target="_blank"');
    expect(result).toContain('rel="noopener"');
    expect(result).toContain(">Google</a>");
  });

  it("should handle paragraphs with double newlines", () => {
    const result = renderMarkdown("First paragraph\n\nSecond paragraph");
    expect(result).toContain("</p><p>");
  });

  it("should handle single newlines as <br>", () => {
    const result = renderMarkdown("Line one\nLine two");
    expect(result).toContain("<br>");
  });

  it("should not escape HTML inside code blocks", () => {
    const result = renderMarkdown("```html\n<div>Hello</div>\n```");
    expect(result).toContain("&lt;div&gt;Hello&lt;/div&gt;");
  });

  it("should wrap output in paragraph tags", () => {
    const result = renderMarkdown("Hello");
    expect(result).toMatch(/^<p>/);
    expect(result).toMatch(/<\/p>$/);
  });
});
