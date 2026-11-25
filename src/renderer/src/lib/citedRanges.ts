import { coveredRuns, flatten, hasWords, type FlatNode, type FlatPiece } from "./citedSpans";

/** The blocks a citation mark's sentence is looked for in: the nearest one around the mark. */
const BLOCK = "p, li, td, th, h1, h2, h3, h4, h5, h6, dd, dt, figcaption, blockquote, .px-markdown";

/** The element a covered span is drawn on when its own block has no words, such as a paragraph of marks after a formula. */
function wordsBefore(block: Element): Element | null {
  for (let at = block.previousElementSibling; at; at = at.previousElementSibling)
    if (!at.classList.contains("px-cite-only")) return at;
  return block.parentElement?.closest(".px-checked") ?? null;
}

/** Puts the range's start, or its `end`, at an offset of a block's flat text. False when no piece holds the offset. */
function setAt(range: Range, pieces: FlatPiece[], offset: number, end: boolean) {
  const piece = end
    ? pieces.findLast((item) => item.start < offset && offset <= item.end) ?? pieces.findLast((item) => item.end <= offset)
    : pieces.find((item) => item.start <= offset && offset < item.end) ?? pieces.find((item) => item.start >= offset);
  if (!piece) return false;
  const node = piece.node as unknown as Node;
  if (piece.kind === "text") {
    const inside = Math.max(0, Math.min(offset - piece.start, piece.end - piece.start));
    if (end) range.setEnd(node, piece.start < offset ? inside : piece.end - piece.start);
    else range.setStart(node, piece.start <= offset ? inside : 0);
  } else if (end) range.setEndAfter(node);
  else range.setStartBefore(node);
  return true;
}

/**
 * The ranges of text in `host` that rest on the passages `numbers`: for each citation mark of one of them, the sentence
 * that ends at its run of marks (`coveredRuns`), or its whole block when that sentence cannot be found.
 */
export function citedRanges(host: HTMLElement, numbers: ReadonlySet<number>): Range[] {
  const blocks = new Set<Element>();
  for (const mark of host.querySelectorAll<HTMLElement>(".px-cite-mark[data-cite]"))
    if (numbers.has(Number(mark.dataset.cite))) {
      const block = mark.parentElement?.closest(BLOCK);
      if (block && host.contains(block)) blocks.add(block);
    }
  const ranges: Range[] = [];
  for (const block of blocks) {
    const { text, pieces } = flatten(block as unknown as FlatNode);
    const marks = pieces.filter((piece) => piece.kind === "mark");
    for (const run of coveredRuns(text)) {
      const cited = run.marks.some((index) => numbers.has(Number((marks[index]!.node as unknown as HTMLElement).dataset.cite)));
      if (!cited) continue;
      const range = document.createRange();
      if (run.fallback) {
        // A block of nothing but marks and punctuation ("[P1]." after a formula) covers the block before it.
        const words = hasWords(text) ? block : wordsBefore(block);
        if (!words) continue;
        range.selectNodeContents(words);
      } else if (!setAt(range, pieces, run.start, false) || !setAt(range, pieces, run.end, true)) continue;
      ranges.push(range);
    }
  }
  return ranges;
}
