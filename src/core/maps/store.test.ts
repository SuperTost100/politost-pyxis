import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../db/connection";
import { createPlan } from "../plans/create";
import { importSmartbook } from "../sources/smartbook";
import {
  openTopicMap,
  patchTopicMap,
  setTopicLayout,
  undoTopicMap,
} from "./store";

function pack(files: Record<string, string>): Uint8Array {
  return zipSync(
    Object.fromEntries(
      Object.entries(files).map(([name, text]) => [name, strToU8(text)]),
    ),
  );
}

describe("openTopicMap", () => {
  it("builds a tree from the chapter and undoes an added branch", () => {
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
    });
    const topic = db
      .prepare(`SELECT id FROM topics WHERE plan_id = ?`)
      .get(plan.planId) as {
      id: string;
    };
    const opened = openTopicMap(db, plan.planId, topic.id);
    expect(opened.nodes[0]?.label).toContain("Moti");
    expect(opened.nodes.length).toBeGreaterThan(1);
    const patched = patchTopicMap(db, plan.planId, topic.id, [
      {
        op: "add_node",
        id: "chain",
        label: "Regola della catena",
        parent: "root",
      },
    ]);
    expect(
      patched.nodes.some((node) => node.label === "Regola della catena"),
    ).toBe(true);
    const undone = undoTopicMap(db, plan.planId, topic.id);
    expect(undone.nodes.some((node) => node.id === "chain")).toBe(false);
    const radial = setTopicLayout(db, plan.planId, topic.id, "radial");
    expect(radial.layout).toBe("radial");
    expect(undoTopicMap(db, plan.planId, topic.id).layout).toBe("tree");
    // An edit reads the topic's map row once.
    const prepare = db.prepare.bind(db);
    let reads = 0;
    db.prepare = ((sql: string) => {
      if (/FROM maps/.test(sql)) reads += 1;
      return prepare(sql);
    }) as typeof db.prepare;
    setTopicLayout(db, plan.planId, topic.id, "radial");
    db.prepare = prepare;
    expect(reads).toBe(1);
  });

  it("gives a topic without a map the outline before the first edit, and refuses an unknown map", () => {
    const db = openDatabase(":memory:");
    const plan = createPlan(db, { title: "Vuoto", sourceIds: [] });
    db.prepare(
      `INSERT INTO topics (id, plan_id, title, position, created_at) VALUES ('t', ?, 'Moti', 0, 1)`,
    ).run(plan.planId);
    expect(setTopicLayout(db, plan.planId, "t", "radial")).toMatchObject({
      layout: "radial",
      nodes: [expect.objectContaining({ label: "Moti" })],
    });
    expect(() => setTopicLayout(db, plan.planId, "t", "tree", "nope")).toThrow("map-missing");
  });
});
