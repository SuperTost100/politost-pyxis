import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../db/connection";
import { createPlan } from "../plans/create";
import { importSmartbook } from "../sources/smartbook";
import { topicExercises } from "./exercises";

function pack(files: Record<string, string>): Uint8Array {
  return zipSync(
    Object.fromEntries(Object.entries(files).map(([name, text]) => [name, strToU8(text)])),
  );
}

describe("topicExercises", () => {
  it("returns the book's exercises for that chapter only", () => {
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
        "chapters/01.md": "## p1 | Energia\nIl vettore.\n",
        "chapters/02.md": "## p1 | Newton\nLa forza.\n",
        "esercizi.md":
          ':::exercise{id="e1" chapter="1"}\nQuanto vale il lavoro?\n:::solution\nW = F s.\n:::\n:::\n:::exercise{id="e2" chapter="2"}\nQuanto vale la forza?\n:::solution\nF = ma.\n:::\n:::\n',
      }),
    );
    const plan = createPlan(db, { title: "Fisica 1", sourceIds: [imported.sourceId] });
    const topics = db
      .prepare(`SELECT id, title FROM topics WHERE plan_id = ? ORDER BY position`)
      .all(plan.planId) as Array<{ id: string; title: string }>;
    const first = topicExercises(db, topics[0]?.id ?? "");
    const second = topicExercises(db, topics[1]?.id ?? "");
    expect(first.map((row) => row.prompt)).toEqual(["Quanto vale il lavoro?"]);
    expect(first[0]?.answer).toContain("W = F");
    const passage = db
      .prepare(`SELECT id FROM passages WHERE source_id = ? AND section_path = '1. Moti'`)
      .get(imported.sourceId) as { id: string };
    expect(first[0]?.passageId).toBe(passage.id);
    expect(second.map((row) => row.prompt)).toEqual(["Quanto vale la forza?"]);
  });
});
