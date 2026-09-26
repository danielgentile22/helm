# Skills get their own private repo

Supersedes ADR 0010. `~/.claude/skills` points at `~/Projects/skills`, a new private
repo, instead of at `otto/skills/`. It holds Daniel's personal skills, the vendored
third-party ones, and the symlinks into pstack and `~/.agents`. helm keeps only the
skills that operate a vault, `update-vault` and `voice-todo`, in `helm/skills/`, and
the skills repo symlinks to them.

otto could be the mount point because otto was private. helm is public (ADR 0028),
and `resume-tailor` carries the master resume. A plain `~/.claude/skills` folder was
rejected because it would have no history and no backup, the same gap the vault has.
Putting personal skills in the vault was rejected because some carry scripts and
assets, and the vault never holds code.

## Consequences

- The master resume moves to the vault's Work department, and `resume-tailor` reads
  it from there. The skill stops carrying personal data.
- helm's two skills are scrubbed of personal examples in their fixtures before they
  are committed to the public repo.
- The skills repo is an ordinary private project, so the global merge policy applies
  to it unless Daniel says otherwise.
