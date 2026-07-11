# Architecture decision records

The deliberate engineering behind HELM, for an engineer reading the repo
cold. Most decisions are about one fact: the runner executes an AI agent
with broad permissions on a personal machine, so the power must stay
reachable by exactly one person.

[MADR](https://adr.github.io/madr/) format: each record states the problem,
the options actually on the table, what was chosen and why, and what it
costs, with status and date in the frontmatter.

1. [Files as the message bus](0001-files-as-the-message-bus.md)
2. [Fail-closed shared-key auth on every write route](0002-fail-closed-shared-key-auth.md)
3. [Loopback-only bind on the machine that can execute code](0003-loopback-only-bind.md)
4. [Remote access = same app, method-based write lockout](0004-method-based-remote-write-lockout.md)
5. [Syncthing must not be able to enqueue work](0005-syncthing-cannot-enqueue-work.md)
6. [Three router tiers, with a rules engine that always works](0006-three-router-tiers.md)
7. [Contract tests where three files must agree](0007-contract-tests-for-triplicated-lists.md)
8. [Deterministic feeds where an LLM adds only failure modes](0008-deterministic-feeds-over-llm.md)
9. [Prompt injection: content path accepted, transport path closed](0009-prompt-injection-threat-model.md)
