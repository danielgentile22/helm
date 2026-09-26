# Architecture decision records

Why helm is built the way it is, for an engineer reading the repo cold. Each record
states the problem, the options on the table, what was chosen, and what it costs.
A record is never edited to change its decision; a later record supersedes it.

## HELM 1 (0001 to 0009)

The first version: a Node runner with a file queue, a three-tier voice router and a
Next.js heads-up display. Its code is at the `helm1-final` tag and its display is in
`archive/hud/`. The principles in 0003 (bind to loopback) and 0008 (deterministic
feeds over a model) still hold in the engine. These use the MADR format, with status
and date in the frontmatter.

- [0001](0001-files-as-the-message-bus.md) Files as the message bus
- [0002](0002-fail-closed-shared-key-auth.md) Fail-closed shared-key auth on every write route
- [0003](0003-loopback-only-bind.md) Loopback-only bind on the machine that can execute code
- [0004](0004-method-based-remote-write-lockout.md) Remote access = same app, method-based write lockout
- [0005](0005-syncthing-cannot-enqueue-work.md) Syncthing must not be able to enqueue work
- [0006](0006-three-router-tiers.md) Three router tiers, with a rules engine that always works
- [0007](0007-contract-tests-for-triplicated-lists.md) Contract tests where three files must agree
- [0008](0008-deterministic-feeds-over-llm.md) Deterministic feeds where an LLM adds only failure modes
- [0009](0009-prompt-injection-threat-model.md) Prompt injection: the content path is accepted, the transport path is closed

## The engine (0010 onward)

The runner, capture producers, dashboard and voice server were built in a private
repo named otto and merged into helm on 2026-09-26. Their records keep the name otto
where it was the name at the time. Records that read "HELM" mean the first version.

- [0010](0010-otto-is-the-skills-mount-point.md) otto is the skills mount point
- [0011](0011-models-json-is-the-model-registry.md) models.json is the single model and effort registry
- [0012](0012-no-branches-no-prs.md) otto and the vault commit straight to main, forever
- [0013](0013-dashboard-is-separate-from-helm2.md) The dashboard is its own app, not a route in Helm 2.0
- [0014](0014-departments-hold-directives-hold-todos.md) Departments hold directives, directives hold todos
- [0015](0015-the-dashboard-owns-nothing.md) The dashboard owns nothing
- [0016](0016-dashboard-reach-is-split-by-endpoint.md) The dashboard's reach is split by endpoint, not by a blanket rule
- [0017](0017-the-hero-is-a-slot.md) The hero is a slot, not a thing
- [0018](0018-threlte-renders-the-hero.md) Threlte renders the hero, but the slot does not require it
- [0019](0019-the-approach-is-the-first-hero-instrument.md) The Approach is the first hero instrument
- [0020](0020-capture-is-deterministic-and-per-source.md) Capture is deterministic, and every source fails on its own
- [0021](0021-dashboard-server-and-slot-contract.md) The dashboard is a Python stdlib server and a Vite build, and the slot is a handle
- [0022](0022-otto-holds-only-what-daniel-puts-in.md) otto holds only what Daniel puts in
- [0023](0023-the-hero-is-a-band-between-two-department-rows.md) The hero is a band between two department rows
- [0024](0024-the-dashboard-is-a-pressure-map.md) The dashboard is a pressure map
- [0025](0025-the-tailnet-door-is-a-passkey.md) The tailnet door is a passkey, and the phone holds the microphone
- [0026](0026-the-map-sizes-the-ink-not-the-plane.md) The map sizes the ink, not the plane
- [0027](0027-a-starred-directive-multiplies-pull.md) A starred directive multiplies pull
- [0028](0028-helm-is-a-public-engine-the-vault-holds-the-person.md) Helm is a public engine; the vault holds the person
- [0029](0029-the-vault-lives-at-home-not-inside-a-repo.md) The vault lives at ~/Vault, not inside a repo
- [0030](0030-runtime-state-lives-in-dot-helm.md) Runtime state lives in ~/.helm
- [0031](0031-helm-1-retires-its-hud-is-archived.md) HELM 1 retires; its HUD is archived, not deleted
- [0032](0032-helm-commits-to-main-too.md) Helm commits straight to main too
- [0033](0033-one-phone-app-helm-chat-is-the-shell.md) One phone app: Helm Chat is the shell
- [0034](0034-skills-get-their-own-private-repo.md) Skills get their own private repo

## Numbering after the merge

helm's own records kept 0001 to 0009. otto's engine records continue from 0010 in
their original order, and every reference inside them and in the code was
renumbered. Two of otto's records are about how the owner's private vault is
organised rather than about the engine, so they live in that vault and are not
published: otto 0001 (the vault nested inside the repo, superseded by 0029 here) and
otto 0002 (the vault organised by department). A reference that reads "otto ADR 0001
(in the vault)" points at one of them. The published 0028 and 0029 are copies with
personal details removed; the originals are in the vault too.

| otto | helm |
|---|---|
| 0003 | 0010 |
| 0004 | 0011 |
| 0005 | 0012 |
| 0006 | 0013 |
| 0007 | 0014 |
| 0008 | 0015 |
| 0009 | 0016 |
| 0010 | 0017 |
| 0011 | 0018 |
| 0012 | 0019 |
| 0013 | 0020 |
| 0014 | 0021 |
| 0015 | 0022 |
| 0016 | 0023 |
| 0017 | 0024 |
| 0018 | 0025 |
| 0019 | 0026 |
| 0020 | 0027 |
| 0021 | 0028 |
| 0022 | 0029 |
| 0023 | 0030 |
| 0024 | 0031 |
| 0025 | 0032 |
| 0026 | 0033 |
| 0027 | 0034 |
