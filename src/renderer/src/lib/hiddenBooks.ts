import { useSyncExternalStore } from "react";

/**
 * The subjects whose PoliTost book row the student dismissed. It is a view choice, so it stays in this window's storage
 * like the other dismissed notices, as a list of subject ids; a subject that is deleted leaves a stale id, which is
 * never read again. Storage that cannot be read or written leaves the row showing, and the choice lasts until the window
 * closes.
 */
const KEY = "pyxis-books-hidden";
let ids: ReadonlySet<string> | null = null;
const listeners = new Set<() => void>();

function read(): ReadonlySet<string> {
  if (ids) return ids;
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    ids = new Set(Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : []);
  } catch {
    ids = new Set();
  }
  return ids;
}

export function useHiddenBookRows(): ReadonlySet<string> {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    read,
  );
}

export function hideBookRow(subjectId: string): void {
  ids = new Set(read()).add(subjectId);
  try {
    localStorage.setItem(KEY, JSON.stringify([...ids]));
  } catch {
    /* The choice still holds for this window. */
  }
  for (const listener of listeners) listener();
}
