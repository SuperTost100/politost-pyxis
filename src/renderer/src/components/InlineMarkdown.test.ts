import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { KnownPassages } from "../markdown/knownPassages";
import { InlineMarkdown } from "./InlineMarkdown";

const draw = (text: string, known?: (n: number) => boolean) =>
  renderToStaticMarkup(
    known
      ? createElement(KnownPassages.Provider, { value: known }, createElement(InlineMarkdown, null, text))
      : createElement(InlineMarkdown, null, text),
  ).replace(/<[^>]+>/g, "");

describe("InlineMarkdown and citation marks", () => {
  it("hides a known passage's mark, as a block's own text inside a lesson does", () => {
    expect(draw("Un esempio con il disco [P1].", (n) => n === 1)).toBe("Un esempio con il disco. ");
  });

  it("shows a stored text's [P1] as written where no passages are known", () => {
    expect(draw("Etichetta [P1].")).toBe("Etichetta [P1]. ");
  });
});
