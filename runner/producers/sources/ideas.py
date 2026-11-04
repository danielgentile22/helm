"""Ideas: every open idea note under `Atlas/Ideas/`, read through `idea_edit.parse_idea`.

Row contract, one per open idea, soonest due first and undated ones after, oldest first:

    {"kind": "idea", "source": "ideas", "id": "<created>-<slug>",
     "path": "Atlas/Ideas/<created>-<slug>.md", "title": str, "created": "YYYY-MM-DD",
     "status": "open", "department": Department, "project": str | None,
     "due": "YYYY-MM-DD" | None, "issue": None}

A note that does not parse fails the source with its path in the reason, so the envelope
says which note to fix and the last good rows stay (ADR 0020). Local only, no network.
"""
from __future__ import annotations

from datetime import datetime

import common
import idea_edit


def collect(env: dict[str, str], now: datetime) -> list[dict]:
    try:
        ideas = idea_edit.load_ideas(common.VAULT)
    except idea_edit.IdeaError as e:
        raise common.SourceError("parse", str(e)) from e
    open_ideas = sorted((i for i in ideas if i.status == "open"),
                        key=lambda i: (i.due is None, i.due or "", i.created, i.id))
    return [{"kind": "idea", "source": "ideas", **i.to_row()} for i in open_ideas]
