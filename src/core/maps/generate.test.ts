import { describe, expect, it } from "vitest";
import { strToU8, zipSync } from "fflate";
import { openDatabase } from "../db/connection";
import { importSmartbook } from "../sources/smartbook";
import { createPlan } from "../plans/create";
import { createRunner } from "../jobs/runner";
import type { GenerateInput } from "../engine/generate";
import {
  editMap,
  enqueueMaps,
  generateMaps,
  mapBuild,
  prepareMaps,
  registerMapJobs,
} from "./generate";
import {
  listTopicMaps,
  moveTopicNode,
  openTopicMap,
  readStoredMap,
  undoTopicMap,
} from "./store";
function fixture(count = 50) {
  const db = openDatabase(":memory:");
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
  input: { planId: string; topicId: string },
  state: string,
) {
  for (let i = 0; i < 200; i++) {
    if (mapBuild(db, input)?.state === state) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(JSON.stringify(mapBuild(db, input)));
}
describe("M10 model maps", () => {
  it("splits all material into bounded maps without discarding an edited legacy outline", async () => {
    const { db, input } = fixture();
    const legacy = openTopicMap(db, input.planId, input.topicId);
    for (const node of legacy.nodes) delete node.sources;
    db.prepare(
      "UPDATE maps SET graph_json = ?, grounding = 'sources' WHERE plan_id = ? AND topic_id = ?",
    ).run(JSON.stringify(legacy), input.planId, input.topicId);
    expect(listTopicMaps(db, input.planId, input.topicId)[0]!.grounding).toBe(
      "sources",
    );
    const legacyId = listTopicMaps(db, input.planId, input.topicId)[0]!.id;
    const params = prepareMaps(db, input);
    expect(params.parts.length).toBeGreaterThan(1);
    expect(params.parts.flatMap((p) => p.passages)).toHaveLength(50);
    expect(params.parts.every((p) => p.passages.length <= 24)).toBe(true);
    await generateMaps(db, input, run);
    const maps = listTopicMaps(db, input.planId, input.topicId);
    expect(maps.filter((m) => m.provider)).toHaveLength(params.parts.length);
    expect(
      readStoredMap(db, input.planId, input.topicId, legacyId)!.graph,
    ).toEqual(legacy);
    const covered = new Set(
      maps
        .filter((m) => m.provider)
        .flatMap(
          (m) =>
            readStoredMap(db, input.planId, input.topicId, m.id)!.passageIds,
        ),
    );
    expect(covered.size).toBe(50);
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
    await generateMaps(db, input, run);
    const maps = listTopicMaps(db, input.planId, input.topicId);
    const id = maps[1]!.id;
    moveTopicNode(db, input.planId, input.topicId, "n1", 777, 888, id);
    const before = readStoredMap(db, input.planId, input.topicId, id)!.graph;
    const untouched = readStoredMap(
      db,
      input.planId,
      input.topicId,
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
      readStoredMap(db, input.planId, input.topicId, maps[0]!.id)!.graph,
    ).toEqual(untouched);
    expect(undoTopicMap(db, input.planId, input.topicId, id).nodes).toEqual(
      before.nodes,
    );
    db.close();
  });
  it("does not overwrite a manual move made during model editing", async () => {
    const { db, input } = fixture(1);
    await generateMaps(db, input, run);
    const id = listTopicMaps(db, input.planId, input.topicId)[0]!.id;
    let release!: (value: ReturnType<typeof response>) => void;
    const pending = editMap(
      db,
      { ...input, mapId: id, instruction: "Rename" },
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    moveTopicNode(db, input.planId, input.topicId, "n1", 42, 45, id);
    release(response({ ops: [{ op: "rename", id: "n1", label: "No" }] }));
    await expect(pending).rejects.toThrow("map-changed");
    expect(
      readStoredMap(db, input.planId, input.topicId, id)!.graph.nodes.find(
        (n) => n.id === "n1",
      )!.x,
    ).toBe(42);
    db.close();
  });
  it("resumes a failed part with stable IDs and retains completed checkpoints", async () => {
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
    const completed = listTopicMaps(db, input.planId, input.topicId);
    expect(completed).toHaveLength(1);
    fail = false;
    expect(enqueueMaps(db, runner, input).jobId).toBe(first.jobId);
    await until(db, input, "succeeded");
    expect(listTopicMaps(db, input.planId, input.topicId)[0]!.id).toBe(
      completed[0]!.id,
    );
    expect(listTopicMaps(db, input.planId, input.topicId)).toHaveLength(3);
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
    expect(listTopicMaps(db, input.planId, input.topicId)).toEqual([]);
    registerMapJobs(db, runner, run);
    enqueueMaps(db, runner, input);
    await until(db, input, "succeeded");
    expect(listTopicMaps(db, input.planId, input.topicId)).toHaveLength(1);
    db.close();
  });
  it("marks a map without source material as general knowledge", async () => {
    const { db, input } = fixture(1);
    db.prepare("DELETE FROM topic_passages WHERE topic_id = ?").run(
      input.topicId,
    );
    await generateMaps(db, input, run);
    expect(listTopicMaps(db, input.planId, input.topicId)[0]).toMatchObject({
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
    const before = readStoredMap(db, input.planId, input.topicId)!.graph;
    await expect(
      editMap(db, { ...input, instruction: "Rename" }, async () =>
        response({ ops: [{ op: "rename", id: "fake", label: "bad" }] }),
      ),
    ).rejects.toThrow();
    expect(readStoredMap(db, input.planId, input.topicId)!.graph).toEqual(
      before,
    );
    db.close();
  });
});
