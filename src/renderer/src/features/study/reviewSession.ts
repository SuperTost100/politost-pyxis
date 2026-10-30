/** The query key of a plan's stored Review. */
export function reviewSessionKey(planId: string | undefined) {
  return ["review-session", planId] as const;
}

/**
 * A page outside a Review reads none. A query that is off still answers from the cache, so a diagnostic opened after
 * a Review would otherwise count that Review's pending drill questions as its own.
 */
export function ownReview<T extends { data?: unknown }>(enabled: boolean, result: T): T {
  return enabled ? result : { ...result, data: undefined };
}
