import { test } from "node:test";
import assert from "node:assert/strict";
import type { ThreadId } from "../../shared/protocol";
import { guidanceOf } from "../../shared/vault";
import { savePrompt } from "./vault-save";

const threadId = "0f0f0f0f-0000-4000-8000-000000000001" as ThreadId;

test("the save prompt names the vault root, the standing instructions, the mirror note and the tool", () => {
  const p = savePrompt("/Users/d/Vault", threadId, null);
  assert.match(p, /\/Users\/d\/Vault/, "the vault root it writes into");
  assert.match(p, /\/Users\/d\/Vault\/CLAUDE\.md/, "the vault's standing instructions, read before writing");
  assert.match(p, new RegExp(`\\[\\[inbox/chats/${threadId}\\]\\]`), "the chat mirror note every produced note links to");
  assert.match(p, /record_note/, "the tool that makes the outcome structured");
  assert.match(p, /canon-worthy/i, "the vault's own bar for what belongs in Atlas");
  assert.match(p, /commit/i, "the vault's git repo is committed, never pushed");
});

test("guidance round-trips through the prompt, and is absent when none was given", () => {
  assert.equal(guidanceOf(savePrompt("/v", threadId, "focus on the backup decision")), "focus on the backup decision");
  assert.equal(guidanceOf(savePrompt("/v", threadId, null)), null);
});
