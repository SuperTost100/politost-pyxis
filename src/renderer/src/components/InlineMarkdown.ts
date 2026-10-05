import { createElement, Fragment } from "react";
import ReactMarkdown from "react-markdown";
import rehypeKatex from "rehype-katex";
import remarkMath from "remark-math";
import "katex/dist/katex.min.css";
import "katex/contrib/mhchem";
import { normalizeMathDelimiters } from "../markdown/normalizeMathDelimiters";

// Everything a button or label cannot hold: blocks, links, images, controls.
const NOT_INLINE = [
  "a",
  "blockquote",
  "button",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "hr",
  "img",
  "input",
  "li",
  "ol",
  "pre",
  "table",
  "tbody",
  "td",
  "th",
  "thead",
  "tr",
  "ul",
];

/**
 * Markdown with math for places that only allow phrasing content, such as a quiz option inside a button. Links and blocks keep their text and lose their markup.
 * It is a .ts file (no JSX) so the node-side typecheck and test can load it, like `pythonRun.ts`.
 */
export function InlineMarkdown({ children }: { children: string }) {
  return createElement(
    "span",
    { className: "px-markdown is-body" },
    createElement(
      ReactMarkdown,
      {
        remarkPlugins: [remarkMath],
        rehypePlugins: [rehypeKatex],
        skipHtml: true,
        disallowedElements: NOT_INLINE,
        unwrapDisallowed: true,
        components: {
          p: ({ children: inner }) => createElement(Fragment, null, inner, " "),
        },
      },
      normalizeMathDelimiters(children),
    ),
  );
}
