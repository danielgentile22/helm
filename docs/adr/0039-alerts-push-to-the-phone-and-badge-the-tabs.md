# Alerts push to the phone and badge the tabs

The four tabs are the same on every device (ADR 0037). On the Mac, Projects is a three
column workspace: the project list, the open project, and what is in flight. Four tabs
hide trouble behind whichever tab you are not on, so anything wrong becomes an alert. An
alert sends one push notification to the phone, counts toward the number on the app
icon, and puts the same number on its tab.

An alert is a condition, not a message. It opens when the engine sees the condition,
pushes once, and closes by itself when the condition clears, such as a routine passing
again. It does not close because it was seen. Dismissing one hides it until the condition
changes, so a routine that keeps failing the same way alerts once, the way the integrity
report already explains unchanged failures once.

| Alert | Tab | Opens when | Closes when |
|---|---|---|---|
| A routine failed | Background | its status result is not a pass | a later run passes |
| A routine went quiet | Background | no run in twice its cadence | it runs |
| A service is down | Background | its health probe fails | the probe answers |
| CI fails on the owner's pull request | Projects | the latest run on it fails | a run passes, or it merges or closes |
| An idea is due | Ideas | its due date is today or past | it is done, dropped or promoted, or the date moves |

## Considered options

- **Web Push to the home screen app.** Chosen. The dashboard is already a home screen
  app behind the passkey, iOS delivers Web Push and app icon badges to home screen apps,
  and a push reaches the phone through Apple even when the phone is off the tailnet.
- **A third-party push app (ntfy, Pushover).** Rejected: another app and account, and a
  tap lands outside helm.
- **A T3 Code scheduled task.** Rejected: it would run a model to send what is a fact
  the engine already has.
- **Email.** Rejected: easy to miss, and it cannot set a badge.

## Consequences

- Alerts live in State, one file per alert at `~/.helm/alerts/<key>.json`, keyed by what
  they are about (`routine:backup`, `ci:keel#12`), so evaluating twice changes nothing.
- The evaluation runs after every routine and on capture's half-hour beat. The page reads
  alert counts from the same files.
- Sending needs the Web Push encryption the Python standard library lacks. A short Node
  script in `dashboard/` sends it, using the same `web-push` package Helm Chat used; the
  dashboard already needs Node to build.
- A push carries only the alert's title and tab, never idea text or a log line.
- The subscription saved by Helm Chat is not reused: it belonged to another app.
