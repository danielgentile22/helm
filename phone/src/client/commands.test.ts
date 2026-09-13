import { test } from "node:test";
import assert from "node:assert/strict";
import type { SlashCommand } from "../shared/protocol";
import { commandLabel, filterCommands, sentText, slashToken, type Draft } from "./commands";

const cmd = (name: string, description = "", argumentHint = ""): SlashCommand => ({ name, description, argumentHint });

const list: readonly SlashCommand[] = [cmd("grill", "Grill a plan", "<plan>"), cmd("grill-with-docs", "Grill against docs", "<plan>"), cmd("unslop", "Cut AI tells", "<text>"), cmd("agrilla", "Substring only", ""), cmd("Deslop", "Capitalised", "")];

const draft = (text: string, command: SlashCommand | null = null): Draft => ({ command, text });

test("slashToken reads the token being typed and stays null once it is not one", () => {
  assert.equal(slashToken(draft("/gri")), "gri");
  assert.equal(slashToken(draft("/")), "");
  assert.equal(slashToken(draft("/grill plan")), null);
  assert.equal(slashToken(draft("/grill\n")), null);
  assert.equal(slashToken(draft("hello")), null);
  assert.equal(slashToken(draft("")), null);
  assert.equal(slashToken(draft("/gri", cmd("grill"))), null, "a chosen command closes the popover");
});

test("filterCommands puts prefix matches before substring matches, case-insensitively, in list order", () => {
  assert.deepEqual(
    filterCommands(list, "gri").map((c) => c.name),
    ["grill", "grill-with-docs", "agrilla"],
  );
  assert.deepEqual(
    filterCommands(list, "DESL").map((c) => c.name),
    ["Deslop"],
  );
  assert.deepEqual(
    filterCommands(list, "").map((c) => c.name),
    list.map((c) => c.name),
    "an empty token matches everything and adds nothing twice",
  );
  assert.deepEqual(filterCommands(list, "zzz"), []);
});

test("sentText sends the command with a leading slash and the typed arguments", () => {
  assert.equal(sentText(draft("  hello  ")), "hello");
  assert.equal(sentText(draft("this plan", cmd("grill"))), "/grill this plan");
  assert.equal(sentText(draft("   ", cmd("grill"))), "/grill", "no trailing space when there are no arguments");
  assert.equal(sentText(draft("x", cmd("/grill"))), "/grill x", "a name that already carries the slash is not doubled");
});

test("commandLabel always shows one leading slash", () => {
  assert.equal(commandLabel(cmd("grill")), "/grill");
  assert.equal(commandLabel(cmd("/grill")), "/grill");
});
