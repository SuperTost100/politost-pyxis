import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../db/connection";
import { importSmartbook } from "../sources/smartbook";
import { completeNode, createPlan, deletePlan } from "./create";

function pack(files: Record<string, string>): Uint8Array {
  return zipSync(
    Object.fromEntries(Object.entries(files).map(([name, text]) => [name, strToU8(text)])),
  );
}

describe("createPlan", () => {
  it("builds a topic per chapter without calling a model", () => {
    const db = openDatabase(":memory:");
    const imported = importSmartbook(
      db,
      pack({
        "smartbook.json": JSON.stringify({
          id: "demo",
          title: "Fisica",
          access: "public",
          chapters: [
            { id: "c1", number: 1, title: "Moti", file: "01.md" },
            { id: "c2", number: 2, title: "Forze", file: "02.md" },
          ],
        }),
        "chapters/01.md": "## p1 | Energia\nIl vettore posizione descrive il punto.\n",
        "chapters/02.md": "## p1 | Newton\nLa forza cambia la quantita di moto.\n",
      }),
    );
    const plan = createPlan(db, {
      title: "Fisica 1",
      sourceIds: [imported.sourceId],
    });
    expect(plan.topics).toBe(2);
    const stored = db
      .prepare(`SELECT target, style, content_language, exam_at FROM plans WHERE id = ?`)
      .get(plan.planId) as {
      target: number;
      style: string;
      content_language: string | null;
      exam_at: number | null;
    };
    expect(stored).toEqual({
      target: 0.75,
      style: "decide",
      content_language: null,
      exam_at: null,
    });
    expect(plan.pathNodes).toBe(12);
    const kinds = db
      .prepare(`SELECT kind FROM path_nodes WHERE plan_id = ? ORDER BY position`)
      .all(plan.planId) as Array<{ kind: string }>;
    expect(kinds.slice(0, 2).map((row) => row.kind)).toEqual(["intro", "diagnostic"]);
    const linked = db
      .prepare(
        `SELECT COUNT(*) AS n FROM topic_passages tp
         JOIN topics t ON t.id = tp.topic_id WHERE t.plan_id = ?`,
      )
      .get(plan.planId) as { n: number };
    expect(linked.n).toBe(2);
    const practice = db
      .prepare(`SELECT id FROM path_nodes WHERE plan_id = ? AND kind = 'practice' LIMIT 1`)
      .get(plan.planId) as { id: string };
    expect(() => completeNode(db, plan.planId, practice.id)).toThrow(/node-locked/);
    deletePlan(db, plan.planId);
    const left = db.prepare(`SELECT COUNT(*) AS n FROM plans`).get() as { n: number };
    expect(left.n).toBe(0);
    expect(() => deletePlan(db, plan.planId)).toThrow(/plan-missing/);
  });

  it("stores the exam date, target, language and style", () => {
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
    const stored = db
      .prepare(`SELECT exam_at, target, content_language, style FROM plans WHERE id = ?`)
      .get(plan.planId) as {
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
  });
});
