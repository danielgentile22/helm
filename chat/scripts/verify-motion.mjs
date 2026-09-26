// Drive headless Chrome over CDP against the dev-fake server and check the motion pass.
// node scripts/verify-motion.mjs, with `node --import tsx scripts/dev-fake.ts` already listening on 8431.
// Screenshots land in SHOTS (default: a temp dir).
import { launchChrome } from "./chrome.mjs";
import { mkdirSync, writeFileSync } from "node:fs";

const BASE = "http://127.0.0.1:8431";
const OUT = (process.env.SHOTS ?? `${process.env.TMPDIR ?? "/tmp/"}helm2-motion-shots`) + "/";
mkdirSync(OUT, { recursive: true });
const { port } = await launchChrome({ windowSize: "400,860" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const target = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((t) => t.type === "page");
setTimeout(() => { console.log("timed out"); process.exit(2); }, 180_000);
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0; const pending = new Map();
ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); } };
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const evaluate = async (expression) => { const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); if (r.result.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails)); return r.result.result.value; };
const shot = async (name) => { const r = await send("Page.captureScreenshot", { format: "png" }); writeFileSync(`${OUT}${name}.png`, Buffer.from(r.result.data, "base64")); };
const results = [];
const check = (name, ok, detail = "") => { results.push({ name, ok, detail }); console.log(`${ok ? "PASS" : "FAIL"} ${name} ${detail}`); };

const submit = (text) => evaluate(`(()=>{const t=document.querySelector('.inputrow .ta');t.focus();const set=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set;set.call(t,${JSON.stringify(text)});t.dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('.send').click();return true})()`);
const openInfoSheet = async () => {
  await evaluate(`document.querySelector('[aria-label="Thread menu"]').click()`);
  await sleep(200);
  await evaluate(`[...document.querySelectorAll('.menu .mitem')].find((b)=>b.textContent.trim()==='Info').click()`);
};
const closeSheetAfter = (ms) => evaluate(`(()=>{[...document.querySelectorAll('.sheet .btn')].find((b)=>b.textContent.trim()==='Close').click();return new Promise((res)=>setTimeout(()=>res(!!document.querySelector('.sheet')),${ms}));})()`);
const timings = () => evaluate(`document.getAnimations().map((a)=>a.effect ? Number(a.effect.getTiming().duration) : 0)`);

await send("Network.enable");
await send("Network.setCookie", { name: "helm_session", value: "dev-session-token", url: BASE });
await send("Emulation.setDeviceMetricsOverride", { width: 400, height: 860, deviceScaleFactor: 2, mobile: true });
await send("Page.enable");

const cwd = process.env.TMPDIR ? `${process.env.TMPDIR}helm2-dev-fake/work` : "/tmp/helm2-dev-fake/work";
const thread = await (await fetch(`${BASE}/api/threads`, { method: "POST", headers: { cookie: "helm_session=dev-session-token", "content-type": "application/json" }, body: JSON.stringify({ cwd, model: "claude-opus-5", effort: "high" }) })).json();
await send("Page.navigate", { url: `${BASE}/` });
await sleep(1500);
await shot("01-list");

const arriving = await evaluate(`(()=>new Promise((res)=>{document.querySelector('.row').click();requestAnimationFrame(()=>{const s=document.querySelector('.arrives');res({opacity:s?Number(getComputedStyle(s).opacity):null,running:document.getAnimations().filter((a)=>a.playState==='running').length});});}))()`);
check("list to thread flies the incoming screen in", arriving.opacity !== null && arriving.opacity < 1, `opacity ${arriving.opacity}, ${arriving.running} running animations`);
await sleep(800);
check("the incoming screen settles opaque", await evaluate(`Number(getComputedStyle(document.querySelector('.arrives')).opacity)`).then((o) => o === 1 ? true : o));
await shot("02-thread");

await openInfoSheet();
await sleep(500);
await shot("03-sheet");
check("the info sheet opened", await evaluate(`!!document.querySelector('.sheet .panel')`));
check("the sheet is still there 50ms after close", await closeSheetAfter(50));
await sleep(500);
check("the sheet is gone 550ms after close", await evaluate(`!document.querySelector('.sheet')`));

await submit("stream please");
check("the stream started", await evaluate(`(async()=>{for(let i=0;i<400;i++){if((document.querySelector('.blk-text .md')?.textContent??'').includes('delta '))return true;await new Promise((r)=>setTimeout(r,25));}return false})()`));
const stream = await evaluate(`(async()=>{
  const anims = () => document.getAnimations().length;
  const entered = () => document.querySelectorAll('.blk.enters').length;
  const baseAnims = anims(), baseEntered = entered();
  let maxAnims = baseAnims, maxEntered = baseEntered;
  for (let i = 0; i < 15; i++) { await new Promise((r)=>setTimeout(r,100)); maxAnims = Math.max(maxAnims, anims()); maxEntered = Math.max(maxEntered, entered()); }
  return { baseAnims, maxAnims, baseEntered, maxEntered };
})()`);
check("a delta starts no animation", stream.maxAnims <= stream.baseAnims + 3, `${stream.baseAnims} at the first delta, ${stream.maxAnims} at the peak`);
check("the streaming text block enters once", stream.maxEntered === stream.baseEntered, `${stream.baseEntered} entering blocks, ${stream.maxEntered} at the peak`);
const frames = await evaluate(`(()=>new Promise((res)=>{const d=[];let last=performance.now();const stop=last+3000;requestAnimationFrame(function tick(now){d.push(now-last);last=now;if(now<stop)requestAnimationFrame(tick);else res(d.slice(1));});}))()`);
const sorted = [...frames].sort((a, b) => a - b);
const p95 = sorted[Math.floor(sorted.length * 0.95)];
const long = frames.filter((f) => f > 100).length;
check("p95 frame delta under 50ms while streaming", p95 < 50, `p95 ${p95.toFixed(1)}ms over ${frames.length} frames`);
check("no frame over 100ms while streaming", long === 0, `${long} long frames`);
await shot("04-streaming");
check("no horizontal overflow at 400px", await evaluate(`document.documentElement.scrollWidth <= window.innerWidth`));

await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
await send("Page.navigate", { url: `${BASE}/t/${thread.threadId}` });
await sleep(2000);
await submit("go slow");
await sleep(1000);
await openInfoSheet();
await sleep(300);
check("reduced motion drops the sheet at once", await closeSheetAfter(50).then((still) => !still));
await evaluate(`document.querySelector('[aria-label="Back"]').click()`);
await sleep(600);
check("reduced motion keeps the running pulse at full opacity", await evaluate(`Number(getComputedStyle(document.querySelector('.ghead .live .dot.pulse')).opacity)`).then((o) => o === 1 ? true : o));
await shot("05-reduced-list");
await evaluate(`document.querySelector('.row').click()`);
await sleep(600);
const reduced = await timings();
check("reduced motion leaves nothing running longer than 1ms", reduced.every((d) => d <= 1), `${reduced.length} animations, durations ${JSON.stringify([...new Set(reduced)])}`);
check("the running rail is still painted under reduced motion", await evaluate(`(()=>{const i=document.querySelector('.turn .rail i');if(!i)return 'no rail';const s=getComputedStyle(i);return s.animationName==='none' && s.backgroundImage==='none' ? true : s.animationName+' / '+s.backgroundImage.slice(0,40)})()`));
await shot("06-reduced-thread");

ws.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
