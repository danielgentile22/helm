# otto is the skills mount point

`~/.claude/skills` is a symlink to `otto/skills/`, and all 70 skills compose
there: 16 real directories owned by Daniel, 34 symlinked out to the pstack plugin,
and 20 symlinked out to `~/.agents/skills`. Load behaviour is unchanged, so skills
still resolve in every repo, but there is one directory to look at and the skills
Daniel actually wrote are finally version controlled.

## Consequences

- Never edit a symlinked skill in place. The next pstack or agents install
  overwrites it.
- The eight vendored Cloudflare documentation skills (1.4 MB, 320 files) come
  along as real directories because nothing auto-updates them. `TOOLS.md` records
  where they came from.
- Symlinks into `~/.claude/pstack-claude` are absolute and meaningful only on this
  machine, which is acceptable while otto is personal and private.
