/** The message key a free-books request failed with, or the offline one for a failure that carries none. */
export function bookErrorKey(err: unknown): string {
  return err && typeof err === "object" && "messageKey" in err
    ? String((err as { messageKey: unknown }).messageKey)
    : "sources.books.offline";
}
