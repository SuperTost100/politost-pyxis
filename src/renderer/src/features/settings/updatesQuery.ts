import type { QueryClient } from "@tanstack/react-query";
import type { UpdateView } from "../../../../shared/updates";
import { outbound } from "../../lib/queryClient";

/** A check that found out something stays fresh for a day; main limits how often GitHub is asked as well. */
export const UPDATES_FRESH_MS = 24 * 60 * 60 * 1000;

/**
 * The update check as a query. `takeForce` says whether the student pressed the button, which skips main's cache.
 *
 * A check that failed is never fresh: the connection coming back asks again. Main keeps a failed answer for 15 minutes
 * and gives it to any check that does not force, so a check made after a failure forces, which main allows once a minute.
 */
export function updatesQuery(client: QueryClient, check: (force: boolean) => Promise<UpdateView>, takeForce: () => boolean) {
  return {
    queryKey: ["updates"],
    queryFn: () => {
      const pressed = takeForce();
      return check(pressed || client.getQueryData<UpdateView>(["updates"])?.state === "failed");
    },
    ...outbound,
    retry: false,
    staleTime: (query: { state: { data?: UpdateView } }) => (query.state.data?.state === "failed" ? 0 : UPDATES_FRESH_MS),
  };
}
