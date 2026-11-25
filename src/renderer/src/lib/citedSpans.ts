/**
 * Which words a citation mark covers. The model writes its marks after the sentence or the clause they support, so a
 * mark covers the sentence that ends at it: from the previous full stop, or the previous mark, up to the mark. Marks next
 * to each other ("[P1][P2]", "[P1], [P2]", "[P1]. [P2]") are one run and cover the same words. When no words are left between that
 * start and the mark, as for a mark that opens its paragraph, the whole block is covered (`fallback`).
 *
 * The text is a block's flattened text (see `flatten`): MARK stands for a citation mark and ATOM for a formula, which is
 * one word whose letters are not ours to split.
 */
export const MARK = "";
export const ATOM = "￼";

export type CoveredRun = {
  /** The positions, in mark order inside the block, of the marks of this run. */
  marks: number[];
  start: number;
  end: number;
  /** No sentence was found before the run, so it covers the whole block. */
  fallback: boolean;
};

const SPACE = /\s/u;
/** Between two marks of one run: spaces and punctuation only, as in "[P1], [P2]" or "[P1]. [P2]". */
const JOIN = /[\s,;:.!?…]/u;
const TERMINAL = /[.!?…]/u;
/** What a new sentence starts with after a full stop: a capital, an opening quote or bracket, or a formula. */
const STARTS = new RegExp(`[\\p{Lu}«"“(\\[${ATOM}]`, "u");
/** Left over at the start of the words after a previous run, such as the ", e" in "[P1], e lo svolgimento [P2]". */
const LEAD = /[\s,;:.!?…)\]»”"'’]/u;

/** Whether a full stop (or ! ? …) at `at` ends a sentence: a space follows, then something a sentence starts with. */
function endsSentence(text: string, at: number): boolean {
  if (!TERMINAL.test(text[at]!) || !SPACE.test(text[at + 1] ?? "")) return false;
  let next = at + 1;
  while (next < text.length && SPACE.test(text[next]!)) next++;
  return next < text.length && STARTS.test(text[next]!);
}

export function coveredRuns(text: string): CoveredRun[] {
  const marks: number[] = [];
  for (let at = 0; at < text.length; at++) if (text[at] === MARK) marks.push(at);
  // Runs of marks with only spaces and punctuation between them.
  const runs: number[][] = [];
  marks.forEach((at, index) => {
    const last = runs.at(-1);
    const previous = last ? marks[last.at(-1)!]! : -1;
    if (last && [...text.slice(previous + 1, at)].every((char) => JOIN.test(char))) last.push(index);
    else runs.push([index]);
  });
  let floor = 0;
  return runs.map((run) => {
    const first = marks[run[0]!]!;
    const last = marks[run.at(-1)!]!;
    // The words end before the mark, without the spaces that set it apart.
    let end = first;
    while (end > floor && SPACE.test(text[end - 1]!)) end--;
    // The search for the start goes back past this sentence's own closing punctuation.
    let from = end;
    while (from > floor && /[.!?…:;,)\]»”"'’]/u.test(text[from - 1]!)) from--;
    let start = floor;
    for (let at = from - 1; at >= floor; at--) {
      if (text[at] === "\n" || endsSentence(text, at)) {
        start = at + 1;
        break;
      }
    }
    while (start < end && LEAD.test(text[start]!)) start++;
    floor = last + 1;
    // Nothing but punctuation between the start and the mark: the whole block.
    const words = text.slice(start, end).replace(new RegExp(`[^\\p{L}\\p{N}${ATOM}]`, "gu"), "");
    return words
      ? { marks: run, start, end, fallback: false }
      : { marks: run, start: 0, end: text.length, fallback: true };
  });
}

/** The part of a DOM node `flatten` needs, so a unit test can run it on a linkedom tree. */
export type FlatNode = {
  nodeType: number;
  textContent: string | null;
  childNodes: ArrayLike<FlatNode>;
  tagName?: string;
  getAttribute?(name: string): string | null;
};

/** A piece of a flattened block: the node it comes from and where its characters sit in the flat text. */
export type FlatPiece = { node: FlatNode; start: number; end: number; kind: "text" | "atom" | "mark" };

const hasClass = (node: FlatNode, name: string) => (node.getAttribute?.("class") ?? "").split(/\s+/).includes(name);
/** Blocks inside a block that are not part of its sentences: a nested list, code, a table, a formula on its own line. */
const SKIP = new Set(["UL", "OL", "PRE", "TABLE", "BLOCKQUOTE"]);

/**
 * A block's text as `coveredRuns` reads it: its text nodes, each formula as ATOM and each citation mark (`.px-cite-mark`)
 * as MARK. The pieces map the flat text back to the nodes, to build a DOM range.
 */
export function flatten(block: FlatNode): { text: string; pieces: FlatPiece[] } {
  let text = "";
  const pieces: FlatPiece[] = [];
  const visit = (node: FlatNode, top: boolean) => {
    if (node.nodeType === 3) {
      const value = node.textContent ?? "";
      pieces.push({ node, start: text.length, end: text.length + value.length, kind: "text" });
      text += value;
      return;
    }
    if (node.nodeType !== 1) return;
    if (hasClass(node, "px-cite-mark")) {
      pieces.push({ node, start: text.length, end: text.length + 1, kind: "mark" });
      text += MARK;
      return;
    }
    if (hasClass(node, "katex") || hasClass(node, "px-formula-source")) {
      pieces.push({ node, start: text.length, end: text.length + 1, kind: "atom" });
      text += ATOM;
      return;
    }
    if (node.tagName === "BR") {
      text += "\n";
      return;
    }
    if (!top && (SKIP.has(node.tagName ?? "") || hasClass(node, "katex-display") || hasClass(node, "px-check-slot")))
      return;
    for (const child of Array.from(node.childNodes)) visit(child, false);
  };
  visit(block, true);
  return { text, pieces };
}
