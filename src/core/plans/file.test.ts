import { strToU8, zipSync } from "fflate";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../db/connection";
import { putBlob, readBlob } from "../blobs";
import { createHash } from "node:crypto";
import { createPlan, readPlan } from "./create";
import { exportPlan, importPlan } from "./file";
import { planMastery, syncGaps } from "./progress";
import { insertGap, mergeGap } from "../study/gapRows";
import { passageIdentity } from "./rebuild";
import { saveQuiz, startAttempt } from "../study/attempt";
import { listSimulations } from "../study/simulation";
import {
  examInstant,
  httpPlanUrl,
  planFileSchema,
} from "../../shared/plan-file";
import { importSmartbook, smartbookChapters } from "../sources/smartbook";
import { loadLesson } from "../study/lesson";
import { topicExercises } from "../study/exercises";
import { deleteCard, rateCard } from "../study/cards";
import { planHandlers } from "./handlers";
import { saveProfile } from "../profile/profile";
import { planOrigin } from "./views";
import {
  importRequest,
  previewPlan,
} from "../../renderer/src/features/plans/importPreview";

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
       VALUES ('rev-1', 'card-1', 'good', '{"dueAt":90000,"intervalDays":0,"ease":2.5}', ?)`,
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
      state: { dueAt: 90000, intervalDays: 0, ease: 2.5 },
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
    expect(scores[0]?.mastery).toBeCloseTo(0.25); // Future evidence and suspended cards do not count.
    const review = db
      .prepare(
        `SELECT rating, state_json FROM card_reviews
         WHERE card_id = (SELECT id FROM cards WHERE plan_id = ?)`,
      )
      .get(restored) as { rating: string; state_json: string };
    expect(review.rating).toBe("good");
    expect(JSON.parse(review.state_json)).toEqual({
      dueAt: 90000,
      intervalDays: 0,
      ease: 2.5,
    });
    expect(readPlan(db, restored)?.steps[0]?.activity).toBe("intro");
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
    redo: { nodes, edges: [{ from: "root", to: "leaf" }], layout: "radial" },
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
    ).toMatchObject({ markdown: content.markdown, passageIds: [p.id] });
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
    expect(importedGraph.redo?.nodes[0]?.id).toBe(importedGraph.nodes[0]?.id);
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

it("rejects malformed imported card schedules before creating any rows", () => {
  const db = openDatabase(":memory:");
  try {
    const base = {
      version: 1 as const,
      title: "Imported",
      topics: [{ title: "Topic", position: 0 }],
      nodes: [],
      cards: [{ front: "F", back: "B", topic: 0 }],
    };
    expect(planFileSchema.safeParse(base).success).toBe(true);
    const invalid = [
      {
        rating: "other",
        state: { intervalDays: 1, ease: 2.5, dueAt: 1000 },
        at: 1,
      },
      {
        rating: "good",
        state: { intervalDays: -1, ease: 2.5, dueAt: 1000 },
        at: 1,
      },
      {
        rating: "good",
        state: { intervalDays: 1, ease: 2.5, dueAt: 1e30 },
        at: 1,
      },
      {
        rating: "good",
        state: {
          intervalDays: 1,
          ease: 2.5,
          dueAt: 1000,
          fsrs: { due: "invalid" },
        },
        at: 1,
      },
    ];
    for (const schedule of invalid) {
      expect(() =>
        importPlan(db, {
          ...base,
          cards: [{ ...base.cards[0]!, schedule }],
        } as unknown as Parameters<typeof importPlan>[1]),
      ).toThrow();
      expect(
        (db.prepare("SELECT COUNT(*) AS n FROM plans").get() as { n: number })
          .n,
      ).toBe(0);
      expect(
        (
          db.prepare("SELECT COUNT(*) AS n FROM card_reviews").get() as {
            n: number;
          }
        ).n,
      ).toBe(0);
    }
  } finally {
    db.close();
  }
});

function bookPlan(db: ReturnType<typeof openDatabase>) {
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
      "esercizi.md":
        ':::exercise{id="e1" chapter="1"}\nQuanto vale il lavoro?\n:::solution\nW = F s.\n:::\n:::\n',
    }),
  );
  const plan = createPlan(db, {
    title: "Fisica 1",
    sourceIds: [source.sourceId],
  });
  const topic = db
    .prepare("SELECT id FROM topics WHERE plan_id=?")
    .get(plan.planId) as { id: string };
  return { planId: plan.planId, topicId: topic.id };
}

describe("progress that names removed cards", () => {
  it("exports a rated card that was deleted or soft-removed and still imports with its evidence", () => {
    const db = openDatabase(":memory:");
    const { planId, topicId } = bookPlan(db);
    const insert = db.prepare(
      `INSERT INTO cards (id, plan_id, topic_id, front, back, grounding, seed_key, created_at)
       VALUES (?, ?, ?, ?, 'retro', 'sources', ?, 1)`,
    );
    insert.run("keep", planId, topicId, "tenuta", null);
    insert.run("hard-gone", planId, topicId, "cancellata", null);
    insert.run("soft-gone", planId, topicId, "rimossa", "seed-1");
    const now = Date.now();
    rateCard(db, "keep", "good", now - 3000);
    rateCard(db, "hard-gone", "again", now - 2000);
    rateCard(db, "soft-gone", "hard", now - 1000);
    deleteCard(db, "hard-gone");
    deleteCard(db, "soft-gone");

    const file = exportPlan(db, planId, { progress: true });
    const rated = file.progress!.filter((event) => event.kind === "card_rated");
    expect(rated.map((event) => event.payload)).toEqual([
      { score: 1, cardId: "keep" },
      { score: 0 },
      { score: 0.5 },
    ]);

    const fresh = openDatabase(":memory:");
    const copy = importPlan(fresh, planFileSchema.parse(file), now);
    const events = fresh
      .prepare(
        "SELECT payload_json FROM learning_events WHERE plan_id=? AND kind='card_rated' ORDER BY created_at",
      )
      .all(copy) as { payload_json: string }[];
    const keptId = (
      fresh.prepare("SELECT id FROM cards WHERE plan_id=?").get(copy) as {
        id: string;
      }
    ).id;
    expect(events.map((row) => JSON.parse(row.payload_json))).toEqual([
      { score: 1, cardId: keptId },
      { score: 0 },
      { score: 0.5 },
    ]);
    // Deleted cards still count toward mastery on both sides.
    expect(planMastery(fresh, copy, now).map((t) => t.mastery)).toEqual(
      planMastery(db, planId, now).map((t) => t.mastery),
    );
  });

  it("still rejects a file whose progress names a card it does not contain", () => {
    const db = openDatabase(":memory:");
    const { planId, topicId } = bookPlan(db);
    db.prepare(
      `INSERT INTO cards (id, plan_id, topic_id, front, back, grounding, created_at)
       VALUES ('c', ?, ?, 'f', 'b', 'sources', 1)`,
    ).run(planId, topicId);
    const file = exportPlan(db, planId, { progress: true });
    const forged = {
      ...file,
      progress: [
        ...(file.progress ?? []),
        {
          kind: "card_rated" as const,
          topic: 0,
          payload: { score: 1, cardId: "ghost" },
          at: 5,
        },
      ],
    };
    const fresh = openDatabase(":memory:");
    expect(() => importPlan(fresh, forged)).toThrow("plan-file");
    expect(fresh.prepare("SELECT count(*) AS n FROM plans").get()).toEqual({
      n: 0,
    });
  });
});

describe("skipped smartbook", () => {
  it("keeps its exercises reachable, with citations, and adds no source row", () => {
    const db = openDatabase(":memory:");
    const { planId, topicId } = bookPlan(db);
    const file = planFileSchema.parse(exportPlan(db, planId));
    const request = importRequest(
      file,
      previewPlan(file, []),
      { 0: "skip" },
      {},
    );
    expect(request.exercises).toHaveLength(1);

    const fresh = openDatabase(":memory:");
    const copy = importPlan(fresh, request);
    const copyTopic = (
      fresh.prepare("SELECT id FROM topics WHERE plan_id=?").get(copy) as {
        id: string;
      }
    ).id;
    expect(fresh.prepare("SELECT count(*) AS n FROM sources").get()).toEqual({
      n: 0,
    });
    expect(fresh.prepare("SELECT count(*) AS n FROM smartbooks").get()).toEqual(
      { n: 0 },
    );
    const found = topicExercises(fresh, copyTopic);
    expect(found.map((row) => row.prompt)).toEqual(["Quanto vale il lavoro?"]);
    expect(found[0]?.answer).toContain("W = F");
    // The cited quote survives as a source-less passage the exercise points at.
    const passage = fresh
      .prepare("SELECT id, text, source_id FROM passages WHERE id=?")
      .get(found[0]!.passageId) as { text: string; source_id: string | null };
    expect(passage.text).toContain("vettore");
    expect(passage.source_id).toBeNull();
    expect(fresh.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    // The original plan is untouched and the exercise does not leak into other plans.
    expect(topicExercises(db, topicId)).toHaveLength(1);
    const other = bookPlan(fresh);
    expect(topicExercises(fresh, other.topicId)).toHaveLength(1);

    // Sharing the imported plan again keeps the exercise.
    const again = exportPlan(fresh, copy);
    expect(again.exercises).toHaveLength(1);
    expect(again.sources).toEqual([]);
    const third = openDatabase(":memory:");
    const thirdPlan = importPlan(third, planFileSchema.parse(again));
    const thirdTopic = (
      third.prepare("SELECT id FROM topics WHERE plan_id=?").get(thirdPlan) as {
        id: string;
      }
    ).id;
    expect(topicExercises(third, thirdTopic).map((row) => row.prompt)).toEqual([
      "Quanto vale il lavoro?",
    ]);
  });
});

describe("imported plan author and date (SHR-08)", () => {
  it("records the exporter's profile name and file date, and invents none", () => {
    const db = openDatabase(":memory:");
    const { planId } = bookPlan(db);
    const named = planHandlers(db).export({ planId });
    expect(named.author).toBeUndefined();
    saveProfile(db, { displayName: "  Giulia  " });
    const shared = planHandlers(db).export({ planId });
    expect(shared.author).toBe("Giulia");
    expect(
      planHandlers(db).export({ planId, author: false }).author,
    ).toBeUndefined();

    const fresh = openDatabase(":memory:");
    const copy = importPlan(fresh, shared, 9_000);
    expect(planOrigin(fresh, copy)).toMatchObject({
      imported: true,
      importedFrom: {
        author: "Giulia",
        exportedAt: shared.createdAt,
        importedAt: 9_000,
      },
    });
    const anonymous = importPlan(fresh, named, 9_100);
    expect(planOrigin(fresh, anonymous).importedFrom).toEqual({
      author: null,
      exportedAt: named.createdAt,
      importedAt: 9_100,
    });
    expect(planOrigin(db, planId)).toMatchObject({
      imported: false,
      importedFrom: null,
    });
  });
});

describe("progress keeps gap state (PRO-02, PRO-08)", () => {
  const t0 = 1_700_000_000_000;
  const mcq = (id: string, topicId: string) => ({
    id,
    topicId,
    stem: id,
    options: ["a", "b"],
    grade: { kind: "mcq" as const, picked: 0, correct: 1 },
  });

  /** Two distinct open gaps on one topic and a third merged into the second, each with answers, a drill and a review. */
  function gapPlan() {
    const db = openDatabase(":memory:");
    const { planId, topicId } = bookPlan(db);
    const quiz = saveQuiz(db, planId, [mcq("q1", topicId), mcq("q2", topicId)], t0 - 100);
    const drill = saveQuiz(db, planId, [mcq("d1", topicId), mcq("d2", topicId)], t0 - 90);
    db.prepare("UPDATE items SET body_json = json_set(body_json, '$.explanation', 'PRIVATE-SENTINEL you confused speed with velocity') WHERE id = ?").run(drill);
    const review = saveQuiz(db, planId, [{ ...mcq("r1", topicId) }], t0 - 80);
    db.prepare("UPDATE items SET kind = 'review' WHERE id = ?").run(review);
    db.prepare("INSERT INTO items (id, plan_id, kind, body_json, grounding, created_at) VALUES ('session', ?, 'review_session', '{\"cardIds\":[],\"drills\":[]}', 'sources', ?)").run(planId, t0 - 70);
    const attempt = (itemId: string, at: number) => {
      const { attemptId } = startAttempt(db, planId, itemId, at);
      db.prepare("UPDATE attempts SET submitted_at = ? WHERE id = ?").run(at + 1, attemptId);
      return attemptId;
    };
    const a1 = attempt(quiz, t0 - 5);
    const a2 = attempt(drill, t0 + 19);
    const a3 = attempt(review, t0 + 29);
    const gapA = insertGap(db, { planId, topicId, openedAt: t0, origin: "answers", misconception: "thinks v=a", severity: "minor" });
    const gapB = insertGap(db, { planId, topicId, openedAt: t0 + 5, origin: "misconception", misconception: "confuses speed with velocity", severity: "severe" });
    const gapC = insertGap(db, { planId, topicId, openedAt: t0 + 6, origin: "misconception", misconception: "speed is velocity", severity: "minor" });
    mergeGap(db, gapC, gapB, t0 + 50);
    const event = (at: number, attemptId: string, scored: Array<[string, number]>) =>
      db
        .prepare("INSERT INTO learning_events (id, kind, plan_id, topic_id, payload_json, created_at) VALUES (?, 'answer_given', ?, ?, ?, ?)")
        .run(
          `ev-${at}`,
          planId,
          topicId,
          JSON.stringify({
            score: scored.reduce((sum, [, score]) => sum + score, 0) / scored.length,
            scores: scored.map(([, score]) => score),
            evidenceKind: "quiz",
            attemptId,
            questionScores: scored.map(([id, score]) => ({ id, kind: "mcq", score })),
          }),
          at,
        );
    event(t0, a1, [["q1", 0], ["q2", 0]]);
    event(t0 + 20, a2, [["d1", 0], ["d2", 1]]);
    event(t0 + 30, a3, [["r1", 0]]);
    const link = db.prepare("INSERT INTO gap_answers (gap_id, attempt_id, question_id) VALUES (?, ?, ?)");
    link.run(gapA, a1, "q1");
    link.run(gapB, a1, "q2");
    link.run(gapB, a2, "d1");
    link.run(gapB, a3, "r1");
    db.prepare("INSERT INTO gap_items (gap_id, item_id) VALUES (?, ?)").run(gapB, drill);
    db.prepare("UPDATE items SET body_json = json_set(body_json, '$.questions[0].gapId', ?) WHERE id = ?").run(gapB, review);
    syncGaps(db, planId, t0 + 100);
    return { db, planId, topicId, gaps: { gapA, gapB, gapC }, attempts: [a1, a2, a3], items: { quiz, drill, review } };
  }

  const eventCounts = (db: ReturnType<typeof openDatabase>, planId: string) =>
    db
      .prepare("SELECT kind, count(*) AS n FROM learning_events WHERE plan_id = ? AND kind LIKE 'gap_%' GROUP BY kind ORDER BY kind")
      .all(planId);

  it("round-trips distinct gaps, their answers and drill, with fresh IDs and one event each", () => {
    const { db, planId, gaps, attempts, items } = gapPlan();
    expect(eventCounts(db, planId)).toEqual([
      { kind: "gap_closed", n: 1 },
      { kind: "gap_opened", n: 3 },
    ]);
    const file = planFileSchema.parse(JSON.parse(JSON.stringify(exportPlan(db, planId, { progress: true }))));
    expect(file.version).toBe(2);
    expect(file.gaps).toHaveLength(3);
    expect(file.attempts).toHaveLength(3);
    expect(file.gapAnswers).toHaveLength(4);
    expect(file.gapItems).toEqual([{ gap: gaps.gapB, item: items.drill }]);
    // The finished review travels as a quiz; its session queue never does.
    expect(file.items?.map((item) => item.kind).sort()).toEqual(["quiz", "quiz", "quiz"]);

    const fresh = openDatabase(":memory:");
    const copy = importPlan(fresh, file, t0 + 500);
    const rows = fresh
      .prepare("SELECT id, topic_id, opened_at, closed_at, origin, misconception, severity, merged_into FROM gaps WHERE plan_id = ? ORDER BY opened_at")
      .all(copy) as Array<Record<string, unknown>>;
    expect(rows.map((row) => [row.misconception, row.severity, row.origin, row.closed_at, row.opened_at])).toEqual([
      ["thinks v=a", "minor", "answers", null, t0],
      ["confuses speed with velocity", "severe", "misconception", null, t0 + 5],
      ["speed is velocity", "minor", "misconception", t0 + 50, t0 + 6],
    ]);
    const [a, b, c] = rows as Array<{ id: string; merged_into: string | null }>;
    expect(c!.merged_into).toBe(b!.id);
    expect(new Set([a!.id, b!.id, c!.id]).size).toBe(3);
    for (const old of Object.values(gaps)) expect(rows.map((row) => row.id)).not.toContain(old);

    const links = fresh
      .prepare("SELECT ga.gap_id AS gap, ga.attempt_id AS attempt, ga.question_id AS q FROM gap_answers ga JOIN gaps g ON g.id = ga.gap_id WHERE g.plan_id = ?")
      .all(copy) as Array<{ gap: string; attempt: string; q: string }>;
    expect(links).toHaveLength(4);
    const questionIds = (fresh.prepare("SELECT body_json FROM items WHERE plan_id = ?").all(copy) as Array<{ body_json: string }>).flatMap(
      (row) => (JSON.parse(row.body_json) as { questions: Array<{ id: string }> }).questions.map((q) => q.id),
    );
    for (const link of links) {
      expect(questionIds).toContain(link.q);
      expect(fresh.prepare("SELECT 1 FROM attempts WHERE id = ? AND plan_id = ?").get(link.attempt, copy)).toBeTruthy();
    }
    expect(links.filter((link) => link.gap === a!.id)).toHaveLength(1);
    expect(links.filter((link) => link.gap === b!.id)).toHaveLength(3);
    const drill = fresh
      .prepare("SELECT gi.gap_id AS gap, i.plan_id AS plan FROM gap_items gi JOIN items i ON i.id = gi.item_id")
      .all() as Array<{ gap: string; plan: string }>;
    expect(drill).toEqual([{ gap: b!.id, plan: copy }]);
    const reviewBody = JSON.parse(
      (fresh.prepare("SELECT body_json FROM items WHERE plan_id = ? AND json_extract(body_json, '$.questions[0].gapId') IS NOT NULL").get(copy) as { body_json: string }).body_json,
    ) as { questions: Array<{ gapId: string }> };
    expect(reviewBody.questions[0]!.gapId).toBe(b!.id);

    // Events carry the new IDs only, once each, and a later sync adds none.
    expect(eventCounts(fresh, copy)).toEqual(eventCounts(db, planId));
    const dump = JSON.stringify([
      fresh.prepare("SELECT payload_json FROM learning_events WHERE plan_id = ?").all(copy),
      fresh.prepare("SELECT body_json FROM items WHERE plan_id = ?").all(copy),
    ]);
    for (const old of [...Object.values(gaps), ...attempts, ...Object.values(items)]) expect(dump).not.toContain(old);
    const closed = fresh.prepare("SELECT payload_json FROM learning_events WHERE plan_id = ? AND kind = 'gap_closed'").get(copy) as { payload_json: string };
    expect(JSON.parse(closed.payload_json)).toMatchObject({ gapId: c!.id, reason: "merged", into: b!.id });
    syncGaps(fresh, copy, t0 + 1000);
    expect(eventCounts(fresh, copy)).toEqual(eventCounts(db, planId));
    expect(fresh.prepare("SELECT count(*) AS n FROM gaps WHERE plan_id = ?").get(copy)).toEqual({ n: 3 });
    expect(fresh.prepare("SELECT count(*) AS n FROM gap_answers").get()).toEqual({ n: 4 });
    // The source plan is untouched, and a second import gets its own IDs.
    const again = importPlan(fresh, file, t0 + 600);
    expect(fresh.prepare("SELECT count(*) AS n FROM gaps WHERE plan_id = ?").get(again)).toEqual({ n: 3 });
    expect(fresh.prepare("SELECT count(DISTINCT id) AS n FROM gaps").get()).toEqual({ n: 6 });
    expect(eventCounts(db, planId)).toEqual([
      { kind: "gap_closed", n: 1 },
      { kind: "gap_opened", n: 3 },
    ]);
  });

  it("leaves gap state, attempts, drills and reviews out unless progress is asked for", () => {
    const { db, planId } = gapPlan();
    const file = exportPlan(db, planId);
    for (const key of ["gaps", "attempts", "gapAnswers", "gapItems", "progress"] as const) expect(file[key]).toBeUndefined();
    // Only the ordinary quiz stays: the drill's explanation is written from the student's wrong answers.
    expect(file.items?.map((item) => item.kind)).toEqual(["quiz"]);
    expect(JSON.stringify(file)).not.toContain("thinks v=a");
    expect(JSON.stringify(file)).not.toContain("PRIVATE-SENTINEL");
    const fresh = openDatabase(":memory:");
    const copy = importPlan(fresh, planFileSchema.parse(file), t0);
    expect(fresh.prepare("SELECT count(*) AS n FROM gaps WHERE plan_id = ?").get(copy)).toEqual({ n: 0 });
    expect(fresh.prepare("SELECT count(*) AS n FROM attempts").get()).toEqual({ n: 0 });
    expect(JSON.stringify(fresh.prepare("SELECT body_json FROM items").all())).not.toContain("PRIVATE-SENTINEL");
    // With progress the drill travels, linked to its gap.
    const withProgress = planFileSchema.parse(JSON.parse(JSON.stringify(exportPlan(db, planId, { progress: true }))));
    expect(JSON.stringify(withProgress)).toContain("PRIVATE-SENTINEL");
    expect(withProgress.gapItems).toHaveLength(1);
  });

  it("carries a passage cited only by a drill, a finished review or the session queue only with progress", () => {
    const { db, planId, items } = gapPlan();
    const source = db.prepare("SELECT source_id AS id FROM passages LIMIT 1").get() as { id: string };
    const passage = db.prepare("INSERT INTO passages (id, source_id, version, text, created_at) VALUES (?, ?, 1, ?, ?)");
    const cite = db.prepare("INSERT INTO item_passages (item_id, passage_id) VALUES (?, ?)");
    const quote = (name: string) => `PASSAGE-${name} quoted only by a private item`;
    for (const [id, item] of [
      ["p-drill", items.drill],
      ["p-review", items.review],
      ["p-session", "session"],
      ["p-quiz", items.quiz],
    ] as const) {
      passage.run(id, source.id, quote(id), t0);
      cite.run(item, id);
    }
    const plain = JSON.stringify(exportPlan(db, planId));
    expect(plain).toContain(quote("p-quiz"));
    for (const name of ["p-drill", "p-review", "p-session"]) expect(plain).not.toContain(quote(name));
    const full = planFileSchema.parse(JSON.parse(JSON.stringify(exportPlan(db, planId, { progress: true }))));
    const texts = full.passages?.map((p) => p.text) ?? [];
    expect(texts).toContain(quote("p-quiz"));
    expect(texts).toContain(quote("p-drill"));
    expect(texts).toContain(quote("p-review"));
    // The session queue never travels, so neither do its passages.
    expect(texts).not.toContain(quote("p-session"));
    expect(() => importPlan(openDatabase(":memory:"), full, t0)).not.toThrow();
  });

  it("does not show an imported simulation attempt as scored history", () => {
    const { db, planId, topicId } = gapPlan();
    const sim = saveQuiz(db, planId, [mcq("s1", topicId)], t0 + 300);
    db.prepare("UPDATE items SET kind = 'simulation', body_json = json_set(body_json, '$.minutes', 30) WHERE id = ?").run(sim);
    const { attemptId } = startAttempt(db, planId, sim, t0 + 310);
    db.prepare("UPDATE attempts SET submitted_at = ? WHERE id = ?").run(t0 + 310 + 600_000, attemptId);
    db.prepare("INSERT INTO attempt_answers (id, attempt_id, payload_json, created_at) VALUES ('sim-answer', ?, ?, ?)").run(
      attemptId,
      JSON.stringify({ score: 1, results: [{ score: 1 }] }),
      t0 + 320,
    );
    // As the grader does, the attempt is named by its answer event, which is how it travels.
    db.prepare("INSERT INTO learning_events (id, kind, plan_id, topic_id, payload_json, created_at) VALUES ('ev-sim', 'answer_given', ?, ?, ?, ?)").run(
      planId,
      topicId,
      JSON.stringify({ score: 1, scores: [1], evidenceKind: "simulation", attemptId }),
      t0 + 330,
    );
    expect(listSimulations(db, planId)).toEqual([{ id: attemptId, at: t0 + 310 + 600_000, score: 1, minutes: 10 }]);
    const file = planFileSchema.parse(JSON.parse(JSON.stringify(exportPlan(db, planId, { progress: true }))));
    expect(file.attempts?.some((a) => a.item != null && a.submittedAt === t0 + 310 + 600_000)).toBe(true);
    const fresh = openDatabase(":memory:");
    const copy = importPlan(fresh, file, t0 + 500);
    expect(fresh.prepare("SELECT count(*) AS n FROM attempts a JOIN items i ON i.id = a.item_id WHERE a.plan_id = ? AND i.kind = 'simulation'").get(copy)).toEqual({ n: 1 });
    // The copy keeps the attempt for gap links but has no result to show, so it is not listed with an invented 0 %.
    expect(listSimulations(fresh, copy)).toEqual([]);
  });

  it("exports a review only when it was finished", () => {
    const { db, planId, topicId } = gapPlan();
    // An unfinished review (open attempt, empty questions) and one never started; an unfinished ordinary quiz.
    const open = saveQuiz(db, planId, [], t0 + 200);
    const never = saveQuiz(db, planId, [mcq("n1", topicId)], t0 + 201);
    const plain = saveQuiz(db, planId, [mcq("p1", topicId)], t0 + 202);
    db.prepare("UPDATE items SET kind = 'review' WHERE id IN (?, ?)").run(open, never);
    startAttempt(db, planId, open, t0 + 210);
    startAttempt(db, planId, plain, t0 + 211);
    const ids = (progress: boolean) => exportPlan(db, planId, { progress }).items?.map((item) => item.id) ?? [];
    expect(ids(true)).toContain(plain);
    expect(ids(true)).not.toContain(open);
    expect(ids(true)).not.toContain(never);
    expect(ids(true)).toHaveLength(4);
    expect(ids(false)).toEqual([expect.any(String), plain]);
    const file = planFileSchema.parse(JSON.parse(JSON.stringify(exportPlan(db, planId, { progress: true }))));
    expect(() => importPlan(openDatabase(":memory:"), file, t0)).not.toThrow();
  });

  it("exports a legacy gap whose events were never written, with its merge reason, and the file imports", () => {
    const { db, planId, gaps } = gapPlan();
    db.prepare("DELETE FROM learning_events WHERE plan_id = ? AND kind LIKE 'gap_%'").run(planId);
    // The backfill itself records the merge.
    syncGaps(db, planId, t0 + 100);
    const backfilled = db
      .prepare("SELECT payload_json FROM learning_events WHERE plan_id = ? AND kind = 'gap_closed'")
      .all(planId) as Array<{ payload_json: string }>;
    expect(backfilled.map((row) => JSON.parse(row.payload_json))).toEqual([{ gapId: gaps.gapC, reason: "merged", into: gaps.gapB }]);
    // An export written straight from the rows is just as complete.
    db.prepare("DELETE FROM learning_events WHERE plan_id = ? AND kind LIKE 'gap_%'").run(planId);
    const file = planFileSchema.parse(JSON.parse(JSON.stringify(exportPlan(db, planId, { progress: true }))));
    expect(file.progress?.filter((event) => event.kind.startsWith("gap_")).map((event) => event.payload)).toEqual([
      { gapId: gaps.gapA, origin: "answers" },
      { gapId: gaps.gapB, origin: "misconception" },
      { gapId: gaps.gapC, origin: "misconception" },
      { gapId: gaps.gapC, reason: "merged", into: gaps.gapB },
    ]);
    const fresh = openDatabase(":memory:");
    const copy = importPlan(fresh, file, t0 + 500);
    expect(eventCounts(fresh, copy)).toEqual([
      { kind: "gap_closed", n: 1 },
      { kind: "gap_opened", n: 3 },
    ]);
    const again = planFileSchema.parse(JSON.parse(JSON.stringify(exportPlan(fresh, copy, { progress: true }))));
    expect(() => importPlan(openDatabase(":memory:"), again, t0)).not.toThrow();
  });

  it("validates a long merge chain linearly and rejects a loop", () => {
    // 30,000 gaps chained 0 -> 1 -> ... -> n; the old per-gap walk was quadratic and a recursive one overflows the stack.
    const { db, planId } = gapPlan();
    const base = planFileSchema.parse(JSON.parse(JSON.stringify(exportPlan(db, planId, { progress: true }))));
    const n = 30_000;
    const chain = (loop: boolean) => {
      const gaps = Array.from({ length: n }, (_, i) => ({
        id: `c${i}`,
        topic: 0,
        openedAt: t0 + i,
        closedAt: i === n - 1 && !loop ? null : t0 + n + i,
        origin: "misconception" as const,
        misconception: null,
        severity: null,
        comparison: null,
        mergedInto: i === n - 1 ? (loop ? "c0" : null) : `c${i + 1}`,
      }));
      const progress = gaps.flatMap((g) => [
        { kind: "gap_opened" as const, topic: 0, payload: { gapId: g.id, origin: g.origin }, at: g.openedAt },
        ...(g.closedAt == null
          ? []
          : [
              {
                kind: "gap_closed" as const,
                topic: 0,
                payload: { gapId: g.id, reason: "merged", into: g.mergedInto },
                at: g.closedAt,
              },
            ]),
      ]);
      return { ...base, items: [], gaps, attempts: [], gapAnswers: [], gapItems: [], progress };
    };
    const fresh = openDatabase(":memory:");
    const copy = importPlan(fresh, chain(false), t0);
    expect(fresh.prepare("SELECT count(*) AS n FROM gaps WHERE plan_id = ?").get(copy)).toEqual({ n: n });
    const loop = openDatabase(":memory:");
    expect(() => importPlan(loop, chain(true), t0)).toThrow("plan-file");
    expect(loop.prepare("SELECT count(*) AS n FROM plans").get()).toEqual({ n: 0 });
  }, 60_000);

  it("keeps an older progress file valid: its gap events and attempt IDs are dropped and the replay writes each gap once", () => {
    const db = openDatabase(":memory:");
    const { planId } = bookPlan(db);
    const base = exportPlan(db, planId, { progress: true });
    const {
      gaps: _gaps,
      attempts: _attempts,
      gapAnswers: _answers,
      gapItems: _items,
      ...older
    } = base;
    const legacy = planFileSchema.parse({
      ...older,
      progress: [
        { kind: "gap_opened", topic: 0, payload: { gapId: "old-gap", origin: "answers" }, at: t0 },
        {
          kind: "answer_given",
          topic: 0,
          payload: { score: 0, scores: [0, 0], attemptId: "old-attempt", questionScores: [{ id: "x", score: 0 }, { id: "y", score: 0 }] },
          at: t0,
        },
      ],
    });
    for (const version of [2, 1] as const) {
      const fresh = openDatabase(":memory:");
      const copy = importPlan(fresh, { ...legacy, version }, t0 + 10);
      expect(eventCounts(fresh, copy)).toEqual([]);
      expect(JSON.stringify(fresh.prepare("SELECT payload_json FROM learning_events").all())).not.toContain("old-");
      syncGaps(fresh, copy, t0 + 20);
      expect(eventCounts(fresh, copy)).toEqual([{ kind: "gap_opened", n: 1 }]);
      expect(fresh.prepare("SELECT count(*) AS n FROM gaps WHERE plan_id = ?").get(copy)).toEqual({ n: 1 });
      syncGaps(fresh, copy, t0 + 30);
      expect(eventCounts(fresh, copy)).toEqual([{ kind: "gap_opened", n: 1 }]);
    }
  });

  it("rejects dangling, looping, duplicated or mistimed gap state before writing anything", () => {
    const { db, planId, gaps } = gapPlan();
    const good = JSON.parse(JSON.stringify(exportPlan(db, planId, { progress: true }))) as ReturnType<typeof exportPlan>;
    const clone = () => JSON.parse(JSON.stringify(good)) as typeof good;
    const gapOf = (file: typeof good, id: string) => file.gaps!.find((gap) => gap.id === id)!;
    const lesson = { id: "lesson-x", topic: 0, kind: "lesson" as const, body: { markdown: "x" }, passageIds: [], grounding: null, provider: null, model: null };
    // The lesson item is fine on its own; only pointing a drill or an attempt at it is refused.
    const withLesson = clone();
    withLesson.items!.push(lesson);
    withLesson.attempts!.push({ id: "attempt-x", item: null, startedAt: t0, submittedAt: t0 + 1 });
    expect(() => importPlan(openDatabase(":memory:"), planFileSchema.parse(withLesson))).not.toThrow();
    const cases: Record<string, (file: typeof good) => void> = {
      "answer for an unknown gap": (file) => void (file.gapAnswers![0]!.gap = "ghost"),
      "answer for an unknown attempt": (file) => void (file.gapAnswers![0]!.attempt = "ghost"),
      "answer for a question the quiz lacks": (file) => void (file.gapAnswers![0]!.question = "ghost"),
      "the same answer twice": (file) => void file.gapAnswers!.push({ ...file.gapAnswers![0]! }),
      "drill for an unknown item": (file) => void (file.gapItems![0]!.item = "ghost"),
      "merge into an unknown gap": (file) => void (gapOf(file, gaps.gapC).mergedInto = "ghost"),
      "merge of an open gap": (file) => void (gapOf(file, gaps.gapA).mergedInto = gaps.gapB),
      "merge loop": (file) => {
        gapOf(file, gaps.gapB).closedAt = t0 + 60;
        gapOf(file, gaps.gapB).mergedInto = gaps.gapC;
      },
      "closed before it opened": (file) => void (gapOf(file, gaps.gapC).closedAt = t0),
      "attempt submitted before it started": (file) => void (file.attempts![0]!.submittedAt = 1),
      "attempt on an unknown quiz": (file) => void (file.attempts![0]!.item = "ghost"),
      "gap event for an unknown gap": (file) => {
        file.progress!.find((event) => event.kind === "gap_opened")!.payload = { gapId: "ghost" };
      },
      "gap opened event twice": (file) =>
        void file.progress!.push({ ...file.progress!.find((event) => event.kind === "gap_opened")! }),
      "event naming an unknown attempt": (file) => {
        (file.progress!.find((event) => event.kind === "answer_given")!.payload as { attemptId: string }).attemptId = "ghost";
      },
      "merge into a gap that merges into an unknown gap": (file) => {
        // a -> b -> ghost: the dangling target sits behind a gap that has not been checked yet.
        const [a, b] = [gapOf(file, gaps.gapA), gapOf(file, gaps.gapB)];
        a.closedAt = t0 + 60;
        a.mergedInto = b.id;
        b.closedAt = t0 + 61;
        b.mergedInto = "ghost";
      },
      "gap_opened carrying a merge target": (file) => {
        (file.progress!.find((event) => event.kind === "gap_opened")!.payload as Record<string, unknown>).into = gaps.gapB;
      },
      "merged close with no merge on the row": (file) => {
        const closed = file.progress!.find((event) => event.kind === "gap_closed")!.payload as Record<string, unknown>;
        gapOf(file, gaps.gapC).mergedInto = null;
        expect(closed.reason).toBe("merged");
      },
      "merged close into a different gap": (file) => {
        (file.progress!.find((event) => event.kind === "gap_closed")!.payload as Record<string, unknown>).into = gaps.gapA;
      },
      "answers close on a merged gap": (file) => {
        const closed = file.progress!.find((event) => event.kind === "gap_closed")!.payload as Record<string, unknown>;
        closed.reason = "answers";
        delete closed.into;
      },
      "unknown close reason": (file) => {
        (file.progress!.find((event) => event.kind === "gap_closed")!.payload as Record<string, unknown>).reason = "bored";
      },
      "gap_opened at another time": (file) => void (file.progress!.find((event) => event.kind === "gap_opened")!.at += 1),
      "gap_closed at another time": (file) => void (file.progress!.find((event) => event.kind === "gap_closed")!.at += 1),
      "gap_opened on another topic": (file) => void (file.progress!.find((event) => event.kind === "gap_opened")!.topic = null),
      "gap_opened with another origin": (file) => {
        (file.progress!.find((event) => event.kind === "gap_opened")!.payload as Record<string, unknown>).origin = "flag";
      },
      "a gap with no opened event": (file) => {
        file.progress = file.progress!.filter((event) => !(event.kind === "gap_opened" && (event.payload as { gapId: string }).gapId === gaps.gapA));
      },
      "a closed gap with no closed event": (file) => {
        file.progress = file.progress!.filter((event) => event.kind !== "gap_closed");
      },
      "gap rows with no events at all": (file) => void (file.progress = file.progress!.filter((event) => !event.kind.startsWith("gap_"))),
      "open attempt": (file) => void ((file.attempts![0] as { submittedAt: number | null }).submittedAt = null),
      "attempt on a lesson": (file) => {
        // No gap answer names it, so only the item's kind is wrong.
        file.items!.push(lesson);
        file.attempts!.push({ id: "attempt-x", item: lesson.id, startedAt: t0, submittedAt: t0 + 1 });
      },
      "drill that is a lesson": (file) => {
        file.items!.push(lesson);
        file.gapItems![0]!.item = lesson.id;
      },
      "gap links without gap rows": (file) => void delete file.gaps,
      "too many gaps": (file) => void (file.gaps = Array.from({ length: 100001 }, (_, i) => ({ ...file.gaps![0]!, id: `g${i}` }))),
    };
    for (const [name, damage] of Object.entries(cases)) {
      const file = clone();
      damage(file);
      const fresh = openDatabase(":memory:");
      expect(() => importPlan(fresh, planFileSchema.parse(file)), name).toThrow();
      expect(fresh.prepare("SELECT count(*) AS n FROM plans").get(), name).toEqual({ n: 0 });
      expect(fresh.prepare("SELECT count(*) AS n FROM gaps").get(), name).toEqual({ n: 0 });
    }
  });
});

describe("import lookups stay linear in a large file", () => {
  it("rejects duplicate document versions before writing embedded sources", () => {
    const db = openDatabase(":memory:");
    const workspace = mkdtempSync(join(tmpdir(), "pyxis-document-version-"));
    const bytes = Buffer.from("Source");
    const file = planFileSchema.parse({
      version: 2, title: "Duplicate", topics: [], nodes: [], cards: [],
      sources: [{ id: "source", title: "Source", sha: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length, data: bytes.toString("base64") }],
      documents: [
        { id: "doc1", sourceId: "source", version: 1, tree: {} },
        { id: "doc2", sourceId: "source", version: 1, tree: {} },
      ],
    });
    try {
      expect(() => importPlan(db, file, Date.now(), workspace)).toThrow(/^plan-file$/);
      expect(db.prepare("SELECT count(*) AS n FROM plans").get()).toEqual({ n: 0 });
      expect(db.prepare("SELECT count(*) AS n FROM sources").get()).toEqual({ n: 0 });
      expect(readdirSync(workspace)).toEqual([]);
    } finally {
      db.close();
      rmSync(workspace, { recursive: true, force: true });
    }
  });
  it("resolves many passages, sources and documents by ID and still rejects a mismatched one", () => {
    const db = openDatabase(":memory:");
    const { planId } = bookPlan(db);
    const base = planFileSchema.parse(JSON.parse(JSON.stringify(exportPlan(db, planId))));
    const n = 9_000;
    const sha = (text: string) => createHash("sha256").update(text).digest("hex");
    const sources = Array.from({ length: n }, (_, i) => ({ id: `s${i}`, kind: "excerpt", title: `S${i}`, sha: sha(`s${i}`), bytes: 0 }));
    const documents = Array.from({ length: n }, (_, i) => ({ id: `d${i}`, sourceId: `s${i}`, version: 1, tree: { chapters: [] } }));
    const passage = (i: number, over: Record<string, unknown> = {}) => ({
      id: `p${i}`,
      sourceId: `s${i % n}`,
      documentId: `d${i % n}`,
      version: 1,
      text: `text ${i}`,
      locator: {},
      section: null,
      charStart: null,
      charEnd: null,
      textSha: sha(`text ${i}`),
      sourceSha: sha(`s${i % n}`),
      ...over,
    });
    const large = (extra: Record<string, unknown> = {}) =>
      ({
        ...base,
        sources: [...(base.sources ?? []), ...sources],
        documents: [...(base.documents ?? []), ...documents],
        passages: [...(base.passages ?? []), ...Array.from({ length: 3 * n }, (_, i) => passage(i, i === 3 * n - 1 ? extra : {}))],
      }) as typeof base;
    const fresh = openDatabase(":memory:");
    const copy = importPlan(fresh, planFileSchema.parse(large()), 1);
    const count = (table: string) => (fresh.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;
    expect(count("passages")).toBe(3 * n + (base.passages?.length ?? 0));
    expect(count("source_documents")).toBe(n + (base.documents?.length ?? 0));
    // Each passage still points at its own source and document.
    expect(
      fresh.prepare("SELECT count(*) AS n FROM passages p JOIN source_documents d ON d.id = p.document_id WHERE d.source_id = p.source_id").get(),
    ).toEqual({ n: 3 * n + (base.passages?.length ?? 0) });
    expect(copy).toBeTruthy();
    // A wrong source hash or a document of another source is refused, writing nothing.
    for (const extra of [{ sourceSha: sha("other") }, { documentId: "d0", sourceId: "s1", sourceSha: sha("s1") }]) {
      const refused = openDatabase(":memory:");
      expect(() => importPlan(refused, planFileSchema.parse(large(extra)), 1)).toThrow("plan-file");
      expect(refused.prepare("SELECT count(*) AS n FROM plans").get()).toEqual({ n: 0 });
    }
  }, 60_000);

  it("checks every lesson's citation order against a long passage list", () => {
    const db = openDatabase(":memory:");
    const { planId } = bookPlan(db);
    const base = exportPlan(db, planId);
    // The schema caps a list at 10,000 IDs; ten lessons of that size made the old `includes` check quadratic.
    const ids = Array.from({ length: 10_000 }, (_, i) => `q${i}`);
    const lesson = (n: number, order: string[]) => ({
      id: `l${n}`,
      topic: 0,
      kind: "lesson" as const,
      body: { markdown: "x", passageIds: order },
      passageIds: ids,
      grounding: null,
      provider: null,
      model: null,
    });
    const parse = (orders: string[][]) =>
      planFileSchema.safeParse(JSON.parse(JSON.stringify({ ...base, items: orders.map((order, n) => lesson(n, order)) })));
    const reversed = [...ids].reverse();
    const cited = (result: ReturnType<typeof parse>) =>
      result.error?.issues.filter((issue) => issue.path.join(".").endsWith("body.passageIds")).length ?? 0;
    // The same set in another order passes; one stranger in its place is refused.
    expect(cited(parse(Array.from({ length: 10 }, () => reversed)))).toBe(0);
    expect(cited(parse([reversed, [...reversed.slice(1), "stranger"]]))).toBe(1);
  }, 20_000);
});

describe("an imported document keeps its original file's identity (PLAN-13)", () => {
  const body = Buffer.from("original pdf bytes");
  const original = createHash("sha256").update(body).digest("hex");

  function pdfPlan() {
    const workspace = mkdtempSync(join(tmpdir(), "pyxis-identity-"));
    const db = openDatabase(":memory:");
    putBlob(workspace, body, "application/pdf", "pdf");
    db.exec(`
      INSERT INTO plans (id,title,status,created_at,updated_at) VALUES ('plan','Fisica','ready',1,1);
      INSERT INTO topics (id,plan_id,title,position,created_at) VALUES ('topic','plan','Moti',0,1);
      INSERT INTO sources (id,title,kind,status,created_at,updated_at,blob_sha,mime) VALUES ('source','Libro','pdf','ready',1,1,'${original}','application/pdf');
      INSERT INTO plan_sources (plan_id,source_id) VALUES ('plan','source');
      INSERT INTO source_documents (id,source_id,version,tree_json,created_at) VALUES ('doc','source',1,'{"pages":1,"blobSha":"${original}","kind":"pdf"}',1);
      INSERT INTO passages (id,source_id,document_id,version,text,locator_json,created_at) VALUES ('p1','source','doc',1,'Il lavoro vale F per s.','{"page":3}',1);
      INSERT INTO topic_passages (topic_id,passage_id) VALUES ('topic','p1');
    `);
    return { db, workspace };
  }

  /** A re-extraction (or a replacement) of the imported source: a new document version over the same source row. */
  function laterVersion(db: ReturnType<typeof openDatabase>, sourceId: string, blobSha: string) {
    db.prepare("INSERT INTO source_documents (id,source_id,version,tree_json,created_at) VALUES ('later',?,2,?,2)").run(
      sourceId,
      JSON.stringify({ pages: 1, blobSha, kind: "pdf" }),
    );
    db.prepare("INSERT INTO passages (id,source_id,document_id,version,text,locator_json,created_at) VALUES ('later-p',?,'later',2,'Altro testo.','{\"page\":3}',2)").run(sourceId);
    return passageIdentity(db, ["later-p"]).locator;
  }

  for (const embed of [true, false]) {
    it(`${embed ? "an embedded" : "an excerpt-only"} import matches its own re-extraction but not an unrelated replacement`, () => {
      const { db, workspace } = pdfPlan();
      const file = planFileSchema.parse(JSON.parse(JSON.stringify(exportPlan(db, "plan", { embed, workspace }))));
      expect(file.passages![0]!.sourceSha).toBe(original);
      // A forged hash inside the document is not carried over.
      (file.documents![0]!.tree as Record<string, unknown>).blobSha = "f".repeat(64);
      const fresh = openDatabase(":memory:");
      const copy = importPlan(fresh, file, 10, mkdtempSync(join(tmpdir(), "pyxis-identity-")));
      const sourceId = (fresh.prepare("SELECT source_id AS id FROM plan_sources WHERE plan_id = ?").get(copy) as { id: string }).id;
      const imported = fresh.prepare("SELECT tree_json FROM source_documents WHERE source_id = ?").get(sourceId) as { tree_json: string };
      expect(JSON.parse(imported.tree_json)).toMatchObject({ sourceSha: original });
      expect(JSON.parse(imported.tree_json)).not.toHaveProperty("blobSha");
      const before = passageIdentity(fresh, [(fresh.prepare("SELECT id FROM passages WHERE source_id = ? AND document_id IS NOT NULL").get(sourceId) as { id: string }).id]).locator;
      expect(before).toHaveLength(1);
      const sameFile = laterVersion(fresh, sourceId, original);
      expect(sameFile).toEqual(before);
      fresh.prepare("DELETE FROM passages WHERE id = 'later-p'").run();
      fresh.prepare("DELETE FROM source_documents WHERE id = 'later'").run();
      expect(laterVersion(fresh, sourceId, "a".repeat(64))).not.toEqual(before);
    });
  }
});
