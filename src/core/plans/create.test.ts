import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../db/connection";
import { importSmartbook } from "../sources/smartbook";
import { createPlan } from "./create";

function pack(files: Record<string, string>): Uint8Array {
  return zipSync(
    Object.fromEntries(Object.entries(files).map(([name, text]) => [name, strToU8(text)])),
  );
}

describe("createPlan", () => {
  it("builds a topic per chapter without calling a model", () => {
    const db = openDatabase(":memory:");
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
        "chapters/01.md": "## p1 | Energia\nIl vettore posizione descrive il punto.\n",
        "chapters/02.md": "## p1 | Newton\nLa forza cambia la quantita di moto.\n",
      }),
    );
    const plan = createPlan(db, {
      title: "Fisica 1",
      sourceIds: [imported.sourceId],
    });
    expect(plan.topics).toBe(2);
    expect(plan.pathNodes).toBe(2);
    const linked = db
      .prepare(
        `SELECT COUNT(*) AS n FROM topic_passages tp
         JOIN topics t ON t.id = tp.topic_id WHERE t.plan_id = ?`,
      )
      .get(plan.planId) as { n: number };
    expect(linked.n).toBe(2);
  });
});
