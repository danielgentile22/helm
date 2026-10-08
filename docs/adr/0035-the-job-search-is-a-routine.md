# The job search is a routine

Every morning at 04:00 helm searches LinkedIn's public listings against criteria kept
in the vault, screens them in code, has Claude pick the ten the owner is most likely to
interview for, runs the resume-tailor skill headlessly for each, and leaves a PDF with
the apply links on the desktop beside a folder of the ten tailored resumes and cover
letters. The record, a research note and a mirror of the folders, goes in the vault.

The alternative was keeping the search a chat session, as the lists of 2026-09-30 and
2026-10-07 were. That costs an hour of attention each time, and the step that mattered
(ten tailored applications ready to send) never happened in the same sitting. The
owner's goal is to apply to all ten by the end of each day, which only works if the
materials are waiting when the day starts.

## Consequences

- The engine knows nothing about who is searching. Queries, deny regexes, the profile
  and the ranking guidance live in `Atlas/Work/files/job-search/criteria.json`;
  `demo-vault/` carries a fictional one, and the tests run against it.
- Clearance, citizenship and years are cut by regex before any model reads a posting,
  and the ranker is told the profile and forbidden to pick against it. A posting the
  owner cannot take never reaches a tailoring run.
- The resume-tailor skill gained a headless mode: no questions, red flags recorded
  rather than raised, unknown tools treated as not used, and no edits to the skills
  inventory. An unattended run has nobody to answer.
- This routine is not silent on success. The report is its output, and a run that
  fails still writes a note and a PDF saying so, so an empty desktop means the job
  did not fire at all.
- The desktop folder is the only thing helm writes outside its three homes. It is a
  copy; the vault mirror is the record.
- Ten tailorings at opus, high effort, every morning is the largest standing model
  cost in helm. `count` and `tailor` in the criteria file are the dials.
