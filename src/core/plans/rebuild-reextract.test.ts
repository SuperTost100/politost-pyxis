import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase } from "../db/connection";
import {
  addExtractionVersion,
  addDocumentVersion,
  storeExtracted,
  type ExtractedDocument,
} from "../sources/documents";
import { createPlan } from "./create";
import { applyRebuild, computeRebuild, reviewRebuild } from "./rebuild";

// PLAN-13 after a real re-extract: every passage has a new id, so the old topics and the new tree share no row id.
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

const page = (n: number, section: string, text: string) => ({
  text,
  locator: { page: n },
  section,
});
const original: ExtractedDocument = {
  scanned: false,
  pages: [
    page(
      1,
      "Cinematica",
      "La velocita e il rapporto tra lo spostamento e il tempo impiegato.",
    ),
    page(
      2,
      "Cinematica",
      "L accelerazione misura la variazione di velocita nel tempo.",
    ),
    page(
      3,
      "Dinamica",
      "La forza risultante e uguale alla massa per l accelerazione.",
    ),
    page(
      4,
      "Energia",
      "Il lavoro e il prodotto della forza per lo spostamento.",
    ),
  ],
};

function setup() {
  const workspace = mkdtempSync(join(tmpdir(), "pyxis-rebuild-reextract-"));
  dirs.push(workspace);
  const db = openDatabase(":memory:");
  const { sourceId } = storeExtracted(db, workspace, {
    title: "Dispensa",
    kind: "pdf",
    mime: "application/pdf",
    ext: ".pdf",
    bytes: new Uint8Array([1, 2, 3]),
    extracted: original,
  });
  // The tree a rebuild would make: one topic per section, from the passages of the latest version.
  const treeOf = () =>
    ["Cinematica", "Dinamica", "Energia"].map((title) => ({
      title,
      summary: "",
      subtopics: [],
      passageIds: (
        db
          .prepare(
            `SELECT id FROM passages WHERE source_id = ? AND section_path = ?
             AND document_id = (SELECT id FROM source_documents WHERE source_id = ? ORDER BY version DESC LIMIT 1) ORDER BY rowid`,
          )
          .all(sourceId, title, sourceId) as Array<{ id: string }>
      ).map((row) => row.id),
    }));
  const { planId } = createPlan(db, {
    title: "Fisica",
    sourceIds: [sourceId],
    tree: treeOf(),
  });
  const topics = () =>
    db
      .prepare(
        `SELECT id, title, archived_at AS archived FROM topics WHERE plan_id = ? ORDER BY position`,
      )
      .all(planId) as Array<{
      id: string;
      title: string;
      archived: number | null;
    }>;
  return { db, workspace, sourceId, planId, treeOf, topics };
}

describe("PLAN-13 matching after a re-extract", () => {
  it("does not carry progress into a different replacement book merely because page numbers match", async () => {
    const { db, workspace, sourceId, planId } = setup();
    addDocumentVersion(db, workspace, sourceId, {
      title: "Ricette", mime: "application/pdf", ext: ".pdf", bytes: new Uint8Array([4, 5, 6]),
      extracted: { scanned: false, pages: [page(1, "Ricette", "Il pane richiede farina, acqua e lievito.")] },
    });
    const ids = db.prepare(
      "SELECT id FROM passages WHERE source_id = ? AND document_id = (SELECT id FROM source_documents WHERE source_id = ? ORDER BY version DESC LIMIT 1)",
    ).all(sourceId, sourceId) as Array<{ id: string }>;
    const result = await computeRebuild(db, planId, [{
      title: "Cucina", summary: "", subtopics: [], passageIds: ids.map((row) => row.id),
    }]);
    expect(result.matches).toEqual([]);
    expect(result.archived).toHaveLength(3);
    db.close();
  });

  it("keeps the topics whose text or place survived and shows how each one matched", async () => {
    const { db, sourceId, planId, treeOf, topics } = setup();
    const [cinematica, dinamica, energia] = topics();
    const before = treeOf();
    for (const topic of [cinematica!, dinamica!, energia!])
      db.prepare(
        `INSERT INTO learning_events(id,kind,plan_id,topic_id,payload_json,created_at) VALUES(?,'answer_given',?,?,'{"score":1}',1)`,
      ).run(`e-${topic.id}`, planId, topic.id);
    addExtractionVersion(db, sourceId, {
      scanned: false,
      pages: [
        // Cinematica: the reader fixed accents, so the text is not the same but the pages are.
        page(
          1,
          "Cinematica",
          "La velocità è il rapporto tra lo spostamento e il tempo impiegato.",
        ),
        page(
          2,
          "Cinematica",
          "L'accelerazione misura la variazione di velocità nel tempo.",
        ),
        // Dinamica: untouched text, but moved to another page number.
        page(7, "Dinamica", original.pages[2]!.text),
        // Energia: both the words and the page changed. Only the title is left.
        page(
          9,
          "Energia",
          "Definizione di lavoro e di potenza, con esempi svolti.",
        ),
      ],
    });
    const after = treeOf();
    // The premise: the old topics and the new tree have no passage row id in common.
    const oldIds = new Set(before.flatMap((topic) => topic.passageIds));
    expect(
      after.flatMap((topic) => topic.passageIds).filter((id) => oldIds.has(id)),
    ).toEqual([]);

    const rebuild = await computeRebuild(db, planId, after);
    const review = reviewRebuild(db, planId, rebuild);
    expect(review.kept).toMatchObject([
      {
        id: cinematica!.id,
        title: "Cinematica",
        newTitle: "Cinematica",
        reason: "passages",
      },
      {
        id: dinamica!.id,
        title: "Dinamica",
        newTitle: "Dinamica",
        reason: "passages",
      },
      {
        id: energia!.id,
        title: "Energia",
        newTitle: "Energia",
        reason: "title",
        score: 1,
      },
    ]);
    expect(review.added).toEqual([]);
    expect(review.archived).toEqual([]);

    expect(applyRebuild(db, planId, rebuild, 9000)).toEqual({
      kept: 3,
      added: 0,
      archived: 0,
    });
    expect(topics().map((topic) => topic.id)).toEqual([
      cinematica!.id,
      dinamica!.id,
      energia!.id,
    ]);
    expect(topics().every((topic) => topic.archived === null)).toBe(true);
    expect(
      db.prepare(`SELECT COUNT(*) AS n FROM learning_events`).get(),
    ).toEqual({ n: 3 });
    // The kept topics now cite the new reading, and only that.
    const linked = db
      .prepare(
        `SELECT p.document_id AS doc FROM topic_passages tp JOIN passages p ON p.id = tp.passage_id WHERE tp.topic_id = ?`,
      )
      .all(cinematica!.id) as Array<{ doc: string }>;
    expect(linked).toHaveLength(2);
    expect(new Set(linked.map((row) => row.doc)).size).toBe(1);
    db.close();
  });

  it("archives, never deletes, a topic with nothing left to match on, and the review says it has progress", async () => {
    const { db, sourceId, planId, treeOf, topics } = setup();
    const [, dinamica] = topics();
    db.prepare(
      `INSERT INTO learning_events(id,kind,plan_id,topic_id,payload_json,created_at) VALUES('e1','answer_given',?,?,'{"score":1}',1)`,
    ).run(planId, dinamica!.id);
    addExtractionVersion(db, sourceId, {
      scanned: false,
      pages: [
        page(1, "Cinematica", original.pages[0]!.text),
        page(2, "Cinematica", original.pages[1]!.text),
        page(
          8,
          "Meccanica dei fluidi",
          "La pressione e la forza per unita di superficie.",
        ),
        page(4, "Energia", original.pages[3]!.text),
      ],
    });
    const next = treeOf();
    next[1] = {
      ...next[1]!,
      title: "Meccanica dei fluidi",
      passageIds: (
        db
          .prepare(
            `SELECT id FROM passages WHERE section_path = 'Meccanica dei fluidi'`,
          )
          .all() as Array<{ id: string }>
      ).map((row) => row.id),
    };
    const rebuild = await computeRebuild(db, planId, next);
    const review = reviewRebuild(db, planId, rebuild);
    expect(review.archived).toEqual([
      { id: dinamica!.id, title: "Dinamica", progress: true },
    ]);
    expect(review.added).toEqual([
      { title: "Meccanica dei fluidi", passages: 1 },
    ]);
    applyRebuild(db, planId, rebuild, 9000);
    expect(topics().find((topic) => topic.id === dinamica!.id)).toMatchObject({
      archived: 9000,
    });
    expect(
      db
        .prepare(`SELECT COUNT(*) AS n FROM learning_events WHERE topic_id = ?`)
        .get(dinamica!.id),
    ).toEqual({ n: 1 });
    db.close();
  });

  it("does not match two topics that merely have no place to compare, such as unlabelled pasted text", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "pyxis-rebuild-reextract-"));
    dirs.push(workspace);
    const db = openDatabase(":memory:");
    const { sourceId } = storeExtracted(db, workspace, {
      title: "Appunti",
      kind: "text",
      mime: "text/plain",
      ext: ".txt",
      bytes: new Uint8Array([1]),
      extracted: {
        scanned: false,
        pages: [
          { text: "Primo paragrafo sul calore.", locator: {}, section: "text" },
          {
            text: "Secondo paragrafo sulla luce.",
            locator: {},
            section: "text",
          },
        ],
      },
    });
    const ids = (
      db
        .prepare(`SELECT id FROM passages WHERE source_id = ? ORDER BY rowid`)
        .all(sourceId) as Array<{ id: string }>
    ).map((row) => row.id);
    const { planId } = createPlan(db, {
      title: "Fisica",
      sourceIds: [sourceId],
      tree: [
        { title: "Calore", summary: "", subtopics: [], passageIds: [ids[0]!] },
        { title: "Luce", summary: "", subtopics: [], passageIds: [ids[1]!] },
      ],
    });
    addExtractionVersion(db, sourceId, {
      scanned: false,
      pages: [
        {
          text: "Testo del tutto diverso sull'ottica.",
          locator: {},
          section: "text",
        },
        {
          text: "Un altro testo, sulla termodinamica.",
          locator: {},
          section: "text",
        },
      ],
    });
    const latest = (
      db
        .prepare(
          `SELECT id FROM passages WHERE source_id = ? AND version = 2 ORDER BY rowid`,
        )
        .all(sourceId) as Array<{ id: string }>
    ).map((row) => row.id);
    const rebuild = await computeRebuild(db, planId, [
      { title: "Ottica", summary: "", subtopics: [], passageIds: [latest[0]!] },
      {
        title: "Termodinamica",
        summary: "",
        subtopics: [],
        passageIds: [latest[1]!],
      },
    ]);
    expect(rebuild.matches).toEqual([]);
    expect(rebuild.archived).toHaveLength(2);
    db.close();
  });
});

describe("PLAN-13 review invalidation and cancellation around a re-extract", () => {
  it("marks a reviewed rebuild stale when the source is read again, and refuses to apply it", async () => {
    const { db, sourceId, planId, treeOf } = setup();
    const rebuild = await computeRebuild(db, planId, treeOf());
    expect(reviewRebuild(db, planId, rebuild).stale).toBe(false);
    addExtractionVersion(db, sourceId, {
      scanned: false,
      pages: [page(1, "Cinematica", "Testo riletto.")],
    });
    expect(reviewRebuild(db, planId, rebuild).stale).toBe(true);
    expect(() => applyRebuild(db, planId, rebuild)).toThrow("rebuild-stale");
    expect(
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM topics WHERE archived_at IS NOT NULL`,
        )
        .get(),
    ).toEqual({ n: 0 });
    db.close();
  });

  it("stops matching when cancelled and leaves the plan as it was", async () => {
    const { db, planId, treeOf, topics } = setup();
    const before = topics();
    const controller = new AbortController();
    const embed = async () => {
      controller.abort();
      return new Float32Array([1, 0]);
    };
    await expect(
      computeRebuild(db, planId, treeOf(), embed, controller.signal),
    ).rejects.toThrow();
    expect(topics()).toEqual(before);
    db.close();
  });
});
