import { expect, test } from "bun:test";
import { renderMd } from "../ui/src/md";

test("escapes raw HTML while preserving it as visible Markdown text", () => {
  const html = renderMd("<img src=x onerror=alert(1)>");
  expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
  expect(html).not.toContain("<img");
});

test("opens allowed links in a safe new tab and renders javascript links as text", () => {
  const html = renderMd("[web](https://example.com/path) [email](mailto:a@example.com) [bad](javascript:alert%281%29)");
  expect(html).toContain('<a href="https://example.com/path" target="_blank" rel="noreferrer noopener">web</a>');
  expect(html).toContain('<a href="mailto:a@example.com" target="_blank" rel="noreferrer noopener">email</a>');
  expect(html).not.toContain("javascript:");
  expect(html).toContain("bad");
  expect(html).not.toContain('<a href="javascript:');
});

test("renders rejected link labels as escaped plain text", () => {
  const html = renderMd("[**bad**](javascript:alert(1)) [![image](https://example.com/x)](javascript:alert(1))");
  expect(html).toContain("**bad**");
  expect(html).toContain("![image](https://example.com/x)");
  expect(html).not.toContain("<strong>");
  expect(html).not.toContain("<img");
  expect(html).not.toContain("<a");
});

test("keeps tables, fenced code, lists, and inline code rendering", () => {
  const html = renderMd("| A | B |\n| - | - |\n| 1 | 2 |\n\n```ts\nconst n = 1;\n```\n\n- item\n\n`inline`");
  expect(html).toContain("<table>");
  expect(html).toContain("<pre><code class=\"language-ts\">");
  expect(html).toContain("<ul>");
  expect(html).toContain("<code>inline</code>");
});
