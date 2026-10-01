import { expect, it, vi } from "vitest";
import { openDatabase } from "../db/connection";
import { indexModelVectors } from "./embed";

vi.mock("./worker-client", () => ({
  runSourceWorker: async (_name: string, input: { texts: string[] }) => {
    await Promise.resolve();
    return input.texts.map(() => { const vector = new Array<number>(384).fill(0); vector[0] = 1; return vector; });
  },
}));

it("SRC-21 concurrent import and model-download indexing commits each vector once", async () => {
  const db = openDatabase(":memory:");
  db.prepare(`INSERT INTO passages (id, text, created_at) VALUES ('p1', 'energia', 1)`).run();
  await Promise.all([
    indexModelVectors(db, "fixture", new AbortController().signal),
    indexModelVectors(db, "fixture", new AbortController().signal),
  ]);
  expect(db.prepare(`SELECT COUNT(*) AS n FROM passages_vec`).get()).toEqual({ n: 1 });
  db.close();
});
