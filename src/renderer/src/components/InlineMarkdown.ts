import { createElement, Fragment, useContext } from "react";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import { normalizeMathDelimiters } from "../../../shared/math-delimiters";
import { citedPassage, linkCitations } from "../markdown/citations";
import { KnownPassages } from "../markdown/knownPassages";
import { inlineRemarkPlugins, rehypePlugins } from "../markdown/plugins";

// Everything a button or label cannot hold: blocks, images, controls. Links are unwrapped below so known citation marks
// still leave their invisible anchor span for the sources row to tint.
const NOT_INLINE = [
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

const urlTransform = (url: string) => (/^cite:p\d+$/.test(url) ? url : defaultUrlTransform(url));

/**
 * Markdown with math for places that only allow phrasing content, such as a quiz option inside a button. Links and blocks keep their text and lose their markup.
 * It is a .ts file (no JSX) so the node-side typecheck and test can load it, like `pythonRun.ts`.
 */
export function InlineMarkdown({ children }: { children: string }) {
  // Inside a page that knows its passages (a lesson part's options and titles), a known mark becomes the same invisible
  // anchor span as in MarkdownView, so pointing at a source tints its words too. Ordinary links keep their text only.
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
        urlTransform,
        disallowedElements: NOT_INLINE,
        unwrapDisallowed: true,
        components: {
          a: ({ href, children: inner }) => {
            const id = known ? citedPassage(href, known) : null;
            if (id !== null) return createElement("span", { className: "px-cite-mark", "data-cite": id });
            return createElement(Fragment, null, inner);
          },
          p: ({ children: inner }) => createElement(Fragment, null, inner, " "),
        },
      },
      normalizeMathDelimiters(text),
    ),
  );
}
