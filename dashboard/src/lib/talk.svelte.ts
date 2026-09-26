// Push to talk. One phase at a time, so there is no pair of booleans that can disagree
// about whether the microphone is hot. Every transition goes through advance() in
// model/turn.ts; nothing here, and nothing outside this module, assigns a phase itself.

import { ApiError, getTurn, getVoiceHealth, postCancelTurn, postTalk, speakUrl } from "./api";
import { clock } from "./clock.svelte";
import { snapshot } from "./snapshot.svelte";
import { advance, hot } from "./model/turn";
import { ms } from "./model/types";
import type { Event as TurnEvent, Phase, Turn, TurnAction } from "./model/turn";
import type { Ms } from "./model/types";

export type { Phase } from "./model/turn";

const MIN_CLIP_MS = 300;
const TURN_POLL_MS = 2000;
const PREFERRED = "audio/webm;codecs=opus";
const BROKEN = "helm could not finish that turn. Hold space and try again.";

let phase = $state<Phase>({ name: "idle" });
let transcript = $state("");
let confirmation = $state("");
let actions = $state<readonly TurnAction[]>([]);

let mic: MediaStream | null = null;
let asking: Promise<MediaStream> | null = null;
let recorder: MediaRecorder | null = null;
let heldFrom: Ms = ms(0);
let player: HTMLAudioElement | null = null;
let polling = false;
let turnId: string | null = null;

// Both ends of a press are async: getUserMedia can still be open when the key comes back up,
// a recorder delivers its last blob a task after stop(), and the run outlives both. So every
// press carries a number, and abandoning one means bumping it. A press whose number has moved
// on never starts a recorder, never sends its clip, and never schedules another poll. The
// caller that bumped it owns the phase from then on.
let press = 0;

/** The one place a phase is written. It hands back what it wrote, because a caller that just
 *  moved the phase cannot read the module variable without fighting the narrowing. */
function to(event: TurnEvent): Phase {
  phase = advance(phase, event);
  return phase;
}

function detail(cause: unknown): string {
  return cause instanceof ApiError ? cause.detail : BROKEN;
}

// The promise is cached, not just the stream, because a release during the permission prompt
// lets a second press start before the first has resolved. Two getUserMedia calls would leave
// one stream unreachable and its track open for the life of the tab.
async function microphone(): Promise<MediaStream> {
  const cached = mic;
  if (cached !== null && cached.active) return cached;
  const already = asking;
  if (already !== null) return already;
  const wanted = navigator.mediaDevices.getUserMedia({ audio: true });
  asking = wanted;
  try {
    const live = await wanted;
    mic = live;
    return live;
  } finally {
    asking = null;
  }
}

// Stopping a recorder does not close the microphone. The track stays live, and macOS keeps
// its indicator lit, until the track itself is stopped. A press that is listening may be
// recording on this same stream, so it keeps it and its own stop releases it later.
function release(): void {
  if (phase.name === "listening") return;
  const live = mic;
  mic = null;
  if (live !== null) for (const track of live.getTracks()) track.stop();
}

function audio(): HTMLAudioElement {
  const made = player;
  if (made !== null) return made;
  const element = new Audio();
  // The acknowledgement plays while the phase is working, where both of these are ignored,
  // so only the confirmation's end moves the phase on.
  element.addEventListener("ended", () => to({ kind: "spoken" }));
  element.addEventListener("error", () => to({ kind: "unplayable" }));
  player = element;
  return element;
}

function speak(text: string): void {
  if (text === "") return;
  const element = audio();
  element.src = speakUrl(text);
  void element.play().catch(() => to({ kind: "unplayable" }));
}

function hush(): void {
  const element = player;
  if (element !== null && !element.paused) element.pause();
}

async function poll(): Promise<void> {
  // A wedged voice process holds the proxy open far longer than the tick, so without this the
  // 30 second ticks would stack requests on something that is already stuck.
  if (polling || hot(phase)) return;
  polling = true;
  try {
    await getVoiceHealth();
  } catch {
    to({ kind: "health-down" });
    return;
  } finally {
    polling = false;
  }
  to({ kind: "health-up" });
}

async function startPress(): Promise<void> {
  if (phase.name === "listening") return;
  if (to({ kind: "press" }).name !== "listening") return;
  const mine = ++press;
  let live: MediaStream;
  try {
    live = await microphone();
  } catch {
    if (press === mine) to({ kind: "mic-denied" });
    return;
  }
  if (press !== mine) {
    release();
    return;
  }
  const taping = MediaRecorder.isTypeSupported(PREFERRED)
    ? new MediaRecorder(live, { mimeType: PREFERRED })
    : new MediaRecorder(live);
  // The buffer belongs to this recorder, so a dropped clip's last blob cannot land in front
  // of the next one and hand the server two containers spliced together.
  const parts: Blob[] = [];
  taping.ondataavailable = (event: BlobEvent): void => {
    if (event.data.size > 0) parts.push(event.data);
  };
  taping.onstop = (): void => {
    release();
    if (press === mine) void send(new Blob(parts, { type: taping.mimeType }));
  };
  taping.start();
  heldFrom = clock.now();
  recorder = taping;
}

async function send(clip: Blob): Promise<void> {
  const mine = press;
  if (clip.size === 0) {
    to({ kind: "dropped" });
    return;
  }
  try {
    const started = await postTalk(clip);
    if (press !== mine) return;
    turnId = started.turn;
    transcript = started.transcript;
    confirmation = "";
    actions = [];
    to({ kind: "heard", turn: started.turn });
    speak(started.ack);
    later(started.turn, mine);
  } catch (cause) {
    if (press === mine) to({ kind: "failed", message: detail(cause) });
  }
}

// A chain rather than an interval, so a cancelled or superseded press leaves nothing behind
// to fire: the next link checks the press number before it asks the server anything.
function later(id: string, mine: number): void {
  setTimeout(() => {
    void pollTurn(id, mine);
  }, TURN_POLL_MS);
}

async function pollTurn(id: string, mine: number): Promise<void> {
  if (press !== mine) return;
  let turn: Turn;
  try {
    turn = await getTurn(id);
  } catch (cause) {
    if (press === mine) to({ kind: "failed", message: detail(cause) });
    return;
  }
  if (press !== mine) return;
  land(turn);
  if (phase.name === "working") later(id, mine);
}

function land(turn: Turn): void {
  if (turn.phase === "done" || turn.phase === "failed") {
    confirmation = turn.confirmation ?? "";
    actions = turn.actions;
    // The server rereads the todos before it writes the phase, so the agenda already agrees
    // and this is the fetch, not a race with the capture.
    if (turn.actions.length > 0) void snapshot.refresh();
  }
  const next = to({ kind: "poll", phase: turn.phase, confirmation: turn.confirmation, actions: turn.actions });
  if (next.name === "speaking") speak(next.says);
}

// The phase moves here rather than in the stop handler, because a recorder takes a task to
// deliver its last blob and leaving the phase on listening across that gap would swallow the
// next press and let a cancelled clip send itself anyway.
function endPress(): void {
  if (phase.name !== "listening") return;
  const taping = recorder;
  recorder = null;
  if (taping === null) {
    press += 1;
    to({ kind: "released-short" });
    return;
  }
  const heldMs = clock.now() - heldFrom;
  if (heldMs < MIN_CLIP_MS) {
    press += 1;
    to({ kind: "released-short" });
  } else {
    to({ kind: "released" });
  }
  if (taping.state !== "inactive") taping.stop();
}

/** Escape only. A run in flight is told to stop before it writes, and bumping the press
 *  number is what ends the poll chain. A blur or a hidden tab never comes here: "On it" means
 *  Daniel can walk away, so switching windows must not kill the run. */
function cancel(): void {
  if (phase.name === "working") {
    const id = turnId;
    press += 1;
    hush();
    to({ kind: "cancel" });
    if (id !== null) void postCancelTurn(id).catch(() => undefined);
    return;
  }
  drop();
}

/** Escape, a blur, or a hidden tab: a hot microphone is dropped without sending. */
function drop(): void {
  if (phase.name !== "listening") return;
  press += 1;
  const taping = recorder;
  recorder = null;
  to({ kind: "cancel" });
  if (taping !== null && taping.state !== "inactive") taping.stop();
}

export const talk = {
  get phase(): Phase {
    return phase;
  },
  /** The last thing the server heard, what it said about it, and the rows it wrote.
   *  Empty until the first turn. */
  get transcript(): string {
    return transcript;
  },
  get confirmation(): string {
    return confirmation;
  },
  get actions(): readonly TurnAction[] {
    return actions;
  },
  poll,
  /** Space down. Asks for the microphone on the first press only, never on page load. */
  press: startPress,
  /** Space up. Sends the clip unless it was too short to be speech. */
  release: endPress,
  /** Escape. Drops a hot microphone, or cancels the run in flight before it writes. */
  cancel,
  /** A blur or a hidden tab. Drops a hot microphone and leaves a run in flight alone. */
  drop,
};
