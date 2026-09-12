import { test } from "node:test";
import assert from "node:assert/strict";
import { renderMarkdown } from "./markdown";

/** DOMPurify needs a window; these cases prove the renderer is already inert without it. */
const raw = (md: string): string => renderMarkdown(md, (html) => html);

test("a fenced block gets a copy button and highlighted spans", () => {
  const html = raw("```ts\nconst x: number = 1;\n```");
  assert.match(html, /<div class="code">/);
  assert.match(html, /<button class="copy" type="button" data-copy>Copy<\/button>/);
  assert.match(html, /<span class="lang">typescript<\/span>/);
  assert.match(html, /<code class="hljs">.*<span class="hljs-/s);
});

test("an unknown language still renders, escaped, with no highlighting", () => {
  const html = raw("```brainfuck\n<not html>\n```");
  assert.match(html, /&lt;not html&gt;/);
  assert.doesNotMatch(html, /hljs-/);
});

test("a table is wrapped so it can scroll on its own", () => {
  const html = raw("| a | b |\n| - | - |\n| 1 | 2 |");
  assert.match(html, /<div class="tablewrap"><table>/);
  assert.match(html, /<\/table>\s*<\/div>/);
});

test("raw html is escaped, so a script tag never reaches the page", () => {
  const html = raw("before\n\n<script>alert(1)</script>\n\nafter <img src=x onerror=alert(1)>");
  assert.doesNotMatch(html, /<script/);
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/, "inert as text, not as an attribute");
  assert.match(html, /&lt;script&gt;/);
});

test("links open in a new tab with no opener, and a javascript url is dropped", () => {
  assert.match(raw("[docs](https://example.com/x)"), /<a href="https:\/\/example\.com\/x" rel="noopener" target="_blank">docs<\/a>/);
  const bad = raw("[tap](javascript:alert(1))");
  assert.doesNotMatch(bad, /<a /);
  assert.match(bad, /tap/);
});

test("ordinary prose survives as prose", () => {
  const html = raw("# Title\n\nSome **bold** and `code`.\n\n- one\n- two");
  assert.match(html, /<h1>Title<\/h1>/);
  assert.match(html, /<strong>bold<\/strong>/);
  assert.match(html, /<code>code<\/code>/);
  assert.match(html, /<li>one<\/li>/);
});
