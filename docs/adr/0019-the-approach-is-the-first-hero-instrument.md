# The Approach is the first hero instrument

The first instrument built for real in the hero slot is The Approach: an orrery of
dated things, where every event, due task and scheduled job is a body whose distance
from the centre is the time until it lands. Decided 2026-09-16 after two prototype
rounds, over The Kiln, a bed of embers showing threads of unfinished work by how
recently they were touched.

The reason is resolution. The Approach changes every hour and makes arrival an
event, so a glance at 4pm shows something the glance at 11am did not. The Kiln's
resolution is a day, and an instrument that repeats itself all day gets ignored,
which is what happened to the breathing orb of goals before it. The Kiln also came
close to failing the redundancy test in ADR 0017: its text panel said nearly
everything its canvas said.

The round 2 prototypes, the measurements, and the full argument are in
`dashboard/prototypes/heroes-round-2/`, with `verdict.md` as the record.

## Consequences

- **The Approach is decided; its design is not finished.** Round 3 has an open list
  in `verdict.md`: sparse weeks, the midnight rollover, the amount of overdue
  motion, ordering on the rim, and a trace of recent arrivals.
- **Two things from The Kiln are grafted, not lost.** Objects are baked as a cold
  face and a hot face and crossfaded by state, never drawn with `shadowBlur`. And
  overdue work carries its age as heat, white when just late and ash when old, so
  the Approach also shows what is cooling.
- **The Kiln is shelved, not rejected.** If the slot ever holds a second instrument
  on a toggle, it is the one, and the palette keeps `--ash`, `--coal`, `--coal-lit`
  and `--ember` for that reason.
- **The shared modules from round 2 become the slot.** Tokens, geometry, labels,
  clock and the page runtime in `shell.js` are the starting point for the real
  implementation, with the changes listed in section 5 of `verdict.md`.
