import { useMemo } from "react";
import { citedOrder } from "../lib/sourcePlaces";
import { usePassagePlaces } from "../lib/passagePlaces";
import { textClaims } from "../lib/mathChecks";
import { MarkdownView } from "./MarkdownView";
import { SourcesRow } from "./SourcesRow";

/**
 * A short text that cites passages by their ids, such as a quiz explanation: the text without marks, and the sources row
 * under it. [Pn] is `citations[n - 1]`.
 */
export function CitedText({
  children,
  citations,
  variant = "body",
}: {
  children: string;
  citations: ReadonlyArray<{ passageId: string; label?: string }>;
  variant?: "body" | "reading";
}) {
  const places = usePassagePlaces(citations);
  const order = useMemo(() => citedOrder(children), [children]);
  const claims = useMemo(() => textClaims(children), [children]);
  const count = citations.length;
  const knownPassage = useMemo(() => (n: number) => n >= 1 && n <= count, [count]);
  return (
    <div className="px-cited-text" data-cited-host>
      <MarkdownView variant={variant} knownPassage={knownPassage}>
        {children}
      </MarkdownView>
      <SourcesRow places={places} order={order} claims={claims} variant="body" />
    </div>
  );
}
