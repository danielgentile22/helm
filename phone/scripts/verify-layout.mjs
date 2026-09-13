// Drive headless Chrome over CDP against the dev-fake server and check the two-pane laptop layout.
// node scripts/verify-layout.mjs, with `node --import tsx scripts/dev-fake.ts` already listening on 8431.
// Screenshots land in SHOTS (default: a temp dir).
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const BASE = "http://127.0.0.1:8431";
const OUT = (process.env.SHOTS ?? `${process.env.TMPDIR ?? "/tmp/"}helm2-layout-shots`) + "/";
mkdirSync(OUT, { recursive: true });
const chrome = spawn(CHROME, ["--headless=new", "--remote-debugging-port=9335", "--window-size=1200,800", "--user-data-dir=/tmp/helm2-cdp-layout", "about:blank"], { stdio: "ignore" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
for (let i = 0; i < 40; i++) { try { await fetch("http://127.0.0.1:9335/json/version"); break; } catch { await sleep(250); } }
const target = (await (await fetch("http://127.0.0.1:9335/json")).json()).find((t) => t.type === "page");
setTimeout(() => { console.log("timed out"); chrome.kill(); process.exit(2); }, 180_000);
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0; const pending = new Map();
ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); } };
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const evaluate = async (expression) => { const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); if (r.result.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails)); return r.result.result.value; };
const shot = async (name) => { const r = await send("Page.captureScreenshot", { format: "png" }); writeFileSync(`${OUT}${name}.png`, Buffer.from(r.result.data, "base64")); };
const results = [];
const check = (name, ok, detail = "") => { results.push({ name, ok, detail }); console.log(`${ok ? "PASS" : "FAIL"} ${name} ${detail}`); };
const has = (selector) => evaluate(`!!document.querySelector(${JSON.stringify(selector)})`);
const wide = () => send("Emulation.setDeviceMetricsOverride", { width: 1200, height: 800, deviceScaleFactor: 1, mobile: false });
const narrow = () => send("Emulation.setDeviceMetricsOverride", { width: 400, height: 860, deviceScaleFactor: 2, mobile: true });

await send("Network.enable");
await send("Network.setCookie", { name: "helm_session", value: "dev-session-token", url: BASE });
await wide();
await send("Page.enable");

const cwd = process.env.TMPDIR ? `${process.env.TMPDIR}helm2-dev-fake/work` : "/tmp/helm2-dev-fake/work";
await (await fetch(`${BASE}/api/threads`, { method: "POST", headers: { cookie: "helm_session=dev-session-token", "content-type": "application/json" }, body: JSON.stringify({ cwd, model: "claude-opus-5", effort: "high" }) })).json();
await send("Page.navigate", { url: `${BASE}/` });
await sleep(1800);

check("the wide list shows two panes", await has(".panes"));
check("the left pane holds the thread rows", await has(".pane-list .row"));
check("the right pane invites a pick", await has(".pane-empty"));
await shot("01-split-list");

await evaluate(`document.querySelector('.pane-list').dataset.mark='before-click'`);
await evaluate(`document.querySelector('.pane-list .row').click()`);
await sleep(1200);
check("opening a thread fills the right pane", await has(".pane-main .transcript"));
check("the left pane survives the navigation", await has(".pane-list"));
check("the list was not remounted", await evaluate(`document.querySelector('.pane-list')?.dataset.mark === 'before-click'`));
check("the open thread's row is marked", await has(".row.is-open"));
await shot("02-split-thread");

const prompts = () => evaluate(`document.querySelectorAll('.blk-prompt').length`);
const before = await prompts();
await evaluate(`(()=>{const t=document.querySelector('.inputrow .ta');t.focus();const set=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set;set.call(t,'sent with the keyboard');t.dispatchEvent(new Event('input',{bubbles:true}));t.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',metaKey:true,bubbles:true}));return true})()`);
await sleep(1500);
const after = await prompts();
check("Cmd+Enter sends from the composer", after > before, `${before} prompts before, ${after} after`);

check("no horizontal overflow at 1200px", await evaluate(`document.documentElement.scrollWidth <= window.innerWidth`), await evaluate(`document.documentElement.scrollWidth + ' vs ' + window.innerWidth`));

await send("Emulation.setDeviceMetricsOverride", { width: 1600, height: 800, deviceScaleFactor: 1, mobile: false });
await sleep(300);
const measure = await evaluate(`(()=>{const t=document.querySelector('.pane-main .transcript').getBoundingClientRect();const c=document.querySelector('.pane-main .composer').getBoundingClientRect();const m=document.querySelector('.pane-main').getBoundingClientRect();return {t:Math.round(t.width),c:Math.round(c.width),tl:Math.round(t.left-m.left),tr:Math.round(m.right-t.right)}})()`);
check("the thread column is capped at 1600px", measure.t <= 820 && measure.c <= 820, JSON.stringify(measure));
check("the capped column is centred in the pane", Math.abs(measure.tl - measure.tr) <= 1, `left ${measure.tl}, right ${measure.tr}`);
await shot("07-split-1600");
await wide();
await sleep(300);

await evaluate(`[...document.querySelectorAll('.pane-list .row .title')].find((t)=>t.textContent.trim()==='stream please').closest('.row').click()`);
await sleep(1200);
await evaluate(`window.scrollTo(0, 400)`);
await sleep(300);
const stuck = await evaluate(`(()=>{const r=(s)=>document.querySelector(s).getBoundingClientRect();return {y:window.scrollY,head:r('.pane-main .head').top,dock:Math.round(r('.pane-main .dock').bottom),bar:r('.pane-list .topbar').top,filter:Math.round(r('.filterbar').bottom),h:window.innerHeight,lh:Math.round(document.querySelector('.pane-list').getBoundingClientRect().height)}})()`);
check("the window scrolls the thread pane", stuck.y > 0, `scrollY ${stuck.y}`);
check("the thread head stays stuck to the window", stuck.head === 0, `head top ${stuck.head}`);
check("the dock stays at the bottom of the window", stuck.dock === stuck.h, `dock bottom ${stuck.dock}, window ${stuck.h}`);
check("the list topbar stays stuck inside the aside", stuck.bar === 0, `topbar top ${stuck.bar}`);
check("the filterbar stays at the bottom of the aside", stuck.filter === stuck.lh, `filterbar bottom ${stuck.filter}, aside ${stuck.lh}`);
await shot("05-split-scrolled");

await evaluate(`document.querySelector('[aria-label="Thread menu"]').click()`);
await sleep(200);
await evaluate(`[...document.querySelectorAll('.menu .mitem')].find((b)=>b.textContent.trim()==='Info').click()`);
await sleep(600);
const dialog = await evaluate(`(()=>{const p=document.querySelector('.sheet .panel');if(!p)return null;const r=p.getBoundingClientRect();return {top:Math.round(r.top),bottom:Math.round(r.bottom),width:Math.round(r.width),h:window.innerHeight}})()`);
check("the sheet is a centred dialog, not a bottom sheet", dialog !== null && dialog.top > 0 && dialog.bottom < dialog.h && Math.abs(dialog.top - (dialog.h - dialog.bottom)) <= 1, JSON.stringify(dialog));
await shot("06-split-dialog");
await evaluate(`[...document.querySelectorAll('.sheet .btn')].find((b)=>b.textContent.trim()==='Close').click()`);
await sleep(400);

await evaluate(`history.pushState(null,'','/');dispatchEvent(new PopStateEvent('popstate'))`);
await sleep(800);

await evaluate(`history.pushState(null,'','/settings');dispatchEvent(new PopStateEvent('popstate'))`);
await sleep(1000);
check("settings replaces the right pane", await has(".pane-main .sbody"));
check("the left pane stays through settings", await has(".pane-list"));
await shot("03-split-settings");

await narrow();
await sleep(600);
check("the narrow window drops the panes", await evaluate(`!document.querySelector('.panes')`));
check("the narrow window keeps one screen", await has(".screen"));
await shot("04-narrow");

await wide();
await sleep(600);
check("widening restores the panes", await has(".panes"));

ws.close(); chrome.kill();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
