/**
 * Assistant text to HTML. Pure: same string in, same string out, no DOM.
 *
 * Two independent guards, because the input is model output rendered with
 * `{@html}`. The renderer never emits raw HTML in the first place (an html
 * token is escaped, a link's scheme is checked), so the markup is already
 * inert before DOMPurify sees it; DOMPurify is the second door and is the
 * reason `sanitize` is a parameter, since it needs a window and this module
 * is tested under node.
 */

import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import css from "highlight.js/lib/languages/css";
import diff from "highlight.js/lib/languages/diff";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import markdown from "highlight.js/lib/languages/markdown";
import plaintext from "highlight.js/lib/languages/plaintext";
import python from "highlight.js/lib/languages/python";
import shell from "highlight.js/lib/languages/shell";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";
import DOMPurify from "dompurify";
import { Marked, Renderer, type RendererObject, type Tokens } from "marked";

for (const [name, lang] of Object.entries({ javascript, typescript, json, bash, shell, diff, python, css, xml, markdown, yaml, plaintext })) hljs.registerLanguage(name, lang);

const ALIAS: Readonly<Record<string, string>> = { js: "javascript", jsx: "javascript", ts: "typescript", tsx: "typescript", sh: "bash", zsh: "bash", py: "python", html: "xml", svelte: "xml", yml: "yaml", md: "markdown", text: "plaintext", txt: "plaintext" };

const SAFE_SCHEME = /^(https?:|mailto:|#|\/|\.)/i;

export type Sanitize = (html: string) => string;

const escape = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// A plain object, not a Renderer subclass: marked copies the renderer's own
// enumerable properties, so methods on a class prototype are silently ignored.
const renderer: RendererObject = {
  code({ text, lang }: Tokens.Code): string {
    const name = ALIAS[(lang ?? "").trim().toLowerCase()] ?? (lang ?? "").trim().toLowerCase();
    const body = name && hljs.getLanguage(name) ? hljs.highlight(text, { language: name, ignoreIllegals: true }).value : escape(text);
    return `<div class="code"><header><span class="lang">${escape(name || "code")}</span><button class="copy" type="button" data-copy>Copy</button></header><pre><code class="hljs">${body}</code></pre></div>`;
  },

  table(this: Renderer, token: Tokens.Table): string {
    return `<div class="tablewrap">${Renderer.prototype.table.call(this, token)}</div>`;
  },

  link(this: Renderer, token: Tokens.Link): string {
    const text = this.parser.parseInline(token.tokens);
    if (!SAFE_SCHEME.test(token.href)) return text;
    const title = token.title ? ` title="${escape(token.title)}"` : "";
    return `<a href="${escape(token.href)}"${title} rel="noopener" target="_blank">${text}</a>`;
  },

  html({ text }: Tokens.HTML | Tokens.Tag): string {
    return escape(text);
  },
};

const marked = new Marked({ gfm: true, breaks: false }).use({ renderer });

const purify: Sanitize = (html) => DOMPurify.sanitize(html, { ADD_ATTR: ["data-copy", "target"] });

export function renderMarkdown(md: string, sanitize: Sanitize = purify): string {
  return sanitize(marked.parse(md, { async: false }));
}
