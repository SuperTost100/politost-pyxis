/**
 * The text of rendered Markdown, with each formula read once. KaTeX draws a formula three times: as MathML for screen
 * readers, as its TeX source in an annotation inside that MathML, and as the HTML the eye sees, so the plain
 * `textContent` of a heading or section holds "Rn\mathbb{R}^nRn" where a student reads "ℝⁿ".
 *
 * It takes any DOM-like node, so a unit test can run it on a linkedom tree.
 */
export type RenderedNode = {
  nodeType: number;
  nodeValue: string | null;
  childNodes: ArrayLike<RenderedNode>;
  localName?: string;
  classList?: { contains(token: string): boolean };
  getAttribute?(name: string): string | null;
};

const ELEMENT = 1;
const TEXT = 3;

const hasClass = (node: RenderedNode, token: string) => node.nodeType === ELEMENT && !!node.classList?.contains(token);

/** Every text node under `node`, as `textContent` reads them. */
function textOf(node: RenderedNode): string {
  return Array.from(node.childNodes)
    .map((child) => (child.nodeType === TEXT ? (child.nodeValue ?? "") : child.nodeType === ELEMENT ? textOf(child) : ""))
    .join("");
}

/** The TeX source KaTeX keeps in the formula's MathML, or an empty string when it has none. */
function texOf(node: RenderedNode): string {
  for (const child of Array.from(node.childNodes)) {
    if (child.nodeType !== ELEMENT) continue;
    if (child.localName === "annotation" && child.getAttribute?.("encoding") === "application/x-tex") {
      return textOf(child).trim();
    }
    const inner = texOf(child);
    if (inner) return inner;
  }
  return "";
}

/**
 * The text under `node`. Each formula is replaced by `formula(tex)`, its TeX source by default. A formula without a TeX
 * annotation gives its drawn text alone, never the screen-reader copy besides.
 */
export function renderedText(node: RenderedNode, formula: (tex: string) => string = (tex) => tex): string {
  if (node.nodeType === TEXT) return node.nodeValue ?? "";
  if (hasClass(node, "katex")) {
    const tex = texOf(node);
    if (tex) return formula(tex);
    const drawn = Array.from(node.childNodes).find((child) => hasClass(child, "katex-html"));
    return drawn ? textOf(drawn) : "";
  }
  return Array.from(node.childNodes)
    .map((child) => renderedText(child, formula))
    .join("");
}

/**
 * How many words a student reads in `node`. A formula counts as one word, whatever its length: it is read as one unit
 * in the line, and counting its TeX symbols would charge a long formula as if it were prose.
 */
export function wordCount(node: RenderedNode): number {
  return renderedText(node, () => "x").split(/\s+/).filter(Boolean).length;
}
