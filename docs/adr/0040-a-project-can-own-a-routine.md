# A project can own a routine

The doorbook project needs a job on this Mac every morning: check the online listing of
each house its phone app marked for sale, and a door the phone can reach to send those
houses and read the answers back. helm already runs every scheduled job on this machine,
so the job goes in `models.json` like any other. The code does not: it lives in the
project, under `scripts/listings/`, and helm's wrappers in `runner/routines/` and
`runner/services/` only find the checkout (`DOORBOOK_ROOT`, default
`~/Projects/doorbook`) and run it.

The alternative was the project installing its own launchd agents. Then the dashboard
would not show the job, a pause from the phone would not reach it, and its failures would
not alert. Copying the code into helm was the other alternative, and it would put a
project's private logic in a public repo.

## Consequences

- The addresses and what the sites said live in `~/.helm/doorbook/`, helm's state home,
  never in either repo.
- The door binds loopback only (ADR 0003). `tailscale serve --bg --https=8665
  http://127.0.0.1:8664` puts it on the tailnet, and it answers only requests whose
  `Tailscale-User-Login` header, set by `tailscale serve`, matches
  `~/.helm/doorbook/owner`. With no owner file it answers nothing.
- The door can start the routine (`launchctl kickstart`) when the phone sends a house that
  was never searched. That is the named-routine row of ADR 0038, with no arguments.
- A machine without the project checkout has wrappers that fail on their first run and say
  so in the routine's status, like any other routine whose input is missing.
