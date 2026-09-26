# HELM 1 retires; its HUD is archived, not deleted

`main` in helm is tagged `helm1-final`, then everything HELM 1 built that otto has
since replaced is deleted: the Node runner and its file queue, helm's copy of the
voice server, the three-tier router, the feeds and the scheduled skills. otto's
Python runner, its voice server fork and its dashboard are the live versions of all of
them, and the router depended on Haiku, which `models.json` forbids.

The HUD is the exception. The orb and much of its layout are worth keeping, so the
UI moves to `archive/hud/` rather than being deleted. Merging it with the dashboard
into one UI is a real design problem that needs prototypes, and it is postponed. Until
then the dashboard is the only live desktop UI.

## Consequences

- `archive/hud/` is not built, not tested and not linted. It is a quarry, not a
  product. The tag `helm1-final` is how to run it as it was.
- The feeds stay dead under ADR 0022. Bringing one back, such as the USCF rating,
  means reopening that record, not reviving the file.
- The HELM line on the resume and the README demo gif describe the HUD. Both get
  rewritten to describe what is live.
