import { Fragment } from "react";
import { typedParts } from "../../../shared/math-delimiters";
import { InlineMarkdown } from "./InlineMarkdown";
import "./TypedText.css";

/**
 * Text a student wrote, shown as they wrote it: line breaks, asterisks, underscores and all. Only the `$…$` formulas from
 * the math field are drawn as math. Model text goes through `MarkdownView` or `InlineMarkdown` instead.
 */
export function TypedText({ children }: { children: string }) {
  return (
    <span className="px-typed">
      {typedParts(children).map((part, index) =>
        part.math ? <InlineMarkdown key={index}>{part.text}</InlineMarkdown> : <Fragment key={index}>{part.text}</Fragment>,
      )}
    </span>
  );
}
