import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import { describe, expect, it } from "vitest";
import { fencedChecks, stripCheckFences } from "../../../shared/math-check";
import { drawn, visibleText } from "./formulaTestKit";
import { remarkPlugins, rehypePlugins } from "./plugins";
import { markdownSource } from "./source";

/** A chat answer as `MarkdownView` draws it: its check blocks taken out and a marker after each checked step. */
function view(body: string, writing = false): string {
  const steps = fencedChecks(body).map((check) => check.step);
  const source = markdownSource(
    stripCheckFences(body),
    undefined,
    writing,
    steps,
  );
  return renderToStaticMarkup(
    createElement(
      ReactMarkdown,
      { remarkPlugins, rehypePlugins, skipHtml: true },
      source,
    ),
  );
}

describe("a chat answer with its check and figure blocks inside list items", () => {
  // Gemini, a chat answer: the blocks indented under the numbered steps they belong to.
  const answer = (indent: string) =>
    [
      "1. **Forze sul piano.** La componente lungo il piano è $mg\\sin\\theta$.",
      "",
      `${indent}\`\`\`check`,
      `${indent}{"kind":"equal","expr":"m*g*sin(theta)","claimed":"m*a","vars":["m","g","theta","a"]}`,
      `${indent}\`\`\``,
      "",
      "2. **Accelerazione.** Quindi $a = g\\sin\\theta$.",
      "",
      `${indent}\`\`\`pyxis-figure`,
      `${indent}{"kind":"plot","caption":"Il piano inclinato","code":"plt.plot([0, 1], [0, 1])"}`,
      `${indent}\`\`\``,
      "",
      "3. **Risultato.** Con $\\theta = 30^\\circ$ si ha $a = g/2$.",
    ].join("\n");

  it.each(["  ", "   ", "    ", "      ", "\t"])(
    "is one list with its formulas drawn, with %j before the fences",
    (indent) => {
      const html = view(answer(indent));
      expect(html.match(/<ol/g)).toHaveLength(1);
      expect(html.match(/<li/g)).toHaveLength(3);
      expect(html.match(/<strong>/g)).toHaveLength(3);
      expect(drawn(html)).toBe(4);
      // The check is a marker in its step, the figure is a figure block, and nothing else is code.
      expect(html.match(/>check<\/a>/g)).toHaveLength(1);
      expect(html.match(/<pre/g)).toHaveLength(1);
      expect(html).toContain('class="language-pyxis-figure"');
      expect(visibleText(html)).not.toMatch(/[$`*]|kind/);
    },
  );

  it("hides a check block still open at the end of a streamed answer and keeps the steps before it", () => {
    const cut = answer("   ").slice(0, answer("   ").indexOf('"claimed"'));
    const html = view(cut, true);
    expect(html.match(/<li/g)).toHaveLength(1);
    expect(drawn(html)).toBe(1);
    expect(html).not.toContain("<pre");
    expect(visibleText(html)).not.toMatch(/[$`]|kind/);
  });
});

describe("citation marks are hidden only where the page knows its passages", () => {
  it("leaves a stored text's literal [P1] as written when no passages are given", () => {
    expect(markdownSource("Label [P1].")).toBe("Label [P1].");
  });

  it("turns a known mark into an anchor when the page gives its passages", () => {
    expect(markdownSource("Label [P1].", (n) => n === 1)).toBe("Label[](cite:p1).");
  });
});
