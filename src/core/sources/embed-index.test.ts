import { expect, it, vi } from "vitest";
import { openDatabase } from "../db/connection";
import { indexModelVectors, setEmbeddingConsent } from "./embed";

let duringEmbed: (() => void) | undefined;
vi.mock("./worker-client", () => ({
  runSourceWorker: async (_name: string, input: { texts: string[] }) => {
    await Promise.resolve();
    duringEmbed?.();
    return input.texts.map(() => { const vector = new Array<number>(384).fill(0); vector[0] = 1; return vector; });
  },
}));

it("SRC-21 concurrent import and model-download indexing commits each vector once", async () => {
  const db = openDatabase(":memory:");
  setEmbeddingConsent(db, true);
  db.prepare(`INSERT INTO passages (id, text, created_at) VALUES ('p1', 'energia', 1)`).run();
  await Promise.all([
    indexModelVectors(db, "fixture", new AbortController().signal),
    indexModelVectors(db, "fixture", new AbortController().signal),
  ]);
  expect(db.prepare(`SELECT COUNT(*) AS n FROM passages_vec`).get()).toEqual({ n: 1 });
  db.close();
});

it("indexing stops after the batch in progress when local search is turned off", async () => {
  const db = openDatabase(":memory:");
  setEmbeddingConsent(db, true);
  const insert = db.prepare(`INSERT INTO passages (id, text, created_at) VALUES (?, 'energia', 1)`);
  for (let i = 0; i < 70; i += 1) insert.run(`p${i}`);
  let batches = 0;
  duringEmbed = () => {
    batches += 1;
    setEmbeddingConsent(db, false);
  };
  await indexModelVectors(db, "fixture", new AbortController().signal);
  duringEmbed = undefined;
  expect(batches).toBe(1);
  expect(db.prepare(`SELECT COUNT(*) AS n FROM passages_vec`).get()).toEqual({ n: 32 });
  db.close();
});

it("indexing reads on from the last batch and prepares its statements once", async () => {
  const db = openDatabase(":memory:");
  setEmbeddingConsent(db, true);
  const insert = db.prepare(`INSERT INTO passages (id, text, created_at) VALUES (?, 'energia', 1)`);
  for (let i = 0; i < 70; i += 1) insert.run(`p${i}`);
  const prepare = db.prepare.bind(db);
  const prepared: string[] = [];
  db.prepare = ((sql: string) => {
    prepared.push(sql);
    return prepare(sql);
  }) as typeof db.prepare;
  const count = await indexModelVectors(db, "fixture", new AbortController().signal);
  db.prepare = prepare;
  expect(count).toBe(70);
  expect(db.prepare(`SELECT COUNT(*) AS n FROM passages_vec`).get()).toEqual({ n: 70 });
  // Four statements, then one consent check before each of the three batches and before the read that ends the loop.
  expect(prepared.length).toBe(8);
  db.close();
});
