import { describe, expect, it } from "vitest";
import { openDatabase } from "../db/connection";
import { uuidv7 } from "../../shared/ids";
import { listSources } from "./smartbook";
import { applyOcrPage, finishOcr, requestOcr, runOcr } from "./ocr";

function seedNeedsOcr(db: ReturnType<typeof openDatabase>): string {
  const now = Date.now();
  const sourceId = uuidv7(now);
  const documentId = uuidv7(now + 1);
  db.prepare(
    `INSERT INTO sources (id, kind, title, status, created_at, updated_at)
     VALUES (?, 'pdf', 'Scan', 'needs-ocr', ?, ?)`,
  ).run(sourceId, now, now);
  db.prepare(
    `INSERT INTO source_documents (id, source_id, version, tree_json, created_at)
     VALUES (?, ?, 1, ?, ?)`,
  ).run(documentId, sourceId, JSON.stringify({ pages: 0 }), now);
  return sourceId;
}

describe("ocr queue", () => {
  it("queues OCR only from needs-ocr", () => {
    const db = openDatabase(":memory:");
    const sourceId = seedNeedsOcr(db);
    requestOcr(db, sourceId);
    expect(listSources(db)[0]?.status).toBe("ocr-queued");
    expect(() => requestOcr(db, sourceId)).toThrow(/invalid-ocr-state/);
  });

  it("refuses to queue a ready source", () => {
    const db = openDatabase(":memory:");
    const sourceId = seedNeedsOcr(db);
    db.prepare(`UPDATE sources SET status = 'ready' WHERE id = ?`).run(sourceId);
    expect(() => requestOcr(db, sourceId)).toThrow(/invalid-ocr-state/);
  });

  it("stores a page with locator and section, without duplicating", () => {
    const db = openDatabase(":memory:");
    const sourceId = seedNeedsOcr(db);
    requestOcr(db, sourceId);
    expect(applyOcrPage(db, sourceId, { page: 2, text: "energia interna" })).toBe(true);
    expect(applyOcrPage(db, sourceId, { page: 2, text: "other text" })).toBe(false);
    const row = db
      .prepare(`SELECT text, locator_json, section_path FROM passages WHERE source_id = ?`)
      .get(sourceId) as { text: string; locator_json: string; section_path: string };
    expect(row.text).toBe("energia interna");
    expect(JSON.parse(row.locator_json)).toEqual({ page: 2 });
    expect(row.section_path).toBe("p. 2");
    expect(
      db.prepare(`SELECT COUNT(*) AS n FROM passages WHERE source_id = ?`).get(sourceId) as {
        n: number;
      },
    ).toEqual({ n: 1 });
  });

  it("finishes ready when passages exist and failed when none", () => {
    const db = openDatabase(":memory:");
    const okId = seedNeedsOcr(db);
    requestOcr(db, okId);
    applyOcrPage(db, okId, { page: 1, text: "forza" });
    expect(finishOcr(db, okId)).toBe("ready");
    expect(listSources(db).find((s) => s.id === okId)?.status).toBe("ready");

    const badId = seedNeedsOcr(db);
    requestOcr(db, badId);
    expect(finishOcr(db, badId)).toBe("failed");
    expect(listSources(db).find((s) => s.id === badId)?.status).toBe("failed");
  });

  it("runs plain pages end to end", () => {
    const db = openDatabase(":memory:");
    const sourceId = seedNeedsOcr(db);
    requestOcr(db, sourceId);
    expect(
      runOcr(db, sourceId, [
        { page: 1, text: "prima" },
        { page: 2, text: "seconda" },
        { page: 2, text: "dup" },
      ]),
    ).toBe("ready");
    expect(
      db.prepare(`SELECT COUNT(*) AS n FROM passages WHERE source_id = ?`).get(sourceId) as {
        n: number;
      },
    ).toEqual({ n: 2 });
    const tree = db
      .prepare(
        `SELECT tree_json FROM source_documents WHERE source_id = ? ORDER BY version DESC LIMIT 1`,
      )
      .get(sourceId) as { tree_json: string };
    expect(JSON.parse(tree.tree_json)).toEqual({ pages: 2 });
  });
});
