#!/usr/bin/env python3
"""Report wikilinks in the vault whose target file does not exist.

Obsidian resolves [[Name]] by basename regardless of folder, so moving a note is
safe and renaming one is not. This is the check the phase 4 script runs before
and after the restructure, and the same check the integrity routine will run.
"""
import re, sys
from pathlib import Path

LINK = re.compile(r'\[\[([^\]\|#\^]+)')
# Obsidian does not render a link inside a code span or a fenced block, so
# neither should this check. `[[wikilinks]]` in prose is documentation.
CODE = re.compile(r'```.*?```|`[^`\n]*`', re.S)

def main(root):
    root = Path(root)
    md = [p for p in root.rglob('*.md') if '.git' not in p.parts]
    # Inbox/ and Archive/ hold generated and frozen material: phone transcripts,
    # old run reports, the Claude.ai export. Valid link TARGETS, never scanned as
    # SOURCES. A dead link in last month's report is not worth a daily failure,
    # and the integrity report quotes broken links, so it would fail on its own
    # output forever. Research reports are no longer here: they moved into the
    # department that owns them on 2026-09-16 and ARE scanned, which is why
    # `sources` no longer excludes them.
    FROZEN = {'Inbox', 'Archive'}
    sources = [p for p in md if not (set(p.relative_to(root).parts) & FROZEN)]
    names = {p.stem for p in md}
    # Notes declare alternative names in frontmatter (People notes especially:
    # "Ada (daughter).md" is linked as [[Ada]]). Those are real targets.
    for p in md:
        head = p.read_text(encoding='utf-8', errors='replace')[:600]
        for line in head.splitlines():
            if line.startswith('aliases:'):
                names |= {a.strip().strip('"\'[]') for a in line.split(':', 1)[1].split(',') if a.strip()}
    # non-markdown attachments are linkable too
    names |= {p.name for p in root.rglob('*') if p.is_file() and '.git' not in p.parts}
    broken = {}
    total = 0
    for p in sources:
        text = CODE.sub(' ', p.read_text(encoding='utf-8', errors='replace'))
        for m in LINK.finditer(text):
            target = m.group(1).strip()
            total += 1
            if target not in names and Path(target).stem not in names:
                broken.setdefault(target, []).append(str(p.relative_to(root)))
    print(f"  OK     {total} wikilinks, {len(broken)} distinct targets missing")
    for t, srcs in sorted(broken.items())[:15]:
        print(f"  FAIL   [[{t}]] referenced by {len(srcs)} file(s), e.g. {srcs[0]}")
    if len(broken) > 15:
        print(f"         and {len(broken)-15} more")
    return 1 if broken else 0

if __name__ == '__main__':
    sys.exit(main(sys.argv[1]))
