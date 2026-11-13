import { parseHTML } from "linkedom";
import { describe, expect, it } from "vitest";
import { dropCitationChips } from "./citationChips";

/** The text a selection keeps once its citation chips are dropped, for the HTML a lesson draws. */
function kept(html: string): string {
  const { document } = parseHTML(`<html><body><div>${html}</div></body></html>`);
  const holder = document.body.firstElementChild!;
  dropCitationChips(holder as unknown as Parameters<typeof dropCitationChips>[0]);
  return holder.textContent!;
}
const chip = '<button class="px-cite">1. Dinamica</button>';
const formula = '<span class="katex">x</span>';

describe("dropCitationChips", () => {
  it("drops the chip and the space before it when plain text follows", () => {
    expect(kept(`uno ${chip} due`)).toBe("uno due");
    expect(kept(`uno ${chip}due`)).toBe("uno due");
  });

  it("keeps the space between a word and an emphasised word that follows the chip", () => {
    expect(kept(`uno ${chip}<em>due</em>`)).toBe("uno due");
    expect(kept(`uno ${chip}<em><strong>due</strong></em> tre`)).toBe("uno due tre");
  });

  it("keeps the space before a formula that follows the chip", () => {
    expect(kept(`uno ${chip}${formula}`)).toBe("uno x");
    expect(kept(`uno ${chip}${formula} due`)).toBe("uno x due");
  });

  it("closes the gap before punctuation, also through an inline element", () => {
    expect(kept(`uno ${chip}, due`)).toBe("uno, due");
    expect(kept(`uno ${chip}<em>, due</em>`)).toBe("uno, due");
    expect(kept(`uno ${chip}.`)).toBe("uno.");
  });

  it("drops the space before a chip at the end", () => {
    expect(kept(`uno ${chip}`)).toBe("uno");
    expect(kept(`uno <em>due </em>${chip}`)).toBe("uno due");
  });

  it("drops two chips in a row as one", () => {
    expect(kept(`uno ${chip}${chip} due`)).toBe("uno due");
    expect(kept(`uno ${chip}${chip}, due`)).toBe("uno, due");
    expect(kept(`uno ${chip} ${chip}<em>due</em>`)).toBe("uno due");
  });

  it("leaves a formula before the chip as it is", () => {
    expect(kept(`${formula} ${chip}<em>due</em>`)).toBe("x due");
    expect(kept(`${formula}${chip}, due`)).toBe("x, due");
  });

  it("leaves a chip at the start with only the text after it", () => {
    expect(kept(`${chip}uno`)).toBe("uno");
    expect(kept(`${chip} uno`).trim()).toBe("uno");
  });
});
