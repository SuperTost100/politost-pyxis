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

/** Whether every `$` of the text has its partner, so no formula is cut in half. */
const closed = (text: string) => (text.match(/\$/g) ?? []).length % 2 === 0;

function start(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= ANSWER_CHARS) return flat;
  let cut = flat.slice(0, ANSWER_CHARS);
  const space = cut.lastIndexOf(" ");
  if (space > ANSWER_CHARS / 2) cut = cut.slice(0, space);
  // A formula the cut reaches into is left out whole, so the card never shows half of one.
  if (!closed(cut)) cut = cut.slice(0, cut.lastIndexOf("$"));
  return `${cut.trimEnd()}…`;
}

const READINGS: Record<string, string> = {
  alpha: "α", beta: "β", gamma: "γ", delta: "δ", epsilon: "ε", theta: "θ", lambda: "λ", mu: "μ", nu: "ν", pi: "π", rho: "ρ",
  sigma: "σ", tau: "τ", phi: "φ", omega: "ω", Delta: "Δ", Omega: "Ω", Sigma: "Σ", cdot: "·", times: "×", pm: "±", leq: "≤",
  geq: "≥", neq: "≠", approx: "≈", to: "→", infty: "∞", sqrt: "√", int: "∫", sum: "Σ", partial: "∂",
};

/**
 * Text as it is read aloud or put in a label: the `$` marks off, and a formula's TeX in plain words (`\theta` is θ,
 * `\cos` is cos, braces gone). Never the source of a formula.
 */
export function plainReading(text: string): string {
  // A part of a fraction or an exponent that is more than one term keeps its grouping: "(a+b)/(c+d)", not "a+b/c+d".
  const group = (part: string) => (/^[A-Za-z0-9_.,²³^\\]+$/.test(part.trim()) ? part.trim() : `(${part.trim()})`);
  const raised = (part: string) => (part.trim() === "2" ? "²" : part.trim() === "3" ? "³" : `^${group(part)}`);
  let reading = text
    .replace(/\$\$?/g, "")
    .replace(/\\(?:mathrm|mathbf|mathit|mathbb|text|textrm|operatorname|left|right|vec|hat|bar|overline)\b\s*/g, "")
    // A fraction with an exponent after it is read in parentheses: "(1/2)²", not "1/2²".
    .replace(/\\[dt]?frac\s*(\d)\s*(\d)(?=(\s*\^)?)/g, (_, top: string, bottom: string, power?: string) =>
      power ? `(${top}/${bottom})` : `${top}/${bottom}`,
    )
    // A single digit after the caret is the whole exponent; a braced one is read below, whole.
    .replace(/\^([23])/g, (_, digit: string) => (digit === "2" ? "²" : "³"));
  // The innermost groups first, so a fraction in a fraction and a power in a fraction are read from the inside out.
  for (let pass = 0; pass < 20; pass += 1) {
    const before = reading;
    reading = reading
      .replace(/\^\{([^{}]*)\}/g, (_, part: string) => raised(part))
      .replace(/\\[dt]?frac\s*\{([^{}]*)\}\s*\{([^{}]*)\}(?=(\s*[\^²³])?)/g, (_, top: string, bottom: string, power?: string) =>
        power ? `(${group(top)}/${group(bottom)})` : `${group(top)}/${group(bottom)}`,
      );
    if (reading === before) break;
  }
  return reading
    .replace(/\\([A-Za-z]+)/g, (_, name: string) => READINGS[name] ?? name)
    .replace(/\\[,;:! ]/g, " ")
    .replace(/[{}]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** A jump's mark stays the one in view while the student has not scrolled away from where it left the page, in the chat it was made in. */
export function pinnedMark(
  pin: { chat: string; index: number; top: number } | null,
  chat: string,
  scrollTop: number,
): number | null {
  return pin && pin.chat === chat && Math.abs(scrollTop - pin.top) <= 24 ? pin.index : null;
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

/**
 * Horizontal position of the outline box from the window's left edge: 6 px past the chat pane's left edge
 * (beside the sidebar, open or folded), or null when fewer than 40 px separate that edge from the message column.
 */
export function outlineLeft(paneLeft: number | undefined, columnLeft: number | undefined): number | null {
  if (paneLeft === undefined || columnLeft === undefined || columnLeft - paneLeft < 40) return null;
  return paneLeft + 6;
}
