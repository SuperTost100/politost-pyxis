/** The part of a chat row the outline reads. */
export type OutlineRow = { id: string; role: "user" | "assistant"; body: string };

/** One question of the conversation: where it is in the chat's rows, its first line and the start of its answer. */
export type OutlineMark = { id: string; row: number; question: string; answer: string };

/** The marks appear from this many questions on: a shorter chat is read at a glance. */
export const MARKS_FROM = 3;
/** How much of an answer the card shows before the cut. */
const ANSWER_CHARS = 220;

/** The first line with text, its runs of spaces squeezed to one. */
export function firstLine(text: string): string {
  const line = text.split("\n").find((part) => part.trim() !== "");
  return line ? line.replace(/\s+/g, " ").trim() : "";
}

function start(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= ANSWER_CHARS) return flat;
  const cut = flat.slice(0, ANSWER_CHARS);
  const space = cut.lastIndexOf(" ");
  return `${(space > ANSWER_CHARS / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/**
 * The outline of a chat: one mark per question, none before the third. `plain` turns a reply into the text the card
 * quotes. A question whose reply has not come has an empty answer.
 */
export function outlineMarks(rows: readonly OutlineRow[], plain: (body: string) => string): OutlineMark[] {
  const marks: OutlineMark[] = [];
  rows.forEach((row, index) => {
    if (row.role !== "user") return;
    const next = rows[index + 1];
    marks.push({
      id: row.id,
      row: index,
      question: firstLine(row.body),
      answer: next?.role === "assistant" ? start(plain(next.body)) : "",
    });
  });
  return marks.length >= MARKS_FROM ? marks : [];
}

/**
 * The mark of the part in view: the last question that starts above `line` (a height in the window). `tops` is each
 * question's distance from the top of the window, or null for one that is not rendered yet. With the line above every
 * rendered question it is the first of them, and -1 when none is rendered. At the end of the page it is the last one,
 * whose answer fills the window even when its question has scrolled above the line.
 */
export function currentMark(tops: ReadonlyArray<number | null>, line: number, atEnd = false): number {
  if (atEnd && tops.at(-1) !== null && tops.length > 0) return tops.length - 1;
  let current = -1;
  let firstRendered = -1;
  tops.forEach((top, index) => {
    if (top === null) return;
    if (firstRendered < 0) firstRendered = index;
    if (top <= line) current = index;
  });
  return current >= 0 ? current : firstRendered;
}

/** Where the rendered part of the chat starts once a jump to the message at `row`: earlier if the question is not rendered. */
export function jumpRange(firstShown: number, row: number): number {
  return Math.min(firstShown, row);
}
