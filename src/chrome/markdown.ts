/**
 * Markdown renderer for chat messages.
 * Uses marked for full GFM support: headers, lists, tables, code blocks, etc.
 */

import { marked, Renderer } from "marked";

// Custom renderer for UX
const renderer = new Renderer();

// Links open in new tab
renderer.link = ({ href, title, text }) => {
  const titleAttr = title ? ` title="${title}"` : "";
  // Sanitize href to prevent javascript: URLs
  const safeHref = /^(https?:|mailto:|#)/i.test(href) ? href : "#";
  return `<a href="${safeHref}"${titleAttr} target="_blank" rel="noopener">${text}</a>`;
};

// Configure marked
marked.setOptions({
  gfm: true,        // GitHub Flavored Markdown
  breaks: false,    // Don't convert \n to <br> (CSS handles spacing)
  renderer,
});

/**
 * Basic HTML sanitization — removes dangerous tags.
 * For chat messages from Pi, this provides defense in depth.
 */
function sanitizeHtml(html: string): string {
  return html
    // Remove script tags and content
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "")
    // Remove event handlers
    .replace(/\s+on\w+\s*=/gi, " data-blocked=")
    // Remove javascript: URLs (not in href, handled by renderer)
    .replace(/javascript:/gi, "blocked:");
}

/**
 * Render markdown to HTML.
 */
export function renderMarkdown(text: string): string {
  const html = marked.parse(text);
  
  // marked.parse returns string | Promise<string>, but with sync config it's string
  if (typeof html !== "string") return "";
  
  // Sanitize and trim trailing newline
  return sanitizeHtml(html).trimEnd();
}
