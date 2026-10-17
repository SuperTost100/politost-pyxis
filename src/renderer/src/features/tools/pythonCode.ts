/**
 * The Python page keeps the code being edited and a few saved snippets in localStorage, so leaving the page or closing
 * the app loses nothing. Stored values are read back defensively: another build or a hand edit may have changed them.
 */
type Reader = Pick<Storage, "getItem">;
type Writer = Pick<Storage, "setItem">;

export const CODE_KEY = "pyxis-python-code";
export const SNIPPETS_KEY = "pyxis-python-snippets";
export const MAX_SNIPPETS = 8;
const NAME_CHARS = 48;

export type Snippet = { name: string; code: string };

export function readCode(
  storage: Reader,
  fallback: string,
  maxChars: number,
): string {
  try {
    const code = storage.getItem(CODE_KEY);
    return code != null && code.length <= maxChars ? code : fallback;
  } catch {
    return fallback;
  }
}

export function writeCode(storage: Writer, code: string): void {
  try {
    storage.setItem(CODE_KEY, code);
  } catch {
    // Storage is full or turned off: the code still stays on screen until the page closes.
  }
}

export function readSnippets(storage: Reader, maxChars: number): Snippet[] {
  try {
    const parsed: unknown = JSON.parse(storage.getItem(SNIPPETS_KEY) ?? "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (item): item is Snippet =>
          !!item &&
          typeof item === "object" &&
          typeof item.name === "string" &&
          typeof item.code === "string" &&
          item.code.trim() !== "" &&
          item.code.length <= maxChars,
      )
      .map(({ name, code }) => ({
        name: name.slice(0, NAME_CHARS) || snippetName(code),
        code,
      }))
      .slice(0, MAX_SNIPPETS);
  } catch {
    return [];
  }
}

export function writeSnippets(storage: Writer, snippets: Snippet[]): void {
  try {
    storage.setItem(SNIPPETS_KEY, JSON.stringify(snippets));
  } catch {
    // As with the code: the list on screen stays until the page closes.
  }
}

/** A snippet is named by its first line that is not blank, so the list reads like the code it opens. */
export function snippetName(code: string): string {
  const line = code
    .split("\n")
    .map((item) => item.trim())
    .find(Boolean);
  if (!line) return "";
  return line.length > NAME_CHARS ? `${line.slice(0, NAME_CHARS - 1)}…` : line;
}

/** Newest first. Saving code already in the list moves it to the top; past the limit the oldest goes. */
export function addSnippet(snippets: Snippet[], code: string): Snippet[] {
  if (!code.trim()) return snippets;
  return [
    { name: snippetName(code), code },
    ...snippets.filter((item) => item.code !== code),
  ].slice(0, MAX_SNIPPETS);
}
