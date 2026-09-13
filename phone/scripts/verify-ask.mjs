// Drive headless Chrome over the ask card alone: the buttons, the deny reason, a 409, and the answered form.
// node scripts/verify-ask.mjs. Nothing else needs to be running.
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";
import sveltePlugin from "esbuild-svelte";

const SP = mkdtempSync(join(tmpdir(), "helm2-ask-")) + "/";
await build({ bundle: true, format: "esm", target: ["es2022"], entryPoints: ["scripts/ask-card-fixture.ts"], outfile: `${SP}app.js`, plugins: [sveltePlugin({ compilerOptions: { css: "external" } })], logLevel: "error" });
await build({ bundle: true, entryPoints: ["src/client/app.css"], outfile: `${SP}app.css`, logLevel: "error" });
writeFileSync(`${SP}index.html`, `<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="app.css"><body style="margin:0;max-width:400px"><div id="tool"></div><div id="q"></div><div id="multi"></div><div id="retry"></div><div id="done"></div><script type="module" src="app.js"></script></body>`);
const types = { ".js": "text/javascript", ".css": "text/css", ".html": "text/html" };
const srv = createServer((req, res) => {
  const p = req.url === "/" ? "index.html" : req.url.slice(1);
  try {
    const body = readFileSync(SP + p);
    res.writeHead(200, { "content-type": types[p.slice(p.lastIndexOf("."))] ?? "text/plain" });
    res.end(body);
  } catch { res.writeHead(404).end(); }
}).listen(8479);

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const chrome = spawn(CHROME, ["--headless=new", "--remote-debugging-port=9341", "--window-size=400,900", "--user-data-dir=/tmp/helm2-cdp-ask2", "about:blank"], { stdio: "ignore" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
for (let i = 0; i < 40; i++) { try { await fetch("http://127.0.0.1:9341/json/version"); break; } catch { await sleep(250); } }
const target = (await (await fetch("http://127.0.0.1:9341/json")).json()).find((t) => t.type === "page");
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0; const pending = new Map();
ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); } };
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const evaluate = async (expression) => { const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); if (r.result.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails)); return r.result.result.value; };
let fails = 0;
const check = (name, ok, detail = "") => { if (!ok) fails++; console.log(`${ok ? "PASS" : "FAIL"} ${name} ${detail}`); };

await send("Page.enable");
await send("Page.navigate", { url: "http://127.0.0.1:8479/" });
for (let i = 0; i < 40; i++) { if (await evaluate(`!!document.querySelector('#tool .askcard')`)) break; await sleep(250); }

const toolText = await evaluate(`document.querySelector('#tool').innerText`);
check("the tool card names the tool and the argument", toolText.includes("Claude wants to") && toolText.includes("rm -rf build"), JSON.stringify(toolText.split("\n").slice(0, 4)));
const btns = await evaluate(`[...document.querySelectorAll('#tool .arow .btn')].map((b)=>b.textContent.trim())`);
check("Allow sits left of Deny", btns[0] === "Allow" && btns[1] === "Deny", btns.join(" | "));
const thisTurn = await evaluate(`[...document.querySelectorAll('#tool .btn')].some((b)=>b.textContent.trim()==='Allow for this turn')`);
check("allow for this turn is a secondary control", thisTurn);
const colours = await evaluate(`(()=>{const b=[...document.querySelectorAll('#tool .arow .btn')];return b.map((x)=>getComputedStyle(x).backgroundColor)})()`);
check("only the primary action is coloured", colours[0] !== colours[1], colours.join(" vs "));

await evaluate(`[...document.querySelectorAll('#tool .btn')].find((b)=>b.textContent.trim()==='Deny').click()`);
await sleep(200);
check("deny opens a reason field", await evaluate(`!!document.querySelector('#tool .ain')`));
await evaluate(`(()=>{const i=document.querySelector('#tool .ain');i.value='wrong branch';i.dispatchEvent(new Event('input'));i.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}))})()`);
await sleep(300);
check("Enter sends the deny with its reason", JSON.stringify(await evaluate(`sent[0]`)) === JSON.stringify({ kind: "deny", reason: "wrong branch" }), JSON.stringify(await evaluate(`sent[0]`)));
check("every button stays disabled after the tap", await evaluate(`[...document.querySelectorAll('#tool button')].every((b)=>b.disabled||b.className.includes('small')&&b.textContent.includes('input'))`));

await evaluate(`setConflict(true)`);
await evaluate(`[...document.querySelectorAll('#q .aopt')][0].click()`);
await sleep(300);
check("a single-select question answers on tap", (await evaluate(`JSON.stringify(sent[1])`)) === JSON.stringify({ kind: "answers", answers: [{ kind: "options", labels: ["Rebase"] }] }), await evaluate(`JSON.stringify(sent[1])`));
check("a 409 shows answered elsewhere", (await evaluate(`document.querySelector('#q').innerText`)).includes("Answered elsewhere"));

const confirm = `[...document.querySelectorAll('#multi .btn')].find((b)=>b.textContent.trim()==='Confirm')`;
check("a multi-question ask waits for every answer", await evaluate(`${confirm}.disabled`));
await evaluate(`document.querySelectorAll('#multi .aqblock')[0].querySelectorAll('.aopt')[1].click()`);
await sleep(150);
check("one question answered is still not enough", await evaluate(`${confirm}.disabled`));
await evaluate(`(()=>{const o=document.querySelectorAll('#multi .aqblock')[1].querySelectorAll('.aopt');o[0].click();o[1].click()})()`);
await sleep(150);
check("a multi-select question ticks every option tapped", await evaluate(`document.querySelectorAll('#multi .aqblock')[1].querySelectorAll('.aopt[aria-pressed="true"]').length === 2`));
check("Confirm opens once every question has an answer", await evaluate(`!${confirm}.disabled`));
await evaluate(`${confirm}.click()`);
await sleep(300);
check("Confirm sends one answer per question, in the order asked", (await evaluate(`JSON.stringify(sent.at(-1))`)) === JSON.stringify({ kind: "answers", answers: [{ kind: "options", labels: ["next"] }, { kind: "options", labels: ["unit", "e2e"] }] }), await evaluate(`JSON.stringify(sent.at(-1))`));

await evaluate(`[...document.querySelectorAll('#retry .btn')].find((b)=>b.textContent.trim()==='Allow').click()`);
await sleep(300);
check("a failed answer offers the buttons again", await evaluate(`[...document.querySelectorAll('#retry .arow .btn')].every((b)=>!b.disabled)`));

const doneText = await evaluate(`document.querySelector('#done').innerText`);
check("an answered card reads as a record", doneText.includes("Denied by laptop: wrong branch"), JSON.stringify(doneText.split("\n").at(-1)));
const overflow = await evaluate(`(document.body.style.margin='0',document.documentElement.scrollWidth <= window.innerWidth)`);
check("no horizontal overflow at 400px", overflow);

const shot = await send("Page.captureScreenshot", { captureBeyondViewport: true });
if (shot.result?.data) { writeFileSync(SP + "card.png", Buffer.from(shot.result.data, "base64")); console.log(`shot ${SP}card.png`); }
console.log(`\n${fails === 0 ? "all checks passed" : fails + " FAILED"}`);
chrome.kill(); srv.close(); process.exit(fails === 0 ? 0 : 1);
