import { strToU8, zipSync } from "fflate";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../db/connection";
import { putBlob, readBlob } from "../blobs";
import { createHash } from "node:crypto";
import { createPlan, readPlan } from "./create";
import { exportPlan, importPlan } from "./file";
import { planMastery } from "./progress";
import { examInstant, httpPlanUrl, planFileSchema } from "../../shared/plan-file";
import { importSmartbook } from "../sources/smartbook";

function pack(files: Record<string, string>): Uint8Array {
  return zipSync(
    Object.fromEntries(Object.entries(files).map(([name, text]) => [name, strToU8(text)])),
  );
}

describe("plan file", () => {
  it("imports a second plan with the same topics and path", () => {
    const db = openDatabase(":memory:");
    const imported = importSmartbook(
      db,
      pack({
        "smartbook.json": JSON.stringify({
          id: "demo",
          title: "Fisica",
          access: "public",
          chapters: [{ id: "c1", number: 1, title: "Moti", file: "01.md" }],
        }),
        "chapters/01.md": "## p1 | Energia\nIl vettore.\n",
        "esercizi.md": "",
      }),
    );
    const plan = createPlan(db, {
      title: "Fisica 1",
      sourceIds: [imported.sourceId],
      examAt: 90_000,
      target: 0.8,
      language: "en",
      style: "read",
    });
    db.prepare(
      `INSERT INTO cards (id, plan_id, topic_id, front, back, grounding, created_at)
       VALUES ('card-1', ?, (SELECT id FROM topics WHERE plan_id = ?), 'fronte', 'retro', 'sources', 1)`,
    ).run(plan.planId, plan.planId);
    db.prepare(
      `INSERT INTO cards (id, plan_id, topic_id, front, back, grounding, removed, created_at)
       VALUES ('card-gone', ?, (SELECT id FROM topics WHERE plan_id = ?), 'tolta', 'via', 'sources', 1, 2)`,
    ).run(plan.planId, plan.planId);
    const file = exportPlan(db, plan.planId);
    const copyId = importPlan(db, file, 50_000);
    expect(copyId).not.toBe(plan.planId);
    const titles = db
      .prepare(`SELECT title FROM topics WHERE plan_id = ? ORDER BY position`)
      .all(copyId) as Array<{ title: string }>;
    expect(titles.map((row) => row.title)).toEqual(["1. Moti"]);
    const nodes = db
      .prepare(`SELECT COUNT(*) AS n FROM path_nodes WHERE plan_id = ?`)
      .get(copyId) as { n: number };
    expect(nodes.n).toBe(plan.pathNodes);
    const cards = db.prepare(`SELECT front, back FROM cards WHERE plan_id = ?`).all(copyId) as Array<{
      front: string;
      back: string;
    }>;
    expect(cards).toEqual([{ front: "fronte", back: "retro" }]);
    const stored = db
      .prepare(`SELECT exam_at, target, content_language, style FROM plans WHERE id = ?`)
      .get(copyId) as {
      exam_at: number;
      target: number;
      content_language: string;
      style: string;
    };
    expect(stored).toEqual({
      exam_at: 90_000,
      target: 0.8,
      content_language: "en",
      style: "read",
    });
    expect(file.progress).toBeUndefined();
    expect(file.cards[0]?.schedule).toBeUndefined();
    const when = 80_000;
    db.prepare(
      `INSERT INTO learning_events (id, kind, plan_id, topic_id, payload_json, created_at)
       VALUES ('evt-1', 'answer_given', ?, (SELECT id FROM topics WHERE plan_id = ?), '{"score":1,"nodeId":"question-7"}', ?)`,
    ).run(plan.planId, plan.planId, when);
    db.prepare(
      `INSERT INTO card_reviews (id, card_id, rating, state_json, reviewed_at)
       VALUES ('rev-1', 'card-1', 'good', '{"dueAt":90000}', ?)`,
    ).run(when);
    const step = db
      .prepare(`SELECT id FROM path_nodes WHERE plan_id = ? ORDER BY position LIMIT 1`)
      .get(plan.planId) as { id: string };
    db.prepare(
      `INSERT INTO learning_events (id, kind, plan_id, payload_json, created_at)
       VALUES ('evt-2', 'lesson_completed', ?, ?, ?)`,
    ).run(plan.planId, JSON.stringify({ nodeId: step.id }), when + 1);
    db.prepare(
      `INSERT INTO learning_events (id, kind, plan_id, payload_json, created_at)
       VALUES ('evt-3', 'lesson_completed', ?, '{"nodeId":0}', ?)`,
    ).run(plan.planId, when + 3);
    const shared = exportPlan(db, plan.planId, { progress: true });
    expect(shared.progress).toEqual([
      { kind: "answer_given", topic: 0, payload: { score: 1, nodeId: "question-7" }, at: when },
      { kind: "lesson_completed", topic: null, payload: { nodeId: 0 }, at: when + 1 },
      { kind: "lesson_completed", topic: null, payload: {}, at: when + 3 },
    ]);
    expect(shared.cards[0]?.schedule).toEqual({
      rating: "good",
      state: { dueAt: 90000 },
      at: when,
    });
    const restored = importPlan(
      db,
      {
        ...shared,
        progress: [
          ...(shared.progress ?? []),
          { kind: "answer_given", topic: 0, payload: { score: 0, nodeId: 0 }, at: when + 2 },
        ],
      },
      70_000,
    );
    const scores = planMastery(db, restored, when);
    expect(scores[0]?.mastery).toBeCloseTo(0.2);
    const review = db
      .prepare(
        `SELECT rating, state_json FROM card_reviews
         WHERE card_id = (SELECT id FROM cards WHERE plan_id = ?)`,
      )
      .get(restored) as { rating: string; state_json: string };
    expect(review.rating).toBe("good");
    expect(JSON.parse(review.state_json)).toEqual({ dueAt: 90000 });
    expect(readPlan(db, restored)?.nodes[0]?.state).toBe("done");
    const kept = db
      .prepare(
        `SELECT payload_json FROM learning_events
         WHERE plan_id = ? AND kind = 'answer_given' ORDER BY created_at`,
      )
      .all(restored) as Array<{ payload_json: string }>;
    expect(kept.map((row) => JSON.parse(row.payload_json))).toEqual([
      { score: 1, nodeId: "question-7" },
      { score: 0, nodeId: 0 },
    ]);
    db.prepare(`UPDATE plans SET target = 2 WHERE id = ?`).run(plan.planId);
    const clamped = exportPlan(db, plan.planId);
    expect(clamped.target).toBe(1);
    expect(importPlan(db, clamped, 60_000)).not.toBe(plan.planId);
  });

  it("names a source by hash and embeds the file only when asked", () => {
    const db = openDatabase(":memory:");
    const workspace = mkdtempSync(join(tmpdir(), "pyxis-"));
    const imported = importSmartbook(
      db,
      pack({
        "smartbook.json": JSON.stringify({
          id: "demo",
          title: "Fisica",
          access: "public",
          chapters: [{ id: "c1", number: 1, title: "Moti", file: "01.md" }],
        }),
        "chapters/01.md": "## p1 | Energia\nIl vettore.\n",
        "esercizi.md": "",
      }),
    );
    const sha = putBlob(workspace, new Uint8Array([1, 2, 3]), "application/zip", "ptsb");
    db.prepare(`UPDATE sources SET blob_sha = ?, mime = ? WHERE id = ?`).run(
      sha,
      "application/zip",
      imported.sourceId,
    );
    const plan = createPlan(db, { title: "Fisica 1", sourceIds: [imported.sourceId] });
    const plain = exportPlan(db, plan.planId, { workspace });
    expect(plain.sources).toEqual([
      { title: "Fisica", sha, bytes: 3, mime: "application/zip" },
    ]);
    const embedded = exportPlan(db, plan.planId, { embed: true, workspace });
    expect(Buffer.from(embedded.sources?.[0]?.data ?? "", "base64")).toEqual(Buffer.from([1, 2, 3]));
    const copy = importPlan(db, embedded, 80_000, workspace);
    const row = db
      .prepare(
        `SELECT s.blob_sha AS sha FROM sources s
         JOIN plan_sources ps ON ps.source_id = s.id
         WHERE ps.plan_id = ?`,
      )
      .get(copy) as { sha: string };
    expect(row.sha).toBe(sha);
    expect(() =>
      importPlan(
        db,
        {
          ...embedded,
          sources: [{ title: "Fisica", sha: "0".repeat(64), bytes: 3, data: embedded.sources?.[0]?.data }],
        },
        90_000,
        workspace,
      ),
    ).toThrow("plan-file");
    const emptySha = putBlob(workspace, new Uint8Array(), "application/octet-stream", "bin");
    db.prepare(`UPDATE sources SET blob_sha = ? WHERE id = ?`).run(emptySha, imported.sourceId);
    const empty = exportPlan(db, plan.planId, { embed: true, workspace });
    expect(empty.sources?.[0]?.bytes).toBe(0);
    expect(empty.sources?.[0]?.data).toBe("");
    const restored = importPlan(db, empty, 100_000, workspace);
    const emptyRow = db
      .prepare(
        `SELECT s.blob_sha AS sha FROM sources s
         JOIN plan_sources ps ON ps.source_id = s.id
         WHERE ps.plan_id = ?`,
      )
      .get(restored) as { sha: string };
    expect(emptyRow.sha).toBe(emptySha);
    expect(() =>
      importPlan(
        db,
        {
          version: 1,
          title: "bad",
          topics: [],
          nodes: [],
          cards: [],
          sources: [
            {
              title: "bad",
              sha: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
              bytes: 4,
              data: "!!!!",
            },
          ],
        },
        110_000,
        workspace,
      ),
    ).toThrow("plan-file");
    const fresh = Buffer.from([9, 9, 9]);
    const orphan = createHash("sha256").update(fresh).digest("hex");
    expect(() =>
      importPlan(
        db,
        {
          version: 1,
          title: "bad",
          topics: [],
          nodes: [],
          cards: [],
          sources: [{ title: "bad", sha: "0".repeat(64), bytes: 3, data: fresh.toString("base64") }],
        },
        120_000,
        workspace,
      ),
    ).toThrow("plan-file");
    expect(() => readBlob(workspace, orphan)).toThrow();
    const first = Buffer.from([7, 7, 7]);
    const firstSha = createHash("sha256").update(first).digest("hex");
    const second = Buffer.from([8, 8, 8]);
    expect(() =>
      importPlan(
        db,
        {
          version: 1,
          title: "bad",
          topics: [],
          nodes: [],
          cards: [],
          sources: [
            { title: "one", sha: firstSha, bytes: 3, data: first.toString("base64") },
            { title: "two", sha: "0".repeat(64), bytes: 3, data: second.toString("base64") },
          ],
        },
        130_000,
        workspace,
      ),
    ).toThrow("plan-file");
    expect(() => readBlob(workspace, firstSha)).toThrow();
  });

  it("refuses a node that points past the topic list", () => {
    const db = openDatabase(":memory:");
    expect(() =>
      importPlan(db, {
        version: 1,
        title: "Fisica",
        topics: [{ title: "Moti", position: 0 }],
        nodes: [{ title: "Studio", kind: "learn", position: 0, topic: 1 }],
        cards: [],
      }),
    ).toThrow("plan-file");
    const count = db.prepare(`SELECT COUNT(*) AS n FROM plans`).get() as { n: number };
    expect(count.n).toBe(0);
  });

  it("accepts only an http plan link", () => {
    expect(httpPlanUrl("https://example.com/piano.json")).toBe(
      "https://example.com/piano.json",
    );
    expect(() => httpPlanUrl("file:///tmp/piano.json")).toThrow("plan-url");
  });

  it("keeps the calendar day across a daylight-saving change", () => {
    const at = new Date(examInstant(1, new Date(2026, 2, 28, 23, 30, 0)));
    expect(at.getFullYear()).toBe(2026);
    expect(at.getMonth()).toBe(2);
    expect(at.getDate()).toBe(29);
    expect(at.getHours()).toBe(12);
  });

  it("rejects a target outside the wizard range", () => {
    expect(() =>
      planFileSchema.parse({
        version: 1,
        title: "Fisica",
        topics: [],
        nodes: [],
        cards: [],
        target: 2,
      }),
    ).toThrow();
  });
});
