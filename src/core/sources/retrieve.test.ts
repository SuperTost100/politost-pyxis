import { describe, expect, it } from "vitest";
import { openDatabase } from "../db/connection";
import { uuidv7 } from "../../shared/ids";
import { fuseRanks, retrieve } from "./retrieve";

function passage(
  db: ReturnType<typeof openDatabase>,
  text: string,
  vector?: Float32Array,
) {
  const id = uuidv7();
  db.prepare(
    `INSERT INTO passages (id, text, created_at) VALUES (?, ?, ?)`,
  ).run(id, text, 1);
  if (vector) {
    const row = db
      .prepare(`SELECT rowid AS n FROM passages WHERE id = ?`)
      .get(id) as {
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
    expect(
      fuseRanks([
        ["a", "b"],
        ["b", "c"],
      ]),
    ).toEqual(["b", "a", "c"]);
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
    expect(retrieve(db, "definizione della velocità").hits[0]?.id).toBe(id);
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

  it("SRC-21 scopes before KNN ranking even when 30 other vectors are nearer", () => {
    const db = openDatabase(":memory:");
    db.exec(`INSERT INTO sources (id, kind, title, created_at, updated_at) VALUES ('s1', 'text', 'Physics', 1, 1);
      INSERT INTO source_documents (id, source_id, version, tree_json, created_at) VALUES ('d1', 's1', 1, '{}', 1)`);
    for (let n = 0; n < 35; n++) passage(db, `outside ${n}`, unit(0));
    const id = passage(db, "scoped physics", unit(0));
    db.prepare(
      `UPDATE passages SET source_id = 's1', document_id = 'd1' WHERE id = ?`,
    ).run(id);
    const found = retrieve(db, "no lexical match", {
      sourceIds: ["s1"],
      embed: () => unit(0),
    });
    expect(found.hits.map((hit) => hit.id)).toEqual([id]);
    db.close();
  });
});

it("unscoped retrieval excludes chat-only documents, including vector results", () => {
  const db = openDatabase(":memory:");
  try {
    db.exec(`INSERT INTO sources (id,kind,title,library,created_at,updated_at) VALUES ('private','txt','Private chat',0,1,1);
      INSERT INTO source_documents (id,source_id,version,tree_json,created_at) VALUES ('private-doc','private',1,'{}',1)`);
    const id = passage(db, "confidential velocità", unit(0));
    db.prepare(
      "UPDATE passages SET source_id='private', document_id='private-doc' WHERE id=?",
    ).run(id);
    expect(retrieve(db, "velocità", { embed: () => unit(0) })).toMatchObject({
      covered: false,
      hits: [],
    });
    expect(
      retrieve(db, "velocità", {
        sourceIds: ["private"],
        embed: () => unit(0),
      }).hits.map((hit) => hit.id),
    ).toEqual([id]);
  } finally {
    db.close();
  }
});

it("one incidental keyword does not cover an unrelated multi-topic question", () => {
  const db = openDatabase(":memory:");
  try {
    passage(db, "Il vettore posizione descrive il punto.");
    expect(retrieve(db, "vettore fotosintesi banane clorofilla").covered).toBe(
      false,
    );
    expect(retrieve(db, "definizione del vettore").covered).toBe(true);
  } finally {
    db.close();
  }
});
