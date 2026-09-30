import { describe, expect, it } from "vitest";
import { openDatabase } from "../db/connection";
import { uuidv7 } from "../../shared/ids";
import { fuseRanks, retrieve } from "./retrieve";

function passage(db: ReturnType<typeof openDatabase>, text: string, vector?: Float32Array) {
  const id = uuidv7();
  db.prepare(`INSERT INTO passages (id, text, created_at) VALUES (?, ?, ?)`).run(
    id,
    text,
    1,
  );
  if (vector) {
    const row = db.prepare(`SELECT rowid AS n FROM passages WHERE id = ?`).get(id) as {
      n: number;
    };
    db.prepare(
      `INSERT INTO passages_vec (passage_rowid, embedding) VALUES (?, ?)`,
    ).run(BigInt(row.n), Buffer.from(vector.buffer));
  }
  return id;
}

function unit(index: number): Float32Array {
  const vector = new Float32Array(384);
  vector[index] = 1;
  return vector;
}

describe("retrieve", () => {
  it("fuses two ranked lists", () => {
    expect(fuseRanks([["a", "b"], ["b", "c"]])).toEqual(["b", "a", "c"]);
  });

  it("searches with FTS when no embedding model is passed", () => {
    const db = openDatabase(":memory:");
    const id = passage(db, "la velocità è la derivata dello spazio");
    passage(db, "il calore aumenta l energia interna");
    const found = retrieve(db, "velocità");
    expect(found.usedVectors).toBe(false);
    expect(found.covered).toBe(true);
    expect(found.hits[0]?.id).toBe(id);
    expect(retrieve(db, "fotosintesi delle banane").covered).toBe(false);
  });

  it("finds a nearby passage when the embedding model is present", () => {
    const db = openDatabase(":memory:");
    passage(db, "la velocità è la derivata dello spazio", unit(0));
    const near = passage(db, "il calore aumenta l energia interna", unit(1));
    const found = retrieve(db, "quanto calore", {
      embed: () => unit(1),
    });
    expect(found.usedVectors).toBe(true);
    expect(found.covered).toBe(true);
    expect(found.hits.some((hit) => hit.id === near)).toBe(true);
  });

  it("reports no coverage when both scores are weak", () => {
    const db = openDatabase(":memory:");
    passage(db, "la velocità è la derivata dello spazio", unit(0));
    const found = retrieve(db, "fotosintesi", { embed: () => unit(3) });
    expect(found.covered).toBe(false);
    expect(found.hits).toHaveLength(0);
  });
});
