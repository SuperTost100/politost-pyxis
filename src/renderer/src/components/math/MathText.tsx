import katex from "katex";
import { useMemo } from "react";
import { parseMathText } from "./mathString";
import "katex/dist/katex.min.css";
import "./MathText.css";

/** A message as the student wrote it: plain text with its `$...$` formulas rendered. */
export function MathText({ text }: { text: string }) {
  const parts = useMemo(
    () =>
      parseMathText(text).map((segment) => {
        if (segment.kind === "text") return { text: segment.text };
        try {
          return {
            html: katex.renderToString(segment.latex, {
              throwOnError: true,
              displayMode: segment.display === true,
              strict: "ignore",
            }),
          };
        } catch {
          const fence = segment.display ? "$$" : "$";
          return { text: `${fence}${segment.latex}${fence}` };
        }
      }),
    [text],
  );
  return (
    <span className="px-mathtext-view">
      {parts.map((part, index) =>
        part.html === undefined ? (
          part.text
        ) : (
          <span key={index} dangerouslySetInnerHTML={{ __html: part.html }} />
        ),
      )}
    </span>
  );
}
