/**
 * The one thing the server's save prompt and the phone's prompt row agree on:
 * where the guidance line sits. The server owns the prompt's wording, so the
 * client cannot parse it; it can only pull back out the one line the person
 * typed.
 */

export const GUIDANCE_PREFIX = "Guidance: ";

/** The guidance line of a save prompt, or null. The prompt puts it last, on its own line, behind GUIDANCE_PREFIX. */
export function guidanceOf(promptText: string): string | null {
  const last = promptText.trimEnd().split("\n").at(-1) ?? "";
  if (!last.startsWith(GUIDANCE_PREFIX)) return null;
  const guidance = last.slice(GUIDANCE_PREFIX.length).trim();
  return guidance === "" ? null : guidance;
}
