import type { QueryClient } from "@tanstack/react-query";

/**
 * After a step is done or a rating saved: each plan's path, its next step, its progress chart and its dates, and the
 * exam list that sums the plans up. Only the plans named are read again.
 */
export function refreshPlan(
  client: Pick<QueryClient, "invalidateQueries">,
  ...planIds: string[]
): Promise<unknown> {
  return Promise.all([
    client.invalidateQueries({ queryKey: ["plans"] }),
    ...[...new Set(planIds)].flatMap((planId) =>
      ["plan", "recommend", "series", "schedule"].map((key) =>
        client.invalidateQueries({ queryKey: [key, planId] }),
      ),
    ),
  ]);
}
