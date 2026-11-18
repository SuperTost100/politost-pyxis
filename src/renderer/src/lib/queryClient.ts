import { QueryClient } from "@tanstack/react-query";

/**
 * The options for a read that goes out to the network (the free books catalog, a book's package, a provider's models, the
 * update check), over the client's defaults, which are made for data on this computer. It still asks at once when the
 * window is offline, so the handler's own "offline" error is what shows, and it asks again when the connection is back, so the
 * list recovers without the student leaving the page.
 */
export const outbound = { networkMode: "always", refetchOnReconnect: true } as const;

/** The app's query client: its defaults and the keys that are kept longer or shorter. */
export function createQueryClient(): QueryClient {
  // Every query and mutation reads or writes local data over IPC, so none waits for the network: with the default mode a
  // window "offline" event (a dropped Wi-Fi) paused all of them for good. A reconnect refetches nothing either, as a focus
  // does not: the data is kept fresh by invalidation, and some of it is costly to compute again (the exam list, Progress).
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, refetchOnWindowFocus: false, refetchOnReconnect: false, networkMode: "always" },
      mutations: { networkMode: "always" },
    },
  });
  // The exam list, a plan and its Progress tab are costly to compute. They stay fresh for 30 s unless a change marks
  // them stale: a finished job, a study write (the `plans.evidence` broadcast) or an explicit invalidation.
  for (const key of ["plans", "plan", "series"]) client.setQueryDefaults([key], { staleTime: 30_000 });
  // A long chat or lesson is a lot of text and math. Its data goes 30 s after leaving it, not after the default 5 minutes.
  for (const key of ["chat", "lesson"]) client.setQueryDefaults([key], { gcTime: 30_000 });
  return client;
}
