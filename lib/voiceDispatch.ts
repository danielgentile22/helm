import { route, QUESTION_START, type Reveal } from "./router";
import { writeIntent } from "./skills";
import { extractModelOverride } from "./modelOverride";
import { conversationContext, rememberExchange } from "./voiceMemory";

// ---------------------------------------------------------------------------
// Shared transcript → intent dispatch. Two front doors call this:
//   POST /api/voice       — PTT audio clip (STT happens in the route)
//   POST /api/voice/text  — wake-word transcript (voice-server already STT'd)
// Same routing, same model-override extraction, same queue writes, same
// conversation memory — only the transport differs.
// ---------------------------------------------------------------------------

export interface VoicePayload {
  transcript: string;
  tier: number;
  skill: string | null;
  queued: string | null;
  reply: string;
  engine: string;
  panels: string[];
  deliverable: string | null;
  reveal: "open" | null;
  reveals: Reveal[];
}

// Voice capture of a Morphy task — e.g. "add a Morphy task to email the AR rep,
// assign Michael, high priority". Parsed deterministically (no model spend) and
// queued as a native morphy-task-add intent the runner writes to Notion. Spoken
// asks default Added-by to Daniel (he's the one talking).
export function parseMorphyCapture(
  raw: string
): { title: string; assignee: string; priority: string } | null {
  const low = raw.toLowerCase().trim();
  // A capture is an imperative — never a question. "did michael add a task to
  // the morphy board?" matches the three-word gate below but must not queue a
  // Notion write. Reuse the router's interrogative test + a raw '?' check.
  if (QUESTION_START.test(low) || raw.includes("?")) return null;
  const isCapture =
    /\bmorphy\b/.test(low) &&
    /\b(task|to-?do|todo|item)\b/.test(low) &&
    /\b(add|create|new|put|note|make|remind|capture)\b/.test(low);
  if (!isCapture) return null;

  // Pull assignee + priority OUT of the sentence wherever they sit (an
  // "assign X" / "for X" clause can come before or after the task text), so
  // what's left is the task itself.
  let work = raw;

  let assignee = "Unassigned";
  const am = work.match(/\b(?:assign(?:ed)?(?:\s+to)?|for)\s+(daniel|michael|both|me|myself)\b/i);
  if (am) {
    const who = am[1].toLowerCase();
    assignee =
      who === "me" || who === "myself"
        ? "Daniel"
        : who === "both"
          ? "Both"
          : who.charAt(0).toUpperCase() + who.slice(1);
    work = work.replace(am[0], " ");
  }

  // Require the word "priority" adjacent so we never grab "low"/"high" out of
  // the task text itself.
  let priority = "Med";
  const pm = work.match(/\b(high|medium|med|low)\s+priority\b|\bpriority\s+(high|medium|med|low)\b/i);
  if (pm) {
    const p = (pm[1] || pm[2]).toLowerCase();
    priority = p.startsWith("h") ? "High" : p.startsWith("l") ? "Low" : "Med";
    work = work.replace(pm[0], " ");
  }

  // Title = what remains after the command preamble (everything up to and
  // including the task word, or after a colon), minus connective filler.
  let title = work;
  const colon = work.indexOf(":");
  if (colon >= 0) title = work.slice(colon + 1);
  else {
    const m = work.match(/\b(?:task|to-?do|todo|item)\b(.*)$/i);
    if (m) title = m[1];
  }
  title = title
    .replace(/^[\s,]*(?:to|that|for|of|about|saying|which says|reading|and)\b/i, "")
    .replace(/\s{2,}/g, " ")
    .replace(/^[\s,]+/, "")
    .replace(/[\s,.:;-]+$/, "")
    .trim();
  if (title.length < 2) return null;
  title = title.charAt(0).toUpperCase() + title.slice(1);
  return { title, assignee, priority };
}

export async function dispatchTranscript(
  transcript: string,
  source: string
): Promise<VoicePayload> {
  // "use opus" / "use fable" spoken in the ask → one-run model override;
  // strip the phrase so routing and the voice-ask prompt see the clean ask
  const override = extractModelOverride(transcript);
  const ask = override ? override.stripped : transcript;

  // Morphy task capture — deterministic and engine-independent. Queue the
  // native intent (the runner writes it to Notion) and confirm immediately.
  const capture = parseMorphyCapture(ask);
  if (capture) {
    const queued = writeIntent("morphy-task-add", source, {
      title: capture.title,
      assignee: capture.assignee,
      priority: capture.priority,
      addedBy: "Daniel",
    });
    const who = capture.assignee === "Unassigned" ? "" : `, assigned to ${capture.assignee}`;
    const reply = `Adding a Morphy task: ${capture.title}${who}.`;
    rememberExchange({ you: transcript, helm: reply, tier: 1, skill: "morphy-task-add" });
    return {
      transcript,
      tier: 1,
      skill: "morphy-task-add",
      queued,
      reply,
      engine: "rules",
      panels: ["morphy"],
      deliverable: null,
      reveal: null,
      reveals: [],
    };
  }

  // running conversation memory — lets follow-ups ("make it shorter",
  // "what about the second one") resolve against the last few exchanges
  const convo = conversationContext();

  const result = await route(ask, convo);

  let queued: string | null = null;
  let reply = result.reply;
  if (result.tier === 1 && result.skill) {
    queued = writeIntent(result.skill, source);
  } else if (result.tier === 3 && ask.split(/\s+/).length >= 3) {
    // open-ended ask → headless claude -p via the runner (voice-ask skill);
    // completion is announced like any other run. Word guard keeps noise
    // and half-caught fragments from spawning real sessions.
    queued = writeIntent("voice-ask", source, {
      prompt: ask,
      ...(override ? { model: override.model } : {}),
      ...(convo ? { context: convo } : {}),
    });
    if (override && queued) {
      reply = `On it — running this one on ${override.spoken}. I'll speak up when it lands.`;
    }
  }

  const spokenReply = queued || result.tier !== 3 ? reply : "I didn't catch enough to act on.";

  rememberExchange({
    you: transcript,
    helm: spokenReply,
    tier: result.tier,
    skill: result.skill ?? (queued && result.tier === 3 ? "voice-ask" : undefined),
  });

  return {
    transcript,
    tier: result.tier,
    skill: result.skill ?? (result.tier === 3 && queued ? "voice-ask" : null),
    queued,
    reply: spokenReply,
    engine: result.engine,
    panels: result.panels ?? [],
    deliverable: result.deliverable ?? null,
    reveal: result.reveal ?? null,
    reveals: result.reveals ?? [],
  };
}
