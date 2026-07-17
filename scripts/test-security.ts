// Security-perimeter sweep (issue #36) — write-route auth, body-size caps,
// chat-only route gating, report-markdown XSS, vault path traversal. Pure
// logic against synthetic input: no server, no network, nothing written
// outside a temp dir. Run: npx -y tsx scripts/test-security.ts
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { NextRequest } from "next/server";
import { bodyTooLarge, checkHelmKey } from "../lib/auth";
import { escapeHtml, mdToHtml } from "../lib/reportMd";
import { blockedInChatOnly, config as middlewareConfig, middleware } from "../middleware";

let failed = 0;
const pass = (msg: string) => console.log(`PASS  ${msg}`);
const fail = (msg: string) => {
  failed++;
  console.log(`FAIL  ${msg}`);
};
const check = (cond: unknown, msg: string) => (cond ? pass(msg) : fail(msg));
const eq = (got: unknown, want: unknown, msg: string) =>
  got === want ? pass(msg) : fail(`${msg}\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`);

// --- write-route shared secret (lib/auth.ts) ----------------------------------
{
  // "" not undefined: an explicit undefined arg triggers the homeEnv default,
  // which would read the machine's real key
  const r = checkHelmKey(null, "");
  check(!r.ok && r.status === 503, "no key configured → 503 (fail closed, not open)");
}
{
  const r = checkHelmKey(null, "secret");
  check(!r.ok && r.status === 401, "missing header → 401");
}
{
  const r = checkHelmKey("wrong!", "secret");
  check(!r.ok && r.status === 401, "wrong key → 401");
}
{
  const r = checkHelmKey("secrets", "secret");
  check(!r.ok && r.status === 401, "length-mismatched key → 401 (no timingSafeEqual throw)");
}
check(checkHelmKey("secret", "secret").ok, "matching key → ok");

// --- body-size precheck (reject BEFORE buffering) ------------------------------
const reqWithLength = (len: string | null) =>
  ({ headers: { get: (n: string) => (n === "content-length" ? len : null) } }) as unknown as Request;
check(bodyTooLarge(reqWithLength("9000000"), 8 * 1024 * 1024), "content-length over cap → rejected");
check(!bodyTooLarge(reqWithLength("1000"), 8 * 1024 * 1024), "content-length under cap → allowed");
check(bodyTooLarge(reqWithLength(null), 8 * 1024 * 1024), "missing content-length (chunked) → rejected");
check(bodyTooLarge(reqWithLength("junk"), 8 * 1024 * 1024), "unparseable content-length → rejected");

// --- CHAT_ONLY method gating (middleware.ts) ------------------------------------
// Writes 404 on the Fly box (they'd enqueue runner work Syncthing carries back).
check(blockedInChatOnly("/api/queue", "POST"), "chat-only blocks POST /api/queue");
check(blockedInChatOnly("/api/voice", "POST"), "chat-only blocks POST /api/voice");
check(blockedInChatOnly("/api/voice/text", "POST"), "chat-only blocks POST /api/voice/text");
check(blockedInChatOnly("/api/todos", "POST"), "chat-only blocks POST /api/todos (toggle)");
check(blockedInChatOnly("/api/transcript", "DELETE"), "chat-only blocks DELETE /api/transcript");
check(blockedInChatOnly("/api/chats", "POST"), "chat-only blocks POST /api/chats (no prefix confusion)");
// Reads pass so the phone can render every tab.
check(!blockedInChatOnly("/api/state", "GET"), "chat-only allows GET /api/state");
check(!blockedInChatOnly("/api/report", "GET"), "chat-only allows GET /api/report");
check(!blockedInChatOnly("/api/transcript", "GET"), "chat-only allows GET /api/transcript");
check(!blockedInChatOnly("/api/todos", "GET"), "chat-only allows GET /api/todos");
// Chat + key pass regardless of method; non-API pages are never gated.
check(!blockedInChatOnly("/api/chat", "POST"), "chat-only allows POST /api/chat");
check(!blockedInChatOnly("/api/key", "GET"), "chat-only allows /api/key");
check(!blockedInChatOnly("/chat", "GET"), "chat-only ignores non-API pages");

// --- CHAT_ONLY middleware wiring (env gate + arg order + matcher scope) ----------
// blockedInChatOnly above is the pure logic; this exercises the 2-line
// middleware() wiring where a refactor regression would actually land.
{
  const call = (path: string, method: string) =>
    middleware(new NextRequest(`http://localhost:3107${path}`, { method }));
  const prevChatOnly = process.env.CHAT_ONLY;
  process.env.CHAT_ONLY = "1";
  eq(call("/api/queue", "POST").status, 404, "CHAT_ONLY=1 → middleware 404s POST /api/queue");
  eq(call("/api/state", "GET").status, 200, "CHAT_ONLY=1 → middleware passes GET /api/state");
  eq(call("/api/chat", "POST").status, 200, "CHAT_ONLY=1 → middleware passes POST /api/chat");
  delete process.env.CHAT_ONLY;
  eq(call("/api/queue", "POST").status, 200, "CHAT_ONLY unset → middleware passes POST /api/queue");
  if (prevChatOnly !== undefined) process.env.CHAT_ONLY = prevChatOnly;
  // matcher scope: middleware never runs at all outside its matcher, so a
  // narrowed matcher silently unguards routes no matter what the code says.
  eq(middlewareConfig.matcher, "/api/:path*", "middleware matcher covers all of /api");
}

// --- auth-guard route sweep (every mutating route calls checkHelmKey) ------------
// The feared failure mode is a NEW mutating route that never calls the guard —
// unit tests on checkHelmKey can't see that. Source-level sweep: every
// app/api/**/route.ts exporting a mutating handler must mention checkHelmKey.
{
  // Intentional exceptions — route path relative to app/api, with the reason.
  // (none today: /api/speak POST was guarded when this sweep landed)
  const UNGUARDED_OK = new Set<string>([]);

  const apiRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "app", "api");
  const routeFiles: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.name === "route.ts") routeFiles.push(p);
    }
  };
  walk(apiRoot);
  check(routeFiles.length >= 8, `route sweep found the API surface (${routeFiles.length} route files)`);

  const MUTATING = /export\s+(?:async\s+)?function\s+(POST|PUT|PATCH|DELETE)\b|export\s+const\s+(POST|PUT|PATCH|DELETE)\s*=/;
  for (const file of routeFiles) {
    const rel = relative(apiRoot, file).split(sep).join("/");
    const src = readFileSync(file, "utf8");
    if (!MUTATING.test(src)) continue; // read-only route — out of scope
    if (UNGUARDED_OK.has(rel)) {
      pass(`/api/${rel.replace(/\/route\.ts$/, "")} — mutating, allowlisted exception`);
      continue;
    }
    check(
      src.includes("checkHelmKey"),
      `/api/${rel.replace(/\/route\.ts$/, "")} — mutating handler calls checkHelmKey (or add to UNGUARDED_OK with a reason)`
    );
  }
}

// --- report markdown XSS (lib/reportMd.ts) ---------------------------------------
eq(escapeHtml('a"b\'c<d>&'), "a&quot;b&#39;c&lt;d&gt;&amp;", "escapeHtml neutralizes quotes too");
{
  // the exact finding-116 payload: quote in the URL broke out of href and
  // injected an onmouseover handler (alert`1` needs no parens)
  const html = mdToHtml('- [x](https://evil" onmouseover="alert`1`)');
  check(!html.includes('evil"'), "URL quote can no longer terminate the href attribute");
  check(!/\son(mouseover|error|click)\s*=\s*"/.test(html), "no live event-handler attribute injected");
  check(html.includes("&quot;"), "quote survives, escaped, inside the href value");
}
{
  const html = mdToHtml("[Anthropic](https://anthropic.com) and **bold** and `code`");
  check(html.includes('<a href="https://anthropic.com"'), "legit links still render");
  check(html.includes("<strong>bold</strong>") && html.includes("<code>code</code>"), "inline markdown still renders");
}
eq(mdToHtml('say "hi"'), "<p>say &quot;hi&quot;</p>", "plain-text quotes render escaped");

// --- vault path traversal (lib/vault.ts) ------------------------------------------
// VAULT_ROOT must be set BEFORE lib/vault (via lib/config) loads → dynamic import.
const vault = mkdtempSync(join(tmpdir(), "helm-test-vault-"));
process.env.VAULT_ROOT = vault;
mkdirSync(join(vault, "inbox"), { recursive: true });
mkdirSync(join(vault, "system", "runs"), { recursive: true });
mkdirSync(join(vault, "daily-notes"), { recursive: true });
mkdirSync(join(vault, "Atlas", "Areas"), { recursive: true });
writeFileSync(join(vault, "inbox", "ok.md"), "hello", "utf8");
writeFileSync(join(vault, "system", "runs", "run.md"), "run", "utf8");
writeFileSync(join(vault, "daily-notes", "secret.md"), "SECRET", "utf8");
writeFileSync(join(vault, "Atlas", "Areas", "note.md"), "atlas", "utf8");

// async wrapper (not top-level await): tsx compiles this script as CJS
void (async () => {
  const { readVaultMarkdown, resolveReadable } = await import("../lib/vault");

  eq(readVaultMarkdown("inbox/ok.md"), "hello", "inbox/ deliverable still readable");
  eq(readVaultMarkdown("system/runs/run.md"), "run", "system/runs/ deliverable still readable");
  eq(readVaultMarkdown("inbox/../daily-notes/secret.md"), null, "inbox/../ traversal blocked (the finding-24 bypass)");
  eq(readVaultMarkdown("system/runs/../../daily-notes/secret.md"), null, "system/runs/../../ traversal blocked");
  eq(readVaultMarkdown("inbox\\..\\daily-notes\\secret.md"), null, "backslash traversal blocked");
  eq(readVaultMarkdown("daily-notes/secret.md"), null, "non-allowlisted dir stays unreadable");
  eq(readVaultMarkdown("Atlas/Areas/note.md"), "atlas", "Atlas/ notes readable (issue #43 tab panels)");
  eq(readVaultMarkdown("Atlas/../daily-notes/secret.md"), null, "Atlas/../ traversal blocked");
  eq(readVaultMarkdown("../outside.md"), null, "escape above the vault stays blocked");
  eq(readVaultMarkdown("inbox/ok.txt"), null, "non-.md stays blocked");
  check(resolveReadable("inbox/../inbox/ok.md") === null, "even inside-allowlist paths with .. are rejected");

  console.log(failed ? `\n${failed} FAILED` : "\nall security checks passed");
  process.exit(failed ? 1 : 0);
})();
