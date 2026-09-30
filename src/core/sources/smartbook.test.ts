import { existsSync, readFileSync } from "node:fs";
import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../db/connection";
import { importSmartbook, searchPassages } from "./smartbook";

const book = "/Users/tost1/Documents/Personal/Vibecode/PoliTost/books/ptt-fisica1.ptsb";

function pack(files: Record<string, string>): Uint8Array {
  return zipSync(
    Object.fromEntries(Object.entries(files).map(([name, text]) => [name, strToU8(text)])),
  );
}

describe("importSmartbook", () => {
  it("stores a chapter paragraph and an exercise", () => {
    const db = openDatabase(":memory:");
    const imported = importSmartbook(
      db,
      pack({
        "smartbook.json": JSON.stringify({
          id: "demo",
          title: "Demo",
          access: "public",
          chapters: [{ id: "c1", number: 1, title: "Moti", file: "01.md" }],
        }),
        "chapters/01.md":
          "## p1 | Energia\nIl vettore posizione descrive il punto.\n\n:::formula{id=\"1.1\" label=\"lavoro\"}\nW = F \\\\cdot s\n:::\n",
        "esercizi.md":
          ':::exercise{id="e1" chapter="1"}\nQuanto vale?\n:::solution\nDue.\n:::\n:::\n',
      }),
    );
    expect(imported.passages).toBe(1);
    expect(imported.exercises).toBe(1);
    const hit = db
      .prepare(
        `SELECT p.text, p.locator_json FROM passages_fts
         JOIN passages p ON p.rowid = passages_fts.rowid
         WHERE passages_fts MATCH 'vettore'`,
      )
      .get() as { text: string; locator_json: string };
    expect(hit.text).toContain("vettore");
    expect(hit.text.startsWith("Energia\nEnergia")).toBe(false);
    expect(hit.text).toContain("W = F");
    expect(JSON.parse(hit.locator_json)).toEqual({ chapter: 1, paragraph: "p1" });
    expect(searchPassages(db, "vettore")).toHaveLength(1);
  });

  it("refuses an encrypted package", () => {
    const db = openDatabase(":memory:");
    const bytes = new Uint8Array([0x50, 0x54, 0x53, 0x42, 0, 0]);
    expect(() => importSmartbook(db, bytes)).toThrow(/encrypted/);
  });

  it("refuses a book whose chapter file is missing", () => {
    const db = openDatabase(":memory:");
    expect(() =>
      importSmartbook(
        db,
        pack({
          "smartbook.json": JSON.stringify({
            id: "demo",
            title: "Demo",
            access: "public",
            chapters: [{ id: "c2", number: 2, title: "Due", file: "02.md" }],
          }),
        }),
      ),
    ).toThrow(/chapter-missing/);
  });

  it("reads the owner's Fisica 1 book when it is on disk", () => {
    if (!existsSync(book)) return;
    const bytes = readFileSync(book);
    const db = openDatabase(":memory:");
    const imported = importSmartbook(db, bytes);
    expect(imported.title).toContain("Fisica");
    expect(imported.chapters).toBeGreaterThan(1);
    expect(imported.passages).toBeGreaterThan(10);
    const chapter2 = db
      .prepare(
        `SELECT locator_json FROM passages
         WHERE json_extract(locator_json, '$.chapter') = 2
         LIMIT 1`,
      )
      .get() as { locator_json: string } | undefined;
    expect(chapter2).toBeTruthy();
  });
});
