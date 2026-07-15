// finishCapture hardening (issue #23): a fast tap-release-tap must not let one
// capture assemble its clip from — or clobber — another's chunk buffer, and a
// mic that dies mid-hold must log instead of hanging/rejecting silently.
// Drives the exported class with fake MediaRecorder/Blob (no DOM, no network).
// Run: npx -y tsx scripts/test-voiceclient.ts
import { VoiceClient } from "../lib/voiceClient";

let failed = 0;
const check = (cond: unknown, msg: string) =>
  cond ? console.log(`PASS  ${msg}`) : (failed++, console.log(`FAIL  ${msg}`));

// fake Blob: records the parts it was built from, reports summed size
let lastBlobParts: any = null;
(globalThis as any).Blob = class {
  size: number;
  type: string;
  constructor(parts: any[], opts: any) {
    lastBlobParts = parts;
    this.type = opts?.type ?? "";
    this.size = parts.reduce((s, p) => s + (p.size ?? 0), 0);
  }
};

class FakeRecorder {
  state = "recording";
  mimeType = "audio/webm";
  throwOnStop = false;
  neverStops = false; // mic died: stop() no-ops, 'stop' never fires
  private listeners: Record<string, Function[]> = {};
  addEventListener(ev: string, cb: Function) {
    (this.listeners[ev] ??= []).push(cb);
  }
  start() {}
  stop() {
    if (this.throwOnStop) throw new Error("mic gone");
    if (this.neverStops) return;
    this.state = "inactive";
    // async so a synchronous re-press can slip in before the await resolves
    setTimeout(() => (this.listeners["stop"] ?? []).forEach((f) => f()), 0);
  }
}

const chunk = (size: number) => ({ size });

async function main() {
// --- 1. overlapping finish/start: snapshot survives a mid-stop re-press -------
{
  const c = new VoiceClient() as any;
  const recA = new FakeRecorder();
  const chunksA = [chunk(500)]; // < 1000 → bails before fetch
  c.recorder = recA;
  c.chunks = chunksA;
  c.captureStart = performance.now() - 1000; // heldMs ~1000

  const p = c.finishCapture();
  // re-press lands while finishCapture is awaiting recA's 'stop'
  const chunksB = [chunk(9999)];
  c.recorder = new FakeRecorder();
  c.chunks = chunksB;
  await p;

  check(lastBlobParts === chunksA, "clip assembled from its own snapshot, not the re-press buffer");
  check(c.chunks === chunksB, "re-press buffer not clobbered by the finishing capture");
}

// --- 2. already-inactive recorder: no await, no hang -------------------------
{
  const c = new VoiceClient() as any;
  const rec = new FakeRecorder();
  rec.state = "inactive"; // mic already stopped (e.g. track ended)
  const chunks = [chunk(500)];
  c.recorder = rec;
  c.chunks = chunks;
  c.captureStart = performance.now();
  await c.finishCapture(); // would hang if it awaited a 'stop' that never comes
  check(lastBlobParts === chunks, "inactive recorder still assembles the clip without awaiting stop");
}

// --- 3. stop() throws mid-hold: visible log, no unhandled rejection ----------
{
  const c = new VoiceClient() as any;
  const rec = new FakeRecorder();
  rec.throwOnStop = true;
  const logged: string[] = [];
  c.log = (cls: string) => logged.push(cls);
  c.recorder = rec;
  c.chunks = [chunk(500)];
  c.captureStart = performance.now();
  await c.finishCapture(); // must resolve, not reject
  check(logged.includes("err"), "dying mic logs an error instead of failing silently");
}

// --- 4. stop() never fires: watchdog expires → logs (not a silent no-op) -----
{
  const c = new VoiceClient() as any;
  const rec = new FakeRecorder();
  rec.neverStops = true; // 'stop' event never arrives
  const logged: string[] = [];
  c.log = (cls: string) => logged.push(cls);
  c.recorder = rec;
  c.chunks = []; // no chunks yet — empty blob would otherwise slip past silently
  c.captureStart = performance.now();
  await c.finishCapture(); // resolves via the 1s watchdog
  check(logged.includes("err"), "stuck recorder logs on watchdog timeout, not a silent empty clip");
}
}

main().then(() => {
  console.log(failed === 0 ? "\nAll voiceClient checks pass." : `\n${failed} check(s) failed.`);
  process.exit(failed ? 1 : 0);
});
