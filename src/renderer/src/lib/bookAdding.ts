import type { QueryClient } from "@tanstack/react-query";
import { useSyncExternalStore } from "react";
import { booksNamed } from "@shared/book-match";
import { bookErrorKey } from "./bookErrors";
import { invoke } from "./ipc";

/**
 * The free books being added now, and the last add of each that failed. The row on a subject's shelf, the reader and the
 * list all show a book's add from here, so each says "adding" while the book downloads and none offers it a second
 * time. Once an add is over the books list is read again, and what it says is what each place shows.
 */
type State = {
  adding: ReadonlySet<string>;
  /** The message key of the last add of a book that failed. */
  failed: ReadonlyMap<string, string>;
};

let state: State = { adding: new Set(), failed: new Map() };
const listeners = new Set<() => void>();
const set = (next: Partial<State>) => {
  state = { ...state, ...next };
  for (const listener of listeners) listener();
};

export function useBookAdding(): State {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => state,
  );
}

/**
 * Downloads a free book and imports it. `options.subjectId` puts it on that subject's shelf, as when the student moves it there.
 * Resolves with the new source, or null when the add failed (the key is in `failed`) or the book is already being added.
 */
export async function addBook(
  client: QueryClient,
  bookId: string,
  options: {
    subjectId?: string;
    /** Called with the new source before the lists are read again, so the caller can prepare where its cover arrives. */
    onImported?: (source: { sourceId: string; title: string; subject: string }) => void;
  } = {},
): Promise<{ sourceId: string; title: string; subject: string } | null> {
  if (state.adding.has(bookId)) return null;
  set({
    adding: new Set(state.adding).add(bookId),
    failed: new Map([...state.failed].filter(([id]) => id !== bookId)),
  });
  try {
    const result = await invoke("sources.importBook", {
      id: bookId,
      ...(options.subjectId ? { subjectId: options.subjectId } : {}),
    });
    options.onImported?.(result);
    await client.invalidateQueries({ queryKey: ["sources"] });
    return result;
  } catch (err) {
    set({ failed: new Map(state.failed).set(bookId, bookErrorKey(err)) });
    return null;
  } finally {
    const adding = new Set(state.adding);
    adding.delete(bookId);
    set({ adding });
  }
}

/** The subject a free book belongs on by name (`booksNamed`), for a book added from the list or the reader. */
export function subjectForBook(
  subjects: ReadonlyArray<{ id: string; name: string }>,
  book: { title: string; subject: string },
): string | undefined {
  return subjects.find((subject) => booksNamed([subject.name], [book]).length > 0)?.id;
}
