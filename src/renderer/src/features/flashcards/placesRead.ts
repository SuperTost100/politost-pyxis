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

/** The activation of each read that counts, by client and read: the others that are waiting have been replaced. */
const latest = new WeakMap<QueryClient, Map<string, object>>();

/**
 * Calls `open` once the read is there, so what the dialog opens on is known when it opens. A fresh read that nothing is
 * making again is there already: `open` runs in the same step, with the click. Otherwise the read is made and `open` waits for it, up to `limit`
 * milliseconds (and for good if it fails), so a slow read never holds the dialog back; the dialog copes with opening
 * before it arrives. Only the last activation for a read opens: one that comes while another still waits takes its
 * place, so a dialog the first one opened and the student closed is not opened again by the second. `after` is not
 * replaceable: it runs once for every activation, right after its `open` or where `open` would have been, for what the
 * activation owes beyond the dialog (taking its parameters out of the address).
 */
export function whenRead<T>(client: QueryClient, query: AheadQuery<T>, open: () => void, limit = 250, after?: () => void): void {
  const calls = latest.get(client) ?? new Map<string, object>();
  latest.set(client, calls);
  const key = JSON.stringify(query.queryKey);
  const mine = {};
  calls.set(key, mine);
  const read = client.getQueryCache().find({ queryKey: query.queryKey });
  // A read that is fresh but being made again (a page asked for it afresh) is not the state of the workspace yet.
  if (read && !read.isStaleByTime(query.staleTime) && !client.isFetching({ queryKey: query.queryKey })) {
    open();
    after?.();
    return;
  }
  let opened = false;
  const go = () => {
    if (opened) return;
    opened = true;
    clearTimeout(timer);
    if (calls.get(key) === mine) open();
    after?.();
  };
  const timer = setTimeout(go, limit);
  // A stale time of 0 makes this join the read on its way instead of answering with the cached one.
  client.fetchQuery({ ...query, staleTime: 0 }).then(go, go);
}
