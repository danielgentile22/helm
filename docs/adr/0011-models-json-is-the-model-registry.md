# models.json is the single model and effort registry

Which model and effort each skill and routine runs at lives in `otto/models.json`.
It exists because the scheduler needs machine-readable values to build a
`claude -p --model X` command line, and the existing policy (the cost and
intelligence table in `~/.claude/CLAUDE.md`, the per-role overrides in
`pstack-models.md`) is prose written for agents to read.

The file encodes Daniel's policy as data, so it rejects `haiku` and any effort
above `high` on write. That matters because the source material this system was
built from specifies `XHIGH` on its skill cards, and a copied config would
otherwise import a value that is out of policy.

## Consequences

- Every entry carries a `why`, since "Opus, high" is a decision worth the
  reasoning when model tiers change.
- Per-skill frontmatter was rejected: 54 of the 70 skills are upstream files
  Daniel does not own, so any value written there is wiped by the next install.
