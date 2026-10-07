import { marked, Renderer } from "marked";

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
}

function safeHref(href: string): string | null {
  try {
    const url = new URL(href);
    return ["http:", "https:", "mailto:"].includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

export function renderMd(text: string): string {
  const renderer = new Renderer();
  renderer.html = ({ text: html }) => escapeHtml(html);
  renderer.link = function (token) {
    const href = safeHref(token.href);
    if (!href) return escapeHtml(token.text);
    const title = token.title ? ` title="${escapeHtml(token.title)}"` : "";
    return `<a href="${escapeHtml(href)}" target="_blank" rel="noreferrer noopener"${title}>${this.parser.parseInline(token.tokens)}</a>`;
  };
  return marked.parse(text, { async: false, renderer });
}
