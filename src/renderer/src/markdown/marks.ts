/**
 * After KaTeX, for the Markdown view: a step's math check goes beside the step it checks, and a paragraph that holds
 * nothing but citation marks (a mark the model put on its own line after a formula) is hidden, so it leaves no gap.
 */

type HastNode = {
  type: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
  value?: string;
};

const hrefOf = (node: HastNode) => (node.type === "element" && node.tagName === "a" ? String(node.properties?.["href"] ?? "") : "");
const blank = (node: HastNode) => node.type === "text" && !(node.value ?? "").trim();
/**
 * Text with no word in it: spaces, and the punctuation a model leaves after a mark on its own line ("[P1]."). A symbol,
 * such as an infinity, is an answer and keeps its paragraph.
 */
const noWords = (node: HastNode) => node.type === "text" && /^[\s\p{P}]*$/u.test(node.value ?? "");

/**
 * A paragraph whose only content is links whose href starts with `prefix`, and spaces. A paragraph of citation marks may
 * also hold punctuation, which goes with it.
 */
function onlyLinks(node: HastNode, prefix: string): boolean {
  if (node.type !== "element" || node.tagName !== "p" || !node.children?.length) return false;
  const filler = prefix === "cite:" ? noWords : blank;
  return (
    node.children.every((child) => filler(child) || hrefOf(child).startsWith(prefix)) &&
    node.children.some((child) => hrefOf(child).startsWith(prefix))
  );
}

function addClass(node: HastNode, name: string) {
  const classes = node.properties?.["className"];
  node.properties = { ...node.properties, className: [...(Array.isArray(classes) ? classes : []), name] };
}

function visit(parent: HastNode) {
  const children = parent.children;
  if (!children) return;
  for (let index = 0; index < children.length; index++) {
    const child = children[index]!;
    if (onlyLinks(child, "cite:")) {
      addClass(child, "px-cite-only");
      continue;
    }
    if (onlyLinks(child, "mathcheck:")) {
      // The step is the block before the marker: a formula on its own line, or the paragraph that ends with the step.
      let before = index - 1;
      while (before >= 0 && (blank(children[before]!) || (children[before]!.properties?.["className"] as unknown[] | undefined)?.includes("px-cite-only")))
        before--;
      const slot: HastNode = {
        type: "element",
        tagName: "div",
        properties: { className: ["px-check-slot"] },
        children: (child.children ?? []).filter((link) => !blank(link)),
      };
      const step = before >= 0 && children[before]!.type === "element" ? children[before]! : null;
      if (!step) {
        children[index] = slot;
        continue;
      }
      const display = (step.properties?.["className"] as unknown[] | undefined)?.includes("katex-display");
      const wrap: HastNode = {
        type: "element",
        tagName: "div",
        properties: { className: ["px-checked", display ? "is-formula" : "is-prose"] },
        // A hidden paragraph of marks between the step and its check stays, so its marks still find their words.
        children: [step, ...children.slice(before + 1, index).filter((node) => !blank(node)), slot],
      };
      children.splice(before, index - before + 1, wrap);
      index = before;
      continue;
    }
    visit(child);
  }
}

export function rehypeMarks() {
  return (tree: HastNode) => visit(tree);
}
