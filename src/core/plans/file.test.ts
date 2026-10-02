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
import {
  examInstant,
  httpPlanUrl,
  planFileSchema,
} from "../../shared/plan-file";
import { importSmartbook, smartbookChapters } from "../sources/smartbook";
import { loadLesson } from "../study/lesson";
import { topicExercises } from "../study/exercises";

function pack(files: Record<string, string>): Uint8Array {
  return zipSync(
    Object.fromEntries(
      Object.entries(files).map(([name, text]) => [name, strToU8(text)]),
    ),
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
    const cards = db
      .prepare(`SELECT front, back FROM cards WHERE plan_id = ?`)
      .all(copyId) as Array<{
      front: string;
      back: string;
    }>;
    expect(cards).toEqual([{ front: "fronte", back: "retro" }]);
    const stored = db
      .prepare(
        `SELECT exam_at, target, content_language, style FROM plans WHERE id = ?`,
      )
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
    expect(file.cards[0]?.suspended).toBeUndefined();
    db.prepare("UPDATE cards SET suspended=1 WHERE id='card-1'").run();
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
      .prepare(
        `SELECT id FROM path_nodes WHERE plan_id = ? ORDER BY position LIMIT 1`,
      )
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
      {
        kind: "answer_given",
        topic: 0,
        payload: { score: 1, nodeId: "question-7" },
        at: when,
      },
      {
        kind: "lesson_completed",
        topic: null,
        payload: { nodeId: 0 },
        at: when + 1,
      },
      { kind: "lesson_completed", topic: null, payload: {}, at: when + 3 },
    ]);
    expect(shared.cards[0]?.suspended).toBe(true);
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
          {
            kind: "answer_given",
            topic: 0,
            payload: { score: 0, nodeId: 0 },
            at: when + 2,
          },
        ],
      },
      70_000,
    );
    expect(
      db.prepare("SELECT suspended FROM cards WHERE plan_id=?").get(restored),
    ).toEqual({ suspended: 1 });
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
    const sha = putBlob(
      workspace,
      new Uint8Array([1, 2, 3]),
      "application/zip",
      "ptsb",
    );
    db.prepare(`UPDATE sources SET blob_sha = ?, mime = ? WHERE id = ?`).run(
      sha,
      "application/zip",
      imported.sourceId,
    );
    const plan = createPlan(db, {
      title: "Fisica 1",
      sourceIds: [imported.sourceId],
    });
    const plain = exportPlan(db, plan.planId, { workspace });
    expect(plain.sources).toEqual([
      {
        id: imported.sourceId,
        kind: "smartbook",
        title: "Fisica",
        sha,
        bytes: 3,
        mime: "application/zip",
      },
    ]);
    const freshDb = openDatabase(":memory:");
    const excerptCopy = importPlan(freshDb, plain, 75_000);
    const resharedExcerpt = exportPlan(freshDb, excerptCopy);
    expect(resharedExcerpt.sources?.[0]).toMatchObject({
      kind: "excerpt",
      sha,
    });
    expect(resharedExcerpt.passages?.[0]?.sourceSha).toBe(sha);
    const embedded = exportPlan(db, plan.planId, { embed: true, workspace });
    expect(Buffer.from(embedded.sources?.[0]?.data ?? "", "base64")).toEqual(
      Buffer.from([1, 2, 3]),
    );
    const copy = importPlan(db, embedded, 80_000, workspace);
    const row = db
      .prepare(
        `SELECT s.blob_sha AS sha FROM sources s
         JOIN plan_sources ps ON ps.source_id = s.id
         WHERE ps.plan_id = ?`,
      )
      .get(copy) as { sha: string };
    expect(row.sha).toBe(sha);
    const copySource = exportPlan(db, copy).sources![0]!;
    expect(smartbookChapters(db, copySource.id!)).toEqual([
      { number: 1, title: "Moti" },
    ]);
    expect(() =>
      importPlan(
        db,
        {
          ...embedded,
          sources: [
            {
              title: "Fisica",
              sha: "0".repeat(64),
              bytes: 3,
              data: embedded.sources?.[0]?.data,
            },
          ],
        },
        90_000,
        workspace,
      ),
    ).toThrow("plan-file");
    const emptySha = putBlob(
      workspace,
      new Uint8Array(),
      "application/octet-stream",
      "bin",
    );
    db.prepare(`UPDATE sources SET blob_sha = ? WHERE id = ?`).run(
      emptySha,
      imported.sourceId,
    );
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
          sources: [
            {
              title: "bad",
              sha: "0".repeat(64),
              bytes: 3,
              data: fresh.toString("base64"),
            },
          ],
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
            {
              title: "one",
              sha: firstSha,
              bytes: 3,
              data: first.toString("base64"),
            },
            {
              title: "two",
              sha: "0".repeat(64),
              bytes: 3,
              data: second.toString("base64"),
            },
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
    const count = db.prepare(`SELECT COUNT(*) AS n FROM plans`).get() as {
      n: number;
    };
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

it("carries lessons, questions, maps and quoted citations into a fresh workspace twice", () => {
  const db = openDatabase(":memory:");
  const source = importSmartbook(
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
    title: "Portable",
    sourceIds: [source.sourceId],
  });
  const topic = db
    .prepare("SELECT id FROM topics WHERE plan_id=?")
    .get(plan.planId) as { id: string };
  const passage = db
    .prepare("SELECT id FROM passages WHERE source_id=?")
    .get(source.sourceId) as { id: string };
  const book = db
    .prepare("SELECT id FROM smartbooks WHERE source_id=?")
    .get(source.sourceId) as { id: string };
  const key = JSON.stringify({
    kind: "lesson",
    scopeId: topic.id,
    promptVersion: "book-1",
    passageIds: [passage.id],
  });
  db.prepare(
    "INSERT INTO exercises(id,smartbook_id,prompt,answer,locator_json,created_at) VALUES('ex',?,'Quanto?','2',?,1)",
  ).run(book.id, JSON.stringify({ chapter: 1, exercise: "e1", kind: "esame" }));
  db.prepare(
    "INSERT INTO items(id,plan_id,topic_id,kind,body_json,grounding,created_at) VALUES('lesson',?,?,'lesson',?,'sources',1)",
  ).run(
    plan.planId,
    topic.id,
    JSON.stringify({
      cacheKey: key,
      markdown: 'A vector [P1].\n\n:::exercise{id="ex"}\nQuanto?\n:::',
    }),
  );
  db.prepare(
    "INSERT INTO item_passages(item_id,passage_id) VALUES('lesson',?)",
  ).run(passage.id);
  db.prepare(
    "INSERT INTO items(id,plan_id,topic_id,kind,body_json,grounding,created_at) VALUES('quiz',?,?,'quiz',?,'sources',2)",
  ).run(
    plan.planId,
    topic.id,
    JSON.stringify({
      questions: [
        {
          id: "question",
          sourceId: "ex",
          sourceIds: [passage.id],
          topicId: topic.id,
          stem: "Quanto?",
          answer: { kind: "completion", accepted: [["2"]] },
        },
      ],
      picks: { question: "1" },
      result: { score: 0 },
    }),
  );
  const nodes = [
    {
      id: "root",
      label: "Moti",
      parent: null,
      x: 0,
      y: 0,
      pinned: true,
      sources: [passage.id],
    },
    {
      id: "leaf",
      label: "Vettore",
      parent: "root",
      x: 200,
      y: 100,
      pinned: false,
      sources: [passage.id],
    },
  ];
  const graph = {
    layout: "radial",
    nodes,
    edges: [{ from: "root", to: "leaf" }],
    undo: { nodes, edges: [{ from: "root", to: "leaf" }], layout: "tree" },
  };
  db.prepare(
    "INSERT INTO maps(id,plan_id,topic_id,graph_json,grounding,created_at) VALUES('map',?,?,?,'sources',3)",
  ).run(
    plan.planId,
    topic.id,
    JSON.stringify({
      version: 1,
      maps: [{ id: "entry", title: "Moti", passageIds: [passage.id], graph }],
    }),
  );
  db.prepare(
    "INSERT INTO cards(id,plan_id,topic_id,front,back,passage_id,grounding,created_at) VALUES('card',?,?,'$v$','Vector',?,NULL,4)",
  ).run(plan.planId, topic.id, passage.id);
  const file = exportPlan(db, plan.planId);
  expect(file.version).toBe(2);
  expect(file.items?.find((i) => i.kind === "quiz")?.body).not.toHaveProperty(
    "picks",
  );
  const fresh = openDatabase(":memory:");
  const first = importPlan(fresh, file, 10_000);
  const second = importPlan(fresh, file, 10_000);
  expect(first).not.toBe(second);
  const copies = [first, second].map((id) => exportPlan(fresh, id));
  expect(copies[0]?.topics[0]?.id).not.toBe(copies[1]?.topics[0]?.id);
  for (const copy of copies) {
    const p = copy.passages![0]!;
    const t = copy.topics[0]!;
    expect(p.text).toBe(file.passages![0]!.text);
    expect(p.textSha).toBe(file.passages![0]!.textSha);
    expect(p.locator).toEqual({ chapter: 1, paragraph: "p1" });
    expect(copy.cards[0]?.passageId).toBe(p.id);
    expect(copy.cards[0]?.grounding).toBe("sources");
    expect(t.passageIds).toEqual([p.id]);
    const lesson = copy.items!.find((i) => i.kind === "lesson")!;
    const content = lesson.body as { markdown: string; cacheKey: string };
    expect(content.markdown).toContain("[P1]");
    expect(content.markdown).toContain(`id="${copy.exercises![0]!.id}"`);
    expect(
      loadLesson(fresh, {
        planId: copy.id!,
        kind: "lesson",
        key: content.cacheKey,
      }),
    ).toEqual({ markdown: content.markdown, passageIds: [p.id] });
    expect(topicExercises(fresh, t.id!).map((exercise) => exercise.id)).toEqual(
      [copy.exercises![0]!.id],
    );
    expect(JSON.parse(content.cacheKey)).toMatchObject({
      scopeId: t.id,
      passageIds: [p.id],
    });
    expect(copy.documents![0]!.tree).toMatchObject({
      kind: "excerpt",
      chapters: [{ id: "c1" }],
    });
    const q = (
      copy.items!.find((i) => i.kind === "quiz")!.body as {
        questions: {
          id: string;
          sourceId: string;
          sourceIds: string[];
          topicId: string;
        }[];
      }
    ).questions[0]!;
    expect(q.id).not.toBe("question");
    expect(q.sourceId).toBe(copy.exercises![0]!.id);
    expect(q.sourceIds).toEqual([p.id]);
    expect(q.topicId).toBe(t.id);
    const importedGraph = copy.maps![0]!.entries[0]!.graph;
    expect(importedGraph.layout).toBe("radial");
    expect(importedGraph.nodes[0]).toMatchObject({
      pinned: true,
      x: 0,
      y: 0,
      sources: [p.id],
    });
    expect(importedGraph.nodes[1]?.parent).toBe(importedGraph.nodes[0]?.id);
    expect(importedGraph.undo?.nodes[0]?.id).toBe(importedGraph.nodes[0]?.id);
    expect(importedGraph.nodes[0]?.id).not.toBe("root");
    expect(fresh.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  }
});

it("rejects a corrupted quote or dangling citation without inserting a plan", () => {
  const db = openDatabase(":memory:");
  const text = "An excerpt";
  const base = {
    version: 2 as const,
    id: "plan",
    title: "Bad",
    topics: [],
    nodes: [],
    cards: [],
    sources: [{ id: "source", title: "Source", sha: null, bytes: 0 }],
    passages: [
      {
        id: "passage",
        sourceId: "source",
        documentId: null,
        version: 1,
        text,
        textSha: createHash("sha256").update(text).digest("hex"),
        sourceSha: null,
        locator: null,
        section: null,
        charStart: null,
        charEnd: null,
      },
    ],
  };
  expect(() =>
    importPlan(db, {
      ...base,
      passages: [{ ...base.passages[0]!, text: "Changed" }],
    }),
  ).toThrow("plan-file");
  expect(() =>
    importPlan(db, {
      ...base,
      cards: [{ front: "A", back: "B", topic: null, passageId: "missing" }],
    }),
  ).toThrow("plan-file");
  expect(db.prepare("SELECT COUNT(*) AS n FROM plans").get()).toEqual({ n: 0 });
});

it("includes source exercise passages outside the selected topic", () => {
  const db = openDatabase(":memory:");
  const source = importSmartbook(
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
    title: "Selected",
    sourceIds: [source.sourceId],
  });
  db.prepare(
    "DELETE FROM topic_passages WHERE topic_id IN (SELECT id FROM topics WHERE plan_id=?)",
  ).run(plan.planId);
  const passage = db
    .prepare("SELECT id FROM passages WHERE source_id=?")
    .get(source.sourceId) as { id: string };
  const book = db
    .prepare("SELECT id FROM smartbooks WHERE source_id=?")
    .get(source.sourceId) as { id: string };
  db.prepare(
    "INSERT INTO exercises(id,smartbook_id,passage_id,prompt,answer,locator_json,created_at) VALUES('outside',?,?,'Quanto?','2','{}',1)",
  ).run(book.id, passage.id);
  const file = exportPlan(db, plan.planId);
  expect(file.passages!.map((p) => p.id)).toEqual([passage.id]);
  const fresh = openDatabase(":memory:");
  const copy = exportPlan(fresh, importPlan(fresh, file));
  expect(copy.exercises![0]!.passageId).toBe(copy.passages![0]!.id);
});

it("round-trips manual cards with nullable grounding honestly", () => {
  const db = openDatabase(":memory:");
  const plan = createPlan(db, { title: "Manual", sourceIds: [] });
  db.prepare(
    "INSERT INTO cards(id,plan_id,front,back,grounding,created_at) VALUES('manual',?,'Question','Answer',NULL,1)",
  ).run(plan.planId);
  const file = exportPlan(db, plan.planId);
  expect(file.cards[0]?.grounding).toBe("general");
  expect(() => planFileSchema.parse(file)).not.toThrow();
  const fresh = openDatabase(":memory:");
  const copy = importPlan(fresh, file);
  expect(exportPlan(fresh, copy).cards[0]?.grounding).toBe("general");
});

it("rejects malformed imported question bodies before writing the database", () => {
  const db = openDatabase(":memory:");
  const base = {
    version: 2 as const,
    title: "Broken quiz",
    topics: [],
    nodes: [],
    cards: [],
    items: [
      {
        id: "quiz",
        kind: "quiz" as const,
        topic: null,
        passageIds: [],
        grounding: "general" as const,
        provider: null,
        model: null,
        body: {
          questions: [
            {
              id: "q",
              stem: "Pick one",
              options: ["A", "B"],
              answer: { kind: "mcq", correct: 9 },
            },
          ],
        },
      },
    ],
  };
  expect(() => importPlan(db, base)).toThrow();
  expect(() =>
    importPlan(db, {
      ...base,
      items: [
        {
          ...base.items[0]!,
          body: {
            questions: [
              {
                id: "q",
                stem: "Fill",
                answer: { kind: "completion", accepted: "answer" },
              },
            ],
          },
        },
      ],
    }),
  ).toThrow();
  expect(() =>
    importPlan(db, {
      ...base,
      items: [
        {
          ...base.items[0]!,
          body: {
            questions: [
              {
                id: "q",
                stem: "True?",
                sourceIds: [42],
                answer: { kind: "tf", correct: true },
              },
            ],
          },
        },
      ],
    }),
  ).toThrow();
  expect(() =>
    importPlan(db, {
      ...base,
      items: [{ ...base.items[0]!, kind: "lesson", body: { markdown: null } }],
    }),
  ).toThrow();
  expect(db.prepare("SELECT COUNT(*) AS n FROM plans").get()).toEqual({ n: 0 });
  expect(db.prepare("SELECT COUNT(*) AS n FROM items").get()).toEqual({ n: 0 });
});

it("assigns stable scoped IDs to otherwise valid older questions without IDs", () => {
  const db = openDatabase(":memory:");
  const plan = createPlan(db, { title: "Older questions", sourceIds: [] });
  const question = {
    stem: "Fill",
    answer: { kind: "completion", accepted: [["2"]] },
  };
  db.prepare(
    "INSERT INTO items(id,plan_id,kind,body_json,grounding,created_at) VALUES('old-quiz',?,'quiz',?,'general',1)",
  ).run(
    plan.planId,
    JSON.stringify({
      questions: [question, question],
      metadata: { revision: 1 },
    }),
  );
  const file = exportPlan(db, plan.planId);
  const body = file.items![0]!.body as {
    questions: { id: string; answer: unknown }[];
    metadata: unknown;
  };
  expect(body.questions[0]!.id).toMatch(/^pyxis-question-/);
  expect(body.questions[0]!.id).not.toBe(body.questions[1]!.id);
  expect(exportPlan(db, plan.planId).items![0]!.body).toEqual(body);
  expect(body.questions[0]!.answer).toEqual(question.answer);
  const fresh = openDatabase(":memory:");
  const copy = exportPlan(fresh, importPlan(fresh, file));
  const copied = copy.items![0]!.body as typeof body;
  expect(copied.questions[0]!.id).not.toBe(body.questions[0]!.id);
  expect(copied.questions[0]!.answer).toEqual(question.answer);
  expect(copied.metadata).toEqual({ revision: 1 });
  const rawFile = {
    ...file,
    items: [{ ...file.items![0]!, body: { questions: [question] } }],
  };
  const importedRaw = exportPlan(fresh, importPlan(fresh, rawFile));
  expect(
    (importedRaw.items![0]!.body as typeof body).questions[0]!.id,
  ).toBeTruthy();
  expect(
    db.prepare("SELECT body_json FROM items WHERE id='old-quiz'").get(),
  ).toEqual({
    body_json: JSON.stringify({
      questions: [question, question],
      metadata: { revision: 1 },
    }),
  });
});
