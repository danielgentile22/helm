// Client-safe HUD_TZ clock helpers. Agenda/daily data is written in HUD_TZ
// (see lib/vault.ts), so the Schedule panel must compare it against "now" in
// that same zone — not the viewing device's — or the NOW marker and the
// today-check drift whenever the browser travels. lib/config.ts reads fs and
// can't ship to the browser; the zone rides in on VaultState.tz instead.
// A missing/invalid zone falls back to the device clock (old behavior).

/** YYYY-MM-DD of `now` in `tz` (en-CA gives ISO ordering). */
export function zonedYMD(now: Date, tz?: string): string {
  try {
    return new Intl.DateTimeFormat("en-CA", tz ? { timeZone: tz } : undefined).format(now);
  } catch {
    return new Intl.DateTimeFormat("en-CA").format(now);
  }
}

/** Minutes since midnight of `now` in `tz`. */
export function zonedMinutes(now: Date, tz?: string): number {
  try {
    const hhmm = new Intl.DateTimeFormat("en-GB", {
      ...(tz ? { timeZone: tz } : {}),
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).format(now);
    const m = hhmm.match(/(\d{2}):(\d{2})/);
    if (m) return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
  } catch {
    // fall through to device clock
  }
  return now.getHours() * 60 + now.getMinutes();
}
