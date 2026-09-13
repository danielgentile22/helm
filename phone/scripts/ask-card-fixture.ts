// Mount points for scripts/verify-ask.mjs: one live tool ask, one question, one already answered.
import { mount } from "svelte";
import AskCard from "../src/client/blocks/AskCard.svelte";
import { HttpError } from "../src/client/api";
import type { AskAnswer } from "../src/shared/protocol";

const sent: AskAnswer[] = [];
(globalThis as Record<string, unknown>).sent = sent;
let conflict = false;
(globalThis as Record<string, unknown>).setConflict = (v: boolean) => (conflict = v);

const onAnswer = async (answer: AskAnswer): Promise<void> => {
  sent.push(answer);
  if (conflict) throw new HttpError(409, "already answered");
};

mount(AskCard, {
  target: document.querySelector("#tool")!,
  props: { ask: { kind: "ask", askId: "a1" as never, ask: { kind: "tool", toolName: "Bash", input: { command: "rm -rf build" }, toolUseId: "tu1" as never, title: "Claude wants to run rm -rf build", description: null }, openedAt: new Date().toISOString(), answer: null }, live: true, onAnswer },
});
mount(AskCard, {
  target: document.querySelector("#q")!,
  props: { ask: { kind: "ask", askId: "a2" as never, ask: { kind: "question", questions: [{ question: "Rebase or merge?", header: "strategy", options: [{ label: "Rebase", description: "linear history" }, { label: "Merge", description: "keeps both" }], multiSelect: false }] }, openedAt: new Date().toISOString(), answer: null }, live: true, onAnswer },
});
mount(AskCard, {
  target: document.querySelector("#done")!,
  props: { ask: { kind: "ask", askId: "a3" as never, ask: { kind: "tool", toolName: "Bash", input: { command: "git push" }, toolUseId: "tu3" as never, title: null, description: null }, openedAt: new Date().toISOString(), answer: { answer: { kind: "deny", reason: "wrong branch" }, by: { by: "user", origin: { via: "pwa", label: "laptop" } }, ts: new Date().toISOString() } }, live: false, onAnswer },
});
