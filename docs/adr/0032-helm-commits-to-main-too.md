# Helm commits straight to main too

ADR 0012 extends to the merged helm repo. No branches, no pull requests: work is
committed to `main`, grouped and labeled, in helm and in the vault alike. This
overrides the global merge policy for these two repos.

The alternative was helm keeping branches, pull requests and a merge gate, since it
is now public code that doubles as a portfolio piece. Daniel chose speed and one
workflow across the whole system over a reviewed history.

## Consequences

- CI already runs on every push to `main`, so it becomes an alarm after the fact
  rather than a gate. A red `main` gets fixed next, before other work.
- With no review step, the commit-time personal-data guard (ADR 0028) is the only
  thing between a mistake and a public, permanent leak. It runs in `pre-commit` and
  `pre-push`, and `core.hooksPath` has to be set on every clone.
- helm's leftover branches (7 local, about 25 remote) are deleted once `helm1-final`
  is tagged.
