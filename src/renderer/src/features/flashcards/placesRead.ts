import type { QueryClient, QueryKey } from "@tanstack/react-query";

/** A query that can be read ahead: its key, its read, and how long a read counts as the state of the workspace. */
export type AheadQuery<T> = { queryKey: QueryKey; queryFn: () => Promise<T>; staleTime: number };

/**
 * Reads before anything asks: on a page that opens a dialog (with `staleTime` 0, so what changed elsewhere is read again
 * whatever was read a moment ago), and when the pointer or the focus reaches the button that opens it. A read still
 * fresh is not made again, and a change that saves marks it stale (`invalidateQueries`).
 */
export function readAhead<T>(client: QueryClient, query: AheadQuery<T>, staleTime = query.staleTime): void {
  void client.prefetchQuery({ ...query, staleTime });
}

/**
 * Calls `open` once the read is there, so what the dialog opens on is known when it opens. A fresh read is there already:
 * `open` runs in the same step, with the click. Otherwise the read is made and `open` waits for it, up to `limit`
 * milliseconds (and for good if it fails), so a slow read never holds the dialog back; the dialog copes with opening
 * before it arrives.
 */
export function whenRead<T>(client: QueryClient, query: AheadQuery<T>, open: () => void, limit = 250): void {
  const read = client.getQueryCache().find({ queryKey: query.queryKey });
  if (read && !read.isStaleByTime(query.staleTime)) return open();
  let opened = false;
  const go = () => {
    if (opened) return;
    opened = true;
    clearTimeout(timer);
    open();
  };
  const timer = setTimeout(go, limit);
  client.fetchQuery(query).then(go, go);
}
