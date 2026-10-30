import { existsSync, readFileSync } from "node:fs";
import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../db/connection";
import { importSmartbook, passagesAround, smartbookMeta } from "./smartbook";
import { uuidv7 } from "../../shared/ids";
import { retrieve } from "./retrieve";

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
    expect(JSON.parse(hit.locator_json)).toEqual({ chapter: 1, paragraph: "p1", title: "Energia" });
    expect(retrieve(db, "vettore").hits).toHaveLength(1);
  });

  it("replaces a {{formula:N}} mention with the formula, in any chapter and in exercises, and keeps one the book lacks", () => {
    const db = openDatabase(":memory:");
    importSmartbook(
      db,
      pack({
        "smartbook.json": JSON.stringify({
          id: "mentions",
          title: "Mentions",
          access: "public",
          chapters: [
            { id: "c1", number: 1, title: "Vettori", file: "01.md" },
            { id: "c2", number: 2, title: "Moto", file: "02.md" },
          ],
        }),
        "chapters/01.md":
          '## p1 | Modulo\nIl modulo si calcola così.\n\n:::formula{id="1.5" label="modulo"}\n$$\n|\\vec{v}| = \\sqrt{v_x^2 + v_y^2}\n$$\n:::\n\n:::formula{id="1.6" label="sistema"}\n$$\n\\begin{cases} x = 1 \\\\ y = 2 \\end{cases}\n$$\n:::\n',
        "chapters/02.md":
          "## p1 | Velocità\nCome in {{formula:1.5}} la velocità è un vettore; vedi anche {{formula:1.6}} e {{formula:9.9}}.\n",
        "esercizi.md":
          ':::exercise{id="e1" chapter="1"}\nCalcola il modulo con {{formula:1.5}}.\n:::solution\nIl modulo è {{formula:1.5}}.\n:::\n:::\n',
      }),
    );
    const speed = db.prepare("SELECT text FROM passages WHERE text LIKE '%Come in%'").get() as { text: string };
    expect(speed.text).toContain("Come in $|\\vec{v}| = \\sqrt{v_x^2 + v_y^2}$ la velocità");
    expect(speed.text).toMatch(/vedi anche \n\$\$\n\\begin\{cases\}[^]*\n\$\$\n e \{\{formula:9\.9\}\}\./);
    const exercise = db.prepare("SELECT prompt, answer FROM exercises").get() as { prompt: string; answer: string };
    expect(exercise.prompt).toBe("Calcola il modulo con $|\\vec{v}| = \\sqrt{v_x^2 + v_y^2}$.");
    expect(exercise.answer).toBe("Il modulo è $|\\vec{v}| = \\sqrt{v_x^2 + v_y^2}$.");
  });

  it("drops markup a book generator leaked into chapters and exercises (#35)", () => {
    const db = openDatabase(":memory:");
    const imported = importSmartbook(
      db,
      pack({
        "smartbook.json": JSON.stringify({
          id: "leaky",
          title: "Analisi 1",
          access: "public",
          chapters: [{ id: "c1", number: 1, title: "Limiti", file: "01.md" }],
        }),
        "chapters/01.md":
          '## p1 | Limiti\nIl limite descrive il comportamento vicino a un punto.</markdown>\n</parameter>\n</invoke>\n',
        "esercizi.md":
          ':::exercise{id="e1" chapter="1"}\nCalcola il limite.</invoke>\n:::solution\nZero.\n:::\n:::\n',
      }),
    );
    expect(imported.passages).toBe(1);
    const texts = (
      db
        .prepare("SELECT text FROM passages UNION ALL SELECT prompt || ' ' || answer FROM exercises")
        .all() as Array<{ text: string }>
    ).map((row) => row.text);
    expect(texts.join("\n")).toContain("Il limite descrive");
    expect(texts.join("\n")).toContain("Calcola il limite.");
    expect(texts.join("\n")).not.toMatch(/<\/?(markdown|parameter|invoke)/);
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
    const older = importSmartbook(
      db,
      pack({
        "smartbook.json": JSON.stringify({
          id: "old",
          title: "Prima",
          specVersion: "1",
          access: "public",
          chapters: [{ id: "c1", number: 1, title: "Moti", file: "01.md" }],
        }),
        "chapters/01.md": "## p1 | Energia\nTesto.\n",
      }),
    );
    expect(smartbookMeta(db, older.sourceId)?.knownSpec).toBe(true);
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
