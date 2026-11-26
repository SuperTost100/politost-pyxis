import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { KnownPassages } from "../markdown/knownPassages";
import { InlineMarkdown } from "./InlineMarkdown";

const render = (text: string, known?: (n: number) => boolean) =>
  renderToStaticMarkup(
    known
      ? createElement(KnownPassages.Provider, { value: known }, createElement(InlineMarkdown, null, text))
      : createElement(InlineMarkdown, null, text),
  );

const draw = (text: string, known?: (n: number) => boolean) => render(text, known).replace(/<[^>]+>/g, "");

describe("InlineMarkdown and citation marks", () => {
  it("hides a known passage's mark and keeps its anchor, as a block's own text inside a lesson does", () => {
    const html = render("Un esempio con il disco [P1].", (n) => n === 1);
    expect(html.replace(/<[^>]+>/g, "")).toBe("Un esempio con il disco. ");
    expect(html).toContain('<span class="px-cite-mark" data-cite="1"></span>');
  });

  it("unwraps ordinary links without rendering an anchor tag", () => {
    const html = render("Vedi [la nota](https://example.com) [P1].", (n) => n === 1);
    expect(html).not.toContain("<a ");
    expect(html.replace(/<[^>]+>/g, "")).toBe("Vedi la nota. ");
  });

  it("shows a stored text's [P1] as written where no passages are known", () => {
    expect(draw("Etichetta [P1].")).toBe("Etichetta [P1]. ");
  });
});
