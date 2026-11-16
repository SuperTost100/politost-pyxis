import { downloadBook, type BooksTransport, type CatalogBook } from "./books";
import { parseSmartbook, type ParsedSmartbook } from "./smartbook";

/** How long a book read before it was added stays in memory. */
const KEEP_MS = 10 * 60_000;

type Held = { sha: string; bytes: Uint8Array; parsed: ParsedSmartbook; timer: ReturnType<typeof setTimeout> };

/**
 * The one free book being read before it is added. Its package is downloaded and checked as an add would, then kept in
 * memory only: nothing is written to the workspace or the database, so a reader closed without adding leaves nothing.
 * Adding the book next takes the same bytes, so reading first is not a second download. The slot empties after
 * `KEEP_MS`, when another book is read, or when the book is added.
 */
export function createBookReading(keepMs = KEEP_MS) {
  let held: Held | null = null;
  const loading = new Map<string, Promise<Held>>();
  const drop = () => {
    if (held) clearTimeout(held.timer);
    held = null;
  };
  return {
    /** The book's parsed package, downloaded once; concurrent calls for it share that download. */
    async open(
      book: CatalogBook,
      transport: BooksTransport,
      maxBytes: number,
      signal?: AbortSignal,
    ): Promise<{ bytes: Uint8Array; parsed: ParsedSmartbook }> {
      if (held?.sha === book.sha256) return held;
      let pending = loading.get(book.sha256);
      if (!pending) {
        // The shared download is not tied to one caller's signal: a caller that leaves must not cancel it for the other.
        pending = (async () => {
          const bytes = await downloadBook(book, transport, maxBytes);
          const parsed = parseSmartbook(bytes);
          drop();
          const timer = setTimeout(drop, keepMs);
          timer.unref?.();
          held = { sha: book.sha256, bytes, parsed, timer };
          return held;
        })().finally(() => loading.delete(book.sha256));
        loading.set(book.sha256, pending);
      }
      if (!signal) return pending;
      // A caller that stops waiting ends its own wait; the download goes on for whoever else needs it.
      return Promise.race([
        pending,
        new Promise<never>((_, reject) => {
          const stop = () => reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
          if (signal.aborted) stop();
          else signal.addEventListener("abort", stop, { once: true });
        }),
      ]);
    },
    /** The package's bytes when this book is the one held, so adding it does not download it again. */
    bytesOf(book: CatalogBook): Uint8Array | null {
      return held?.sha === book.sha256 ? held.bytes : null;
    },
    drop,
  };
}
