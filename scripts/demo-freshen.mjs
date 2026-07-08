// Freshen the demo vault's dates so "today"-gated readers light up: the
// morning report is picked by today's filename prefix, the weekly metric
// delta needs points inside a trailing 7-day window, and the agenda only
// renders when its date IS today. The committed demo-vault is anchored to a
// fixed date; this shifts EVERY date/timestamp (file contents and filenames)
// forward by the same number of days so the newest daily note becomes today.
// Idempotent — a second run is a no-op. Pure data: no HUD code knows about it.
//
// Run: node scripts/demo-freshen.mjs   (then VAULT_ROOT=demo-vault next dev)
import fs from "node:fs";
import path from "node:path";

const DAY = 24 * 3600 * 1000;
// bare YYYY-MM-DD, optionally followed by an ISO time part — one regex pass
// so a timestamp's date half is never double-shifted
const STAMP = /(\d{4}-\d{2}-\d{2})(T[0-9:.]+Z)?/g;

const shiftYmd = (ymd, days) => {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
};

export function freshenDemoVault(root, today) {
  const dailyDir = path.join(root, "daily-notes");
  const anchor = fs
    .readdirSync(dailyDir)
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f))
    .sort()
    .pop()
    ?.slice(0, 10);
  if (!anchor) throw new Error(`no anchor daily note in ${dailyDir}`);
  const days = Math.round((Date.parse(today) - Date.parse(anchor)) / DAY);
  if (days === 0) return 0;

  const walk = (dir) =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]
    );

  for (const file of walk(root)) {
    const shifted = fs.readFileSync(file, "utf-8").replace(STAMP, (_, ymd, time) =>
      time
        ? new Date(Date.parse(ymd + time) + days * DAY).toISOString()
        : shiftYmd(ymd, days)
    );
    fs.writeFileSync(file, shifted, "utf-8");
    const newName = path.basename(file).replace(STAMP, (_, ymd) => shiftYmd(ymd, days));
    if (newName !== path.basename(file)) fs.renameSync(file, path.join(path.dirname(file), newName));
  }
  return days;
}

// CLI: freshen the committed demo vault in place, "today" in the demo's TZ.
if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  const root = path.resolve(process.argv[2] ?? "demo-vault");
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: process.env.HUD_TZ ?? "America/New_York",
  }).format(new Date());
  const days = freshenDemoVault(root, today);
  console.log(days === 0 ? `demo vault already at ${today}` : `demo vault shifted +${days}d to ${today}`);
}
