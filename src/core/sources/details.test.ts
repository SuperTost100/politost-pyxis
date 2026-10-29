import { afterEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import { openDatabase } from "../db/connection";
import { sourceDetails } from "./details";
import { addDocumentVersion, storeExtracted, type ExtractedDocument } from "./documents";
import { applyOcrPage, finishOcr, requestOcr } from "./ocr";

const text = (page: number) => `Testo della pagina ${page}, abbastanza lungo da contare come pagina vera.`;

/** A PDF as the import reads it: one page per entry, `null` for a page with no text layer. */
function pdf(pages: Array<string | null>): ExtractedDocument {
  const read = pages.map((body, index) => ({
    text: body ?? "",
    locator: { page: index + 1 },
    section: `p. ${index + 1}`,
  }));
  const thin = read.filter((page) => page.text.length < 30).length;
  return { pages: read, scanned: thin * 2 > read.length };
}

function store(db: Database.Database, extracted: ExtractedDocument, title = "Dispensa") {
  return storeExtracted(db, "", { title, kind: "pdf", mime: "application/pdf", ext: ".pdf", extracted, sha: "sha" })
    .sourceId;
}

function plan(db: Database.Database, id: string, sourceId: string, role = "material") {
  db.prepare(`INSERT INTO plans (id, title, created_at, updated_at) VALUES (?, ?, 1, 1)`).run(id, `Esame ${id}`);
  db.prepare(`INSERT INTO plan_sources (plan_id, source_id, role) VALUES (?, ?, ?)`).run(id, sourceId, role);
}

function passage(db: Database.Database, sourceId: string, page: number): string {
  return (
    db
      .prepare(`SELECT id FROM passages WHERE source_id = ? AND json_extract(locator_json, '$.page') = ? LIMIT 1`)
      .get(sourceId, page) as { id: string }
  ).id;
}

function cite(db: Database.Database, planId: string, itemId: string, kind: string, ...passageIds: string[]) {
  db.prepare(`INSERT INTO items (id, plan_id, kind, body_json, created_at) VALUES (?, ?, ?, '{}', 1)`).run(
    itemId,
    planId,
    kind,
  );
  for (const id of passageIds)
    db.prepare(`INSERT INTO item_passages (item_id, passage_id) VALUES (?, ?)`).run(itemId, id);
}

afterEach(() => vi.useRealTimers());

describe("source details", () => {
  it("tells the pages OCR read from the text layer and the blank ones", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.UTC(2026, 9, 12, 9));
    const db = openDatabase(":memory:");
    // Two pages with a text layer and four without, so the import marks it a scan.
    const sourceId = store(db, pdf([text(1), text(2), null, null, null, null]));
    expect(sourceDetails(db, sourceId)?.pages).toEqual({ count: 2, ocr: [], blank: [] });

    // OCR reads the scanned pages later; page 5 turns out blank.
    vi.setSystemTime(Date.UTC(2026, 9, 12, 10));
    requestOcr(db, sourceId);
    for (const page of [3, 4, 5, 6]) applyOcrPage(db, sourceId, { page, text: page === 5 ? " " : text(page) });
    expect(finishOcr(db, sourceId)).toBe("ready");

    const details = sourceDetails(db, sourceId);
    expect(details?.addedAt).toBe(Date.UTC(2026, 9, 12, 9));
    expect(details?.pages).toEqual({ count: 6, ocr: [3, 4, 6], blank: [5], ocrAt: Date.UTC(2026, 9, 12, 10) });
    expect(details?.sections).toBe(5);
  });

  it("leaves OCR out of a PDF read from its text layer, and keeps its empty pages as blank", () => {
    const db = openDatabase(":memory:");
    const sourceId = store(db, pdf([text(1), "", text(3), text(4)]));
    expect(sourceDetails(db, sourceId)?.pages).toEqual({ count: 4, ocr: [], blank: [2] });
  });

  it("counts each lesson or quiz once per section it cites, most cited first, older versions included", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(1_000);
    const db = openDatabase(":memory:");
    const sourceId = store(db, pdf([text(1), text(2), text(3)]));
    plan(db, "a", sourceId);
    const old = passage(db, sourceId, 2);
    // A new version of the file: page 2 keeps its section name, so the citation of the old passage still counts there.
    vi.setSystemTime(2_000);
    addDocumentVersion(db, "", sourceId, {
      title: "Dispensa",
      mime: "application/pdf",
      ext: ".pdf",
      extracted: pdf([text(1), text(2), text(3)]),
      sha: "sha-2",
    });
    const [, p2, p3] = [1, 2, 3].map((page) =>
      (
        db
          .prepare(
            `SELECT id FROM passages WHERE source_id = ? AND json_extract(locator_json, '$.page') = ?
             ORDER BY created_at DESC LIMIT 1`,
          )
          .get(sourceId, page) as { id: string }
      ).id,
    );
    cite(db, "a", "lesson", "lesson", p2!, p3!);
    cite(db, "a", "quiz", "quiz", p2!);
    cite(db, "a", "intro", "intro", p3!);
    cite(db, "a", "old-lesson", "lesson", old);
    // One item citing two passages of one section counts once.
    cite(db, "a", "review", "review", old, p2!);

    const details = sourceDetails(db, sourceId);
    expect(details?.citations).toBe(6);
    expect(details?.bySection.map(({ section, count }) => [section, count])).toEqual([
      ["p. 2", 4],
      ["p. 3", 2],
      ["p. 1", 0],
    ]);
    expect(details?.bySection[0]).toMatchObject({ passageId: p2, firstPage: 2, lastPage: 2 });
    // The second version is newer than the first, but its own passages are not OCR pages.
    expect(details?.pages).toEqual({ count: 3, ocr: [], blank: [] });
  });

  it("lists the exams that use the source with the topics drawing on it", () => {
    const db = openDatabase(":memory:");
    const sourceId = store(db, pdf([text(1), text(2)]));
    const other = store(db, pdf([text(1)]), "Altro");
    plan(db, "a", sourceId);
    plan(db, "b", sourceId, "past_paper");
    plan(db, "c", other);
    db.prepare(`UPDATE plans SET archived_at = 5 WHERE id = 'b'`).run();
    const topic = db.prepare(`INSERT INTO topics (id, plan_id, title, position, archived_at, created_at) VALUES (?, ?, ?, ?, ?, 1)`);
    topic.run("t2", "a", "Derivate", 2, null);
    topic.run("t1", "a", "Limiti", 1, null);
    topic.run("t3", "a", "Vecchio", 3, 9);
    topic.run("t4", "a", "Senza fonte", 4, null);
    const link = db.prepare(`INSERT INTO topic_passages (topic_id, passage_id) VALUES (?, ?)`);
    link.run("t1", passage(db, sourceId, 1));
    link.run("t2", passage(db, sourceId, 2));
    link.run("t3", passage(db, sourceId, 2));
    link.run("t4", passage(db, other, 1));

    expect(sourceDetails(db, sourceId)?.exams).toEqual([
      { planId: "a", title: "Esame a", role: "material", archived: false, topics: ["Limiti", "Derivate"] },
      { planId: "b", title: "Esame b", role: "past_paper", archived: true, topics: [] },
    ]);
  });

  it("shows no pages for a book or a photo, and nothing for a removed or unknown source", () => {
    const db = openDatabase(":memory:");
    const photo = storeExtracted(db, "", {
      title: "Lavagna",
      kind: "image",
      mime: "image/png",
      ext: ".png",
      extracted: { pages: [{ text: text(1), locator: { page: 1 }, section: "text" }], scanned: false },
      sha: "sha-photo",
    }).sourceId;
    expect(sourceDetails(db, photo)).toMatchObject({ sections: 1, citations: 0 });
    expect(sourceDetails(db, photo)?.pages).toBeUndefined();

    db.prepare(`UPDATE sources SET status = 'removed' WHERE id = ?`).run(photo);
    expect(sourceDetails(db, photo)).toBeNull();
    expect(sourceDetails(db, "missing")).toBeNull();
  });
});
