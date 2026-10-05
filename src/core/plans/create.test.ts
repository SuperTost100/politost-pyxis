import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../db/connection";
import { importSmartbook } from "../sources/smartbook";
import {
  completeNode,
  createPlan,
  deletePlan,
  listPlans,
  readPlan,
} from "./create";
import { applyRebuild, computeRebuild } from "./rebuild";
import { uuidv7 } from "../../shared/ids";
import { pathState } from "./path";

function pack(files: Record<string, string>): Uint8Array {
  return zipSync(
    Object.fromEntries(
      Object.entries(files).map(([name, text]) => [name, strToU8(text)]),
    ),
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
        "chapters/01.md":
          "## p1 | Energia\nIl vettore posizione descrive il punto.\n",
        "chapters/02.md":
          "## p1 | Newton\nLa forza cambia la quantita di moto.\n",
      }),
    );
    const plan = createPlan(db, {
      title: "Fisica 1",
      sourceIds: [imported.sourceId],
    });
    expect(plan.topics).toBe(2);
    const stored = db
      .prepare(
        `SELECT target, style, content_language, exam_at FROM plans WHERE id = ?`,
      )
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
      .prepare(
        `SELECT kind FROM path_nodes WHERE plan_id = ? ORDER BY position`,
      )
      .all(plan.planId) as Array<{ kind: string }>;
    expect(kinds.slice(0, 2).map((row) => row.kind)).toEqual([
      "intro",
      "diagnostic",
    ]);
    const linked = db
      .prepare(
        `SELECT COUNT(*) AS n FROM topic_passages tp
         JOIN topics t ON t.id = tp.topic_id WHERE t.plan_id = ?`,
      )
      .get(plan.planId) as { n: number };
    expect(linked.n).toBe(2);
    const practice = db
      .prepare(
        `SELECT id FROM path_nodes WHERE plan_id = ? AND kind = 'practice' LIMIT 1`,
      )
      .get(plan.planId) as { id: string };
    expect(() => completeNode(db, plan.planId, practice.id)).toThrow(
      /node-locked/,
    );
    deletePlan(db, plan.planId);
    const left = db.prepare(`SELECT COUNT(*) AS n FROM plans`).get() as {
      n: number;
    };
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
      .prepare(
        `SELECT exam_at, target, content_language, style FROM plans WHERE id = ?`,
      )
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
    const reading = db
      .prepare(
        `SELECT kind FROM path_nodes WHERE plan_id = ? AND topic_id IS NOT NULL ORDER BY position`,
      )
      .all(plan.planId) as Array<{ kind: string }>;
    expect(reading.slice(0, 2).map((row) => row.kind)).toEqual([
      "learn",
      "practice",
    ]);
    const practicePlan = createPlan(db, {
      title: "Esercizi",
      sourceIds: [imported.sourceId],
      style: "practice",
    });
    const practicing = db
      .prepare(
        `SELECT kind FROM path_nodes WHERE plan_id = ? AND topic_id IS NOT NULL ORDER BY position`,
      )
      .all(practicePlan.planId) as Array<{ kind: string }>;
    expect(practicing.slice(0, 2).map((row) => row.kind)).toEqual([
      "practice",
      "learn",
    ]);
    const rows = db
      .prepare(
        `SELECT id, kind, topic_id, position FROM path_nodes WHERE plan_id = ?`,
      )
      .all(practicePlan.planId) as Array<{
      id: string;
      kind:
        | "intro"
        | "diagnostic"
        | "learn"
        | "practice"
        | "cards"
        | "gaps"
        | "simulation"
        | "final";
      topic_id: string | null;
      position: number;
    }>;
    const states = pathState(
      rows.map((row) => ({
        id: row.id,
        stage: row.kind,
        topicId: row.topic_id,
        position: row.position,
      })),
      rows
        .filter((row) => row.kind === "intro" || row.kind === "diagnostic")
        .map((row) => row.id),
      {},
    );
    const stateOf = (kind: string) =>
      states.find(
        (item) => item.id === rows.find((row) => row.kind === kind)?.id,
      )?.state;
    expect(stateOf("practice")).toBe("current");
    expect(stateOf("learn")).toBe("locked");
  });

  it("keeps the final check locked after a failed simulation", () => {
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
      target: 0.8,
    });
    const nodes = db
      .prepare(`SELECT id, kind, topic_id FROM path_nodes WHERE plan_id = ?`)
      .all(plan.planId) as Array<{
      id: string;
      kind: string;
      topic_id: string | null;
    }>;
    let at = Date.now();
    for (const node of nodes) {
      if (node.kind === "final") continue;
      db.prepare(
        `INSERT INTO learning_events (id, kind, plan_id, topic_id, payload_json, created_at)
         VALUES (?, 'lesson_completed', ?, NULL, ?, ?)`,
      ).run(uuidv7(at), plan.planId, JSON.stringify({ nodeId: node.id }), at);
      at += 1;
    }
    for (const topicId of new Set(
      nodes.flatMap((node) => (node.topic_id ? [node.topic_id] : [])),
    )) {
      db.prepare(
        `INSERT INTO learning_events (id, kind, plan_id, topic_id, payload_json, created_at)
         VALUES (?, 'answer_given', ?, ?, ?, ?)`,
      ).run(
        uuidv7(at),
        plan.planId,
        topicId,
        JSON.stringify({ score: 0, scores: [0] }),
        at,
      );
      at += 1;
    }
    const view = readPlan(db, plan.planId);
    expect(view?.nodes.find((node) => node.kind === "simulation")?.state).toBe(
      "done",
    );
    expect(view?.nodes.find((node) => node.kind === "final")?.state).toBe(
      "locked",
    );
  });

  it("keeps a draft when there is no source, and renames topics before the path is built", () => {
    const db = openDatabase(":memory:");
    const plan = createPlan(db, {
      title: "Bozza",
      sourceIds: [],
      topicTitles: [],
    });
    expect(plan.topics).toBe(0);
    expect(
      db.prepare(`SELECT status FROM plans WHERE id = ?`).get(plan.planId),
    ).toEqual({
      status: "draft",
    });
    const imported = importSmartbook(
      db,
      pack({
        "smartbook.json": JSON.stringify({
          id: "demo",
          title: "Fisica",
          access: "public",
          chapters: [{ id: "c1", number: 1, title: "Moti", file: "01.md" }],
        }),
        "chapters/01.md":
          "## p1 | Energia\nIl vettore posizione descrive il punto.\n",
      }),
    );
    const named = createPlan(db, {
      title: "Fisica 1",
      sourceIds: [imported.sourceId],
      topicTitles: ["Cinematica"],
    });
    expect(readPlan(db, named.planId)?.topics[0]?.title).toBe("Cinematica");
  });

  it("builds one topic per section of a plain document and keeps old topics on rebuild", async () => {
    const db = openDatabase(":memory:");
    const now = Date.now();
    const sourceId = uuidv7(now);
    db.prepare(
      `INSERT INTO sources (id, kind, title, status, created_at, updated_at)
       VALUES (?, 'text', 'Dispense', 'ready', ?, ?)`,
    ).run(sourceId, now, now);
    const insert = db.prepare(
      `INSERT INTO passages (id, source_id, text, locator_json, section_path, char_start, char_end, created_at)
       VALUES (?, ?, ?, '{}', ?, 0, 10, ?)`,
    );
    insert.run(
      uuidv7(now + 1),
      sourceId,
      "la velocita e la derivata",
      "Cinematica",
      now,
    );
    insert.run(
      uuidv7(now + 2),
      sourceId,
      "la forza cambia il moto",
      "Dinamica",
      now,
    );
    const plan = createPlan(db, { title: "Fisica", sourceIds: [sourceId] });
    const before =
      readPlan(db, plan.planId)?.topics.map((topic) => topic.id) ?? [];
    expect(
      readPlan(db, plan.planId)
        ?.topics.map((topic) => topic.title)
        .sort(),
    ).toEqual(["Cinematica", "Dinamica"]);
    const extra = uuidv7(now + 3);
    db.prepare(
      `INSERT INTO sources (id, kind, title, status, created_at, updated_at)
       VALUES (?, 'text', 'Dinamica', 'ready', ?, ?)`,
    ).run(extra, now, now);
    db.prepare(
      `INSERT INTO passages (id, source_id, text, locator_json, section_path, char_start, char_end, created_at)
       VALUES (?, ?, 'ancora forza', '{}', 'Dinamica', 0, 10, ?)`,
    ).run(uuidv7(now + 4), extra, now);
    const treeOf = (titles: string[]) =>
      titles.map((title) => ({
        title,
        summary: "",
        subtopics: [],
        passageIds: (
          db
            .prepare(
              "SELECT id FROM passages WHERE section_path = ? ORDER BY created_at",
            )
            .all(title) as Array<{ id: string }>
        ).map((row) => row.id),
      }));
    const rebuilt = applyRebuild(
      db,
      plan.planId,
      await computeRebuild(db, plan.planId, treeOf(["Cinematica", "Dinamica"])),
    );
    expect(rebuilt.added).toBe(0);
    const after =
      readPlan(db, plan.planId)?.topics.map((topic) => topic.id) ?? [];
    expect(after).toEqual(before);
    const fresh = uuidv7(now + 5);
    db.prepare(
      `INSERT INTO sources (id, kind, title, status, created_at, updated_at)
       VALUES (?, 'text', 'Energia', 'ready', ?, ?)`,
    ).run(fresh, now, now);
    db.prepare(
      `INSERT INTO passages (id, source_id, text, locator_json, section_path, char_start, char_end, created_at)
       VALUES (?, ?, 'lavoro ed energia', '{}', 'Energia', 0, 10, ?)`,
    ).run(uuidv7(now + 6), fresh, now);
    expect(
      applyRebuild(
        db,
        plan.planId,
        await computeRebuild(
          db,
          plan.planId,
          treeOf(["Cinematica", "Dinamica", "Energia"]),
        ),
      ).added,
    ).toBe(1);
    const learn = db
      .prepare(
        `SELECT COUNT(*) AS n FROM path_nodes WHERE plan_id = ? AND kind = 'learn' AND title = 'Energia'`,
      )
      .get(plan.planId) as { n: number };
    expect(learn.n).toBe(1);
  });

  it("stops before saving when cancel arrives during preparation", async () => {
    const db = openDatabase(":memory:");
    const { planHandlers } = await import("./handlers");
    const controller = new AbortController();
    const pending = planHandlers(db).create(
      { title: "Stop", sourceIds: ["missing-a", "missing-b"] },
      controller.signal,
    );
    controller.abort();
    await expect(pending).rejects.toThrow(/aborted/);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM plans`).get()).toEqual({
      n: 0,
    });
  });

  it("does not leave a plan when creation is cancelled", () => {
    const db = openDatabase(":memory:");
    const signal = new AbortController();
    signal.abort();
    expect(() =>
      createPlan(db, { title: "Stop", sourceIds: [], signal: signal.signal }),
    ).toThrow(/aborted/);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM plans`).get()).toEqual({
      n: 0,
    });
  });
});

it("orders upcoming exams by date and past exams last", () => {
  const db = openDatabase(":memory:");
  const now = new Date(2026, 9, 4, 12).getTime();
  const insert = db.prepare(
    "INSERT INTO plans (id,title,status,exam_at,created_at,updated_at) VALUES (?,?,'ready',?,1,?)",
  );
  insert.run("later", "Later", now + 7 * 86400000, 100);
  insert.run("sooner", "Sooner", now + 86400000, 1);
  insert.run("past", "Past", now - 86400000, 1000);
  insert.run("undated", "Undated", null, 10000);
  expect(listPlans(db, now).map((p) => p.id)).toEqual([
    "sooner",
    "later",
    "undated",
    "past",
  ]);
  db.close();
});
