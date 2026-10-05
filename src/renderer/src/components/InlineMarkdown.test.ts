import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { InlineMarkdown } from "./InlineMarkdown";

const render = (markdown: string) =>
  renderToStaticMarkup(createElement(InlineMarkdown, null, markdown));

describe("InlineMarkdown", () => {
  it("keeps inline math and emphasis", () => {
    const html = render("La derivata è $x^2$ e **non** $\\frac{1}{2}$");
    expect(html).toContain("katex");
    expect(html).toContain("<strong>non</strong>");
  });

  it("emits no block or interactive markup a button cannot hold", () => {
    const html = render(
      "Vedi [la regola](https://example.test) [P1]\n\n- uno\n- due\n\n```python\nprint(1)\n```\n\n![x](https://example.test/x.png)\n\n<div>html</div>",
    );
    for (const tag of ["<a ", "<ul", "<li", "<pre", "<img", "<div", "<p>", "<p "])
      expect(html, tag).not.toContain(tag);
    expect(html).toContain("la regola");
    expect(html).toContain("print(1)");
  });
});
