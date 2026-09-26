# Runtime state lives in ~/.helm

Everything helm writes for its own use goes in one folder, `~/.helm/`, which sits
inside neither the vault nor the engine repo. That covers Helm Chat threads and push
subscriptions (today `~/.helm2/`), passkey credentials (today `otto/runner/auth/` and
`~/.helm2/auth`), the dashboard's status files, metrics, logs and voice turns.

HELM 1 kept this in a `system/` folder inside the vault, and otto kept it in
gitignored folders inside its own repo. The first breaks the rule that the vault is
knowledge only, and a status file rewritten every 30 minutes would bury real edits in
the vault's history. The second leaves personal files in the working tree of what is
now a public repo (ADR 0028), guarded only by a gitignore line.

## Consequences

- Three homes, three rules: the engine is public code, the vault is private knowledge
  in git, and state is private, mostly disposable and outside git.
- Chat threads and credentials are the only state worth backing up. The rest
  rebuilds itself.
- The 306 HELM 1 run records in `otto/runner/runs/` are dead. A few representative
  ones go to `Vault/Archive/`; the rest are deleted.
