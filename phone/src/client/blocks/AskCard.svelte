<script lang="ts">
  /**
   * The one place a turn waits on a person. A card either offers an answer or
   * reports the one it already has: the buttons go on the first tap and never
   * come back, because the answer is settled by the log, not by this screen.
   * Allow and Deny are told apart by their words and their fixed positions,
   * never by colour alone.
   */
  import { toolSummary, type AskAnswer, type AskQuestion, type QuestionAnswer } from "../../shared/protocol";
  import type { AskItem } from "../../shared/turns";
  import { HttpError } from "../api";
  import { answerLine } from "../transcript";

  let { ask, live, onAnswer }: { ask: AskItem; live: boolean; onAnswer: (answer: AskAnswer) => Promise<void> } = $props();

  let sent = $state(false);
  let elsewhere = $state(false);
  let denying = $state(false);
  let reason = $state("");
  let showInput = $state(false);
  /** One entry per question: the labels ticked, or the typed text. */
  let picks = $state<(QuestionAnswer | null)[]>([]);
  let othering = $state<number | null>(null);
  let otherText = $state("");

  const payload = $derived(ask.ask);
  const settled = $derived(ask.answer !== null);
  const busy = $derived(sent || settled);
  const summary = $derived(payload.kind === "tool" ? toolSummary(payload.toolName, payload.input) : null);
  const input = $derived(payload.kind === "tool" ? (typeof payload.input === "string" ? payload.input : JSON.stringify(payload.input, null, 1)) : "");
  const questions = $derived<readonly AskQuestion[]>(payload.kind === "question" ? payload.questions : []);
  const complete = $derived(questions.length > 0 && questions.every((_, i) => picks[i]));

  async function submit(answer: AskAnswer): Promise<void> {
    if (busy) return;
    sent = true;
    try {
      await onAnswer(answer);
    } catch (err) {
      if (err instanceof HttpError && err.status === 409) elsewhere = true;
    }
  }

  function onReasonKey(e: KeyboardEvent): void {
    if (e.key === "Enter") {
      e.preventDefault();
      void submit({ kind: "deny", reason: reason.trim() || null });
    }
  }

  function pick(ix: number, label: string, multi: boolean): void {
    if (multi) {
      const chosen = picks[ix]?.kind === "options" ? (picks[ix] as { labels: readonly string[] }).labels : [];
      const next = chosen.includes(label) ? chosen.filter((l) => l !== label) : [...chosen, label];
      picks[ix] = next.length ? { kind: "options", labels: next } : null;
      return;
    }
    picks[ix] = { kind: "options", labels: [label] };
    if (questions.length === 1) void submit({ kind: "answers", answers: [picks[0]!] });
  }

  function sendOther(ix: number): void {
    const text = otherText.trim();
    if (!text) return;
    picks[ix] = { kind: "text", text };
    othering = null;
    otherText = "";
    if (questions.length === 1) void submit({ kind: "answers", answers: [picks[0]!] });
  }

  const ticked = (ix: number, label: string): boolean => picks[ix]?.kind === "options" && (picks[ix] as { labels: readonly string[] }).labels.includes(label);
</script>

<div class="askcard" class:is-settled={settled}>
  {#if payload.kind === "tool"}
    <div class="aq">Claude wants to <b>{summary?.label}</b></div>
    {#if summary?.arg}<div class="aarg">{summary.arg}</div>{/if}
    {#if payload.title}<div class="atitle">{payload.title}</div>{/if}
    {#if payload.description}<div class="adesc">{payload.description}</div>{/if}
    <button class="btn small" type="button" aria-expanded={showInput} onclick={() => (showInput = !showInput)}>{showInput ? "hide input" : "input"}</button>
    {#if showInput}<pre class="io">{input}</pre>{/if}
  {:else}
    {#each questions as q, ix (ix)}
      <div class="aqblock">
        <span class="chip">{q.header}</span>
        <div class="aq">{q.question}</div>
        <div class="aopts">
          {#each q.options as o (o.label)}
            <button class="aopt" type="button" disabled={busy} aria-pressed={ticked(ix, o.label)} onclick={() => pick(ix, o.label, q.multiSelect)}>
              {#if q.multiSelect}<span class="box">{ticked(ix, o.label) ? "✓" : ""}</span>{/if}
              <span class="l"><b>{o.label}</b>{#if o.description}<i>{o.description}</i>{/if}</span>
            </button>
          {/each}
        </div>
        {#if othering === ix}
          <div class="arow">
            <input class="ain" type="text" placeholder="Your answer" bind:value={otherText} disabled={busy} onkeydown={(e) => e.key === "Enter" && (e.preventDefault(), sendOther(ix))} />
            <button class="btn small primary" type="button" disabled={busy} onclick={() => sendOther(ix)}>Send</button>
          </div>
        {:else if !busy}
          <button class="btn small" type="button" onclick={() => ((othering = ix), (otherText = ""))}>Other…</button>
        {/if}
        {#if picks[ix]?.kind === "text"}<div class="aarg">{(picks[ix] as { text: string }).text}</div>{/if}
      </div>
    {/each}
  {/if}

  {#if settled}
    <div class="aans">{answerLine(ask)}</div>
  {:else if elsewhere}
    <div class="aans">Answered elsewhere</div>
  {:else if live && payload.kind === "tool"}
    {#if denying}
      <div class="arow">
        <!-- svelte-ignore a11y_autofocus -->
        <input class="ain" type="text" placeholder="Why not (optional)" bind:value={reason} disabled={busy} autofocus onkeydown={onReasonKey} />
        <button class="btn small" type="button" disabled={busy} onclick={() => void submit({ kind: "deny", reason: reason.trim() || null })}>Send deny</button>
      </div>
    {:else}
      <div class="arow">
        <button class="btn primary" type="button" disabled={busy} onclick={() => void submit({ kind: "allow" })}>Allow</button>
        <span class="grow"></span>
        <button class="btn" type="button" disabled={busy} onclick={() => (denying = true)}>Deny</button>
      </div>
      <button class="btn small" type="button" disabled={busy} onclick={() => void submit({ kind: "allowTurn" })}>Allow for this turn</button>
    {/if}
  {:else if live && questions.length > 1}
    <div class="arow">
      <span class="grow"></span>
      <button class="btn primary" type="button" disabled={busy || !complete} onclick={() => void submit({ kind: "answers", answers: picks.filter((p): p is QuestionAnswer => p !== null) })}>Confirm</button>
    </div>
  {:else if live && questions.some((q) => q.multiSelect)}
    <div class="arow">
      <span class="grow"></span>
      <button class="btn primary" type="button" disabled={busy || !complete} onclick={() => void submit({ kind: "answers", answers: [picks[0]!] })}>Confirm</button>
    </div>
  {/if}
</div>
