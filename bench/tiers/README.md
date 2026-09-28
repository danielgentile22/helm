# Tier ladder benchmark

Issue 59. Measurement only: nothing in talk, Helm Chat, the dashboard or `models.json`
changes. The benchmark answers three questions with numbers from this machine.

1. Can the Mac hold Kev, a local language model and the speech server at once?
2. Which Kev size (4B or 9B) sorts helm's requests well enough, and at what confidence threshold?
3. Which local model (Qwen 3.6 35B-A3B or Gemma 4 26B) does tier 2 work inside talk's sandbox?

## What it does

For each grid cell (Kev 4B or 9B, by Qwen or Gemma) the harness starts the Kev server on
port 8009 and a benchmark-only Ollama on 11435, times the local model cold and warm, then
sends every sentence in `fixture.json` to Kev's System One endpoint with two questions: which
tier, and which tier 1 menu action. Tier 2 sentences also run through `claude -p` with talk's
permission mode and tool lists (read from `dashboard/server/turns.py`, never copied), pointed at
Ollama, against a throwaway git copy of `demo-vault/` that is reset before every case. A tier 2
case passes on its outcome: the right words in the reply, or exactly one commit that touches only
the expected department note and adds the expected text. Memory is sampled every two seconds for
the whole cell. Both servers are stopped when the cell ends, on Ctrl-C too.

The tiers are 0 none (noise), 1 instant (one allowlisted menu action, performed by code), 2 local
and 3 cloud. A decision below the threshold climbs, never falls: instant and none go to local,
local goes to cloud. Instant is the one tier that acts without reading, so only a confident
decision reaches it. An instant decision whose menu action is none also counts as local, since
code has nothing to perform. A case is unsafe when it ends below its label, or when noise ends
as an instant action. The recommended threshold is the lowest of 0.00, 0.05, ... 1.00 at which
no case is unsafe.

## Run

The speech server must be up (`curl 127.0.0.1:3108/health`); the harness refuses to start
otherwise, so memory always includes it. Kev lives in `~/.helm/bench/tiers/kev` and the models in
`~/.helm/bench/tiers/hf` and `~/.helm/bench/tiers/ollama`. Nothing here installs them.

```
python3 bench/tiers/bench.py                         full grid, four cells
python3 bench/tiers/bench.py --only 7                one case, 1-based, still the grid
python3 bench/tiers/bench.py --kev 4b --local qwen   one cell
python3 bench/tiers/bench.py --keep                  leave the vault copy on disk
python3 bench/tiers/bench.py --skip-tier2            decisions and memory only
```

Results land in `~/.helm/bench/tiers/results/<YYYY-MM-DD-HHMM>.md` and `.json`, server logs in
`~/.helm/bench/tiers/logs/`. Removing the benchmark is deleting `~/.helm/bench`.

## The recommendation rule

Prefer the smaller Kev when its worst cell has no unsafe case at its threshold and its cloud
share is within 5 points of the larger Kev's. Prefer the local model with more tier 2 passes
across its cells; a tie goes to the faster warm latency. The threshold is the chosen cell's.

## Caveats

- Memory per process is the larger of RSS and `footprint`, because each misses one kind of
  model memory: RSS leaves out the Metal buffers MLX holds Kev's weights in, and footprint
  leaves out the clean file pages llama-server maps Ollama's weights from. The machine-level
  truth is still the free memory percentage (`kern.memorystatus_level`) and swap used; read
  the per-process numbers next to those.
- Run it with a normal working load open (a browser, a few Claude Code sessions), or the
  headroom number flatters the machine.
- If the tier 2 preflight fails (no result event, or no "ready"), the cell records
  `tier2_blocked` with the last 40 lines of stderr and skips its tier 2 cases. That is a finding.
- Tier 2 runs in every cell, so each local model is graded twice, once beside each Kev size.
- `invented_tool` means a tool outside Read, Grep, Glob, Bash and Skill. Skill is Claude Code's
  own skill loader; a local model that finds the voice-todo skill through it is doing what
  talk's prompt does.
- The tier 2 run's `HELM_STATE` points at a scratch folder, so the todo editor's agenda
  re-merge never touches the real dashboard.
- 40 cases is small. A threshold chosen on it is a starting point, not a calibration.
