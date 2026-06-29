/**
 * Markdown renderer for chat messages.
 * Uses marked for full GFM support + highlight.js for syntax highlighting.
 */

import { marked, Renderer } from "marked";
import hljs from "highlight.js/lib/core";

// Import common languages
import javascript from "highlight.js/lib/languages/javascript";
import typescript from "highlight.js/lib/languages/typescript";
import python from "highlight.js/lib/languages/python";
import bash from "highlight.js/lib/languages/bash";
import json from "highlight.js/lib/languages/json";
import css from "highlight.js/lib/languages/css";
import xml from "highlight.js/lib/languages/xml"; // includes HTML
import sql from "highlight.js/lib/languages/sql";
import yaml from "highlight.js/lib/languages/yaml";
import markdown from "highlight.js/lib/languages/markdown";

// Register languages
hljs.registerLanguage("javascript", javascript);
hljs.registerLanguage("js", javascript);
hljs.registerLanguage("typescript", typescript);
hljs.registerLanguage("ts", typescript);
hljs.registerLanguage("python", python);
hljs.registerLanguage("py", python);
hljs.registerLanguage("bash", bash);
hljs.registerLanguage("sh", bash);
hljs.registerLanguage("shell", bash);
hljs.registerLanguage("json", json);
hljs.registerLanguage("css", css);
hljs.registerLanguage("html", xml);
hljs.registerLanguage("xml", xml);
hljs.registerLanguage("sql", sql);
hljs.registerLanguage("yaml", yaml);
hljs.registerLanguage("yml", yaml);
hljs.registerLanguage("markdown", markdown);
hljs.registerLanguage("md", markdown);

// Custom renderer
const renderer = new Renderer();

// Links open in new tab
renderer.link = ({ href, title, text }) => {
  const titleAttr = title ? ` title="${title}"` : "";
  const safeHref = /^(https?:|mailto:|#)/i.test(href) ? href : "#";
  return `<a href="${safeHref}"${titleAttr} target="_blank" rel="noopener">${text}</a>`;
};

// Code blocks with syntax highlighting
renderer.code = ({ text, lang }) => {
  const language = lang && hljs.getLanguage(lang) ? lang : "plaintext";
  let highlighted: string;
  
  try {
    if (language === "plaintext") {
      highlighted = escapeHtml(text);
    } else {
      highlighted = hljs.highlight(text, { language }).value;
    }
  } catch {
    highlighted = escapeHtml(text);
  }
  
  const langClass = lang ? ` class="language-${lang}"` : "";
  return `<pre><code${langClass}>${highlighted}</code></pre>`;
};

// Configure marked
marked.setOptions({
  gfm: true,
  breaks: false,
  renderer,
});

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

/**
 * Basic HTML sanitization — removes dangerous tags.
 */
function sanitizeHtml(html: string): string {
  return html
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "")
    .replace(/\s+on\w+\s*=/gi, " data-blocked=")
    .replace(/javascript:/gi, "blocked:");
}

/**
 * Render markdown to HTML with syntax highlighting.
 */
export function renderMarkdown(text: string): string {
  const html = marked.parse(text);
  
  if (typeof html !== "string") return "";
  
  return sanitizeHtml(html).trimEnd();
}
