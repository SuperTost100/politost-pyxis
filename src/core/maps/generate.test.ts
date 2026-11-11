import { describe, expect, it } from "vitest";
import { strToU8, zipSync } from "fflate";
import { openDatabase } from "../db/connection";
import { importSmartbook } from "../sources/smartbook";
import { createPlan } from "../plans/create";
import { createRunner } from "../jobs/runner";
import type { GenerateInput } from "../engine/generate";
import { partialText, templateVersion } from "../engine/prompts";
import {
  deleteMapAndBuilds,
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
  renameMap,
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
/** What a request with an instruction is answered with: the map, or that this part has nothing for the request. */
function focused(answer: { nodes: unknown[]; edges: unknown[] } | "nothing") {
  return { result: answer === "nothing" ? { kind: "nothing" } : { kind: "map", ...answer } };
}
function plainMap(prompt: string) {
  const data = JSON.parse(prompt) as { passages: { id: string }[] };
  const ids = [...new Set(data.passages.map((p) => p.id))];
  return {
    nodes: Array.from({ length: 8 }, (_, i) => ({
      id: `n${i}`,
      label: `Concetto ${i}`,
      parent: i ? "n0" : null,
      sources: i ? ids.slice(0, 1) : ids,
    })),
    edges: [],
  };
}
/** A part's answer: the map, in the shape its request asks for. */
function generated(prompt: string) {
  const map = plainMap(prompt);
  return (JSON.parse(prompt) as { instruction?: string }).instruction ? focused(map) : map;
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
  it("ends a build of several parts with one map whose main branches are the parts", async () => {
    const { db, input } = fixture();
    const topic = db.prepare("SELECT title FROM topics WHERE id = ?").pluck().get(input.topicId) as string;
    let part = 0;
    const calls: Array<{ title: string; part?: number; of?: number; passages: unknown[] }> = [];
    await generateMaps(db, input, async (call) => {
      calls.push(JSON.parse(call.prompt));
      const data = plainMap(call.prompt);
      const at = ++part;
      return response({
        ...data,
        nodes: data.nodes.map((node, i) => ({
          ...node,
          // Each part names its own root, and every part also names the concept " Moto " in its own spelling.
          label:
            i === 0
              ? `Ramo ${at}`
              : i === 3
                ? at === 1
                  ? "Moto"
                  : at === 2
                    ? " moto "
                    : "MOTO"
                : `Parte ${at}, concetto ${i}`,
        })),
      });
    });
    expect(calls).toHaveLength(3);
    // Every part gets the topic's title, which part it is and how many there are.
    expect(calls.map(({ title, part, of }) => ({ title, part, of }))).toEqual([
      { title: topic, part: 1, of: 3 },
      { title: topic, part: 2, of: 3 },
      { title: topic, part: 3, of: 3 },
    ]);
    const maps = listMaps(db, input);
    expect(maps).toHaveLength(1);
    expect(maps[0]).toMatchObject({ title: topic, passageCount: 50, grounding: "sources" });
    const { graph } = readStoredMap(db, input)!;
    const roots = graph.nodes.filter((node) => node.parent === null);
    expect(roots).toHaveLength(1);
    expect(roots[0]!.label).toBe(topic);
    // Each part's root is a main branch, with its own concepts below it.
    const under = (id: string) => graph.nodes.filter((node) => node.parent === id);
    const branches = under(roots[0]!.id);
    expect(branches.map((node) => node.label)).toEqual(["Ramo 1", "Ramo 2", "Ramo 3"]);
    for (const [at, branch] of branches.entries())
      for (const i of [1, 2, 4, 5, 6, 7])
        expect(under(branch.id).map((node) => node.label)).toContain(`Parte ${at + 1}, concetto ${i}`);
    // The same concept in three parts is one node, under the first part's branch, with the first spelling.
    const labels = graph.nodes.map((node) => node.label.trim().toLowerCase());
    expect(labels.filter((label) => label === "moto")).toHaveLength(1);
    expect(under(branches[0]!.id).map((node) => node.label)).toContain("Moto");
    expect(under(branches[1]!.id)).toHaveLength(6);
    // The citations survive the merge.
    const cited = new Set(graph.nodes.flatMap((node) => node.sources ?? []));
    expect(cited.size).toBe(50);
    expect(graph.nodes).toHaveLength(1 + 3 + 3 * 6 + 1);
    expect(new Set(graph.nodes.map((node) => node.id)).size).toBe(graph.nodes.length);
    db.close();
  });
  it("gives a topic read in one part no part number and makes its root the topic", async () => {
    const { db, input } = fixture(1);
    const topic = db.prepare("SELECT title FROM topics WHERE id = ?").pluck().get(input.topicId) as string;
    const prompts: string[] = [];
    await generateMaps(db, input, async (call) => {
      prompts.push(call.prompt);
      return response(generated(call.prompt));
    });
    expect(prompts).toHaveLength(1);
    expect(JSON.parse(prompts[0]!)).toMatchObject({ title: topic });
    expect(JSON.parse(prompts[0]!)).not.toHaveProperty("part");
    const { graph } = readStoredMap(db, input)!;
    expect(graph.nodes.filter((node) => node.parent === null).map((node) => node.label)).toEqual([topic]);
    expect(graph.nodes).toHaveLength(8);
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

describe("maps made on request", () => {
  /** A runner whose model call is `model`, and a way to ask for a map the way the dialog does. */
  function asking(model: GenerateInput["run"]) {
    const { db, input } = fixture(1);
    const runner = createRunner(db, () => {});
    registerMapJobs(db, runner, model);
    const settled = async () => {
      for (let i = 0; i < 400; i++) {
        const open = db.prepare("SELECT COUNT(*) FROM jobs WHERE state IN ('queued', 'running')").pluck().get();
        if (!open) return;
        await new Promise((r) => setTimeout(r, 5));
      }
      throw new Error("jobs did not settle");
    };
    return { db, input, runner, settled };
  }

  it("sends the instruction, trimmed, with every part's call, and keeps it through a resume", async () => {
    const { db, input } = fixture();
    const sent: Array<{ part?: number; instruction?: string }> = [];
    let fail = true;
    const runner = createRunner(db, () => {});
    registerMapJobs(db, runner, async (call) => {
      sent.push(JSON.parse(call.prompt));
      if (sent.length === 2 && fail) throw new Error("offline");
      return response(generated(call.prompt));
    });
    const asked = "solo le definizioni, con un esempio ciascuna";
    const first = enqueueMaps(db, runner, input, `  ${asked}\n`);
    await until(db, input, "failed");
    expect(mapBuild(db, input)).toMatchObject({ state: "failed", instruction: asked });
    fail = false;
    // Asking again with the same words picks the stopped build up instead of starting another.
    expect(enqueueMaps(db, runner, input, asked).jobId).toBe(first.jobId);
    await until(db, input, "succeeded");
    // Parts 1, 2 (failed), then 2 and 3 again: every call carried the instruction.
    expect(sent.map((call) => call.part)).toEqual([1, 2, 2, 3]);
    expect(sent.every((call) => call.instruction === asked)).toBe(true);
    // The map keeps the words, in its own JSON, for the lists to show.
    expect(readStoredMap(db, input)!.instruction).toBe(asked);
    expect(listMaps(db, input)).toEqual([expect.objectContaining({ instruction: asked })]);
    expect(listAllMaps(db)).toEqual([expect.objectContaining({ instruction: asked })]);
    expect(db.prepare("SELECT COUNT(*) FROM jobs WHERE kind = 'map-build'").pluck().get()).toBe(1);
    db.close();
  });

  it("sends no instruction when the request has none or only blanks", async () => {
    const prompts: Array<Record<string, unknown>> = [];
    const { db, input, runner, settled } = asking(async (call) => {
      prompts.push(JSON.parse(call.prompt));
      return response(generated(call.prompt));
    });
    enqueueMaps(db, runner, input, " \n\t ");
    await settled();
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).not.toHaveProperty("instruction");
    expect(readStoredMap(db, input)!.instruction).toBeUndefined();
    expect(mapBuild(db, input)!.instruction).toBeNull();
    // A blank request is the same as none: the map that exists is the answer, and nothing is built again.
    expect(enqueueMaps(db, runner, input, "  ").maps).toHaveLength(1);
    expect(db.prepare("SELECT COUNT(*) FROM jobs WHERE kind = 'map-build'").pluck().get()).toBe(1);
    db.close();
  });

  it("refuses an instruction longer than an edit's", () => {
    const { db, input, runner } = asking(run);
    expect(() => enqueueMaps(db, runner, input, "x".repeat(2001))).toThrow("map-instruction");
    expect(() => enqueueMaps(db, runner, input, "x".repeat(2000))).not.toThrow();
    db.close();
  });

  it("builds a new map for a request with an instruction even when the scope has one, and keeps the first", async () => {
    const { db, input, runner, settled } = asking(run);
    enqueueMaps(db, runner, input);
    await settled();
    const [plain] = listMaps(db, input);
    // Without an instruction the map that exists is the answer.
    expect(enqueueMaps(db, runner, input).maps).toHaveLength(1);
    expect(db.prepare("SELECT COUNT(*) FROM jobs WHERE kind = 'map-build'").pluck().get()).toBe(1);
    // With one, the same scope gets a second map, and the first stays as it was.
    const stored = readStoredMap(db, input, plain!.id)!;
    enqueueMaps(db, runner, input, "solo i teoremi");
    await settled();
    const maps = listMaps(db, input);
    expect(maps.map((map) => map.instruction)).toEqual([undefined, "solo i teoremi"]);
    expect(readStoredMap(db, input, plain!.id)).toEqual(stored);
    // The same words again, once that map is there, ask for another one.
    enqueueMaps(db, runner, input, "solo i teoremi");
    await settled();
    expect(listMaps(db, input)).toHaveLength(3);
    expect(new Set(listMaps(db, input).map((map) => map.id)).size).toBe(3);
    // A request without words still opens the first map and builds nothing.
    expect(enqueueMaps(db, runner, input).maps).toHaveLength(3);
    expect(db.prepare("SELECT COUNT(*) FROM jobs WHERE kind = 'map-build'").pluck().get()).toBe(3);
    expect(listAllMaps(db).map((entry) => entry.instruction)).toEqual([null, "solo i teoremi", "solo i teoremi"]);
    db.close();
  });

  it("treats the same scope and instruction under way as one job, and another instruction as another", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started = 0;
    const { db, input, runner, settled } = asking(async (call) => {
      started++;
      await gate;
      return response(generated(call.prompt));
    });
    const first = enqueueMaps(db, runner, input, "solo i teoremi");
    while (!started) await new Promise((r) => setTimeout(r, 1));
    expect(enqueueMaps(db, runner, input, " solo i teoremi ").jobId).toBe(first.jobId);
    // Another request is not the same job, and a request without words is not either.
    const other = enqueueMaps(db, runner, input, "con gli esempi");
    const plain = enqueueMaps(db, runner, input);
    expect(new Set([first.jobId, other.jobId, plain.jobId]).size).toBe(3);
    expect(enqueueMaps(db, runner, input).jobId).toBe(plain.jobId);
    expect(enqueueMaps(db, runner, input, "con gli esempi").jobId).toBe(other.jobId);
    // The page follows the newest build of the scope, and shows its words.
    expect(mapBuild(db, input)).toMatchObject({ jobId: plain.jobId, instruction: null });
    expect(mapBuild(db, input)).not.toBeNull();
    release();
    await settled();
    expect(listMaps(db, input).map((map) => map.instruction).sort()).toEqual([
      "con gli esempi",
      "solo i teoremi",
      undefined,
    ]);
    db.close();
  });

  it("asks again with the instruction a stopped build had", async () => {
    let fail = true;
    const { db, input, runner, settled } = asking(async (call) => {
      if (fail) throw new Error("offline");
      return response(generated(call.prompt));
    });
    const plain = enqueueMaps(db, runner, input);
    await settled();
    const asked = enqueueMaps(db, runner, input, "solo i teoremi");
    await settled();
    expect(mapBuild(db, input)).toMatchObject({ jobId: asked.jobId, state: "failed", instruction: "solo i teoremi" });
    fail = false;
    // Retrying the request that failed does not retry the plain one, which failed too.
    expect(enqueueMaps(db, runner, input, "solo i teoremi").jobId).toBe(asked.jobId);
    await settled();
    expect(listMaps(db, input).map((map) => map.instruction)).toEqual(["solo i teoremi"]);
    expect(plain.jobId).not.toBe(asked.jobId);
    db.close();
  });

  it("lets a request with an instruction leave out passages it does not ask for, and one without may not", async () => {
    const { db: many, input } = fixture(4);
    const runner = createRunner(many, () => {});
    // Eight concepts that all cite only the first passage of the part, whatever was asked.
    registerMapJobs(many, runner, async (call) => {
      const { passages } = JSON.parse(call.prompt) as { passages: Array<{ id: string }> };
      const plain = {
        nodes: Array.from({ length: 8 }, (_, i) => ({
          id: `n${i}`,
          label: `Concetto ${i}`,
          parent: i ? "n0" : null,
          sources: [passages[0]!.id],
        })),
        edges: [],
      };
      return response(JSON.parse(call.prompt).instruction ? focused(plain) : plain);
    });
    enqueueMaps(many, runner, input);
    await until(many, input, "failed");
    expect(listMaps(many, input)).toEqual([]);
    enqueueMaps(many, runner, input, "solo il primo");
    await until(many, input, "succeeded");
    const [map] = listMaps(many, input);
    // Only what the concepts cite is listed as the map's passages.
    expect(map).toMatchObject({ passageCount: 1, instruction: "solo il primo" });
    many.close();
  });
});

describe("a focused request and the parts that have nothing for it", () => {
  const asked = "solo i teoremi sui limiti";
  /** A part's reply: the map, a small one, or that the part has nothing. */
  type Reply = "nothing" | "map" | "small";
  function reply(call: { prompt: string }, kind: Reply, root = "Ramo") {
    const { passages, part } = JSON.parse(call.prompt) as { passages: Array<{ id: string }>; part?: number };
    const ids = [...new Set(passages.map((p) => p.id))];
    if (kind === "nothing") return response(focused("nothing"));
    const count = kind === "small" ? 3 : 8;
    return response(
      focused({
        nodes: Array.from({ length: count }, (_, i) => ({
          id: `n${i}`,
          label: i ? `${root} ${part ?? 1}, concetto ${i}` : `${root} ${part ?? 1}`,
          parent: i ? "n0" : null,
          sources: i ? ids.slice(0, 1) : ids,
        })),
        edges: [],
      }),
    );
  }

  it("leaves out the parts that answer they have nothing, and keeps the others as the map's branches", async () => {
    const { db, input } = fixture();
    const parts = prepareMaps(db, input).parts;
    expect(parts).toHaveLength(3);
    let call = 0;
    const runner = createRunner(db, () => {});
    registerMapJobs(db, runner, async (item) => reply(item, ++call === 2 ? "nothing" : "map"));
    enqueueMaps(db, runner, input, asked);
    await until(db, input, "succeeded");
    const [map] = listMaps(db, input);
    const stored = readStoredMap(db, input, map!.id)!;
    const root = stored.graph.nodes.find((node) => node.parent === null)!;
    const branches = stored.graph.nodes.filter((node) => node.parent === root.id).map((node) => node.label);
    expect(branches).toEqual(["Ramo 1", "Ramo 3"]);
    // Only the passages of the parts that had something are the map's.
    expect(new Set(stored.passageIds)).toEqual(
      new Set([...parts[0]!.passages, ...parts[2]!.passages].map((passage) => passage.id)),
    );
    db.close();
  });

  it("accepts a small result when little is relevant, and only for a request with an instruction", async () => {
    const { db, input } = fixture(1);
    const runner = createRunner(db, () => {});
    registerMapJobs(db, runner, async (item) => {
      const sent = JSON.parse(item.prompt) as { instruction?: string };
      const plain = reply(item, "small").structured as { result: { nodes: unknown[]; edges: unknown[] } };
      return sent.instruction ? response(focused(plain.result)) : response(plain.result);
    });
    enqueueMaps(db, runner, input);
    await until(db, input, "failed");
    expect(listMaps(db, input)).toEqual([]);
    enqueueMaps(db, runner, input, asked);
    await until(db, input, "succeeded");
    expect(readStoredMap(db, input)!.graph.nodes).toHaveLength(3);
    db.close();
  });

  it("does not take a nothing-answer from a request without an instruction", async () => {
    const { db, input } = fixture(1);
    const runner = createRunner(db, () => {});
    registerMapJobs(db, runner, async () => response(focused("nothing")));
    enqueueMaps(db, runner, input);
    await until(db, input, "failed");
    expect(mapBuild(db, input)!.error).not.toBe("map-nothing-matched");
    expect(listMaps(db, input)).toEqual([]);
    db.close();
  });

  it("stores no map and says nothing matched when every part answers it has nothing, and retry does not read again", async () => {
    const { db, input } = fixture();
    let calls = 0;
    const runner = createRunner(db, () => {});
    registerMapJobs(db, runner, async (item) => {
      calls++;
      return reply(item, "nothing");
    });
    const first = enqueueMaps(db, runner, input, asked);
    await until(db, input, "failed");
    expect(calls).toBe(3);
    expect(listMaps(db, input)).toEqual([]);
    expect(mapBuild(db, input)).toMatchObject({ state: "failed", error: "map-nothing-matched", instruction: asked });
    // The parts that came back empty are done: asking again with the same words retries without calling the model.
    expect(enqueueMaps(db, runner, input, asked).jobId).toBe(first.jobId);
    await until(db, input, "failed");
    expect(calls).toBe(3);
    expect(mapBuild(db, input)).toMatchObject({ error: "map-nothing-matched" });
    expect(listMaps(db, input)).toEqual([]);
    // Other words are another request, which reads the material again.
    enqueueMaps(db, runner, input, "solo le definizioni");
    await until(db, input, "failed");
    expect(calls).toBe(6);
    db.close();
  });

  it("follows the same rule when the request has a single part", async () => {
    const { db, input } = fixture(1);
    const runner = createRunner(db, () => {});
    registerMapJobs(db, runner, async (item) => reply(item, "nothing"));
    enqueueMaps(db, runner, input, asked);
    await until(db, input, "failed");
    expect(mapBuild(db, input)).toMatchObject({ error: "map-nothing-matched" });
    expect(listMaps(db, input)).toEqual([]);
    db.close();
  });

  it("resumes after a failed part without reading the parts that were done, the empty ones included", async () => {
    const { db, input } = fixture();
    const parts: number[] = [];
    let fail = true;
    const runner = createRunner(db, () => {});
    registerMapJobs(db, runner, async (item) => {
      const { part } = JSON.parse(item.prompt) as { part: number };
      parts.push(part);
      if (part === 2 && fail) throw new Error("offline");
      return reply(item, part === 1 ? "nothing" : "map");
    });
    const job = enqueueMaps(db, runner, input, asked);
    await until(db, input, "failed");
    expect(mapBuild(db, input)).toMatchObject({ state: "failed", progress: 1 / 3 });
    fail = false;
    expect(enqueueMaps(db, runner, input, asked).jobId).toBe(job.jobId);
    await until(db, input, "succeeded");
    // Part 1 (nothing) was not read again.
    expect(parts).toEqual([1, 2, 2, 3]);
    const stored = readStoredMap(db, input)!;
    const root = stored.graph.nodes.find((node) => node.parent === null)!;
    expect(stored.graph.nodes.filter((node) => node.parent === root.id).map((node) => node.label)).toEqual([
      "Ramo 2",
      "Ramo 3",
    ]);
    db.close();
  });
});

describe("reading a build by its job, and the map it made", () => {
  /** Builds whose model call fails when the instruction starts with "fail", and waits for `release` when it starts with "hold". */
  function twoBuilds() {
    const { db, input } = fixture(1);
    const runner = createRunner(db, () => {});
    const held = new Map<string, () => void>();
    registerMapJobs(db, runner, async (call) => {
      const { instruction } = JSON.parse(call.prompt) as { instruction?: string };
      if (instruction?.startsWith("fail")) throw new Error("offline");
      if (instruction?.startsWith("hold"))
        await new Promise<void>((resolve) => {
          held.set(instruction, resolve);
        });
      return response(generated(call.prompt));
    });
    const waitFor = async (check: () => boolean) => {
      for (let i = 0; i < 400 && !check(); i++) await new Promise((r) => setTimeout(r, 5));
      expect(check()).toBe(true);
    };
    return { db, input, runner, held, waitFor };
  }

  it("reads the build the student asked for, not the newest one of the scope", async () => {
    const { db, input, runner } = twoBuilds();
    const a = enqueueMaps(db, runner, input, "fail: solo A");
    await until(db, input, "failed");
    const b = enqueueMaps(db, runner, input, "solo B");
    await until(db, input, "succeeded");
    // The newest build is B's...
    expect(mapBuild(db, input)).toMatchObject({ jobId: b.jobId, state: "succeeded" });
    // ...but A's progress is A's, and asking for A again retries A.
    expect(mapBuild(db, input, a.jobId)).toMatchObject({ jobId: a.jobId, state: "failed", instruction: "fail: solo A" });
    expect(enqueueMaps(db, runner, input, "fail: solo A").jobId).toBe(a.jobId);
    expect(mapBuild(db, input, a.jobId)!.jobId).toBe(a.jobId);
    db.close();
  });

  it("reads no build by a job that is not one of the scope's map builds", async () => {
    const { db, input, runner } = twoBuilds();
    const a = enqueueMaps(db, runner, input, "solo A");
    await until(db, input, "succeeded");
    expect(mapBuild(db, input, "missing")).toBeNull();
    const other = fixture(1);
    expect(mapBuild(other.db, other.input, a.jobId)).toBeNull();
    db.close();
    other.db.close();
  });

  it("returns the id of the map a finished build made, whatever order two builds finish in", async () => {
    const { db, input, runner, held, waitFor } = twoBuilds();
    const a = enqueueMaps(db, runner, input, "hold A");
    const b = enqueueMaps(db, runner, input, "hold B");
    await waitFor(() => held.size === 2);
    expect(mapBuild(db, input, a.jobId)!.mapId).toBeNull();
    // The newer request finishes first, the older one after it, so the older map is the last the scope holds.
    held.get("hold B")!();
    await waitFor(() => mapBuild(db, input, b.jobId)?.state === "succeeded");
    held.get("hold A")!();
    await waitFor(() => mapBuild(db, input, a.jobId)?.state === "succeeded");
    const maps = listMaps(db, input);
    expect(maps.map((map) => map.instruction)).toEqual(["hold B", "hold A"]);
    expect(mapBuild(db, input, a.jobId)!.mapId).toBe(maps[1]!.id);
    expect(mapBuild(db, input, b.jobId)!.mapId).toBe(maps[0]!.id);
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

describe("renaming and deleting a map", () => {
  it("renames one map of a topic, allows a name another map has, and finds it by the new name", async () => {
    const { db, input } = fixture(4);
    await generateMaps(db, input, run);
    const runner = createRunner(db, () => {});
    registerMapJobs(db, runner, run);
    enqueueMaps(db, runner, input, "solo i teoremi");
    await until(db, input, "succeeded");
    const [plain, focusedMap] = listMaps(db, input);
    expect(renameMap(db, input, focusedMap!.id, "  Teoremi sui limiti ").title).toBe("Teoremi sui limiti");
    expect(renameMap(db, input, plain!.id, "Teoremi sui limiti").title).toBe("Teoremi sui limiti");
    expect(listMaps(db, input).map((map) => map.title)).toEqual(["Teoremi sui limiti", "Teoremi sui limiti"]);
    // The request it was built from stays, so the switcher still tells the two apart.
    expect(listMaps(db, input)[1]!.instruction).toBe("solo i teoremi");
    expect(listAllMaps(db, "teoremi limiti")).toHaveLength(2);
    expect(() => renameMap(db, input, "gone", "Altro")).toThrow("map-missing");
    expect(() => renameMap(db, input, plain!.id, "   ")).toThrow("map-title");
    db.close();
  });

  it("deletes one map and keeps the others, and the row goes with the last map", async () => {
    const { db, input } = fixture(4);
    const runner = createRunner(db, () => {});
    registerMapJobs(db, runner, run);
    enqueueMaps(db, runner, input);
    await until(db, input, "succeeded");
    enqueueMaps(db, runner, input, "solo i teoremi");
    await until(db, input, "succeeded");
    const [plain, focusedMap] = listMaps(db, input);
    expect(deleteMapAndBuilds(db, runner, input, { mapId: focusedMap!.id })).toBe(true);
    expect(listMaps(db, input).map((map) => map.id)).toEqual([plain!.id]);
    // Deleting it again is not an error: the map is gone, as asked.
    expect(deleteMapAndBuilds(db, runner, input, { mapId: focusedMap!.id })).toBe(false);
    expect(deleteMapAndBuilds(db, runner, input, { mapId: plain!.id })).toBe(true);
    expect(listMaps(db, input)).toEqual([]);
    expect(listAllMaps(db)).toEqual([]);
    expect(db.prepare("SELECT COUNT(*) FROM maps").pluck().get()).toBe(0);
    db.close();
  });

  it("builds a new map for a plain request once the map its finished build made was deleted", async () => {
    const { db, input } = fixture(4);
    const runner = createRunner(db, () => {});
    registerMapJobs(db, runner, run);
    const first = enqueueMaps(db, runner, input);
    await until(db, input, "succeeded");
    // While the map is there, a plain request is answered by it.
    expect(enqueueMaps(db, runner, input).jobId).toBe(first.jobId);
    deleteMapAndBuilds(db, runner, input, { mapId: listMaps(db, input)[0]!.id });
    const again = enqueueMaps(db, runner, input);
    expect(again.jobId).not.toBe(first.jobId);
    await until(db, input, "succeeded");
    expect(listMaps(db, input)).toHaveLength(1);
    db.close();
  });

  it("stops a map still being written, and the build ending later does not bring it back", async () => {
    const { db, input } = fixture(4);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const slow: GenerateInput["run"] = async (call) => {
      await gate;
      return response(generated(call.prompt));
    };
    const runner = createRunner(db, () => {});
    registerMapJobs(db, runner, slow);
    const { jobId } = enqueueMaps(db, runner, input, "solo i teoremi");
    await until(db, input, "running");
    // The page names a map being written by its build.
    expect(deleteMapAndBuilds(db, runner, input, { jobId: jobId! })).toBe(false);
    release();
    for (let i = 0; i < 100 && mapBuild(db, input, jobId)?.state === "running"; i++)
      await new Promise((r) => setTimeout(r, 5));
    expect(mapBuild(db, input, jobId)?.state).toBe("cancelled");
    expect(listMaps(db, input)).toEqual([]);
    // It left Attività, so nothing offers to resume it, and the scope has no build to show.
    expect(runner.list().some((job) => job.id === jobId)).toBe(false);
    expect(mapBuild(db, input)).toBeNull();
    db.close();
  });

  it("gives up a stopped build of the map, so resuming it cannot bring the map back", async () => {
    const { db, input } = fixture(4);
    const runner = createRunner(db, () => {});
    registerMapJobs(db, runner, run);
    const { jobId } = enqueueMaps(db, runner, input);
    await until(db, input, "succeeded");
    const mapId = listMaps(db, input)[0]!.id;
    // A second build that names the same map, stopped on its way, as after a quit.
    const stopped = runner.start("map-build", { ...prepareMaps(db, input), mapId, built: [], next: 0 });
    runner.cancel(stopped);
    deleteMapAndBuilds(db, runner, input, { mapId });
    expect(runner.list().some((job) => job.id === stopped)).toBe(false);
    // Riprendi in Attività resumes what it lists; a build given up is not resumed, even when asked for by id.
    expect(runner.resumeAll([stopped])).toEqual([]);
    expect(mapBuild(db, input, stopped)?.state).toBe("cancelled");
    expect(listMaps(db, input)).toEqual([]);
    // The finished build that made the map stays in today's list as what happened.
    expect(mapBuild(db, input, jobId)?.state).toBe("succeeded");
    db.close();
  });

  it("makes an AI edit that ends after its map was deleted fail, without storing the map again", async () => {
    const { db, input } = fixture(4);
    await generateMaps(db, input, run);
    const mapId = listMaps(db, input)[0]!.id;
    const runner = createRunner(db, () => {});
    let deleted = false;
    const edit = editMap(db, { ...input, mapId, instruction: "aggiungi un esempio" }, async () => {
      deleteMapAndBuilds(db, runner, input, { mapId });
      deleted = true;
      return response({ ops: [{ op: "add_node", id: "x", label: "Esempio", parent: "n0" }] });
    });
    await expect(edit).rejects.toThrow("map-missing");
    expect(deleted).toBe(true);
    expect(listMaps(db, input)).toEqual([]);
    db.close();
  });
});
