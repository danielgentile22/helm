/**
 * Thread search: a projection of the logs into searchable text, plus the
 * pure matcher over it. The corpus per thread is the prompt text and the
 * assistant text of each turn, keyed by the seq of that turn's boundary so
 * a hit can name where to land. Tool input and output, thinking, notes,
 * files and asks are not searched.
 *
 * The cache extends at read time by cursor, not by a log subscription. A
 * search reads from the cached cursor forward, so there is no subscribe
 * then read gap to reason about, nothing to detach, and boot costs nothing:
 * a thread is folded the first time somebody searches it and only the tail
 * is parsed and folded after that. The read itself still scans the file
 * from the start, which log.read() does by design. Nothing is written to
 * disk, and the corpus is held for the life of the process.
 *
 * Invariants
 *   S1. `done` holds one TurnText per ended turn, in end order, and never
 *       changes again. `live` holds only turns that can still gain text,
 *       so the next extend folds onto the smallest possible prefix. An
 *       event addressed to a turn already in `done` reopens it in the fold;
 *       `doneIds` is what tells extend to drop that phantom instead of
 *       carrying it forever.
 *   S2. `headSeq` is the seq of the last event folded. Every event with a
 *       greater seq is still to be read.
 *   S3. One fold per thread at a time. Concurrent callers share the
 *       in-flight promise, so an event is never folded twice.
 */

import type { ClientMsgId, Cursor, MatchRange, Seq, ThreadId, TurnId } from "../../shared/protocol";
import { foldTurn, type Turn } from "../../shared/turns";
import type { LogRegistry, ThreadLog } from "./log";

/** One searchable turn: the seq of its turn boundary and the text a person wrote or read in it. */
export interface TurnText {
  readonly seq: Seq;
  readonly text: string;
}

export interface Corpus {
  readonly headSeq: Cursor;
  readonly done: readonly TurnText[];
  readonly live: readonly Turn[];
  /** The seq of the `input.queued` that opened each turn still waiting for its `turn.started`. */
  readonly promptSeq: ReadonlyMap<ClientMsgId, Seq>;
  /** Every turn already reduced into `done` (S1). */
  readonly doneIds: ReadonlySet<TurnId>;
}

export interface CorpusMatch {
  readonly seq: Seq | null;
  readonly snippet: string;
  readonly ranges: readonly MatchRange[];
  readonly turnsMatched: number;
}

const SNIPPET_CHARS = 160;
/** A term matches only where no letter, digit or underscore precedes it. */
const WORD_START = "(?<![\\p{L}\\p{N}_])";
const TOKEN = /"([^"]*)"|(\S+)/g;

const emptyCorpus: Corpus = { headSeq: 0, done: [], live: [], promptSeq: new Map(), doneIds: new Set() };

/** A double-quoted span is one term, whatever whitespace it holds. */
export function parseQuery(q: string): readonly string[] {
  const terms: string[] = [];
  for (const m of q.matchAll(TOKEN)) {
    const term = (m[1] ?? m[2]?.replace(/"/g, "") ?? "").trim().toLowerCase();
    if (term) terms.push(term);
  }
  return terms;
}

/**
 * Case-insensitive, anchored at a word start, so "upload" finds "Uploads"
 * and "load" does not. Matched against the original text rather than a
 * lowercased copy, because case folding is not length preserving and the
 * offsets have to index the string the client will slice.
 */
export function matchAll(text: string, term: string): MatchRange[] {
  const out: MatchRange[] = [];
  if (!term) return out;
  const re = new RegExp(WORD_START + term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "giu");
  for (const m of text.matchAll(re)) out.push([m.index, m.index + m[0].length]);
  return out;
}

/**
 * Null unless every term matches in the title or in some turn. The chosen
 * turn is the one covering the most distinct terms, latest wins a tie. A
 * hit that lives only in the title carries no seq and no snippet.
 */
export function searchCorpus(title: string | null, corpus: Corpus, terms: readonly string[]): CorpusMatch | null {
  if (terms.length === 0) return null;
  const covered = new Set<string>();
  for (const term of terms) if (matchAll(title ?? "", term).length > 0) covered.add(term);

  let best: { turn: TurnText; terms: readonly string[] } | null = null;
  let turnsMatched = 0;
  for (const turn of turnTexts(corpus)) {
    const hits = terms.filter((term) => matchAll(turn.text, term).length > 0);
    if (hits.length === 0) continue;
    turnsMatched += 1;
    for (const term of hits) covered.add(term);
    const better = !best || hits.length > best.terms.length;
    /** A tie goes to the turn that started latest, which is the seq the row will land on. */
    const laterTie = best !== null && hits.length === best.terms.length && turn.seq >= best.turn.seq;
    if (better || laterTie) best = { turn, terms: hits };
  }
  if (covered.size < terms.length) return null;
  if (!best) return { seq: null, snippet: "", ranges: [], turnsMatched: 0 };

  const first = matchAll(best.turn.text, best.terms[0]!)[0]!;
  const snippet = snippetAround(best.turn.text, first);
  const ranges = merge(terms.flatMap((term) => matchAll(snippet, term)));
  return { seq: best.turn.seq, snippet, ranges, turnsMatched };
}

function turnTexts(corpus: Corpus): readonly TurnText[] {
  const live = corpus.live.map((t) => turnText(t, corpus.promptSeq)).filter((t): t is TurnText => t !== null);
  return live.length === 0 ? corpus.done : [...corpus.done, ...live];
}

/** The hit's line, windowed so the whole matched term survives even when it is longer than the window. */
function snippetAround(text: string, hit: MatchRange): string {
  const from = text.lastIndexOf("\n", hit[0] - 1) + 1;
  const nl = text.indexOf("\n", hit[0]);
  const line = text.slice(from, nl < 0 ? text.length : nl);
  const at = hit[0] - from;
  if (line.length <= SNIPPET_CHARS) return line.trim();
  const end = Math.min(line.length, Math.max(at + (hit[1] - hit[0]), at + SNIPPET_CHARS / 2, SNIPPET_CHARS));
  return line.slice(Math.max(0, end - SNIPPET_CHARS), end).trim();
}

function merge(ranges: readonly MatchRange[]): MatchRange[] {
  const sorted = [...ranges].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const out: MatchRange[] = [];
  for (const [start, end] of sorted) {
    const last = out[out.length - 1];
    if (last && start < last[1]) out[out.length - 1] = [last[0], Math.max(last[1], end)];
    else out.push([start, end]);
  }
  return out;
}

/** The prompt and every text block, trimmed and joined. Null when the turn has no boundary to land on. */
function turnText(turn: Turn, promptSeq: ReadonlyMap<ClientMsgId, Seq>): TurnText | null {
  const seq = turnSeq(turn, promptSeq);
  if (seq === null) return null;
  const parts: string[] = [];
  const prompt = turn.prompt?.text.trim();
  if (prompt) parts.push(prompt);
  for (const item of turn.items) {
    if (item.kind !== "text") continue;
    const text = item.text.trim();
    if (text) parts.push(text);
  }
  return { seq, text: parts.join("\n") };
}

function turnSeq(turn: Turn, promptSeq: ReadonlyMap<ClientMsgId, Seq>): Seq | null {
  if (turn.turnId) {
    const seq = Number(turn.turnId.slice(2));
    if (Number.isInteger(seq)) return seq as Seq;
  }
  const clientMsgId = turn.prompt?.clientMsgId;
  return (clientMsgId ? promptSeq.get(clientMsgId) : undefined) ?? null;
}

export class ThreadSearch {
  private readonly cached = new Map<ThreadId, Corpus>();
  private readonly folding = new Map<ThreadId, Promise<Corpus>>();

  constructor(private readonly logs: LogRegistry) {}

  /** The thread's corpus, folded up to the log's current head (S3). */
  corpus(threadId: ThreadId): Promise<Corpus> {
    const running = this.folding.get(threadId);
    if (running) return running;
    const fold = this.fold(threadId).finally(() => this.folding.delete(threadId));
    this.folding.set(threadId, fold);
    return fold;
  }

  private async fold(threadId: ThreadId): Promise<Corpus> {
    const log = await this.logs.get(threadId);
    const have = this.cached.get(threadId);
    if (have && log.getHead().lastSeq <= have.headSeq) return have;
    const next = await extend(have ?? emptyCorpus, log);
    this.cached.set(threadId, next);
    return next;
  }
}

async function extend(base: Corpus, log: ThreadLog): Promise<Corpus> {
  const promptSeq = new Map(base.promptSeq);
  const doneIds = new Set(base.doneIds);
  const done = [...base.done];
  let live = base.live;
  let headSeq = base.headSeq;
  for await (const ev of log.read(base.headSeq)) {
    if (ev.kind === "input.queued") promptSeq.set(ev.clientMsgId, ev.seq);
    live = foldTurn(live, ev);
    headSeq = ev.seq;
  }
  const open: Turn[] = [];
  for (const turn of live) {
    if (turn.turnId && doneIds.has(turn.turnId)) continue;
    // A section with neither a turn nor a prompt holds only notes and files, which are never searched.
    if (turn.turnId === null && turn.prompt === null) continue;
    if (turn.end === null) {
      open.push(turn);
      continue;
    }
    const text = turnText(turn, promptSeq);
    if (text) done.push(text);
    if (turn.turnId) doneIds.add(turn.turnId);
    if (turn.prompt) promptSeq.delete(turn.prompt.clientMsgId);
  }
  return { headSeq, done, live: open, promptSeq, doneIds };
}
