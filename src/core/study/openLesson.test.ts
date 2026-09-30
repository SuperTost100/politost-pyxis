import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../db/connection";
import { createPlan } from "../plans/create";
import { importSmartbook } from "../sources/smartbook";
import { openLesson } from "./openLesson";

function pack(files: Record<string, string>): Uint8Array {
  return zipSync(
    Object.fromEntries(Object.entries(files).map(([name, text]) => [name, strToU8(text)])),
  );
}

describe("openLesson", () => {
  it("returns the chapter text and the same text on the second open", () => {
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
        "chapters/01.md": "## p1 | Energia\nIl vettore sposta il punto.\n",
        "esercizi.md": "",
      }),
    );
    const plan = createPlan(db, { title: "Fisica 1", sourceIds: [imported.sourceId] });
    const topic = db.prepare(`SELECT id FROM topics WHERE plan_id = ?`).get(plan.planId) as {
      id: string;
    };
    const first = openLesson(db, plan.planId, topic.id);
    const second = openLesson(db, plan.planId, topic.id);
    expect(first.markdown).toContain("Il vettore");
    expect(first.passageIds.length).toBeGreaterThan(0);
    expect(second).toEqual(first);
    const rows = db.prepare(`SELECT COUNT(*) AS n FROM items WHERE kind = 'lesson'`).get() as {
      n: number;
    };
    expect(rows.n).toBe(1);
  });
});
