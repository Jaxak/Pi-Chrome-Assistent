// @vitest-environment node

import { describe, expect, it } from "vitest";
import { renderMarkdown } from "./markdown";

describe("renderMarkdown", () => {
  it("should remove script tags for XSS protection", () => {
    const result = renderMarkdown("<script>alert('xss')</script>");
    expect(result).not.toContain("<script>");
    expect(result).not.toContain("alert");
  });

  it("should remove event handlers", () => {
    const result = renderMarkdown('<div onclick="alert()">click</div>');
    expect(result).not.toContain("onclick=");
    expect(result).toContain("data-blocked=");
  });

  it("should block javascript: URLs in links", () => {
    const result = renderMarkdown("[click](javascript:alert())");
    expect(result).not.toContain("javascript:");
    expect(result).toContain('href="#"');
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

  it("should render links with target blank", () => {
    const result = renderMarkdown("[Google](https://google.com)");
    expect(result).toContain('<a href="https://google.com"');
    expect(result).toContain('target="_blank"');
    expect(result).toContain('rel="noopener"');
    expect(result).toContain(">Google</a>");
  });

  it("should handle paragraphs with double newlines", () => {
    const result = renderMarkdown("First paragraph\n\nSecond paragraph");
    expect(result).toContain("<p>First paragraph</p>");
    expect(result).toContain("<p>Second paragraph</p>");
  });

  it("should not convert single newlines to br", () => {
    const result = renderMarkdown("Line one\nLine two");
    // Single newlines within a paragraph don't create new elements
    expect(result).toContain("Line one");
    expect(result).toContain("Line two");
  });

  it("should escape HTML inside code blocks", () => {
    const result = renderMarkdown("```html\n<div>Hello</div>\n```");
    expect(result).toContain("&lt;div&gt;Hello&lt;/div&gt;");
  });

  it("should wrap output in paragraph tags", () => {
    const result = renderMarkdown("Hello");
    expect(result).toMatch(/^<p>/);
    expect(result).toMatch(/<\/p>$/);
  });

  // New GFM features
  it("should render headers", () => {
    const result = renderMarkdown("# Header 1\n## Header 2");
    expect(result).toContain("<h1");
    expect(result).toContain("<h2");
  });

  it("should render unordered lists", () => {
    const result = renderMarkdown("- Item 1\n- Item 2");
    expect(result).toContain("<ul>");
    expect(result).toContain("<li>Item 1</li>");
  });

  it("should render ordered lists", () => {
    const result = renderMarkdown("1. First\n2. Second");
    expect(result).toContain("<ol>");
    expect(result).toContain("<li>First</li>");
  });

  it("should render blockquotes", () => {
    const result = renderMarkdown("> This is a quote");
    expect(result).toContain("<blockquote>");
  });

  it("should render tables", () => {
    const result = renderMarkdown("| A | B |\n|---|---|\n| 1 | 2 |");
    expect(result).toContain("<table>");
    expect(result).toContain("<th>A</th>");
    expect(result).toContain("<td>1</td>");
  });
});
