import { createElement, Fragment, useContext } from "react";
import ReactMarkdown from "react-markdown";
import { normalizeMathDelimiters } from "../../../shared/math-delimiters";
import { linkCitations } from "../markdown/citations";
import { KnownPassages } from "../markdown/knownPassages";
import { inlineRemarkPlugins, rehypePlugins } from "../markdown/plugins";

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
  // Inside a page that knows its passages (a lesson part's options and titles), a known mark goes, as in its text: the
  // sources row names it. Its link is not inline content, so it is unwrapped to nothing.
  const known = useContext(KnownPassages);
  const text = known ? linkCitations(children, known) : children;
  return createElement(
    "span",
    { className: "px-markdown is-body" },
    createElement(
      ReactMarkdown,
      {
        remarkPlugins: inlineRemarkPlugins,
        rehypePlugins,
        skipHtml: true,
        disallowedElements: NOT_INLINE,
        unwrapDisallowed: true,
        components: {
          p: ({ children: inner }) => createElement(Fragment, null, inner, " "),
        },
      },
      normalizeMathDelimiters(text),
    ),
  );
}
