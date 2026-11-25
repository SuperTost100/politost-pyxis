import { useQueries } from "@tanstack/react-query";
import { anchoredChecks, fencedChecks, type AnchoredCheck, type MathCheck } from "@shared/math-check";
import { parseSmartText } from "@shared/smart-text";
import { invoke } from "./ipc";
import type { CheckTally } from "./sourcePlaces";

/** One claim's check. The formula's mark and the sources row ask with the same key, so the check runs once. */
export function checkQuery({ kind, expr, claimed, vars }: MathCheck) {
  const input = { kind, expr, claimed, vars };
  return {
    queryKey: ["math-check", input],
    queryFn: () => invoke("tools.check", input),
    retry: false,
    staleTime: 60000,
  } as const;
}

/** The claims a Markdown text checks, as its view draws them: the ones stored with it, or its ```check blocks. */
export function textClaims(markdown: string, stored?: AnchoredCheck[]): AnchoredCheck[] {
  return anchoredChecks(markdown, stored ?? fencedChecks(markdown));
}

/** The claims of a lesson's smart text, one Markdown part at a time, as SmartText draws them. */
export function smartClaims(markdown: string): AnchoredCheck[] {
  return parseSmartText(markdown).flatMap((segment) => (segment.type === "markdown" ? textClaims(segment.text) : []));
}

/** What the checks of `claims` came to. A check that failed to run says nothing, like one the checker cannot evaluate. */
export function useCheckTally(claims: readonly MathCheck[]): CheckTally {
  const results = useQueries({ queries: claims.map(checkQuery) });
  const states = results.map((result) => (result.isPending ? "pending" : (result.data?.state ?? "none")));
  return {
    verified: states.filter((state) => state === "verified").length,
    failed: states.filter((state) => state === "failed").length,
    pending: states.filter((state) => state === "pending").length,
  };
}
