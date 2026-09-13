/**
 * The fake above the adapter seam: a scripted AgentSession. Everything above
 * it (supervisor, log, SSE, HTTP, auth, mirror, push) runs real against it.
 * The adapter itself is tested below the seam, against a recorded SDK query
 * in agent.test.ts. A script receives the turn and a control handle and emits
 * whatever sequence of events the test needs, with whatever timing.
 */

import type { AskAnswer, AskId, AskPayload, ClaudeSessionId, Effort, ModelId, PermissionMode, SlashCommand, ToolUseId, TurnId, Usage } from "../../shared/protocol";
import { Pushable } from "../util/pushable";
import type { AgentEvent, AgentFactory, AgentSession, RawModel, SpawnOptions, TurnInput } from "./agent";

export interface FakeTurn {
  readonly input: TurnInput;
  /** Emit any event under this turn. */
  emit(ev: AgentEvent): void;
  text(delta: string, blockIx?: number): void;
  thinking(delta: string): void;
  tool(name: string, input: unknown, output: string, isError?: boolean): void;
  /** Open a tool and leave it open, so a script can hold the thread mid-tool. */
  toolStart(name: string, input: unknown): ToolUseId;
  toolEnd(id: ToolUseId, output: string, isError?: boolean): void;
  /**
   * Pause on the user: emits `ask.opened` and resolves with whatever answer()
   * the supervisor forwards, the way the SDK's permission callback blocks.
   * The fake never emits the `ask.answered`; the supervisor logs that.
   */
  ask(ask: AskPayload): Promise<AskAnswer>;
  /** Finish the turn. Exactly once per send; the fake enforces it. */
  end(outcome?: "ok" | "error", error?: string | null, usage?: Usage | null): void;
  /** Resolves when the supervisor calls interrupt() during this turn. */
  readonly interrupted: Promise<void>;
  /** Simulate the process dying mid-turn: the event stream ends with no turn.ended. */
  crash(): void;
}

export type FakeScript = (turn: FakeTurn) => Promise<void> | void;

export const defaultUsage: Usage = { inputTokens: 10, outputTokens: 5, cacheReadTokens: 100, cacheWriteTokens: 0, costUsd: 0.01, contextTokens: 110, contextWindow: 200_000, durationMs: 42 };

/** Echoes the prompt back as one text block and ends ok. */
export const echoScript: FakeScript = (t) => {
  t.text(`Echo: ${t.input.text}`);
  t.end();
};

export class FakeSession implements AgentSession {
  readonly pid = 4242;
  sessionId: ClaudeSessionId | null;
  readonly out = new Pushable<AgentEvent>();
  killed = false;
  readonly setModelCalls: ModelId[] = [];
  readonly setEffortCalls: Effort[] = [];
  readonly setPermissionModeCalls: PermissionMode[] = [];
  readonly sends: TurnInput[] = [];
  /** Every answer the supervisor forwarded, in order. */
  readonly answers: { askId: AskId; answer: AskAnswer }[] = [];
  private readonly waiting = new Map<AskId, (answer: AskAnswer) => void>();
  private current: { turnId: TurnId; ended: boolean; settle: () => void; onInterrupt: () => void } | null = null;
  private dead = false;

  get alive(): boolean {
    return !this.dead && !this.out.isEnded;
  }

  /** Snapshot of the factory list taken at spawn, so a later factory edit does not reach a live session until reloadSkills(). */
  private commandList: readonly SlashCommand[];

  constructor(readonly spawnOpts: SpawnOptions, private readonly script: FakeScript, sessionId: ClaudeSessionId, private readonly onDisk: () => readonly SlashCommand[]) {
    this.sessionId = sessionId;
    this.commandList = onDisk();
    this.out.push({ kind: "session.bound", sessionId });
  }

  async commands(): Promise<readonly SlashCommand[]> {
    return this.commandList;
  }

  /** Stand in for the SDK's `commands_changed` push: the live menu changed under us. */
  pushCommands(list: readonly SlashCommand[]): void {
    this.commandList = list;
  }

  async reloadSkills(): Promise<readonly SlashCommand[]> {
    this.commandList = this.onDisk();
    return this.commandList;
  }

  send(input: TurnInput): Promise<void> {
    if (this.dead) return Promise.reject(new Error("session is dead"));
    if (this.current) throw new Error("fake: send while a turn is running is not scripted");
    this.sends.push(input);
    let onInterrupt = (): void => {};
    const interrupted = new Promise<void>((r) => (onInterrupt = r));
    const done = new Promise<void>((settle) => {
      this.current = { turnId: input.turnId, ended: false, settle, onInterrupt };
    });
    const cur = this.current!;
    const turn: FakeTurn = {
      input,
      interrupted,
      emit: (ev) => {
        if (cur.ended) throw new Error("fake: emit after end");
        this.out.push(ev);
        if (ev.kind === "turn.ended") {
          cur.ended = true;
          this.current = null;
          cur.settle();
        }
      },
      text: (delta, blockIx = 0) => turn.emit({ kind: "assistant.text", turnId: input.turnId, blockIx, delta }),
      thinking: (delta) => turn.emit({ kind: "assistant.thinking", turnId: input.turnId, delta }),
      toolStart: (name, inp) => {
        const toolUseId = `tu-${Math.random().toString(36).slice(2, 8)}` as ToolUseId;
        turn.emit({ kind: "tool.started", turnId: input.turnId, toolUseId, name, input: inp });
        return toolUseId;
      },
      toolEnd: (toolUseId, output, isError = false) => turn.emit({ kind: "tool.finished", turnId: input.turnId, toolUseId, output, isError }),
      ask: (ask) => {
        const askId = `ask-${Math.random().toString(36).slice(2, 8)}` as AskId;
        const answered = new Promise<AskAnswer>((resolve) => this.waiting.set(askId, resolve));
        turn.emit({ kind: "ask.opened", turnId: input.turnId, askId, ask });
        return answered;
      },
      tool: (name, inp, output, isError = false) => turn.toolEnd(turn.toolStart(name, inp), output, isError),
      end: (outcome = "ok", error = null, usage = defaultUsage) =>
        turn.emit({ kind: "turn.ended", turnId: input.turnId, outcome, sessionId: this.sessionId, usage, error }),
      crash: () => {
        this.dead = true;
        this.out.end();
        cur.ended = true;
        this.current = null;
        cur.settle();
      },
    };
    queueMicrotask(() => {
      void Promise.resolve(this.script(turn)).catch((err) => {
        if (!cur.ended) turn.end("error", String(err));
      });
    });
    return done;
  }

  async interrupt(): Promise<void> {
    const cur = this.current;
    if (!cur) return;
    cur.onInterrupt();
    // Scripts that do not await `interrupted` still get a clean interrupted end on the next tick.
    await new Promise((r) => setTimeout(r, 0));
    if (this.current === cur && !cur.ended) {
      this.out.push({ kind: "turn.ended", turnId: cur.turnId, outcome: "interrupted", sessionId: this.sessionId, usage: null, error: null });
      cur.ended = true;
      this.current = null;
      cur.settle();
    }
  }

  async setModel(model: ModelId): Promise<void> {
    this.setModelCalls.push(model);
  }
  async setEffort(effort: Effort): Promise<void> {
    this.setEffortCalls.push(effort);
  }
  async setPermissionMode(mode: PermissionMode): Promise<void> {
    this.setPermissionModeCalls.push(mode);
  }
  answer(askId: AskId, answer: AskAnswer): void {
    this.answers.push({ askId, answer });
    const resolve = this.waiting.get(askId);
    this.waiting.delete(askId);
    resolve?.(answer);
  }
  events(): AsyncIterable<AgentEvent> {
    return this.out;
  }
  async kill(): Promise<void> {
    this.killed = true;
    this.dead = true;
    this.out.end();
    const cur = this.current;
    if (cur) {
      this.current = null;
      cur.ended = true;
      cur.settle();
    }
  }
}

export class FakeAgentFactory implements AgentFactory {
  readonly sessions: FakeSession[] = [];
  script: FakeScript;
  catalog: readonly RawModel[] = [
    { id: "claude-opus-5", label: "Opus 5", supportsEffort: true, efforts: ["low", "medium", "high", "xhigh", "max"] },
    { id: "claude-sonnet-5", label: "Sonnet 5", supportsEffort: true, efforts: ["low", "medium", "high", "xhigh"] },
    { id: "claude-haiku-4-5-20251001", label: "Haiku 4.5", supportsEffort: false, efforts: [] },
    { id: "default", label: "Default (recommended)", supportsEffort: true, efforts: ["low", "medium", "high"] },
  ];
  /** The menu "on disk": mutate it to simulate a skill being added, then reload. */
  commandList: readonly SlashCommand[] = [
    { name: "commit", description: "Commit staged work", argumentHint: "" },
    { name: "grill-with-docs", description: "Grill a plan against the docs", argumentHint: "<plan>" },
  ];
  /** Every cwd commands() was probed with, in call order. */
  readonly probes: string[] = [];
  private spawnCount = 0;

  constructor(script: FakeScript = echoScript) {
    this.script = script;
  }

  async spawn(opts: SpawnOptions): Promise<AgentSession> {
    this.spawnCount += 1;
    const sessionId = (opts.resume ?? `fake-session-${this.spawnCount}`) as ClaudeSessionId;
    const s = new FakeSession(opts, this.script, sessionId, () => this.commandList);
    this.sessions.push(s);
    return s;
  }

  async models(): Promise<readonly RawModel[]> {
    return this.catalog;
  }

  async commands(cwd: string): Promise<readonly SlashCommand[]> {
    this.probes.push(cwd);
    return this.commandList;
  }

  get last(): FakeSession {
    const s = this.sessions.at(-1);
    if (!s) throw new Error("no session spawned yet");
    return s;
  }
}
