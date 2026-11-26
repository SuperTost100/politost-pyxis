import { useMemo } from "react";
import { formulaHtml } from "../../markdown/formulaHtml";
import { parseDisplayMath } from "./displayMath";
import "katex/dist/katex.min.css";
import "./MathText.css";

/** A message or written answer as the student wrote it: plain text with its formulas drawn. */
export function MathText({ text }: { text: string }) {
  const parts = useMemo(
    () =>
      parseDisplayMath(text).map((segment) => {
        if (segment.kind === "text") return { text: segment.text };
        return {
          html: formulaHtml(segment.latex, { displayMode: segment.display === true, strict: "ignore" }),
        };
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
