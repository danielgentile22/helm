import { test } from "node:test";
import assert from "node:assert/strict";
import type { Seq } from "../../shared/protocol";
import { matchAll, parseQuery, searchCorpus, type Corpus, type TurnText } from "./search";

const corpusOf = (...turns: readonly [number, string][]): Corpus => ({
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
