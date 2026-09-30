import { existsSync, readFileSync } from "node:fs";
import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../db/connection";
import { importSmartbook, passagesAround, searchPassages, smartbookMeta } from "./smartbook";
import { uuidv7 } from "../../shared/ids";

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
          "## p1 | Energia\nIl vettore posizione descrive il punto.\n\n:::formula{id=\"1.1\" label=\"lavoro\"}\n$$\nW = F \\\\cdot s\n$$\n:::\n",
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
    expect(hit.text, hit.text).toMatch(/\$\$[\s\S]*W = F[\s\S]*\$\$/);
    expect(JSON.parse(hit.locator_json)).toEqual({ chapter: 1, paragraph: "p1" });
    expect(searchPassages(db, "vettore")).toHaveLength(1);
  });

  it("opens every passage on the cited page", () => {
    const db = openDatabase(":memory:");
    db.prepare(
      `INSERT INTO sources (id, kind, title, status, created_at, updated_at)
       VALUES ('s', 'pdf', 'Note', 'ready', 1, 1)`,
    ).run();
    const cited = uuidv7();
    const sibling = uuidv7();
    const insert = db.prepare(
      `INSERT INTO passages (id, source_id, text, locator_json, created_at) VALUES (?, 's', ?, ?, 1)`,
    );
    insert.run(cited, "prima pagina", JSON.stringify({ page: 4 }));
    insert.run(sibling, "ancora pagina", JSON.stringify({ page: 4 }));
    insert.run(uuidv7(), "altra", JSON.stringify({ page: 5 }));
    const rows = passagesAround(db, cited);
    expect(rows.map((row) => row.id).sort()).toEqual([cited, sibling].sort());
    expect(rows.find((row) => row.id === cited)?.current).toBe(true);
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

  it("shows authors and version, and warns on an unknown spec", () => {
    const db = openDatabase(":memory:");
    const known = importSmartbook(
      db,
      pack({
        "smartbook.json": JSON.stringify({
          id: "demo",
          title: "Demo",
          authors: ["Ada"],
          version: "0.3",
          specVersion: "1.1",
          access: "public",
          chapters: [{ id: "c1", number: 1, title: "Moti", file: "01.md" }],
        }),
        "chapters/01.md": "## p1 | Energia\nTesto.\n",
      }),
    );
    expect(smartbookMeta(db, known.sourceId)).toMatchObject({
      title: "Demo",
      authors: ["Ada"],
      version: "0.3",
      specVersion: "1.1",
      knownSpec: true,
    });
    const unknown = importSmartbook(
      db,
      pack({
        "smartbook.json": JSON.stringify({
          id: "next",
          title: "Dopo",
          specVersion: "9",
          access: "public",
          chapters: [{ id: "c1", number: 1, title: "Moti", file: "01.md" }],
        }),
        "chapters/01.md": "## p1 | Energia\nTesto.\n",
      }),
    );
    expect(smartbookMeta(db, unknown.sourceId)?.knownSpec).toBe(false);
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
