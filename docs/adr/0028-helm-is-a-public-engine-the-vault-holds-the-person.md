# Helm is a public engine; the vault holds the person

otto and helm merge into one system named helm. The `danielgentile22/helm` repo stays
public, and it holds only engine: code, generic docs, a demo vault. Everything that is
about Daniel lives in the vault, which has no remote. That includes the persona and
directives now in otto's `CLAUDE.md`, the department routers, and the master resume.
Runtime state is neither engine nor person and has its own home (ADR 0030). Helm
learns who it serves by reading a vault, the same way it already runs against
`demo-vault/`.

The alternatives were making helm private and merging freely, or keeping a private
working repo with a hand-updated public mirror. Going private throws away a public repo
that doubles as a portfolio piece. The mirror would drift from the real thing within weeks.
The split also matches how the system already behaves: Helm Chat reads the vault's
`CLAUDE.md` before saving a note, and otto's dashboard owns nothing that is not backed
by a file (ADR 0015).

## Consequences

- **Every file is engine or person, and personal history in a public repo is
  permanent.** A mistake cannot be taken back by deleting the file. The merge needs a
  commit-time guard in helm, in the spirit of the `.githooks` vault guard, that rejects
  known personal paths and names.
- **otto's private git history does not travel into helm as-is.** It contains personal
  run records, fixtures and resume content. What moves is the current engine code,
  re-committed after review.
- **The four departments stay hardcoded in the engine.** Work, Chess, Projects and
  Life are specific to Daniel but not sensitive, the demo vault uses the same four,
  and helm is built for one user. Reading them from the vault is a feature for the
  day someone else runs helm, not part of the merge.
