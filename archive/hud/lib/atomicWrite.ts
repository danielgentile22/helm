import fs from "fs";

// Write-to-temp-then-rename — rename is atomic on APFS, so cross-process
// readers of vault state files (the runner's queue watcher, the next chat
// turn's sidecar read, Syncthing's rescan) never observe a truncated or
// half-written file. Same-directory temp keeps the rename on one filesystem.
// Mirror of writeJson() in runner/runner.js.
export function atomicWriteFileSync(file: string, data: string): void {
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, data, "utf-8");
  fs.renameSync(tmp, file);
}
