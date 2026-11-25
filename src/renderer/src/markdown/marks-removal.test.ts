import { describe, expect, it } from "vitest";
import { stripPassageRefsOutsideCode } from "../../../shared/smart-text";
import { parseMarkdown, walk, type MdNode } from "../../../shared/markdown-tree";
import chatFixtures from "../../../../tests/fixtures/chat-conversations.json";
import { SOURCES_ANSWER, SOURCES_LESSON } from "../../../../tests/e2e/chat-look-seed";
import { partText, recapText } from "../../../../tests/e2e/part-texts";
import corpus from "./formula-corpus.json";
import { linkCitations } from "./citations";

/**
 * Removing citation marks, for the view (`linkCitations`) and for an export (`stripPassageRefsOutsideCode`), must leave the
 * Markdown as it was: the same blocks in the same order, and a text with no mark exactly as written. The texts are the
 * recorded answers and lessons of the formula corpus, the chat fixtures and the e2e lessons; each is also read with marks
 * added where a model puts them, after a sentence and at the start of a list item.
 */

const BLOCKS = new Set(["paragraph", "heading", "list", "listItem", "code", "math", "blockquote", "table", "thematicBreak", "html"]);

/** The blocks of a text in order, without paragraphs that hold nothing but marks or empty links (which a removal drops). */
function blocks(text: string): string[] {
  const found: string[] = [];
  walk(parseMarkdown(text), (node: MdNode) => {
    if (!BLOCKS.has(node.type)) return;
    if (node.type === "paragraph") {
      const words = (node.children ?? []).some((child) => child.type !== "link" && !/^[\s[\]P\d,;]*$/.test(child.value ?? ""));
      if (!words) return false;
    }
    found.push(node.type === "list" ? `list:${(node as { ordered?: boolean }).ordered ? "ol" : "ul"}` : node.type);
  });
  return found;
}

const strings = (value: unknown): string[] =>
  typeof value === "string" ? [value] : Array.isArray(value) ? value.flatMap(strings) : value && typeof value === "object" ? Object.values(value).flatMap(strings) : [];

const texts = [
  ...(corpus as { texts: Array<{ text: string }> }).texts.map((entry) => entry.text),
  ...strings((chatFixtures as { conversations: unknown }).conversations).filter((text) => text.length > 40),
  partText("Limiti"),
  recapText,
  SOURCES_ANSWER("$$h = 2$$"),
  SOURCES_LESSON,
  "- ![Diagramma](diagram.png)\n- Una voce .\n\n1. Uno ;\n2. Due",
];

/** The text with marks where a model writes them: after each sentence, and at the start of each list item. */
function marked(text: string): string {
  let n = 0;
  const mark = () => `[P${(n++ % 9) + 1}]`;
  return text
    .split("\n")
    .map((line) => {
      if (/^\s*(```|~~~|\$\$|\|)/.test(line) || /^\s{4,}/.test(line)) return line;
      return line
        .replace(/^(\s*(?:[-*+]|\d+[.)])\s+)(?=\S)/, (lead) => `${lead}${mark()} `)
        .replace(/([a-zàèéìòù])\.(?=\s|$)/g, (_, letter: string) => `${letter} ${mark()}, ${mark()}.`);
    })
    .join("\n");
}

describe("removing citation marks", () => {
  it("leaves a text with no mark exactly as written", () => {
    for (const text of texts.filter((value) => !/\[P\d/.test(value))) {
      expect(stripPassageRefsOutsideCode(text), text.slice(0, 80)).toBe(text);
      expect(linkCitations(text, () => true), text.slice(0, 80)).toBe(text);
    }
  });

  it("keeps the blocks of a text in their order, for the view and for an export", () => {
    let checked = 0;
    for (const text of texts) {
      const withMarks = marked(text);
      if (withMarks === text) continue;
      checked++;
      const expected = blocks(text);
      expect(blocks(linkCitations(withMarks, () => true)), withMarks.slice(0, 120)).toEqual(expected);
      expect(blocks(stripPassageRefsOutsideCode(withMarks)), withMarks.slice(0, 120)).toEqual(expected);
    }
    expect(checked).toBeGreaterThan(40);
  });

  it("keeps the space after a list marker and the indentation of a mark on its own line", () => {
    expect(linkCitations("- [P1] Vedi l'originale.", () => true)).toBe("- [](cite:p1) Vedi l'originale.");
    expect(stripPassageRefsOutsideCode("- [P1] Vedi l'originale.")).toBe("- Vedi l'originale.");
    expect(stripPassageRefsOutsideCode("1. [P1], [P2] Primo.\n> [P3] Citato.")).toBe("1. Primo.\n> Citato.");
  });

  it("touches no space that is not next to a mark", () => {
    expect(stripPassageRefsOutsideCode("- ![Diagramma](diagram.png)\nVale ; poi .")).toBe("- ![Diagramma](diagram.png)\nVale ; poi .");
    expect(stripPassageRefsOutsideCode("Vale [P1], [P2]. Poi")).toBe("Vale. Poi");
  });
});
