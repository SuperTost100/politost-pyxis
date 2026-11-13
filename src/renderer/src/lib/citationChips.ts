/** The part of a DOM node this needs, so a unit test can run it on a linkedom tree. */
type Dom = {
  nodeType: number;
  textContent: string | null;
  previousSibling: Dom | null;
  nextSibling: Dom | null;
  parentNode: Dom | null;
  firstChild: Dom | null;
  lastChild: Dom | null;
  tagName?: string;
  getAttribute?(name: string): string | null;
  remove?(): void;
  querySelectorAll?(selector: string): ArrayLike<Dom>;
};

const TEXT = 3;
const ELEMENT = 1;
const hasClass = (node: Dom, name: string) =>
  node.nodeType === ELEMENT && (node.getAttribute?.("class") ?? "").split(/\s+/).includes(name);
const isChip = (node: Dom) => hasClass(node, "px-cite");

/** The last text node under `node`, or `node` itself when it is one; chips do not count, since they are going. */
function lastText(node: Dom): Dom | null {
  if (node.nodeType === TEXT) return (node.textContent ?? "") === "" ? null : node;
  if (node.nodeType !== ELEMENT || isChip(node)) return null;
  for (let child = node.lastChild; child; child = child.previousSibling) {
    const found = lastText(child);
    if (found) return found;
  }
  return null;
}

/**
 * What a reader sees right after a chip: "end", "gap" (a space or punctuation, so the text already has its separator),
 * or "word" (a letter, a digit or a formula, which needs the space the chip left). Inline elements are looked through,
 * and so are other chips.
 */
function whatFollows(chip: Dom): "end" | "gap" | "word" {
  const first = (node: Dom): "gap" | "word" | null => {
    if (node.nodeType === TEXT) {
      const text = node.textContent ?? "";
      return text === "" ? null : /^[\s.,;:!?)\]}»”’…]/u.test(text) ? "gap" : "word";
    }
    if (node.nodeType !== ELEMENT || isChip(node)) return null;
    if (hasClass(node, "katex") || hasClass(node, "katex-display")) return "word";
    for (let child = node.firstChild; child; child = child.nextSibling) {
      const found = first(child);
      if (found) return found;
    }
    return null;
  };
  for (let at: Dom | null = chip; at; at = at.parentNode) {
    for (let next = at.nextSibling; next; next = next.nextSibling) {
      const found = first(next);
      if (found) return found;
    }
    // Leaving an inline element goes on with what follows it; the holder itself is where the text ends.
    if (at.parentNode?.nodeType !== ELEMENT || at.parentNode.tagName === "DIV") break;
  }
  return "end";
}

/**
 * Takes the citation chips out of a copy of a selection, with the space before each one when that space only set the
 * chip apart: before punctuation, before a space that is already there, and at the end. Before a word or a formula, also
 * inside an emphasised word, one space stays, so "uno [1]<em>due</em>" reads "uno due".
 */
export function dropCitationChips(holder: Dom) {
  for (const chip of Array.from(holder.querySelectorAll?.(".px-cite") ?? [])) {
    const follows = whatFollows(chip);
    // The last words before the chip, past spaces that stand alone (between two chips, say), which go. A formula is one
    // word whose letters are not ours to trim, so the space that follows it is the one that is trimmed.
    let before: Dom | null = null;
    let spaces: Dom | null = null;
    for (let at = chip.previousSibling; at && !before; at = at.previousSibling) {
      if (hasClass(at, "katex") || hasClass(at, "katex-display")) break;
      const text = lastText(at);
      if (text && (text.textContent ?? "").trim() === "") {
        text.textContent = "";
        spaces = text;
      } else before = text;
    }
    // A word right after the chip needs the one space the chip's own gap gave; anything else needs none.
    const space = follows === "word" ? " " : "";
    if (before) before.textContent = (before.textContent ?? "").replace(/\s+$/, "") + space;
    else if (spaces) spaces.textContent = space;
    chip.remove?.();
  }
}
