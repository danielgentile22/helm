// Launch the browser the verify scripts drive, and guarantee it dies with this process.
// Never /Applications/Google Chrome.app. A headless instance of that bundle registers with
// LaunchServices under com.google.Chrome, so macOS hands `open -a "Google Chrome"` to an invisible
// window and the real browser never appears. chrome-headless-shell is a bare binary rather than an
// app bundle, so it registers nothing. Chrome for Testing is a bundle and cannot reach 127.0.0.1
// on this machine, which is why it is not the one we use.
import { execFileSync, spawn } from "node:child_process";
import { existsSync, globSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

const MARKER = "helm2-verify-profile";
const CACHE = `${process.env.HOME}/.cache/puppeteer/chrome-headless-shell/*/chrome-headless-shell-*/chrome-headless-shell`;
const INSTALL = "npm run setup:browser";

const resolveBinary = (binary) => {
  const override = binary ?? process.env.HELM_CHROME;
  if (override?.includes("/Applications/Google Chrome.app")) {
    throw new Error(`refusing the installed Chrome. A headless instance of that bundle absorbs every \`open -a "Google Chrome"\`. Use chrome-headless-shell: ${INSTALL}`);
  }
  const found = override ?? globSync(CACHE).sort().at(-1);
  if (!found || !existsSync(found)) throw new Error(`no chrome-headless-shell binary found. Run: ${INSTALL}`);
  return found;
};

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

// Every process of ours carries --user-data-dir=<marker>-<owner pid>-<random>, so the command line
// alone says who owns it. Keying off that rather than the directory matters: a close() that killed
// the browser and removed the directory can still leave the process up for a moment, and a stray
// whose directory is already gone would otherwise be invisible forever.
const OWNED = new RegExp(`^\\s*(\\d+)\\s.*--user-data-dir=(\\S*${MARKER}-(\\d+)-\\S*)`);

const owned = () => {
  try {
    return execFileSync("ps", ["-eo", "pid=,command="], { encoding: "utf8" }).split("\n")
      .map((line) => line.match(OWNED)).filter(Boolean)
      .map(([, pid, dir, owner]) => ({ pid: Number(pid), dir, owner: Number(owner) }));
  } catch { return []; }
};

const discard = (dir) => { try { rmSync(dir, { recursive: true, force: true }); } catch {} };

// A run killed with SIGKILL runs no handler, so its browser outlives it. The next run reaps it.
// Profiles carry their owner's pid, so a sibling script running right now is left alone.
const reapStale = async () => {
  const stale = () => owned().filter(({ owner }) => !alive(owner));
  const dirs = new Set(stale().map(({ dir }) => dir));
  for (const { pid } of stale()) { try { process.kill(pid, "SIGKILL"); } catch {} }
  for (let i = 0; i < 60 && stale().length; i++) await new Promise((r) => setTimeout(r, 50));
  for (const dir of globSync(join(tmpdir(), `${MARKER}-*`))) {
    if (!alive(Number(basename(dir).split("-")[3]))) dirs.add(dir);
  }
  for (const dir of dirs) discard(dir);
};

export const launchChrome = async ({ windowSize = "400,900", binary } = {}) => {
  const executable = resolveBinary(binary);
  await reapStale();
  const profile = mkdtempSync(join(tmpdir(), `${MARKER}-${process.pid}-`));
  const chrome = spawn(executable, ["--remote-debugging-port=0", `--window-size=${windowSize}`, `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });

  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    try { chrome.kill("SIGKILL"); } catch {}
    discard(profile);
  };
  process.on("exit", close);
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, () => { close(); process.exit(130); });

  const portFile = join(profile, "DevToolsActivePort");
  for (let i = 0; i < 80; i++) {
    if (existsSync(portFile)) {
      const [port] = readFileSync(portFile, "utf8").split("\n");
      if (port?.trim()) return { port: Number(port.trim()), close };
    }
    if (chrome.exitCode !== null) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  close();
  throw new Error("chrome-headless-shell reported no debugging port within 20s");
};
