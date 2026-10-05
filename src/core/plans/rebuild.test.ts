import { describe, expect, it } from "vitest";
import { openDatabase } from "../db/connection";
import { createRunner } from "../jobs/runner";
import type { GenerateInput } from "../engine/generate";
import { createPlan, readPlan } from "./create";
import { planHandlers } from "./handlers";
import { exportPlan, importPlan } from "./file";
import { planMastery } from "./progress";
import {
  applyRebuild,
  computeRebuild,
  matchTopics,
  reviewRebuild,
} from "./rebuild";
import { attachPlanSources } from "./views";

const topic = (id: string, title: string, passageIds: string[]) => ({
  id,
  title,
  passageIds,
});
const ids = (n: number, from = 0) =>
  Array.from({ length: n }, (_, i) => `p${from + i}`);
const never = () => 0;

describe("PLAN-13 matching", () => {
  it("matches on Jaccard strictly above 0.3, and not at 0.3", () => {
    // 3 shared of a union of 10 is exactly 0.3; 4 of 9 is above it.
    const at = matchTopics(
      [topic("a", "A", ids(6))],
      [{ title: "X", passageIds: [...ids(3), ...ids(4, 20)] }],
      never,
    );
    expect(at.matches).toEqual([]);
    expect(at.archived).toEqual(["a"]);
    const above = matchTopics(
      [topic("a", "A", ids(6))],
      [{ title: "X", passageIds: [...ids(4), ...ids(3, 20)] }],
      never,
    );
    expect(above.matches).toMatchObject([
      { oldId: "a", newIndex: 0, reason: "passages" },
    ]);
  });

  it("matches on a high title similarity when no passage overlaps", () => {
    const result = matchTopics(
      [topic("a", "Kinematics", [])],
      [{ title: "Cinematica", passageIds: [] }],
      () => 0.93,
    );
    expect(result.matches).toMatchObject([{ oldId: "a", reason: "title" }]);
    expect(
      matchTopics(
        [topic("a", "Kinematics", [])],
        [{ title: "Cinematica", passageIds: [] }],
        () => 0.89,
      ).matches,
    ).toEqual([]);
  });

  it("greedily takes the best pair first and uses each topic once", () => {
    // Old a overlaps new 0 slightly and new 1 strongly; old b overlaps new 1 weakly.
    const result = matchTopics(
      [topic("a", "A", ids(10)), topic("b", "B", ids(10, 7))],
      [
        { title: "N0", passageIds: ids(4) },
        { title: "N1", passageIds: ids(9) },
      ],
      never,
    );
    expect(result.matches.map((m) => [m.oldId, m.newIndex])).toEqual([
      ["a", 1],
    ]);
    // b overlaps new 1 by only 2 of 17, so it is archived and new 0 stays a new topic.
    expect(result.archived).toEqual(["b"]);
  });
});

function plan() {
  const db = openDatabase(":memory:");
  db.prepare(
    "INSERT INTO sources(id,kind,title,status,created_at,updated_at) VALUES('a','file','Appunti','ready',1,1),('b','file','Slide','ready',1,1)",
  ).run();
  for (const id of ["a", "b"])
    db.prepare(
      "INSERT INTO source_documents(id,source_id,version,tree_json,created_at) VALUES(?,?,1,'{}',1)",
    ).run(`doc-${id}`, id);
  const insert = db.prepare(
    "INSERT INTO passages(id,source_id,document_id,text,locator_json,section_path,created_at) VALUES(?,?,?,?,'{}',?,?)",
  );
  insert.run("c1", "a", "doc-a", "velocita", "Cinematica", 1);
  insert.run("c2", "a", "doc-a", "accelerazione", "Cinematica", 2);
  insert.run("d1", "a", "doc-a", "forza", "Dinamica", 3);
  insert.run("s1", "b", "doc-b", "lavoro ed energia", "Energia", 4);
  insert.run("s2", "b", "doc-b", "potenza", "Energia", 5);
  const { planId } = createPlan(db, { title: "Fisica", sourceIds: ["a"] });
  const topics = () =>
    db
      .prepare(
        "SELECT id,title,archived_at AS archived FROM topics WHERE plan_id=? ORDER BY position",
      )
      .all(planId) as Array<{ id: string; title: string; archived: number | null }>;
  return { db, planId, topics };
}

const tree = (db: ReturnType<typeof openDatabase>, titles: string[]) =>
  titles.map((title) => ({
    title,
    summary: `${title} summary`,
    subtopics: [],
    passageIds: (
      db
        .prepare("SELECT id FROM passages WHERE section_path = ? ORDER BY id")
        .all(title) as Array<{ id: string }>
    ).map((row) => row.id),
  }));

describe("PLAN-13 apply", () => {
  it.each(["topic", "source"])("refuses a reviewed tree after %s content changes with the same ids", async (change) => {
    const { db, planId, topics } = plan();
    const rebuild = await computeRebuild(db, planId, tree(db, ["Cinematica", "Energia"]), async () => null);
    if (change === "topic") {
      db.prepare("UPDATE topics SET title = 'Changed after review' WHERE id = ?").run(topics()[0]!.id);
    } else {
      db.prepare("UPDATE sources SET blob_sha = 'changed-content' WHERE id IN (SELECT source_id FROM plan_sources WHERE plan_id = ?)").run(planId);
    }
    expect(reviewRebuild(db, planId, rebuild).stale).toBe(true);
    expect(() => applyRebuild(db, planId, rebuild)).toThrow("rebuild-stale");
    db.close();
  });
  it("applies exactly the reviewed diff, keeps matched ids and archives the rest with their history", async () => {
    const { db, planId, topics } = plan();
    const [cinematica, dinamica] = topics();
    const now = 5000;
    db.prepare(
      "INSERT INTO learning_events(id,kind,plan_id,topic_id,payload_json,created_at) VALUES('e1','answer_given',?,?,'{\"score\":1}',?)",
    ).run(planId, dinamica!.id, now);
    db.prepare(
      "INSERT INTO gaps(id,plan_id,topic_id,opened_at) VALUES('g1',?,?,?)",
    ).run(planId, dinamica!.id, now);
    const nodesBefore = (
      db
        .prepare("SELECT id FROM path_nodes WHERE topic_id = ?")
        .all(cinematica!.id) as Array<{ id: string }>
    ).map((row) => row.id);

    // The new tree keeps Cinematica (same passages) and adds Energia; Dinamica is gone.
    const rebuild = await computeRebuild(
      db,
      planId,
      tree(db, ["Cinematica", "Energia"]),
    );
    const review = reviewRebuild(db, planId, rebuild);
    expect(review.kept).toMatchObject([
      { id: cinematica!.id, title: "Cinematica", reason: "passages" },
    ]);
    expect(review.added).toEqual([{ title: "Energia", passages: 2 }]);
    expect(review.archived).toEqual([
      { id: dinamica!.id, title: "Dinamica", progress: true },
    ]);
    // Previewing changes nothing.
    expect(topics().every((row) => row.archived === null)).toBe(true);
    expect(topics()).toHaveLength(2);

    expect(applyRebuild(db, planId, rebuild, 6000)).toEqual({
      kept: 1,
      added: 1,
      archived: 1,
    });
    const after = topics();
    const active = after.filter((row) => row.archived === null);
    expect(active.map((row) => row.title)).toEqual(["Cinematica", "Energia"]);
    expect(active[0]!.id).toBe(cinematica!.id);
    // What was reviewed is what happened.
    expect(active.map((row) => row.title)).toEqual([
      ...review.kept.map((row) => row.title),
      ...review.added.map((row) => row.title),
    ]);
    expect(after.filter((row) => row.archived !== null)).toEqual([
      { id: dinamica!.id, title: "Dinamica", archived: 6000 },
    ]);

    // Nothing the student produced is deleted.
    expect(
      db.prepare("SELECT COUNT(*) AS n FROM learning_events").get(),
    ).toEqual({ n: 1 });
    expect(db.prepare("SELECT topic_id FROM gaps").get()).toEqual({
      topic_id: dinamica!.id,
    });
    expect(
      (
        db
          .prepare("SELECT id FROM path_nodes WHERE topic_id = ?")
          .all(cinematica!.id) as Array<{ id: string }>
      ).map((row) => row.id),
    ).toEqual(nodesBefore);

    // The active plan, mastery and path show only active topics.
    const view = readPlan(db, planId)!;
    expect(view.topics.map((row) => row.title)).toEqual([
      "Cinematica",
      "Energia",
    ]);
    expect(
      view.nodes.filter((n) => n.topicId === dinamica!.id),
    ).toHaveLength(0);
    expect(view.nodes.map((n) => n.kind)).toEqual([
      "intro",
      "diagnostic",
      "learn",
      "practice",
      "cards",
      "gaps",
      "learn",
      "practice",
      "cards",
      "gaps",
      "simulation",
      "final",
    ]);
    expect(planMastery(db, planId).map((row) => row.title)).toEqual([
      "Cinematica",
      "Energia",
    ]);
    // Matched topic links now follow the new tree.
    expect(
      db
        .prepare("SELECT passage_id FROM topic_passages WHERE topic_id = ? ORDER BY 1")
        .all(cinematica!.id),
    ).toEqual([{ passage_id: "c1" }, { passage_id: "c2" }]);
    db.close();
  });

  it("refuses a reviewed rebuild when the plan changed since", async () => {
    const { db, planId } = plan();
    const rebuild = await computeRebuild(
      db,
      planId,
      tree(db, ["Cinematica", "Dinamica", "Energia"]),
    );
    db.prepare(
      "INSERT INTO topics(id,plan_id,title,position,created_at) VALUES('extra',?,'Extra',9,1)",
    ).run(planId);
    expect(reviewRebuild(db, planId, rebuild).stale).toBe(true);
    expect(() => applyRebuild(db, planId, rebuild)).toThrow("rebuild-stale");
    expect(
      db.prepare("SELECT COUNT(*) AS n FROM topics WHERE archived_at IS NOT NULL").get(),
    ).toEqual({ n: 0 });
    db.close();
  });

  it("matches by embedded title and keeps the old title", async () => {
    const { db, planId, topics } = plan();
    const [cinematica] = topics();
    const vector = (text: string) =>
      Promise.resolve(
        new Float32Array(
          text.includes("Kinematics") || text.includes("Cinematica")
            ? [1, 0]
            : [0, 1],
        ),
      );
    const rebuild = await computeRebuild(
      db,
      planId,
      [{ title: "Kinematics", summary: "", subtopics: [], passageIds: [] }],
      vector,
    );
    expect(rebuild.matches).toMatchObject([
      { oldId: cinematica!.id, reason: "title" },
    ]);
    applyRebuild(db, planId, rebuild);
    expect(topics().find((row) => row.id === cinematica!.id)?.title).toBe(
      "Cinematica",
    );
    db.close();
  });

  it("exports archived topics with their flag and brings them back archived", async () => {
    const { db, planId } = plan();
    const rebuild = await computeRebuild(db, planId, tree(db, ["Cinematica"]));
    applyRebuild(db, planId, rebuild);
    const file = exportPlan(db, planId);
    expect(file.topics.map((t) => [t.title, t.archived ?? false])).toEqual([
      ["Cinematica", false],
      ["Dinamica", true],
    ]);
    const imported = importPlan(db, file);
    expect(readPlan(db, imported)!.topics.map((t) => t.title)).toEqual([
      "Cinematica",
    ]);
    expect(
      db
        .prepare("SELECT COUNT(*) AS n FROM topics WHERE plan_id = ?")
        .get(imported),
    ).toEqual({ n: 2 });
    db.close();
  });
});

const response = (data: unknown) => ({
  text: JSON.stringify(data),
  structured: data,
  provider: "claude" as const,
  model: "fixture",
  inputTokens: 1,
});

describe("PLAN-13 rebuild job", () => {
  async function waitFor(
    handlers: ReturnType<typeof planHandlers>,
    planId: string,
    state: string,
  ) {
    for (let i = 0; i < 400; i++) {
      if (handlers.rebuildState({ planId })?.state === state) return;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error(JSON.stringify(handlers.rebuildState({ planId })));
  }

  it("builds with the topic step, survives cancel and retry, and applies the reviewed result", async () => {
    const { db, planId, topics } = plan();
    db.prepare(
      "INSERT INTO feature_engines (feature, selection_json, updated_at) VALUES ('default', ?, 1)",
    ).run(JSON.stringify({ provider: "claude", model: "claude-sonnet-5" }));
    attachPlanSources(db, planId, ["b"]);
    let block = true;
    let entered = false;
    let calls = 0;
    const run: GenerateInput["run"] = async (input) => {
      if (!input.system?.startsWith("Build"))
        throw new Error("only the topic step calls a model");
      calls += 1;
      entered = true;
      while (block) {
        input.signal?.throwIfAborted();
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      const outline = JSON.parse(input.prompt) as {
        sources: Array<{ segmentId: string; label: string }>;
      };
      // A one-section source is cut by passage order, so its label carries a part number.
      const segment = (label: string) =>
        outline.sources
          .filter((s) => s.label.startsWith(label))
          .map((s) => s.segmentId);
      return response({
        topics: [
          {
            title: "Cinematica",
            summary: "Moto",
            subtopics: [],
            segmentIds: segment("Cinematica"),
          },
          {
            title: "Energia",
            summary: "Lavoro",
            subtopics: [],
            segmentIds: segment("Energia"),
          },
        ],
      });
    };
    const runner = createRunner(db, () => {});
    const handlers = planHandlers(db, "", runner, run);
    const before = topics();
    const { jobId } = handlers.rebuildStart({ planId });
    expect(handlers.rebuildStart({ planId }).jobId).toBe(jobId);
    while (!entered) await new Promise((resolve) => setTimeout(resolve, 5));
    runner.cancel(jobId);
    await waitFor(handlers, planId, "cancelled");
    expect(topics()).toEqual(before);
    block = false;
    runner.retry(jobId);
    await waitFor(handlers, planId, "succeeded");
    expect(calls).toBe(2);
    const state = handlers.rebuildState({ planId })!;
    expect(state.steps.map((s) => s.name)).toEqual([
      "sources",
      "topics",
      "match",
    ]);
    expect(state.review).toMatchObject({
      stale: false,
      kept: [{ title: "Cinematica" }],
      added: [{ title: "Energia", passages: 2 }],
      archived: [{ title: "Dinamica", progress: false }],
    });
    // The review is durable until applied: nothing has changed yet.
    expect(topics()).toEqual(before);
    expect(handlers.rebuildApply({ planId, jobId })).toEqual({
      kept: 1,
      added: 1,
      archived: 1,
    });
    expect(
      readPlan(db, planId)!.topics.map((t) => [t.id, t.title]),
    ).toEqual([
      [before[0]!.id, "Cinematica"],
      [expect.any(String), "Energia"],
    ]);
    expect(handlers.rebuildState({ planId })).toBeNull();
    expect(readPlan(db, planId)!.status).toBe("ready");
    db.close();
  });
});
