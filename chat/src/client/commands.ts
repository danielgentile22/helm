/**
 * The composer draft and the three pure decisions the slash UI makes about it.
 *
 * One object rather than scattered booleans: a draft is either free text or a
 * chosen command plus its arguments, and the popover is open exactly when
 * slashToken() is non-null. No component keeps a second copy of that state.
 */

import type { SlashCommand } from "../shared/protocol";

export interface Draft {
  command: SlashCommand | null;
  text: string;
}

export const emptyDraft = (): Draft => ({ command: null, text: "" });

/** The server reports names without the leading slash; the wire text needs one. */
export const commandLabel = (command: SlashCommand): string => (command.name.startsWith("/") ? command.name : `/${command.name}`);

const bareName = (command: SlashCommand): string => (command.name.startsWith("/") ? command.name.slice(1) : command.name);

/**
 * The token being typed after `/`, or null when no command is being typed.
 * `/` on its own is a token of "", which matches everything.
 */
export function slashToken(draft: Draft): string | null {
  if (draft.command !== null) return null;
  if (!draft.text.startsWith("/")) return null;
  const token = draft.text.slice(1);
  return /\s/.test(token) ? null : token;
}

/** Prefix matches first, then substring matches, each in the list's own order. */
export function filterCommands(list: readonly SlashCommand[], token: string): SlashCommand[] {
  const needle = token.toLowerCase();
  const prefix: SlashCommand[] = [];
  const inside: SlashCommand[] = [];
  for (const command of list) {
    const name = bareName(command).toLowerCase();
    if (name.startsWith(needle)) prefix.push(command);
    else if (needle !== "" && name.includes(needle)) inside.push(command);
  }
  return [...prefix, ...inside];
}

/** Exactly what goes over the wire, so the desktop sees `/name args`. */
export function sentText(draft: Draft): string {
  return draft.command ? `${commandLabel(draft.command)} ${draft.text}`.trim() : draft.text.trim();
}
