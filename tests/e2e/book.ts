import { strToU8, zipSync } from "fflate";

export type BookChapter = {
  /** Defaults to "c1", "c2"… by position. A book update matches chapters by this id. */
  id?: string;
  title: string;
  /** The chapter's Markdown, with its "## p1 | Title" passages. */
  text: string;
};

/**
 * A public smartbook (.ptsb): smartbook.json, chapters/01.md and on in order, and any other files such as
 * esercizi.md or esami.md.
 */
export function makeBook({
  id,
  title = "Fisica",
  version,
  chapters,
  files = {},
}: {
  id: string;
  title?: string;
  version?: string;
  chapters: BookChapter[];
  files?: Record<string, string>;
}): Uint8Array {
  const entries = chapters.map((chapter, index) => ({
    id: chapter.id ?? `c${index + 1}`,
    number: index + 1,
    title: chapter.title,
    file: `${String(index + 1).padStart(2, "0")}.md`,
    text: chapter.text,
  }));
  return zipSync({
    "smartbook.json": strToU8(
      JSON.stringify({
        id,
        title,
        version,
        access: "public",
        chapters: entries.map(({ text: _text, ...entry }) => entry),
      }),
    ),
    ...Object.fromEntries(
      entries.map((entry) => [`chapters/${entry.file}`, strToU8(entry.text)]),
    ),
    ...Object.fromEntries(
      Object.entries(files).map(([name, text]) => [name, strToU8(text)]),
    ),
  });
}
