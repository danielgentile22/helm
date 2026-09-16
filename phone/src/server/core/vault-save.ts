/**
 * The prompt a "Save to vault" turn runs. Server-owned so it can change
 * without a client deploy, and logged as the turn's `input.queued` text so
 * the transcript shows exactly what was asked.
 *
 * It does not define canon-worthiness itself. It points at the vault's own
 * standing instructions and quotes their bar, so a save from the phone and a
 * session running inside the vault agree on what belongs in Atlas.
 */

import type { ThreadId } from "../../shared/protocol";
import { GUIDANCE_PREFIX } from "../../shared/vault";

export function savePrompt(vaultRoot: string, threadId: ThreadId, guidance: string | null): string {
  const mirror = `[[Inbox/helm2-phone-chats/${threadId}]]`;
  const paragraphs = [
    `Record this conversation as knowledge in the Obsidian vault at ${vaultRoot}.`,

    `Before writing anything, read the vault's standing instructions at ${vaultRoot}/CLAUDE.md and follow its conventions for frontmatter, wikilinks, dated bullets, supersession callouts, and one home per fact.`,

    "Write only what is canon-worthy by the vault's own definition: the conversation made a commitment Daniel will act on later, it changed a standing workflow, tool, or configuration, or it established a fact future sessions need that a repo or its git history does not already hold. If nothing here is canon-worthy, say so in one sentence and write nothing.",

    "What belongs may be a new decision note in Atlas/Decisions, a dated bullet on the matching Atlas/Areas note, a new or updated project note, or several of these. Prefer updating an existing note over creating a parallel one.",

    `Link every note you create or change to this conversation's chat mirror note, ${mirror}, so the knowledge keeps its provenance. The mirror note links back on its own.`,


    "If this thread already called record_note earlier, those calls name the notes you wrote before. Update those notes rather than creating new ones.",

    `Commit the vault's local git repo with a message naming this thread (${threadId}). Never add a remote and never push.`,

    "After writing, call the record_note tool once per note you created or changed, with the note's absolute path and a one-line summary of what changed in it. Then reply in two or three sentences.",
  ];
  if (guidance) paragraphs.push(GUIDANCE_PREFIX + guidance);
  return paragraphs.join("\n\n");
}
