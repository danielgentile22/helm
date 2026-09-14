// Drive headless Chrome over CDP against the dev-fake server and check the composer.
// node scripts/verify-composer.mjs, with `node --import tsx scripts/dev-fake.ts` already listening on 8431.
// Screenshots land in SHOTS (default: a temp dir).
import { launchChrome } from "./chrome.mjs";
import { writeFileSync } from "node:fs";

const BASE = "http://127.0.0.1:8431";
const OUT = (process.env.SHOTS ?? `${process.env.TMPDIR ?? "/tmp/"}helm2-shots`) + "/";
import { mkdirSync } from "node:fs";
mkdirSync(OUT, { recursive: true });
const { port } = await launchChrome({ windowSize: "400,860" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const target = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((t) => t.type === "page");
setTimeout(() => { console.log("timed out"); process.exit(2); }, 90_000);
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0; const pending = new Map();
ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); } };
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const evaluate = async (expression) => { const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); if (r.result.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails)); return r.result.result.value; };
const shot = async (name) => { const r = await send("Page.captureScreenshot", { format: "png" }); writeFileSync(`${OUT}${name}.png`, Buffer.from(r.result.data, "base64")); };
const results = [];
const check = (name, ok, detail = "") => { results.push({ name, ok, detail }); console.log(`${ok ? "PASS" : "FAIL"} ${name} ${detail}`); };

await send("Network.enable");
await send("Network.setCookie", { name: "helm_session", value: "dev-session-token", url: BASE });
await send("Emulation.setDeviceMetricsOverride", { width: 400, height: 860, deviceScaleFactor: 2, mobile: true });
await send("Page.enable");

const cwd = process.env.TMPDIR ? `${process.env.TMPDIR}helm2-dev-fake/work` : "/tmp/helm2-dev-fake/work";
const thread = await (await fetch(`${BASE}/api/threads`, { method: "POST", headers: { cookie: "helm_session=dev-session-token", "content-type": "application/json" }, body: JSON.stringify({ cwd, model: "claude-opus-5", effort: "high" }) })).json();
await send("Page.navigate", { url: `${BASE}/t/${thread.threadId}` });
await sleep(1500);
await shot("01-idle");
check("quick row shows model, effort, skills chips", await evaluate(`[...document.querySelectorAll('.quick .chip')].map(c=>c.textContent.trim()).join('|')`).then((t) => /Opus 5.*high.*Skills/.test(t) ? true : t));
check("helper line says idle with glyph", await evaluate(`document.querySelector('.helper')?.textContent.trim()`).then((t) => /◌\s*idle/.test(t) ? true : t));

// Slash popover
const ta = () => `document.querySelector('.inputrow .ta')`;
await evaluate(`(()=>{const t=${ta()};t.focus();const set=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set;set.call(t,'/gri');t.dispatchEvent(new Event('input',{bubbles:true}));})()`);
await sleep(300);
await shot("02-popover");
check("popover lists grill commands", await evaluate(`[...document.querySelectorAll('.pop .cmd-row .nm')].map(e=>e.textContent).join(',')`).then((t) => t === "/grill-with-docs,/grill" || t === "/grill,/grill-with-docs" ? true : t));
await send("Input.dispatchKeyEvent", { type: "keyDown", key: "ArrowDown", code: "ArrowDown", windowsVirtualKeyCode: 40 });
await send("Input.dispatchKeyEvent", { type: "keyUp", key: "ArrowDown", code: "ArrowDown", windowsVirtualKeyCode: 40 });
await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" });
await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
await sleep(300);
check("second row picked becomes a command chip", await evaluate(`document.querySelector('.chip.cmd b')?.textContent`).then((t) => t === "/grill" ? true : t));
check("placeholder is the argument hint", await evaluate(`${ta()}.placeholder`).then((t) => t === "<plan>" ? true : t));
await send("Input.insertText", { text: "the composer" });
await sleep(100);
await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" });
await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
await send("Input.insertText", { text: "plan" });
await sleep(100);
check("Enter inserted a newline", await evaluate(`${ta()}.value`).then((t) => t === "the composer\nplan" ? true : JSON.stringify(t)));
await shot("03-command-chip");
await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, modifiers: 4 });
await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, modifiers: 4 });
await sleep(1200);
await shot("04-sent-command");
check("cmd+enter sent the wire text", await evaluate(`[...document.querySelectorAll('.prompt-text')].at(-1)?.textContent`).then((t) => t === "/grill the composer\nplan" ? true : JSON.stringify(t)));
check("agent ran it", await evaluate(`document.body.textContent.includes('Ran command: /grill the composer')`));

// Paste an image
await evaluate(`(async()=>{const t=${ta()};t.focus();const c=document.createElement('canvas');c.width=40;c.height=30;const g=c.getContext('2d');g.fillStyle='#e08a1e';g.fillRect(0,0,40,30);const blob=await new Promise(r=>c.toBlob(r,'image/png'));const f=new File([blob],'pasted.png',{type:'image/png'});const dt=new DataTransfer();dt.items.add(f);const ev=new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:dt});t.dispatchEvent(ev);})()`);
await sleep(1000);
await shot("05-staged-thumb");
check("paste staged a thumbnail", await evaluate(`document.querySelector('.stage .th img')?.getAttribute('src')`).then((t) => t && t.includes("/uploads/") ? true : t));
await send("Input.insertText", { text: "look at this" });
await evaluate(`document.querySelector('.send').click()`);
await sleep(1200);
await shot("06-inline-image");
check("sent image renders inline", await evaluate(`(()=>{const i=[...document.querySelectorAll('.shots img')].at(-1);return i? i.naturalWidth+'x'+i.naturalHeight : null})()`).then((t) => t === "40x30" ? true : t));
check("agent saw the upload", await evaluate(`document.body.textContent.includes('pasted.png (image/png)')`));

// Morph to stop and interrupt
await send("Input.insertText", { text: "go slow" });
await evaluate(`document.querySelector('.send').click()`);
await sleep(800);
await shot("07-running");
check("send morphed to stop while running", await evaluate(`document.querySelector('.send').classList.contains('stop') && document.querySelector('.send').getAttribute('aria-label')`).then((t) => t === "Stop" ? true : t));
check("stop chip present", await evaluate(`!!document.querySelector('.chip.stop')`));
check("helper says running", await evaluate(`document.querySelector('.helper')?.textContent.trim()`).then((t) => /◆\s*running/.test(t) ? true : t));
const before = await evaluate(`document.querySelector('.send').getBoundingClientRect().toJSON()`);
await evaluate(`document.querySelector('.send').click()`);
await sleep(1200);
const after = await evaluate(`document.querySelector('.send').getBoundingClientRect().toJSON()`);
check("stop interrupted the turn", await evaluate(`!document.querySelector('.send').classList.contains('stop') && !document.querySelector('.chip.stop')`));
check("button never moved", before.x === after.x && before.y === after.y && before.width === after.width, `${before.x},${before.y} -> ${after.x},${after.y}`);
await shot("08-after-stop");

// Skills sheet
await evaluate(`[...document.querySelectorAll('.quick .chip')].find(c=>c.textContent.includes('Skills')).click()`);
await sleep(500);
check("skills search took focus", await evaluate(`document.activeElement?.classList.contains('search')`));
await send("Input.insertText", { text: "slop" });
await sleep(200);
await shot("09-skills-sheet");
check("scope path keeps its case", await evaluate(`getComputedStyle(document.querySelector(".sheet .scope")).textTransform`).then((t) => t === "none" ? true : t));
check("skills search filters to unslop", await evaluate(`[...document.querySelectorAll('.sheet .list .cmd-row .nm')].map(e=>e.textContent).join(',')`).then((t) => t === "/unslop" ? true : t));
await evaluate(`[...document.querySelectorAll('.sheet .shead .chip')].find(c=>c.textContent.includes('Reload')).click()`);
await sleep(500);
check("reload kept the list", await evaluate(`document.querySelectorAll('.sheet .list .cmd-row').length`).then((n) => n === 1 ? true : n));
await evaluate(`document.querySelector('.sheet .list .cmd-row').click()`);
await sleep(300);
check("sheet pick set the chip", await evaluate(`document.querySelector('.chip.cmd b')?.textContent`).then((t) => t === "/unslop" ? true : t));
check("focus ring sits on the box, not the textarea", await evaluate(`(()=>{const t=document.querySelector(".inputrow .ta");t.focus();const b=getComputedStyle(t.closest(".box"));return b.boxShadow!=="none" && getComputedStyle(t).outlineStyle==="none"})()`));
check("no horizontal overflow at 400px", await evaluate(`document.documentElement.scrollWidth <= window.innerWidth`));

// Dark theme
await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "dark" }] });
await sleep(300);
await shot("10-dark");

ws.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
