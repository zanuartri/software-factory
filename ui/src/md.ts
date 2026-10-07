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

export function renderMd(text: string, copyCode = false): string {
  const renderer = new Renderer();
  renderer.html = ({ text: html }) => escapeHtml(html);
  renderer.code = ({ text, lang }) => {
    const code = `<pre><code${lang ? ` class="language-${escapeHtml(lang)}"` : ""}>${escapeHtml(text)}</code></pre>`;
    return copyCode ? `<div data-code-block class="group relative"><button type="button" data-copy-code aria-label="Copy code" class="absolute right-2 top-2 rounded bg-surface px-2 py-1 text-[10px] text-fg-muted opacity-0 shadow-sm transition-opacity hover:text-fg focus:opacity-100 group-hover:opacity-100 focus-visible:outline-2 focus-visible:outline-accent">Copy</button>${code}</div>` : code;
  };
  renderer.link = function (token) {
    const href = safeHref(token.href);
    if (!href) return escapeHtml(token.text);
    const title = token.title ? ` title="${escapeHtml(token.title)}"` : "";
    return `<a href="${escapeHtml(href)}" target="_blank" rel="noreferrer noopener"${title}>${this.parser.parseInline(token.tokens)}</a>`;
  };
  return marked.parse(text, { async: false, renderer });
}
