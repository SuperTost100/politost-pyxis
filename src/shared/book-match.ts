const ROMAN: Record<string, string> = { i: "1", ii: "2", iii: "3", iv: "4", v: "5" };

/**
 * A name as it is compared: no case, no accents, no punctuation, one space between words, and a Roman number written
 * as a digit ("Analisi II" and "Analisi 2" are the same name).
 */
function plainName(name: string): string {
  return name
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .split(" ")
    .map((word) => ROMAN[word] ?? word)
    .join(" ");
}

/** Whether two names are the same name, by the rule `booksNamed` uses. */
export function sameName(a: string, b: string): boolean {
  const left = plainName(a);
  return left !== "" && left === plainName(b);
}

/**
 * The free books that are about a subject or an exam, found by name only. A book matches when the name is the book's
 * subject or its title, the same up to case, accents, punctuation and Roman numerals. Nothing looser: a name that is
 * only close ("Fisica" for "Fisica 1") offers nothing, so a wrong match is rare, and the offers that come from it can
 * be dismissed or unticked.
 */
export function booksNamed<T extends { title: string; subject: string }>(names: string[], books: T[]): T[] {
  const wanted = new Set(names.map(plainName).filter(Boolean));
  if (!wanted.size) return [];
  return books.filter((book) => wanted.has(plainName(book.subject)) || wanted.has(plainName(book.title)));
}
