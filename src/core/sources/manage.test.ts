import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../db/connection";
import { uuidv7 } from "../../shared/ids";
import { importDocumentFile } from "./documents";
import { removeSource, renameSource, replaceSourceFile } from "./manage";
import { importSmartbook, smartbookChapters, smartbookMeta, searchPassages } from "./smartbook";

describe("rename and replace", () => {
  it("hides old smartbook chapters after a document replacement", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pyxis-book-replace-"));
    const db = openDatabase(":memory:");
    const source = importSmartbook(db, zipSync({
      "smartbook.json": strToU8(JSON.stringify({ id: "book", title: "Book", access: "public", chapters: [{ id: "c1", number: 1, title: "Moti", file: "01.md" }] })),
      "chapters/01.md": strToU8("## p1 | Moto\nLa velocità descrive il moto.\n"),
    }));
    expect(smartbookChapters(db, source.sourceId)).toHaveLength(1);
    const path = join(dir, "new.txt");
    writeFileSync(path, "Il calore cambia l energia interna del sistema.");
    await replaceSourceFile(db, dir, source.sourceId, path);
    expect(smartbookChapters(db, source.sourceId)).toEqual([]);
    expect(smartbookMeta(db, source.sourceId)).toBeNull();
    expect(searchPassages(db, "calore")).toHaveLength(1);
  });

  it("renames a source and keeps the old passage after a replacement", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pyxis-replace-"));
    const first = join(dir, "one.txt");
    const second = join(dir, "two.txt");
    writeFileSync(first, "la velocita e la derivata dello spazio rispetto al tempo");
    writeFileSync(second, "il calore aumenta l energia interna del sistema termodinamico");
    const db = openDatabase(":memory:");
    const imported = await importDocumentFile(db, dir, first);
    renameSource(db, imported.sourceId, "Lezione 1");
    const old = searchPassages(db, "velocita")[0];
    expect(old?.text).toContain("derivata");
    await replaceSourceFile(db, dir, imported.sourceId, second);
    expect(searchPassages(db, "velocita")).toHaveLength(0);
    expect(searchPassages(db, "calore")[0]?.text).toContain("energia");
    const kept = db.prepare(`SELECT text FROM passages WHERE id = ?`).get(old?.id) as {
      text: string;
    };
    expect(kept.text).toContain("derivata");
    const title = db.prepare(`SELECT title FROM sources WHERE id = ?`).get(imported.sourceId) as {
      title: string;
    };
    expect(title.title).toBe("two");
  });

  it("asks before removing a source that a plan still uses", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pyxis-remove-"));
    const file = join(dir, "note.txt");
    writeFileSync(file, "la velocita e la derivata dello spazio rispetto al tempo");
    const db = openDatabase(":memory:");
    const imported = await importDocumentFile(db, dir, file);
    const sourceId = imported.sourceId;
    const now = Date.now();
    const planId = uuidv7(now + 1);
    db.prepare(
      `INSERT INTO plans (id, title, status, created_at, updated_at) VALUES (?, 'Esame', 'ready', ?, ?)`,
    ).run(planId, now, now);
    db.prepare(`INSERT INTO plan_sources (plan_id, source_id) VALUES (?, ?)`).run(planId, sourceId);
    expect(removeSource(db, sourceId, false)).toEqual({ removed: false, inUse: true });
    expect(removeSource(db, sourceId, true).removed).toBe(true);
    expect(
      db.prepare(`SELECT COUNT(*) AS n FROM plan_sources WHERE source_id = ?`).get(sourceId),
    ).toEqual({ n: 0 });
    expect(
      db.prepare(`SELECT status FROM sources WHERE id = ?`).get(sourceId),
    ).toEqual({ status: "removed" });
    expect(searchPassages(db, "velocita")).toHaveLength(0);
    expect(
      db.prepare(`SELECT text FROM passages WHERE source_id = ?`).get(sourceId),
    ).toMatchObject({ text: expect.stringContaining("derivata") });
  });
});
