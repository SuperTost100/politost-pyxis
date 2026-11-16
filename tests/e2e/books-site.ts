import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeBook } from "./book";

export const MARKUP = '<script>window.__injected = true</script> e <b>grassetto</b>';

/** A folder laid out like books.politost.it: Fisica 1 (about a subject the student has) and Chimica (about none). */
export function booksSite() {
  const dir = mkdtempSync(join(tmpdir(), "pyxis-library-books-site-"));
  mkdirSync(join(dir, "books"));
  const entry = (id: string, title: string, subject: string, chapters: Array<{ title: string; text: string }>) => {
    const bytes = makeBook({ id, title, version: "1.0.0", chapters });
    writeFileSync(join(dir, "books", `${id}@1.0.0.ptsb`), bytes);
    return {
      id,
      title,
      subject,
      authors: ["PoliTost"],
      version: "1.0.0",
      chapters: chapters.length,
      package: `books/${id}@1.0.0.ptsb`,
      bytes: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
  };
  const books = [
    entry("fisica-1", "Fisica 1", "Fisica 1", [
      { title: "Moti", text: `## p1 | Velocità\nLa velocità media è lo spazio percorso diviso il tempo impiegato.\n\n## p2 | Altro\n${MARKUP}\n` },
      { title: "Forze", text: "## p1 | Dinamica\nLa forza risultante è massa per accelerazione.\n" },
    ]),
    entry("chimica", "Chimica di base", "Chimica", [{ title: "Atomi", text: "## p1 | Atomo\nL'atomo ha un nucleo.\n" }]),
  ];
  writeFileSync(join(dir, "catalog.json"), JSON.stringify({ catalogVersion: 1, books }));
  return dir;
}
