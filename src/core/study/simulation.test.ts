import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../db/connection";
import { createPlan } from "../plans/create";
import { importSmartbook } from "../sources/smartbook";
import { readSimulation, startSimulation } from "./simulation";

function pack(files: Record<string, string>): Uint8Array {
  return zipSync(
    Object.fromEntries(Object.entries(files).map(([name, text]) => [name, strToU8(text)])),
  );
}

describe("simulation", () => {
  it("keeps the remaining time and submits when the clock hits zero", () => {
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
        "esercizi.md":
          ':::exercise{id="e1" chapter="1"}\nQuanto vale?\n:::solution\n10 N\n:::\n:::\n',
      }),
    );
    const plan = createPlan(db, { title: "Fisica 1", sourceIds: [imported.sourceId] });
    const start = 1_700_000_000_000;
    const opened = startSimulation(db, plan.planId, 30, start);
    expect(JSON.stringify(opened.questions)).not.toContain("10 N");
    const midway = readSimulation(db, opened.attemptId, start + 60_000);
    expect(midway.submitted).toBe(false);
    expect(midway.leftMs).toBe(29 * 60_000);
    const ended = readSimulation(db, opened.attemptId, start + 31 * 60_000);
    expect(ended.submitted).toBe(true);
    expect(ended.leftMs).toBe(0);
  });
});
