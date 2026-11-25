import rehypeKatex from "rehype-katex";
import remarkMath from "remark-math";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { unified } from "unified";
import { describe, expect, it } from "vitest";
import { rehypeMarks } from "./marks";

type Node = { type: string; tagName?: string; properties?: { className?: string[]; href?: string }; children?: Node[] };

/** The tree's elements as "tag.class" lines, indented by depth, without KaTeX's insides. */
async function shape(markdown: string): Promise<string[]> {
  const pipeline = unified().use(remarkParse).use(remarkMath).use(remarkRehype).use(rehypeKatex).use(rehypeMarks);
  const tree = (await pipeline.run(pipeline.parse(markdown))) as Node;
  const lines: string[] = [];
  const walk = (node: Node, depth: number) => {
    if (node.type !== "element") return;
    if (node.properties?.className?.includes("katex")) return;
    const classes = node.properties?.className?.filter((name) => name.startsWith("px-") || name.startsWith("is-") || name === "katex-display");
    lines.push(`${"  ".repeat(depth)}${node.tagName}${classes?.length ? `.${classes.join(".")}` : ""}${node.properties?.href ? ` ${node.properties.href}` : ""}`);
    if (!classes?.includes("katex-display")) node.children?.forEach((child) => walk(child, depth + 1));
  };
  (tree.children ?? []).forEach((child) => walk(child, 0));
  return lines;
}

describe("rehypeMarks", () => {
  it("puts a check beside the formula before it", async () => {
    expect(await shape("Quindi:\n\n$$\nx^2\n$$\n\n[check](mathcheck:0)\n\nFine.")).toEqual([
      "p",
      "div.px-checked.is-formula",
      "  span.katex-display",
      "  div.px-check-slot",
      "    a mathcheck:0",
      "p",
    ]);
  });

  it("puts a check beside a paragraph step, also inside a list item", async () => {
    expect(await shape("- La derivata è $x$.\n\n  [check](mathcheck:0)\n")).toEqual([
      "ul",
      "  li",
      "    div.px-checked.is-prose",
      "      p",
      "      div.px-check-slot",
      "        a mathcheck:0",
    ]);
  });

  it("hides a paragraph of marks and keeps it with the formula a check follows", async () => {
    expect(await shape("$$\ny\n$$\n\n[](cite:p1)\n\n[check](mathcheck:0)")).toEqual([
      "div.px-checked.is-formula",
      "  span.katex-display",
      "  p.px-cite-only",
      "    a cite:p1",
      "  div.px-check-slot",
      "    a mathcheck:0",
    ]);
  });

  it("leaves a check with no step before it on its own", async () => {
    expect(await shape("[check](mathcheck:0)")).toEqual(["div.px-check-slot", "  a mathcheck:0"]);
  });
});
