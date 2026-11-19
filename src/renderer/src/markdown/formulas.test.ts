import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import { describe, expect, it } from "vitest";
import { normalizeMathDelimiters } from "../../../shared/math-delimiters";
import corpus from "./formula-corpus.json";
import { inlineRemarkPlugins, remarkPlugins, rehypePlugins } from "./plugins";
import { markdownSource } from "./source";

/**
 * The answers of the four AI tools (Claude Haiku and Sonnet, ChatGPT Luna and Terra, Cursor Grok, Gemini Hydrogen and
 * Argon) to the same course material, recorded on 2026-11-19: the texts that drew an error or showed a formula as text,
 * and the most formula-heavy text of every place the app shows AI text. Every formula goes through the pipeline the
 * views use, so a change that breaks one of them fails here.
 */
type Entry = {
  id: string;
  tool: string;
  lang: string;
  place: string;
  /** Drawn like a quiz option or a caption: in a button or a label, with no `displayMathLines`. */
  inline: boolean;
  /** The formulas remark-math finds in the text as the renderer prepares it. */
  formulas: number;
  /** Dollar signs left in the text around them: prices. */
  dollars: number;
  /** Formulas KaTeX cannot draw even so (a typo of the model's). */
  undrawable: number;
  text: string;
};
const entries = corpus.texts as Entry[];

function render(text: string, inline: boolean, writing = false): string {
  return renderToStaticMarkup(
    createElement(
      ReactMarkdown,
      {
        remarkPlugins: inline ? inlineRemarkPlugins : remarkPlugins,
        rehypePlugins,
        skipHtml: true,
      },
      inline ? normalizeMathDelimiters(text) : markdownSource(text, undefined, writing),
    ),
  );
}

/** `html` without the elements that start with `open` (and everything in them, up to their closing tag). */
function without(html: string, open: string, tag: "span" | "pre" | "code"): string {
  let out = "";
  let at = 0;
  for (;;) {
    const start = html.indexOf(open, at);
    if (start === -1) return out + html.slice(at);
    out += html.slice(at, start);
    let depth = 0;
    let cursor = start;
    do {
      const next = html.slice(cursor).search(new RegExp(`<(/?)${tag}[ >]`));
      const close = next >= 0 && html.slice(cursor + next).startsWith(`</${tag}`);
      if (next < 0) return out;
      depth += close ? -1 : 1;
      cursor += next + tag.length + 2;
    } while (depth > 0);
    at = cursor;
  }
}

/** What a reader sees as plain text: no formula, no code, no tag. */
function visibleText(html: string): string {
  let text = html;
  for (const open of ['<span class="katex-display"', '<span class="katex"', '<span class="px-formula-source']) {
    text = without(text, open, "span");
  }
  text = without(text, "<pre", "pre");
  text = without(text, "<code", "code");
  return text.replace(/<[^>]+>/g, "");
}

const drawn = (html: string) => html.split('<span class="katex">').length - 1;
const undrawn = (html: string) => html.split("px-formula-source").length - 1;

describe("the corpus of recorded AI answers", () => {
  it("is a real corpus", () => {
    expect(entries.length).toBeGreaterThan(60);
    expect(new Set(entries.map((entry) => entry.tool))).toEqual(new Set(["claude", "codex", "agent", "antigravity"]));
    expect(new Set(entries.map((entry) => entry.lang))).toEqual(new Set(["it", "en"]));
    expect(entries.reduce((sum, entry) => sum + entry.formulas, 0)).toBeGreaterThan(600);
  });

  it.each(entries.map((entry) => [entry.id, entry] as const))("%s draws every formula it has", (_id, entry) => {
    const html = render(entry.text, entry.inline);
    expect(html).not.toContain("katex-error");
    expect(html).not.toContain("cc0000");
    expect(undrawn(html)).toBe(entry.undrawable);
    expect(drawn(html)).toBe(entry.formulas - entry.undrawable);
    // Nothing is left as text: no backslash command, no dollar sign but the prices.
    const text = visibleText(html);
    expect(text.match(/\\[A-Za-z]{2,}/g) ?? []).toEqual([]);
    expect((text.match(/\$/g) ?? []).length).toBe(entry.dollars);
  });
});

describe("a formula KaTeX cannot draw", () => {
  it("shows its source in the text's own colour, never in an error colour", () => {
    // A parse error (an open brace) and an unknown command, which KaTeX draws with that command in red.
    for (const [text, source] of [
      ["Vale $\\frac{1}{$ qui", "\\frac{1}{"],
      ["Vale $a \\badcommand b$ qui", "a \\badcommand b"],
    ] as const) {
      const html = render(text, false);
      expect(html).toContain(`<span class="px-formula-source">${source}</span>`);
      expect(html).not.toContain("katex-error");
      expect(html).not.toContain("cc0000");
    }
  });

  it("does so for a display formula too, and keeps the dollar sign it was written with", () => {
    // An unknown command, which KaTeX draws in red, and an open brace, which it refuses.
    for (const body of ["\\badcommand + 25\\ \\$", "\\frac{1}{ + 25\\ \\$"]) {
      const html = render(`Prima\n\n$$\n${body}\n$$\n\nDopo`, false);
      expect(html).toContain(`<span class="px-formula-source is-display">${body}</span>`);
      expect(html).not.toContain("cc0000");
    }
  });

  it("leaves the formulas around it drawn", () => {
    const html = render("$x^2$ e $\\badcommand$ e $y^2$", false);
    expect(drawn(html)).toBe(2);
    expect(undrawn(html)).toBe(1);
  });
});

describe("an answer that is still being written", () => {
  // Claude's chat answer (display formulas on their own lines, a price), ChatGPT's (formulas in \( \) and \[ \]), a
  // lesson part of ChatGPT's (display formulas that share the $$ line with their first and last line).
  const written = ["claude-it-chat-answer", "codex-it-chat-answer", "codex-en-lesson-prose"].map((id) => {
    const entry = entries.find((item) => item.id.startsWith(id));
    expect(entry, id).toBeDefined();
    return [id, entry!] as const;
  });

  it.each(written)("%s never shows half a formula as source or as an error, at any length", { timeout: 30_000 }, (_id, entry) => {
    const text = entry.text.slice(0, 2400);
    // A prefix every 11 characters, which cuts the answer inside every formula and most delimiters.
    for (let end = 12; end < text.length; end += 11) {
      const html = render(text.slice(0, end), false, true);
      expect(html, `at ${end}`).not.toContain("katex-error");
      expect(html, `at ${end}`).not.toContain("cc0000");
      expect(undrawn(html), `at ${end}`).toBe(0);
      const visible = visibleText(html);
      expect(visible.match(/\\[A-Za-z]{2,}/g) ?? [], `at ${end}`).toEqual([]);
      // A price in the answer is the only dollar sign a reader may see.
      expect((visible.match(/\$/g) ?? []).length, `at ${end}`).toBeLessThanOrEqual(entry.dollars);
    }
  });

  it("shows the whole text when it is finished", () => {
    const entry = written[0]![1];
    expect(render(entry.text, false, true)).toBe(render(entry.text, false, false));
  });
});
