// Drive headless Chrome over CDP against the dev-fake server and check the fork divider and the link back.
// node scripts/verify-fork.mjs, with `node --import tsx scripts/dev-fake.ts` already listening on 8431.
// Screenshots land in SHOTS (default: a temp dir).
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const BASE = "http://127.0.0.1:8431";
const COOKIE = "helm_session=dev-session-token";
const OUT = (process.env.SHOTS ?? `${process.env.TMPDIR ?? "/tmp/"}helm2-fork-shots`) + "/";
mkdirSync(OUT, { recursive: true });
const chrome = spawn(CHROME, ["--headless=new", "--remote-debugging-port=9347", "--window-size=400,900", "--user-data-dir=/tmp/helm2-cdp-fork", "about:blank"], { stdio: "ignore" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
for (let i = 0; i < 40; i++) { try { await fetch("http://127.0.0.1:9347/json/version"); break; } catch { await sleep(250); } }
const target = (await (await fetch("http://127.0.0.1:9347/json")).json()).find((t) => t.type === "page");
setTimeout(() => { console.log("timed out"); chrome.kill(); process.exit(2); }, 180_000);
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0; const pending = new Map();
ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); } };
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const evaluate = async (expression) => { const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); if (r.result.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails)); return r.result.result.value; };
const shot = async (name) => { const r = await send("Page.captureScreenshot", { format: "png" }); writeFileSync(`${OUT}${name}.png`, Buffer.from(r.result.data, "base64")); console.log(`shot ${OUT}${name}.png`); };
const api = async (path, init = {}) => { const res = await fetch(BASE + path, { ...init, headers: { cookie: COOKIE, "content-type": "application/json", ...init.headers } }); return { status: res.status, body: await res.json().catch(() => null) }; };
let fails = 0;
const check = (name, ok, detail = "") => { if (!ok) fails++; console.log(`${ok ? "PASS" : "FAIL"} ${name} ${detail}`); };
const text = (sel) => evaluate(`document.querySelector(${JSON.stringify(sel)})?.innerText ?? null`);

const cwd = process.env.TMPDIR ? `${process.env.TMPDIR}helm2-dev-fake/work` : "/tmp/helm2-dev-fake/work";
const source = (await api("/api/threads", { method: "POST", body: JSON.stringify({ cwd, model: "claude-opus-5", effort: "high", title: "Listing" }) })).body;
for (const t of ["first turn", "second turn"]) {
  await api(`/api/threads/${source.threadId}/send`, { method: "POST", body: JSON.stringify({ clientMsgId: crypto.randomUUID(), text: t, label: "verify" }) });
  await sleep(1200);
}
// The event route is SSE with no replay-only mode, so read the replay and hang up once it goes quiet.
const abort = new AbortController();
const stream = await fetch(`${BASE}/api/threads/${source.threadId}/events?after=0`, { headers: { cookie: COOKIE }, signal: abort.signal });
const reader = stream.body.getReader();
let raw = "";
const readUntilQuiet = (async () => { for (;;) { const { done, value } = await reader.read(); if (done) break; raw += new TextDecoder().decode(value); } })().catch(() => undefined);
await sleep(1200);
abort.abort();
await readUntilQuiet;
const events = raw.split("\n").filter((l) => l.startsWith("data:")).map((l) => { try { return JSON.parse(l.slice(5)); } catch { return null; } }).filter((e) => e && e.kind);
const firstTurn = events.find((e) => e.kind === "turn.started").turnId;
check("the source ran two turns", events.filter((e) => e.kind === "turn.ended").length === 2, `${events.length} events, first turn ${firstTurn}`);

const forked = await api(`/api/threads/${source.threadId}/fork`, { method: "POST", body: JSON.stringify({ turnId: firstTurn }) });
check("the fork endpoint answers 201 with a summary", forked.status === 201 && !!forked.body?.config?.threadId, `${forked.status} ${JSON.stringify(forked.body?.config?.title ?? null)}`);
const fork = forked.body.config;

await send("Network.enable");
await send("Network.setCookie", { name: "helm_session", value: "dev-session-token", url: BASE });
await send("Emulation.setDeviceMetricsOverride", { width: 400, height: 900, deviceScaleFactor: 2, mobile: true });
await send("Page.enable");
// Headless Chrome reports dark by default, so both themes are named rather than assumed.
const theme = (value) => send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value }] });
await theme("light");

await send("Page.navigate", { url: `${BASE}/t/${fork.threadId}` });
await sleep(2500);
const divider = await text(".forkline");
check("the fork's transcript draws the divider", divider !== null && divider.startsWith("Forked from"), JSON.stringify(divider));
check("the divider names the source thread", (divider ?? "").includes("Listing"), JSON.stringify(divider));
check("the divider links at the source turn's seq", (await evaluate(`document.querySelector('.forkline a').getAttribute('href')`)) === `/t/${source.threadId}#seq=${firstTurn.slice(2)}`, await evaluate(`document.querySelector('.forkline a').getAttribute('href')`));
check("the divider is underlined, not colour alone", (await evaluate(`getComputedStyle(document.querySelector('.forkline a')).textDecorationLine`)) === "underline");
check("the hairlines run the width of the block", await evaluate(`(()=>{const h=[...document.querySelectorAll('.forkline .hair')];return h.length===2&&h.every((x)=>x.getBoundingClientRect().width>4)})()`));
check("the copied turn is above the divider", await evaluate(`(()=>{const p=document.querySelector('.blk-prompt'),f=document.querySelector('.blk-fork');return !!p&&!!f&&p.getBoundingClientRect().top<f.getBoundingClientRect().top})()`));
check("only the first turn was copied", (await evaluate(`document.querySelectorAll('.blk-prompt').length`)) === 1, `${await evaluate(`document.querySelectorAll('.blk-prompt').length`)} prompts`);
const memoryNote = await text(".forknote");
check("a fork with no memory says so in words", memoryNote === null || memoryNote.includes("no memory of the turns above"), JSON.stringify(memoryNote));
check("no horizontal overflow at 400px", await evaluate(`document.documentElement.scrollWidth <= window.innerWidth`), await evaluate(`document.documentElement.scrollWidth + ' vs ' + window.innerWidth`));
await shot("01-fork-divider-light");
await theme("dark");
await sleep(400);
await shot("02-fork-divider-dark");
await theme("light");

await send("Page.navigate", { url: `${BASE}/t/${source.threadId}` });
await sleep(2500);
const link = await text(".forkto");
check("the source shows the link to the fork", link !== null && link.startsWith("Forked to"), JSON.stringify(link));
check("the link carries a chevron, not colour alone", (link ?? "").includes("›"), JSON.stringify(link));
check("the link points at the fork", (await evaluate(`document.querySelector('.forkto').getAttribute('href')`)) === `/t/${fork.threadId}`);
check("the link sits under the forked turn", await evaluate(`document.querySelector('.forkto').closest('[data-turn]')?.dataset.turn === ${JSON.stringify(firstTurn)}`), await evaluate(`document.querySelector('.forkto').closest('[data-turn]')?.dataset.turn`));
check("the glyph column marks the link with a shape", (await evaluate(`getComputedStyle(document.querySelector('.blk-forkOut'),'::before').content`)).includes("↳"), await evaluate(`getComputedStyle(document.querySelector('.blk-forkOut'),'::before').content`));
await shot("03-source-link-light");

const opened = await evaluate(`(()=>{const e=document.querySelector('.blk-text .md');if(!e)return 'no text block';e.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true}));return 'ok'})()`);
await sleep(400);
const items = await evaluate(`[...document.querySelectorAll('.mitem')].map((b)=>b.textContent.trim())`);
check("a completed turn offers Fork from here", Array.isArray(items) && items.includes("Fork from here"), `${opened}: ${(items ?? []).join(" | ")}`);
check("Fork from here sits after Quote into the composer", (items ?? []).indexOf("Fork from here") === (items ?? []).indexOf("Quote into the composer") + 1, (items ?? []).join(" | "));
await shot("04-fork-from-here-sheet");
await evaluate(`[...document.querySelectorAll('.btn')].find((b)=>b.textContent.trim()==='Cancel').click()`);
await sleep(300);
const promptOpened = await evaluate(`(()=>{const e=document.querySelector('.blk-prompt .prompt-text');if(!e)return 'no prompt block';e.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true}));return 'ok'})()`);
await sleep(400);
const promptItems = await evaluate(`[...document.querySelectorAll('.mitem')].map((b)=>b.textContent.trim())`);
check("the prompt of a completed turn offers Fork from here too", promptOpened === "ok" && Array.isArray(promptItems) && promptItems.includes("Fork from here"), `${promptOpened}: ${(promptItems ?? []).join(" | ")}`);
await evaluate(`[...document.querySelectorAll('.btn')].find((b)=>b.textContent.trim()==='Cancel').click()`);
await sleep(300);

await api(`/api/threads/${source.threadId}/send`, { method: "POST", body: JSON.stringify({ clientMsgId: crypto.randomUUID(), text: "stream a long reply", label: "verify" }) });
await sleep(2500);
const liveText = await evaluate(`(()=>{const t=document.querySelector('.turn.is-live');if(!t)return 'no live turn';const e=[...t.querySelectorAll('.blk-text .md')].at(-1);if(!e)return 'no text yet';e.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true}));return 'ok'})()`);
await sleep(400);
const liveItems = await evaluate(`[...document.querySelectorAll('.mitem')].map((b)=>b.textContent.trim())`);
check("a running turn offers no fork", liveText === "ok" && Array.isArray(liveItems) && liveItems.length > 0 && !liveItems.includes("Fork from here"), `${liveText}: ${(liveItems ?? []).join(" | ")}`);
await api(`/api/threads/${source.threadId}/interrupt`, { method: "POST" });

await sleep(1500);
await send("Page.navigate", { url: `${BASE}/t/${source.threadId}` });
await sleep(2500);
const before = await evaluate(`location.pathname`);
await evaluate(`document.querySelector('.blk-text .md').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true}))`);
await sleep(400);
await evaluate(`[...document.querySelectorAll('.mitem')].find((b)=>b.textContent.trim()==='Fork from here').click()`);
await sleep(3000);
const landed = await evaluate(`location.pathname`);
check("tapping Fork from here opens a new thread", landed.startsWith("/t/") && landed !== before, `${before} -> ${landed}`);
check("the new thread opens with the copied transcript and its divider", (await text(".forkline"))?.startsWith("Forked from") === true, JSON.stringify(await text(".forkline")));
check("no error line is left over the composer", (await evaluate(`!document.querySelector('.inline-error')`)), await text(".inline-error"));
await shot("05-forked-by-tap");

console.log(`\n${fails === 0 ? "all checks passed" : fails + " FAILED"}`);
chrome.kill(); process.exit(fails === 0 ? 0 : 1);
