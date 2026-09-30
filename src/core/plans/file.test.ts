import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../db/connection";
import { createPlan } from "./create";
import { exportPlan, importPlan } from "./file";
import { httpPlanUrl } from "../../shared/plan-file";
import { importSmartbook } from "../sources/smartbook";

function pack(files: Record<string, string>): Uint8Array {
  return zipSync(
    Object.fromEntries(Object.entries(files).map(([name, text]) => [name, strToU8(text)])),
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
    const plan = createPlan(db, { title: "Fisica 1", sourceIds: [imported.sourceId] });
    db.prepare(
      `INSERT INTO cards (id, plan_id, topic_id, front, back, grounding, created_at)
       VALUES ('card-1', ?, (SELECT id FROM topics WHERE plan_id = ?), 'fronte', 'retro', 'sources', 1)`,
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
    const card = db.prepare(`SELECT front, back FROM cards WHERE plan_id = ?`).get(copyId) as {
      front: string;
      back: string;
    };
    expect(card).toEqual({ front: "fronte", back: "retro" });
  });

  it("accepts only an http plan link", () => {
    expect(httpPlanUrl("https://example.com/piano.json")).toBe(
      "https://example.com/piano.json",
    );
    expect(() => httpPlanUrl("file:///tmp/piano.json")).toThrow("plan-url");
  });
});
