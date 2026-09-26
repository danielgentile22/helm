# otto and the vault commit straight to main, forever

Daniel's global policy is branch, open a pull request, merge after review. otto
and `Vault/` are exempt: grouped, labeled commits straight to main, no branches,
no pull requests, permanently.

Both are single-author personal repos, and the vault has no remote at all so a
pull request is not even possible there. Most of the work is filesystem surgery
(moving 756 files, repointing symlinks, installing launchd jobs) where a diff
shows renames and proves nothing about whether the result works. Verification
comes from running the thing, not from reading the diff.

## Consequences

- Risky filesystem phases get a dry-run script that prints every move and
  rewrite for approval, then runs for real. The script is the reviewable artifact.
- This rule is written into both `CLAUDE.md` files, because a future session
  reading the global policy would otherwise helpfully open a pull request.
