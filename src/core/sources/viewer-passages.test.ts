import { strToU8, zipSync } from "fflate";
import { expect, it } from "vitest";
import { openDatabase } from "../db/connection";
import { chapterPassages, importSmartbook, sourcePassages } from "./smartbook";

it("reads a whole book, or one chapter of it, for the viewer", () => {
  const db = openDatabase(":memory:");
  const book = importSmartbook(
    db,
    zipSync({
      "smartbook.json": strToU8(
        JSON.stringify({
          id: "demo",
          title: "Fisica",
          access: "public",
          chapters: [
            { id: "c1", number: 1, title: "Moti", file: "01.md" },
            { id: "c2", number: 2, title: "Forze", file: "02.md" },
          ],
        }),
      ),
      "chapters/01.md": strToU8("## p1 | Velocità\nSpazio su tempo.\n"),
      "chapters/02.md": strToU8("## p1 | Forza\nMassa per accelerazione.\n"),
      "esercizi.md": strToU8(""),
    }),
  );
  const chapterOf = (passage: { locator: unknown }) => (passage.locator as { chapter: number }).chapter;
  expect(sourcePassages(db, book.sourceId).map(chapterOf)).toEqual([1, 2]);
  expect(chapterPassages(db, book.sourceId, 2).map(chapterOf)).toEqual([2]);
  expect(chapterPassages(db, book.sourceId, 3)).toEqual([]);
});
