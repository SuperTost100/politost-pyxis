import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../db/connection";
import { createPlan, readPlan } from "../plans/create";
import { uuidv7 } from "../../shared/ids";
import { importSmartbook } from "../sources/smartbook";
import { studyHandlers } from "./handlers";
import { readSimulation, recordTopicScores, saveSimulationDraft, startSimulation } from "./simulation";

function pack(files: Record<string, string>): Uint8Array {
  return zipSync(
    Object.fromEntries(Object.entries(files).map(([name, text]) => [name, strToU8(text)])),
  );
}

describe("simulation", () => {
  it("keeps the remaining time and submits when the clock hits zero", () => {
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
        "esercizi.md":
          ':::exercise{id="e1" chapter="1"}\nQuanto vale?\n:::solution\n10 N\n:::\n:::\n',
      }),
    );
    const plan = createPlan(db, { title: "Fisica 1", sourceIds: [imported.sourceId] });
    const start = 1_700_000_000_000;
    const opened = startSimulation(db, plan.planId, 30, start);
    expect(JSON.stringify(opened.questions)).not.toContain("10 N");
    const midway = readSimulation(db, opened.attemptId, start + 60_000);
    expect(midway.submitted).toBe(false);
    expect(midway.leftMs).toBe(29 * 60_000);
    const ended = readSimulation(db, opened.attemptId, start + 31 * 60_000);
    expect(ended.submitted).toBe(true);
    expect(ended.leftMs).toBe(0);
    expect(ended.topics[0]?.title).toContain("Moti");
    expect(ended.topics[0]?.score).toBe(0);
    const event = db
      .prepare(
        `SELECT payload_json FROM learning_events WHERE plan_id = ? AND kind = 'answer_given'`,
      )
      .get(plan.planId) as { payload_json: string };
    expect(JSON.parse(event.payload_json).score).toBe(0);
  });

  it("keeps each repeated question on its own topic", () => {
    const db = openDatabase(":memory:");
    db.prepare(
      `INSERT INTO plans (id, title, status, created_at, updated_at) VALUES ('plan', 'Fisica', 'ready', 1, 1)`,
    ).run();
    db.prepare(
      `INSERT INTO topics (id, plan_id, title, position, created_at) VALUES ('a', 'plan', 'A', 0, 1), ('b', 'plan', 'B', 1, 1)`,
    ).run();
    recordTopicScores(
      db,
      "plan",
      [{ topicId: "a" }, { topicId: "b" }],
      [{ score: 1 }, { score: 0 }],
      1,
    );
    const rows = db
      .prepare(`SELECT topic_id, payload_json FROM learning_events ORDER BY topic_id`)
      .all() as Array<{ topic_id: string; payload_json: string }>;
    expect(rows.map((row) => [row.topic_id, JSON.parse(row.payload_json).score])).toEqual([
      ["a", 1],
      ["b", 0],
    ]);
  });

  it("stores a per-topic score when the simulation is graded", () => {
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
        "esercizi.md":
          ':::exercise{id="e1" chapter="1"}\nQuanto vale?\n:::solution\n10 N\n:::\n:::\n',
      }),
    );
    const plan = createPlan(db, { title: "Fisica 1", sourceIds: [imported.sourceId] });
    const opened = startSimulation(db, plan.planId, 30, Date.now());
    const question = opened.questions[0];
    expect(question).toBeTruthy();
    studyHandlers(db).quizSubmit({
      attemptId: opened.attemptId,
      picks: { [question!.id]: "10 N" },
    });
    const event = db
      .prepare(
        `SELECT payload_json FROM learning_events WHERE plan_id = ? AND kind = 'answer_given'`,
      )
      .get(plan.planId) as { payload_json: string };
    expect(JSON.parse(event.payload_json).score).toBe(1);
  });

  it("draws a question from a later topic and finishes the simulation node", () => {
    const db = openDatabase(":memory:");
    const many = Array.from({ length: 20 }, (_, index) =>
      `:::exercise{id="a${index}" chapter="1"}\nA${index}\n:::solution\n1\n:::\n:::\n`,
    ).join("\n");
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
        "chapters/01.md": "## p1 | Energia\nUno.\n",
        "chapters/02.md": "## p1 | Forze\nDue.\n",
        "esercizi.md": `${many}\n:::exercise{id="b1" chapter="2"}\nFROM2\n:::solution\n2\n:::\n:::\n`,
      }),
    );
    const plan = createPlan(db, { title: "Fisica 1", sourceIds: [imported.sourceId] });
    const nodes = db
      .prepare(`SELECT id, kind, topic_id FROM path_nodes WHERE plan_id = ? ORDER BY position`)
      .all(plan.planId) as Array<{ id: string; kind: string; topic_id: string | null }>;
    let at = Date.now();
    for (const node of nodes) {
      if (node.kind === "simulation" || node.kind === "final") continue;
      db.prepare(
        `INSERT INTO learning_events (id, kind, plan_id, topic_id, payload_json, created_at)
         VALUES (?, 'lesson_completed', ?, NULL, ?, ?)`,
      ).run(uuidv7(at), plan.planId, JSON.stringify({ nodeId: node.id }), at);
      at += 1;
    }
    for (const topicId of new Set(nodes.flatMap((node) => (node.topic_id ? [node.topic_id] : [])))) {
      db.prepare(
        `INSERT INTO learning_events (id, kind, plan_id, topic_id, payload_json, created_at)
         VALUES (?, 'answer_given', ?, ?, ?, ?)`,
      ).run(uuidv7(at), plan.planId, topicId, JSON.stringify({ score: 1, scores: [1] }), at);
      at += 1;
    }
    const opened = startSimulation(db, plan.planId, 30, at);
    expect(opened.questions.map((question) => question.stem)).toContain("FROM2");
    const question = opened.questions[0];
    studyHandlers(db).quizSubmit({
      attemptId: opened.attemptId,
      picks: { [question!.id]: "nope" },
    });
    expect(readPlan(db, plan.planId)?.nodes.find((node) => node.kind === "simulation")?.state).toBe(
      "done",
    );
  });

  it("restores a draft and ignores a late answer", () => {
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
        "esercizi.md":
          ':::exercise{id="e1" chapter="1"}\nQuanto vale?\n:::solution\n10 N\n:::\n:::\n',
      }),
    );
    const plan = createPlan(db, { title: "Fisica 1", sourceIds: [imported.sourceId] });
    const opened = startSimulation(db, plan.planId, 30, Date.now());
    const question = opened.questions[0];
    saveSimulationDraft(db, opened.attemptId, { [question!.id]: "10 N" });
    expect(readSimulation(db, opened.attemptId).picks[question!.id]).toBe("10 N");
    db.prepare(`UPDATE attempts SET started_at = ? WHERE id = ?`).run(
      Date.now() - 31 * 60_000,
      opened.attemptId,
    );
    saveSimulationDraft(db, opened.attemptId, { [question!.id]: "late" });
    const saved = db
      .prepare(`SELECT payload_json FROM attempt_answers WHERE attempt_id = ?`)
      .get(opened.attemptId) as { payload_json: string };
    expect(JSON.parse(saved.payload_json).picks[question!.id]).toBe("10 N");
  });
});
