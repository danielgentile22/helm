// Prove scripts/chrome.mjs cannot leak a browser: every exit path kills it, a SIGKILLed run's
// orphan is reaped by the next launch, a live sibling is not, and the binary is never the
// installed Chrome.app whose bundle identity steals `open -a "Google Chrome"`.
// node scripts/verify-chrome-lifecycle.mjs. Nothing else needs to be running.
import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { launchChrome } from "./chrome.mjs";

const HELPER = fileURLToPath(new URL("./chrome.mjs", import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Helper processes carry --type=; only the browser process itself is a leak worth counting.
const processes = () => execFileSync("ps", ["-eo", "pid=,command="], { encoding: "utf8" }).split("\n").filter((l) => l.includes("helm2-verify-profile"));
const browsers = () => processes().filter((l) => !l.includes("--type="));

let fails = 0;
const check = (name, ok, detail = "") => { if (!ok) fails++; console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` ${detail}` : ""}`); };

// Each scenario is a child node process that launches a browser then exits the way the name says.
const scenario = (body) => spawn(process.execPath, ["--input-type=module", "-e", `import { launchChrome } from ${JSON.stringify(HELPER)};\nconst { port } = await launchChrome();\nconsole.log(port);\n${body}`], { stdio: ["ignore", "pipe", "inherit"] });
const portOf = (child) => new Promise((r) => { let out = ""; child.stdout.on("data", (d) => { out += d; if (out.includes("\n")) r(Number(out.trim())); }); });

const settle = async () => { for (let i = 0; i < 40; i++) { if (browsers().length === 0) return true; await sleep(250); } return false; };

check("no stray browsers before the run", browsers().length === 0, `${browsers().length} found`);

const { port, close } = await launchChrome();
const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
check("the helper returns a live debugging port", typeof port === "number" && port > 0, `port ${port}`);
check("the browser is Chrome for Testing, not the installed Chrome", /Chrome\/\d/.test(version.Browser), version.Browser);
const installed = processes().filter((line) => line.includes("/Applications/Google Chrome.app"));
check("no process runs out of /Applications/Google Chrome.app", installed.length === 0, `${installed.length} matches`);
let refused = "it launched anyway";
try { await launchChrome({ binary: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" }); } catch (error) { refused = error.message; }
check("the installed Chrome is refused outright", refused.includes("absorbs"), refused);
close();
check("close() leaves nothing behind", await settle(), `${browsers().length} survived`);

const clean = scenario("process.exit(0);");
await portOf(clean);
await new Promise((r) => clean.on("exit", r));
check("a normal exit leaves nothing behind", await settle(), `${browsers().length} survived`);

const thrown = scenario("throw new Error('an evaluate() rejected mid-script');");
await portOf(thrown);
await new Promise((r) => thrown.on("exit", r));
check("an uncaught throw leaves nothing behind", await settle(), `${browsers().length} survived`);

const termed = scenario("await new Promise(() => {});");
await portOf(termed);
termed.kill("SIGTERM");
await new Promise((r) => termed.on("exit", r));
check("SIGTERM leaves nothing behind", await settle(), `${browsers().length} survived`);

const killed = scenario("await new Promise(() => {});");
await portOf(killed);
killed.kill("SIGKILL");
await new Promise((r) => killed.on("exit", r));
await sleep(1000);
check("SIGKILL does orphan a browser, since no handler can run", browsers().length > 0, `${browsers().length} orphaned`);

const sibling = scenario("await new Promise(() => {});");
const siblingPort = await portOf(sibling);
const reaper = await launchChrome();
check("the next launch reaps the orphan", (await (await fetch(`http://127.0.0.1:${siblingPort}/json/version`)).json()).Browser !== undefined, "sibling still answering");
check("a live sibling's browser is left alone", browsers().length === 2, `${browsers().length} running, expected the sibling and the reaper`);
reaper.close();
sibling.kill("SIGTERM");
await new Promise((r) => sibling.on("exit", r));
check("teardown leaves nothing behind", await settle(), `${browsers().length} survived`);

console.log(`\n${fails === 0 ? "all checks passed" : fails + " FAILED"}`);
process.exit(fails === 0 ? 0 : 1);
