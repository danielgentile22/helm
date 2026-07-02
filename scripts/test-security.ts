// Security-perimeter sweep (issue #36) — write-route auth, body-size caps,
// chat-only route gating, report-markdown XSS, vault path traversal. Pure
// logic against synthetic input: no server, no network, nothing written
// outside a temp dir. Run: npx -y tsx scripts/test-security.ts
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bodyTooLarge, checkHelmKey } from "../lib/auth";
import { escapeHtml, mdToHtml } from "../lib/reportMd";
import { blockedInChatOnly } from "../middleware";

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

// --- CHAT_ONLY route gating (middleware.ts) -------------------------------------
check(blockedInChatOnly("/api/queue"), "chat-only blocks /api/queue");
check(blockedInChatOnly("/api/voice"), "chat-only blocks /api/voice");
check(blockedInChatOnly("/api/voice/text"), "chat-only blocks /api/voice/text");
check(blockedInChatOnly("/api/daily"), "chat-only blocks /api/daily");
check(blockedInChatOnly("/api/report"), "chat-only blocks /api/report");
check(blockedInChatOnly("/api/chats"), "chat-only blocks /api/chats (no prefix confusion)");
check(!blockedInChatOnly("/api/chat"), "chat-only allows /api/chat");
check(!blockedInChatOnly("/api/key"), "chat-only allows /api/key");
check(!blockedInChatOnly("/chat"), "chat-only ignores non-API pages");

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
writeFileSync(join(vault, "inbox", "ok.md"), "hello", "utf8");
writeFileSync(join(vault, "system", "runs", "run.md"), "run", "utf8");
writeFileSync(join(vault, "daily-notes", "secret.md"), "SECRET", "utf8");

// async wrapper (not top-level await): tsx compiles this script as CJS
void (async () => {
  const { readVaultMarkdown, resolveReadable } = await import("../lib/vault");

  eq(readVaultMarkdown("inbox/ok.md"), "hello", "inbox/ deliverable still readable");
  eq(readVaultMarkdown("system/runs/run.md"), "run", "system/runs/ deliverable still readable");
  eq(readVaultMarkdown("inbox/../daily-notes/secret.md"), null, "inbox/../ traversal blocked (the finding-24 bypass)");
  eq(readVaultMarkdown("system/runs/../../daily-notes/secret.md"), null, "system/runs/../../ traversal blocked");
  eq(readVaultMarkdown("inbox\\..\\daily-notes\\secret.md"), null, "backslash traversal blocked");
  eq(readVaultMarkdown("daily-notes/secret.md"), null, "non-allowlisted dir stays unreadable");
  eq(readVaultMarkdown("../outside.md"), null, "escape above the vault stays blocked");
  eq(readVaultMarkdown("inbox/ok.txt"), null, "non-.md stays blocked");
  check(resolveReadable("inbox/../inbox/ok.md") === null, "even inside-allowlist paths with .. are rejected");

  console.log(failed ? `\n${failed} FAILED` : "\nall security checks passed");
  process.exit(failed ? 1 : 0);
})();
