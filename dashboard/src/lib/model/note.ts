// The session note is a whole assistant recap in markdown. The row gets one plain line.

const NOTE_MAX = 70;
const MARKS = /[*_`#>]+|\[([^\]]*)\]\([^)]*\)/g;
const SENTENCE_END = /[.!?](\s|$)/;

export function noteLine(note: string): string {
  const first = note.split(/\n/).map((l) => l.trim()).find((l) => l !== "") ?? "";
  const plain = first.replace(MARKS, "$1").replace(/\s+/g, " ").trim();
  const end = SENTENCE_END.exec(plain);
  const sentence = end === null ? plain : plain.slice(0, end.index + 1);
  return sentence.length <= NOTE_MAX ? sentence : `${sentence.slice(0, NOTE_MAX - 1).trimEnd()}…`;
}
