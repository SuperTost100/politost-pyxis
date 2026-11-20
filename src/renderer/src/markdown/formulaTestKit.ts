import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import { normalizeMathDelimiters } from "../../../shared/math-delimiters";
import { inlineRemarkPlugins, remarkPlugins, rehypePlugins } from "./plugins";
import { markdownSource } from "./source";

// What the formula tests share: a text drawn as a view draws it, and what a reader sees in the result.

export function render(text: string, inline: boolean, writing = false): string {
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
export function visibleText(html: string): string {
  let text = html;
  for (const open of ['<span class="katex-display"', '<span class="katex"', '<span class="px-formula-source']) {
    text = without(text, open, "span");
  }
  text = without(text, "<pre", "pre");
  text = without(text, "<code", "code");
  return text.replace(/<[^>]+>/g, "");
}

export const drawn = (html: string) => html.split('<span class="katex">').length - 1;
export const undrawn = (html: string) => html.split("px-formula-source").length - 1;

