# The vault lives at ~/Vault, not inside a repo

Supersedes otto ADR 0001 (in the vault). The vault moves out of `otto/Vault/` to `~/Vault`, a standalone
git repo with no remote that sits inside no other repo. Helm finds it through one
setting, `HELM_VAULT_ROOT`, which Helm Chat already reads.

otto ADR 0001 (in the vault) nested the vault so otto's `CLAUDE.md` would load underneath the vault's
own. Once helm became a public engine (ADR 0028), that reason went away: the persona
moves into the vault, so the vault carries its own context. What was left of nesting
was the risk. A vault nested inside a public repo is one careless `git add` away from
publishing legal, medical and financial records, and the only guards would be a
gitignore line and a hook that lives in local git config and does not travel with a
clone. Helm also works with branches, worktrees and pull requests, and none of those
worktrees would contain a nested vault.

`~/Projects/Vault` was rejected because `~/Projects` holds code repos and the vault
never holds code.

## Consequences

- Everything that hardcodes `otto/Vault` has to be repointed in the same change:
  Helm Chat's `HELM_VAULT_ROOT`, the hooks in `~/.claude/settings.json`, skills that
  name the path (`update-vault`, `know-it`), and the routers.
- **The vault still has no backup.** Moving it is the moment to take one, before the
  move and not after.
