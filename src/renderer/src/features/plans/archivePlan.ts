import type { QueryClient } from "@tanstack/react-query";
import { invoke } from "../../lib/ipc";
import { refreshPlan } from "../../lib/refreshPlan";

/** Archives or restores a plan. That changes what every review queue, count and card list shows, so they all read again. */
export async function setPlanArchived(client: QueryClient, planId: string, archived: boolean) {
  await invoke("plans.archive", { planId, archived });
  await Promise.all([
    refreshPlan(client, planId),
    ...["card-browse", "cards", "card-queue", "review-session"].map((key) =>
      client.invalidateQueries({ queryKey: [key] }),
    ),
  ]);
}
