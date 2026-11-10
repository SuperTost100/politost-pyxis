import { describe, expect, it } from "vitest";
import { strToU8, zipSync } from "fflate";
import { openDatabase } from "../db/connection";
import { importSmartbook } from "../sources/smartbook";
import { createPlan } from "../plans/create";
import { createRunner } from "../jobs/runner";
import type { GenerateInput } from "../engine/generate";
import { partialText, templateVersion } from "../engine/prompts";
import {
  editMap,
  enqueueMaps,
  mapBuild,
  prepareMaps,
  registerMapJobs,
} from "./generate";
import {
  listMaps,
  moveMapNode,
  openMap,
  patchMap,
  readStoredMap,
  undoMap,
} from "./store";
import type { MapScope } from "./scope";
import { listAllMaps } from "./library";
import { addSubject } from "../plans/subjects";
function fixture(count = 50) {
  const db = openDatabase(":memory:");
  db.prepare(
    "INSERT INTO feature_engines (feature, selection_json, updated_at) VALUES ('default', ?, 1)",
  ).run(JSON.stringify({ provider: "claude", model: "claude-sonnet-5" }));
  const imported = importSmartbook(
    db,
    zipSync({
      "smartbook.json": strToU8(
        JSON.stringify({
          id: "maps",
          title: "Fisica",
          access: "public",
          chapters: [{ id: "c1", number: 1, title: "Moti", file: "01.md" }],
        }),
      ),
      "chapters/01.md": strToU8(
        Array.from(
          { length: count },
          (_, i) =>
            `## p${i} | Concetto ${i}\nIl concetto ${i} descrive un moto.\n`,
        ).join("\n"),
      ),
    }),
  );
  const { planId } = createPlan(db, {
    title: "Fisica",
    sourceIds: [imported.sourceId],
  });
  const { id: topicId } = db
    .prepare("SELECT id FROM topics WHERE plan_id = ?")
    .get(planId) as { id: string };
  return { db, input: { planId, topicId } };
}
function response(data: unknown) {
  return {
    text: JSON.stringify(data),
    structured: data,
    provider: "claude",
    model: "fixture",
    inputTokens: 1,
  };
}
function generated(prompt: string) {
  const data = JSON.parse(prompt) as { passages: { id: string }[] };
  const ids = [...new Set(data.passages.map((p) => p.id))];
  return {
    title: "Moti",
    nodes: Array.from({ length: 8 }, (_, i) => ({
      id: `n${i}`,
      label: `Concetto ${i}`,
      parent: i ? "n0" : null,
      sources: i ? ids.slice(0, 1) : ids,
    })),
    edges: [],
  };
}
const run: GenerateInput["run"] = async (input) =>
  response(generated(input.prompt));
async function until(
  db: ReturnType<typeof openDatabase>,
  input: MapScope,
  state: string,
) {
  for (let i = 0; i < 200; i++) {
    if (mapBuild(db, input)?.state === state) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(JSON.stringify(mapBuild(db, input)));
}
/** Builds a topic's maps through the job, as the app does, and waits for it. */
async function generateMaps(
  db: ReturnType<typeof openDatabase>,
  input: MapScope,
  model: GenerateInput["run"],
) {
  const runner = createRunner(db, () => {});
  registerMapJobs(db, runner, model);
  enqueueMaps(db, runner, input);
  await until(db, input, "succeeded");
}
describe("M10 model maps", () => {
  it("reads all material in bounded parts and adds one map, without discarding an edited legacy outline", async () => {
    const { db, input } = fixture();
    const legacy = openMap(db, input);
    for (const node of legacy.nodes) delete node.sources;
    db.prepare(
      "UPDATE maps SET graph_json = ?, grounding = 'sources' WHERE plan_id = ? AND topic_id = ?",
    ).run(JSON.stringify(legacy), input.planId, input.topicId);
    expect(listMaps(db, input)[0]!.grounding).toBe(
      "sources",
    );
    const legacyId = listMaps(db, input)[0]!.id;
    const params = prepareMaps(db, input);
    expect(params.parts.length).toBeGreaterThan(1);
    expect(params.parts.flatMap((p) => p.passages)).toHaveLength(50);
    expect(params.parts.every((p) => p.passages.length <= 24)).toBe(true);
    await generateMaps(db, input, run);
    const maps = listMaps(db, input);
    expect(maps.filter((m) => m.provider)).toHaveLength(1);
    expect(
      readStoredMap(db, input, legacyId)!.graph,
    ).toEqual(legacy);
    const covered = new Set(
      maps
        .filter((m) => m.provider)
        .flatMap(
          (m) =>
            readStoredMap(db, input, m.id)!.passageIds,
        ),
    );
    expect(covered.size).toBe(50);
    db.close();
  });
  it("ends a build of several parts with one map that holds the concepts of every part", async () => {
    const { db, input } = fixture();
    const topic = db.prepare("SELECT title FROM topics WHERE id = ?").pluck().get(input.topicId) as string;
    let part = 0;
    const calls: Array<{ title: string; passages: unknown[] }> = [];
    await generateMaps(db, input, async (call) => {
      calls.push(JSON.parse(call.prompt));
      const data = generated(call.prompt);
      const at = ++part;
      return response({
        ...data,
        nodes: data.nodes.map((node, i) => ({
          ...node,
          // Every part also names the concept " Moto " in its own spelling.
          label: i === 3 ? (at === 1 ? "Moto" : at === 2 ? " moto " : "MOTO") : `Parte ${at}, concetto ${i}`,
        })),
      });
    });
    expect(calls).toHaveLength(3);
    const maps = listMaps(db, input);
    expect(maps).toHaveLength(1);
    expect(maps[0]).toMatchObject({ title: topic, passageCount: 50, grounding: "sources" });
    const { graph } = readStoredMap(db, input)!;
    const roots = graph.nodes.filter((node) => node.parent === null);
    expect(roots).toHaveLength(1);
    expect(roots[0]!.label).toBe(topic);
    const labels = graph.nodes.map((node) => node.label.trim().toLowerCase());
    for (const at of [1, 2, 3])
      for (const i of [0, 1, 2, 4, 5, 6, 7]) expect(labels).toContain(`parte ${at}, concetto ${i}`);
    // The same concept in three parts is one node, and it keeps the first spelling.
    expect(labels.filter((label) => label === "moto")).toHaveLength(1);
    expect(graph.nodes.find((node) => node.label === "Moto")).toBeDefined();
    // Each part hangs under the topic, and the citations survive the merge.
    expect(graph.nodes.filter((node) => node.parent === roots[0]!.id)).toHaveLength(3);
    const cited = new Set(graph.nodes.flatMap((node) => node.sources ?? []));
    expect(cited.size).toBe(50);
    expect(graph.nodes).toHaveLength(1 + 3 * 7 + 1);
    expect(new Set(graph.nodes.map((node) => node.id)).size).toBe(graph.nodes.length);
    db.close();
  });
  it("does not start a second build for a scope that already has one", async () => {
    const { db, input } = fixture(1);
    let release!: () => void;
    let started = 0;
    const runner = createRunner(db, () => {});
    registerMapJobs(db, runner, async (call) => {
      started++;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return response(generated(call.prompt));
    });
    const first = enqueueMaps(db, runner, input);
    while (!started) await new Promise((r) => setTimeout(r, 1));
    // A second confirm while the first build runs gets the same job back.
    expect(enqueueMaps(db, runner, input).jobId).toBe(first.jobId);
    release();
    await until(db, input, "succeeded");
    // So does a request after it finished: the maps are not built again.
    expect(enqueueMaps(db, runner, input)).toMatchObject({ jobId: first.jobId, maps: [expect.anything()] });
    expect(db.prepare("SELECT COUNT(*) FROM jobs WHERE kind = 'map-build'").pluck().get()).toBe(1);
    expect(started).toBe(1);
    expect(listMaps(db, input)).toHaveLength(1);
    db.close();
  });
  it("retains every character when one passage exceeds a map input limit", () => {
    const { db, input } = fixture(1);
    const text = "x".repeat(50001);
    db.prepare("UPDATE passages SET text = ?").run(text);
    const params = prepareMaps(db, input);
    expect(
      params.parts
        .flatMap((p) => p.passages)
        .map((p) => p.text)
        .join(""),
    ).toBe(text);
    expect(
      params.parts.every(
        (p) => p.passages.reduce((n, p) => n + p.text.length, 0) <= 18000,
      ),
    ).toBe(true);
    db.close();
  });
  it("applies a model patch only to the selected map, preserves positions and undoes the whole patch", async () => {
    const { db, input } = fixture();
    // An offline outline made before the build is the scope's other map.
    openMap(db, input);
    await generateMaps(db, input, run);
    const maps = listMaps(db, input);
    expect(maps).toHaveLength(2);
    const id = maps[1]!.id;
    moveMapNode(db, input, "n1", 777, 888, id);
    const before = readStoredMap(db, input, id)!.graph;
    const untouched = readStoredMap(
      db,
      input,
      maps[0]!.id,
    )!.graph;
    const patched = await editMap(
      db,
      { ...input, mapId: id, instruction: "Rename and connect" },
      async () =>
        response({
          ops: [
            { op: "rename", id: "n1", label: "Nuovo" },
            { op: "connect", from: "n1", to: "n2", label: "causa" },
          ],
        }),
    );
    expect(patched.nodes.find((n) => n.id === "n1")).toMatchObject({
      x: 777,
      y: 888,
      pinned: true,
      label: "Nuovo",
    });
    expect(
      readStoredMap(db, input, maps[0]!.id)!.graph,
    ).toEqual(untouched);
    expect(undoMap(db, input, id).nodes).toEqual(
      before.nodes,
    );
    db.close();
  });
  it("fills the language placeholder, includes the citation rule and records template provenance", async () => {
    const { db, input } = fixture(1);
    const systems: string[] = [];
    await generateMaps(db, input, async (call) => {
      systems.push(call.system ?? "");
      return run!(call);
    });
    expect(systems[0]).toContain("Write all output in Italian.");
    expect(systems[0]).toContain(partialText("citation"));
    expect(systems[0]).not.toMatch(/\{\{[A-Za-z]/);
    expect(
      db
        .prepare(
          "SELECT prompt_template, prompt_version FROM maps WHERE plan_id = ?",
        )
        .get(input.planId),
    ).toEqual({
      prompt_template: "map.generate",
      prompt_version: templateVersion("map.generate"),
    });
    const id = listMaps(db, input)[0]!.id;
    await editMap(
      db,
      { ...input, mapId: id, instruction: "Rename" },
      async (call) => {
        systems.push(call.system ?? "");
        return response({ ops: [{ op: "rename", id: "n1", label: "Nuovo" }] });
      },
    );
    expect(systems[1]).toContain("Write all new labels in Italian.");
    expect(systems[1]).not.toMatch(/\{\{[A-Za-z]/);
    db.close();
  });
  it("applies a model edit on top of a move made while it was writing", async () => {
    const { db, input } = fixture(1);
    await generateMaps(db, input, run);
    const id = listMaps(db, input)[0]!.id;
    let release!: (value: ReturnType<typeof response>) => void;
    const pending = editMap(
      db,
      { ...input, mapId: id, instruction: "Rename" },
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    moveMapNode(db, input, "n1", 42, 45, id);
    release(response({ ops: [{ op: "rename", id: "n1", label: "No" }] }));
    const edited = await pending;
    const node = edited.nodes.find((n) => n.id === "n1")!;
    expect([node.label, node.x, node.y]).toEqual(["No", 42, 45]);
    const stored = readStoredMap(db, input, id)!.graph;
    expect(stored.nodes.find((n) => n.id === "n1")!.label).toBe("No");
    // Undo returns to the map as the student had left it, move included.
    const undone = undoMap(db, input, id);
    const before = undone.nodes.find((n) => n.id === "n1")!;
    expect([before.label === "No", before.x]).toEqual([false, 42]);
    db.close();
  });
  it("names the error when the edit no longer fits the map", async () => {
    const { db, input } = fixture(1);
    await generateMaps(db, input, run);
    const id = listMaps(db, input)[0]!.id;
    const leaf = readStoredMap(db, input, id)!.graph.nodes
      .filter((n) => n.parent !== null)
      .at(-1)!;
    let release!: (value: ReturnType<typeof response>) => void;
    const pending = editMap(
      db,
      { ...input, mapId: id, instruction: "Rename" },
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    patchMap(
      db,
      input,
      [{ op: "delete", id: leaf.id }],
      id,
    );
    release(response({ ops: [{ op: "rename", id: leaf.id, label: "No" }] }));
    await expect(pending).rejects.toMatchObject({
      code: "map-edit-conflict",
      messageKey: "map.editConflict",
    });
    db.close();
  });
  it("passes the caller's signal to the model and leaves the undo history out of the prompt", async () => {
    const { db, input } = fixture(1);
    await generateMaps(db, input, run);
    const id = listMaps(db, input)[0]!.id;
    moveMapNode(db, input, "n1", 42, 45, id);
    const controller = new AbortController();
    const seen: Array<{ signal?: AbortSignal; prompt: string }> = [];
    await editMap(
      db,
      { ...input, mapId: id, instruction: "Rename" },
      async (call) => {
        seen.push({ signal: call.signal, prompt: call.prompt });
        return response({ ops: [{ op: "rename", id: "n1", label: "Nuovo" }] });
      },
      controller.signal,
    );
    expect(seen[0]!.signal).toBe(controller.signal);
    const graph = JSON.parse(seen[0]!.prompt).graph;
    expect([graph.undo, graph.redo]).toEqual([null, null]);
    db.close();
  });
  it("resumes a failed part and keeps the parts that were already read", async () => {
    const { db, input } = fixture();
    let calls = 0,
      fail = true;
    const runner = createRunner(db, () => {});
    registerMapJobs(db, runner, async (i) => {
      calls++;
      if (calls === 2 && fail) throw new Error("offline");
      return response(generated(i.prompt));
    });
    const first = enqueueMaps(db, runner, input);
    await until(db, input, "failed");
    // The part that finished waits in the job; no half-built map shows meanwhile.
    expect(listMaps(db, input)).toEqual([]);
    expect(mapBuild(db, input)).toMatchObject({ state: "failed", progress: 1 / 3 });
    fail = false;
    expect(enqueueMaps(db, runner, input).jobId).toBe(first.jobId);
    await until(db, input, "succeeded");
    expect(listMaps(db, input)).toHaveLength(1);
    expect(readStoredMap(db, input)!.passageIds).toHaveLength(50);
    expect(calls).toBe(4);
    db.close();
  });
  it("cannot publish a model result after cancellation and can retry it", async () => {
    const { db, input } = fixture(1);
    let release!: () => void;
    let started = false;
    const runner = createRunner(db, () => {});
    registerMapJobs(db, runner, async (i) => {
      started = true;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return response(generated(i.prompt));
    });
    const job = enqueueMaps(db, runner, input);
    while (!started) await new Promise((r) => setTimeout(r, 1));
    runner.cancel(job.jobId);
    release();
    await until(db, input, "cancelled");
    await new Promise((r) => setTimeout(r, 10));
    expect(listMaps(db, input)).toEqual([]);
    registerMapJobs(db, runner, run);
    enqueueMaps(db, runner, input);
    await until(db, input, "succeeded");
    expect(listMaps(db, input)).toHaveLength(1);
    db.close();
  });
  it("marks a map without source material as general knowledge", async () => {
    const { db, input } = fixture(1);
    db.prepare("DELETE FROM topic_passages WHERE topic_id = ?").run(
      input.topicId,
    );
    await generateMaps(db, input, run);
    expect(listMaps(db, input)[0]).toMatchObject({
      grounding: "general",
      passageCount: 0,
    });
    expect(db.prepare("SELECT grounding FROM maps").get()).toEqual({
      grounding: "general",
    });
    db.close();
  });
  it("rejects patches that name nonexistent nodes without changing stored graph", async () => {
    const { db, input } = fixture(1);
    await generateMaps(db, input, run);
    const before = readStoredMap(db, input)!.graph;
    await expect(
      editMap(db, { ...input, instruction: "Rename" }, async () =>
        response({ ops: [{ op: "rename", id: "fake", label: "bad" }] }),
      ),
    ).rejects.toThrow();
    expect(readStoredMap(db, input)!.graph).toEqual(
      before,
    );
    db.close();
  });
});

describe("whole-subject maps", () => {
  /** A subject with one book of `count` passages and no exam. */
  function subjectFixture(count: number) {
    const db = openDatabase(":memory:");
    db.prepare(
      "INSERT INTO feature_engines (feature, selection_json, updated_at) VALUES ('default', ?, 1)",
    ).run(JSON.stringify({ provider: "claude", model: "claude-sonnet-5" }));
    const { id: subjectId } = addSubject(db, "Fisica I");
    const book = importSmartbook(
      db,
      zipSync({
        "smartbook.json": strToU8(
          JSON.stringify({
            id: "subject-book",
            title: "Mazzoldi",
            access: "public",
            chapters: [{ id: "c1", number: 1, title: "Moti", file: "01.md" }],
          }),
        ),
        "chapters/01.md": strToU8(
          Array.from({ length: count }, (_, i) => `## p${i} | Sezione ${i}\nIl concetto ${i} descrive un moto.\n`).join("\n"),
        ),
      }),
    );
    db.prepare("UPDATE sources SET subject_id = ? WHERE id = ?").run(subjectId, book.sourceId);
    return { db, input: { subjectId } };
  }

  it("builds one map of a subject that has no exam, from the subject's sources", async () => {
    const { db, input } = subjectFixture(40);
    expect(db.prepare("SELECT COUNT(*) FROM plans").pluck().get()).toBe(0);
    const params = prepareMaps(db, input);
    expect(params.parts).toHaveLength(1);
    expect(params.parts[0]!.title).toBe("Fisica I");
    expect(params.parts[0]!.passages).toHaveLength(24);
    await generateMaps(db, input, run);
    expect(listMaps(db, input)).toEqual([
      expect.objectContaining({ title: "Fisica I", grounding: "sources", passageCount: 24, provider: "claude" }),
    ]);
    expect(db.prepare("SELECT subject_id, plan_id, topic_id FROM maps").all()).toEqual([
      { subject_id: input.subjectId, plan_id: null, topic_id: null },
    ]);
    expect(listAllMaps(db)).toEqual([
      expect.objectContaining({ subjectName: "Fisica I", planId: null, topicId: null, nodeCount: 8 }),
    ]);
    expect(mapBuild(db, input)).toMatchObject({ state: "succeeded", progress: 1 });
    // The map is edited in place like any other.
    const edited = await editMap(db, { ...input, instruction: "Rinomina" }, async () =>
      response({ ops: [{ op: "rename", id: "n1", label: "Vettori" }] }),
    );
    expect(edited.nodes.find((node) => node.id === "n1")!.label).toBe("Vettori");
    expect(readStoredMap(db, input)!.graph.nodes.find((node) => node.id === "n1")!.label).toBe("Vettori");
    db.close();
  });

  it("keeps a subject's build apart from the builds of its exam's topics", async () => {
    const { db, input } = subjectFixture(3);
    const source = db.prepare("SELECT id FROM sources").pluck().get() as string;
    const { planId } = createPlan(db, { title: "Fisica", sourceIds: [source], subject: "Fisica I" });
    const topicId = db.prepare("SELECT id FROM topics WHERE plan_id = ?").pluck().get(planId) as string;
    await generateMaps(db, { planId, topicId }, run);
    expect(mapBuild(db, input)).toBeNull();
    expect(listMaps(db, input)).toEqual([]);
    await generateMaps(db, input, run);
    expect(listMaps(db, input)).toHaveLength(1);
    expect(listMaps(db, { planId, topicId })).toHaveLength(1);
    expect(
      db.prepare("SELECT subject_id, plan_id IS NULL AS whole FROM maps ORDER BY whole").all(),
    ).toEqual([
      { subject_id: input.subjectId, whole: 0 },
      { subject_id: input.subjectId, whole: 1 },
    ]);
    db.close();
  });

  it("refuses a subject that does not exist", () => {
    const { db } = subjectFixture(1);
    expect(() => prepareMaps(db, { subjectId: "nope" })).toThrow("subject-missing");
    expect(() => listMaps(db, { subjectId: "nope" })).toThrow("subject-missing");
    db.close();
  });
});
