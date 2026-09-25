import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FIRST_GENERATION } from "../../shared/protocol";
import type { ClientMsgId, Seq, ThreadId, TurnId } from "../../shared/protocol";
import { LogRegistry } from "./log";
import { matchAll, parseQuery, searchCorpus, ThreadSearch, type Corpus, type TurnText } from "./search";

const corpusOf = (...turns: readonly [number, string][]): Corpus => ({
  generation: FIRST_GENERATION,
  headSeq: (turns[turns.length - 1]?.[0] ?? 0) as Seq,
  done: turns.map(([seq, text]): TurnText => ({ seq: seq as Seq, text })),
  live: [],
  promptSeq: new Map(),
  doneIds: new Set(),
});

test("parseQuery: whitespace splits, quotes hold a phrase together, case is folded", () => {
  assert.deepEqual(parseQuery('"fatal error" launchd'), ["fatal error", "launchd"]);
  assert.deepEqual(parseQuery("  Upload   STAGING "), ["upload", "staging"]);
  assert.deepEqual(parseQuery('"  keeps   inner  "'), ["keeps   inner"]);
  assert.deepEqual(parseQuery(""), []);
  assert.deepEqual(parseQuery('   ""  '), []);
});

test("matchAll: case-insensitive at a word start only", () => {
  assert.deepEqual(matchAll("Uploads are staged; uploads again", "upload"), [[0, 6], [20, 26]]);
  assert.deepEqual(matchAll("uploads", "load"), []);
  assert.deepEqual(matchAll("re-upload and (upload) and _upload", "upload"), [[3, 9], [15, 21]]);
  assert.deepEqual(matchAll("Étage and étage", "étage"), [[0, 5], [10, 15]]);
  assert.deepEqual(matchAll("anything", ""), []);
  assert.deepEqual(matchAll("a (b) c", "(b)"), [[2, 5]], "a term is text, not a pattern");
  const turkish = "İstanbul is a city";
  const [start, end] = matchAll(turkish, "is")[0]!;
  assert.equal(turkish.slice(start, end), "is", "offsets index the original, which case folding would have shifted");
});

test("searchCorpus: every term must appear, the best turn wins, the snippet is its matching line", () => {
  const corpus = corpusOf([4, "how are uploads staged\nnothing here"], [9, "staged uploads land in a temp dir\ntail"]);
  assert.equal(searchCorpus(null, corpus, ["missing"]), null);
  assert.equal(searchCorpus(null, corpus, ["uploads", "launchd"]), null);

  const one = searchCorpus(null, corpus, ["uploads"])!;
  assert.equal(one.turnsMatched, 2);
  assert.equal(one.seq, 9, "a tie on distinct terms goes to the latest turn");
  assert.equal(one.snippet, "staged uploads land in a temp dir");
  assert.deepEqual(one.ranges, [[7, 14]]);

  const two = searchCorpus(null, corpus, ["temp", "uploads"])!;
  assert.equal(two.seq, 9, "the turn covering both terms wins");
  assert.deepEqual(two.ranges, [[7, 14], [25, 29]]);
  assert.equal(two.snippet.slice(7, 14), "uploads");
});

test("searchCorpus: the title carries a term, and a title-only hit has no turn to land on", () => {
  const corpus = corpusOf([4, "we talked about uploads"]);
  const both = searchCorpus("Staging design", corpus, ["staging", "uploads"])!;
  assert.equal(both.seq, 4, "the term the title covered does not move the best turn");
  assert.deepEqual(both.ranges, [[16, 23]]);

  const titleOnly = searchCorpus("Staging design", corpusOf([4, "nothing to see"]), ["staging"])!;
  assert.deepEqual(titleOnly, { seq: null, snippet: "", ranges: [], turnsMatched: 0 });
});

test("searchCorpus: a long line is windowed around the first hit and overlapping ranges merge", () => {
  const line = `${"filler word ".repeat(40)}needle tail`;
  const hit = searchCorpus(null, corpusOf([2, line]), ["needle"])!;
  assert.ok(hit.snippet.length <= 160, `snippet was ${hit.snippet.length}`);
  const [start, end] = hit.ranges[0]!;
  assert.equal(hit.snippet.slice(start, end), "needle");

  const merged = searchCorpus(null, corpusOf([2, "overlapping terms"]), ["overlap", "overlapping"])!;
  assert.deepEqual(merged.ranges, [[0, 11]]);

  const phrase = "a quoted phrase longer than half the window and then some more words after it";
  const long = searchCorpus(null, corpusOf([2, `${"filler word ".repeat(20)}${phrase} tail`]), [phrase])!;
  const [from, to] = long.ranges[0]!;
  assert.equal(long.snippet.slice(from, to), phrase, "a term longer than half the window is not cut by it");
});

test("ThreadSearch folds a corpus again from nothing when the log has moved to a new generation, and finds the same passage", async () => {
  const root = await mkdtemp(join(tmpdir(), "helm2-search-"));
  const logs = new LogRegistry(root);
  const threadId = "0f0f0f0f-0000-4000-8000-0000000000cc" as ThreadId;
  const log = await logs.get(threadId);
  const origin = { via: "pwa", label: "iphone" } as const;
  await log.append({ kind: "input.queued", clientMsgId: "m1" as ClientMsgId, text: "where are uploads staged", uploads: [], origin });
  const start = await log.append((seq) => ({ kind: "turn.started" as const, turnId: `t:${seq}` as TurnId, clientMsgId: "m1" as ClientMsgId, model: "claude-opus-5" as never, effort: "high" as const, spawned: true }));
  for (const word of ["in ", "a ", "temp ", "dir"]) await log.append({ kind: "assistant.text", turnId: start.turnId, blockIx: 0, delta: word });
  await log.append({ kind: "turn.ended", turnId: start.turnId, outcome: "ok", sessionId: null, usage: null, error: null });

  const search = new ThreadSearch(logs);
  const before = await search.corpus(threadId);
  assert.equal(before.generation, 0);
  assert.equal(before.headSeq, 7);
  const hitBefore = searchCorpus(null, before, ["temp"])!;
  assert.equal(hitBefore.seq, start.seq);

  assert.equal((await log.compact()).ok, true);
  const after = await search.corpus(threadId);
  assert.equal(after.generation, 1);
  assert.equal(after.headSeq, 5, "the corpus was rebuilt over the compacted log rather than extended past a head it never had");
  const hitAfter = searchCorpus(null, after, ["temp"])!;
  assert.equal(hitAfter.snippet, hitBefore.snippet);
  assert.deepEqual(hitAfter.ranges, hitBefore.ranges);
  assert.equal(hitAfter.seq, 3, "the turn boundary in the new numbering");
  assert.equal(await search.corpus(threadId), after, "a corpus in the current generation is reused");
  await rm(root, { recursive: true });
});
