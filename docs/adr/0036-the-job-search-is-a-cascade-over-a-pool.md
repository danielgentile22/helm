# The job search is a cascade over a pool

On 2026-10-09 three of the first five postings on the morning list were unusable: one
required citizenship, one was a job board reposting another employer's role behind a
sign-up, and one asked for an active clearance and three years. Every fact was in the
posting text. The regex screen missed them because the wording varied, and the ranker
never saw them because it read only the first 1,400 characters of each posting. Nothing
recorded what was dropped or why, and a posting that was good but not top ten was
forgotten overnight.

The job search is now a cascade of passes over the full posting text, each cheaper than
the next, with code deciding every drop from a structured verdict; a pool that carries
judged postings across days; and a funnel in every morning's note and PDF.

## The cascade

Seven stages, each reading the previous stage's file and writing its own under
`status/job-search/<day>/` beside a `dropped-<stage>.json` naming the reason.

1. `search` pulls cards per bucket (near home, remote elsewhere) until each bucket has
   its target of cards the pool has never met, with LinkedIn's experience, posted-within,
   remote, job type and job function filters on the request. The title and employer
   regexes still cut first.
2. `detail` fetches each page once into the cache and runs the description regexes, the
   years floor and the remote check. These are kept as the cheap first cut; the funnel
   shows what they caught.
3. `eligibility` asks a cheaper model one question per posting and gets a fixed JSON
   form: citizenship (required, not required, or open to the owner's work status),
   clearance (required, obtainable, none, with Public Trust counting as required) and
   whether a board or agency posted it on behalf of another employer, each with the
   sentence it rests on. Code drops from the form; the sentence is the reason.
4. `skills` asks the same model for the years floor from the required section alone, the
   primary stack, and each required hard skill marked has, adjacent or missing against
   the owner's skills inventory, read whole from the vault. The thresholds (`max_years`,
   `never_stack`, `max_missing`) live in the criteria file.
5. `rank` shows the strongest model every candidate in full with both verdicts, asks it
   to re-check each against the same rules and name any it overturns, then order the
   survivors. It returns at most `count` and is told fewer is correct.
6. `tailor` is unchanged.
7. `report` computes the funnel and writes the two notes and the PDF.

A verdict is cached under `verdicts/<id>.json` with a hash of the criteria that shaped
it, so a posting is judged once per criteria version. Prompts travel on stdin, since a
full-text rank prompt is longer than an argument may be, and every call asks for JSON
output so its token counts and list-rate cost are recorded per stage in `costs.json`.

## The pool

`pool.json` holds one record per posting the search has met, with a status: `judged`
(passed every pass, never shown), `dropped` (the stage and reason), `picked` (the day
shown) or `expired` (older than `pool_days` from its posting date). It replaces the seen
ledger, whose entries became picked records on the first run. A regex drop is recorded
too, so a card met once is never fetched again. The ranker reads today's judged postings
plus every live record from earlier days, so the morning list is the best of everything
live and a posting that was good but not top ten waits for a thinner day. A picked
posting is never shown again; an overturned one is dropped with the model's reason.

## The funnel

`funnel.py` computes, from the stage files alone, how many came in per bucket, how many
were already known, how many each stage removed, how many were carried, ranked,
overturned and picked, and what each stage cost. The top note opens with it, the PDF
carries the line and a cost table, and a second research note lists every dropped posting
with its link, stage and reason, plus the pool carryovers, so a bad morning can be
diagnosed from the vault.

## Replay

`--replay --day D` reruns the cascade over a past day's cards from the posting cache,
against a scratch pool, writing to that day's state directory and leaving the funnel
there. No LinkedIn, no note, no PDF, no status. A filter change is measured on real data
before it runs live.

## Consequences

- Supersedes the line in ADR 0035 that said clearance, citizenship and years are cut by
  regex before any model reads a posting. The regexes stay as the first cut; the model
  passes read the whole text; code still decides every drop, from a form instead of a
  pattern.
- Two more registry entries, `routines.job-search.passes.eligibility` and `.skills`, so
  the pass models are policy, not code. The ban on the smallest model holds for them.
- The criteria file grew: bucket targets, LinkedIn filters, the owner's work status, the
  never list, the missing-skill threshold, the pool age and the skills inventory path.
  The demo vault carries fictional values for all of them.
- A single failed model call drops its posting closed, with the failure as the reason
  and no pool record, so an outage never produces a bad pick and the posting is tried
  again tomorrow. A stage where every call fails raises, and the failure path writes the
  note and the status as before.
- The cost is now visible every morning. A hundred eligibility calls, a few dozen skills
  calls and one large rank call is the standing bill beside the tailorings.
