import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase } from "../db/connection";
import { MODEL_FILES, setEmbeddingConsent } from "./embed";
import { checkSyllabus, compareToPlans, OFF_SYLLABUS_BELOW, offSyllabus, planContextTexts, sectionVectors, storedSyllabus, syllabusFor } from "./syllabus";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A 384-dimension vector pointing mostly along `axis`, with a little of `other`. */
const vector = (axis: number, other = 0, mix = 0): Float32Array => {
  const v = new Float32Array(384);
  v[axis] = 1;
  if (mix) v[other] = mix;
  return v;
};

function setup() {
  const model = mkdtempSync(join(tmpdir(), "pyxis-syllabus-"));
  dirs.push(model);
  for (const name of Object.keys(MODEL_FILES)) {
    mkdirSync(dirname(join(model, name)), { recursive: true });
    writeFileSync(join(model, name), "");
  }
  const db = openDatabase(":memory:");
  setEmbeddingConsent(db, true);
  db.prepare(`INSERT INTO subjects (id, name, created_at) VALUES ('sub', 'Termodinamica', 1)`).run();
  db.prepare(`INSERT INTO plans (id, subject_id, title, status, created_at, updated_at) VALUES ('plan', 'sub', 'Fisica tecnica', 'ready', 1, 1)`).run();
  db.prepare(`INSERT INTO sources (id, kind, title, status, created_at, updated_at) VALUES ('src', 'pdf', 'Dispense', 'ready', 1, 1)`).run();
  db.prepare(`INSERT INTO plan_sources (plan_id, source_id) VALUES ('plan', 'src')`).run();
  db.prepare(`INSERT INTO source_documents (id, source_id, version, tree_json, created_at) VALUES ('d1', 'src', 1, '{}', 1)`).run();
  db.prepare(`INSERT INTO source_documents (id, source_id, version, tree_json, created_at) VALUES ('d2', 'src', 2, '{}', 2)`).run();
  const topic = db.prepare(`INSERT INTO topics (id, plan_id, title, position, archived_at, created_at) VALUES (?, 'plan', ?, ?, ?, 1)`);
  topic.run("t1", "Primo principio", 0, null);
  topic.run("t2", "Entropia", 1, null);
  topic.run("t3", "Argomento tolto", 2, 5);
  let rowid = 0;
  const passage = (id: string, doc: string, section: string, vec: Float32Array | null) => {
    rowid += 1;
    db.prepare(
      `INSERT INTO passages (rowid, id, source_id, document_id, version, text, section_path, created_at) VALUES (?, ?, 'src', ?, ?, ?, ?, 1)`,
    ).run(rowid, id, doc, doc === "d1" ? 1 : 2, `testo ${id}`, section);
    if (vec) db.prepare(`INSERT INTO passages_vec (passage_rowid, embedding) VALUES (?, ?)`).run(BigInt(rowid), Buffer.from(vec.buffer));
  };
  return { model, db, passage };
}

describe("SRC-08 off-syllabus sections, from vectors the index already holds", () => {
  it("reads the plan's title, subject and live topics, and leaves out a topic removed from the path", () => {
    const { db } = setup();
    expect(planContextTexts(db, "plan")).toEqual(["Fisica tecnica", "Termodinamica", "Primo principio", "Entropia"]);
    expect(planContextTexts(db, "missing")).toEqual([]);
    db.close();
  });

  it("averages passages per section of the current version only", () => {
    const { db, passage } = setup();
    passage("old", "d1", "Capitolo 1", vector(9));
    passage("a", "d2", "Capitolo 1", vector(0));
    passage("b", "d2", "Capitolo 1", vector(1));
    const sections = sectionVectors(db, "src");
    expect([...sections.keys()]).toEqual(["Capitolo 1"]);
    const mean = sections.get("Capitolo 1")!;
    expect([mean[0], mean[1], mean[9]]).toEqual([0.5, 0.5, 0]);
    db.close();
  });

  it("flags the sections far from every plan text, least related first, and keeps the near ones", () => {
    const sections = new Map([
      ["Calore", vector(0, 5, 0.2)],
      ["Entropia", vector(1)],
      ["Ricette di cucina", vector(7)],
      ["Storia romana", vector(8, 7, 0.4)],
    ]);
    const plan = [vector(0), vector(1)];
    const result = offSyllabus(sections, plan);
    expect(result.sections).toBe(4);
    expect(result.off).toBe(2);
    expect(result.worst.map((entry) => entry.section)).toEqual(["Ricette di cucina", "Storia romana"]);
    expect(result.worst.every((entry) => entry.similarity < OFF_SYLLABUS_BELOW)).toBe(true);
    // Raising the bar flags the section that is only partly aligned.
    expect(offSyllabus(sections, plan, 0.99).off).toBe(3);
  });

  it("checks each plan that uses the source, embeds only the short plan texts, and makes no engine request", async () => {
    const { db, model, passage } = setup();
    passage("a", "d2", "Primo principio", vector(0));
    passage("b", "d2", "Ricette", vector(7));
    const asked: string[][] = [];
    const embed = async (_dir: string, texts: string[]) => {
      asked.push(texts);
      // Both plan texts about heat point along axis 0 and 1; the rest of the world is elsewhere.
      return texts.map((_, index) => vector(index === 2 || index === 0 ? 0 : 1));
    };
    const result = await checkSyllabus(db, model, "src", undefined, embed as never);
    expect(asked).toEqual([["query: Fisica tecnica", "query: Termodinamica", "query: Primo principio", "query: Entropia"]]);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ planId: "plan", planTitle: "Fisica tecnica", state: "checked", sections: 2, off: 1 });
    expect(result[0]!.worst).toEqual([{ section: "Ricette", similarity: 0 }]);
    db.close();
  });

  it("says why it cannot check instead of passing the source: no model, no vectors, no plan text", async () => {
    const { db, model, passage } = setup();
    const never = (async () => {
      throw new Error("not called");
    }) as never;
    // Not consented, so the local search model is off.
    setEmbeddingConsent(db, false);
    expect((await checkSyllabus(db, model, "src", undefined, never))[0]).toMatchObject({ state: "unavailable", off: 0 });
    setEmbeddingConsent(db, true);
    // Consented but nothing indexed yet.
    expect((await checkSyllabus(db, model, "src", undefined, never))[0]).toMatchObject({ state: "unindexed" });
    passage("a", "d2", "Capitolo", vector(0));
    db.prepare(`UPDATE plans SET title = '' WHERE id = 'plan'`).run();
    db.prepare(`UPDATE plans SET subject_id = NULL WHERE id = 'plan'`).run();
    db.prepare(`DELETE FROM topics`).run();
    expect((await checkSyllabus(db, model, "src", undefined, never))[0]).toMatchObject({ state: "no-context" });
    // A source no plan uses has nothing to be off.
    db.prepare(`DELETE FROM plan_sources`).run();
    expect(await checkSyllabus(db, model, "src", undefined, never)).toEqual([]);
    db.close();
  });

  it("stops when cancelled", async () => {
    const { db, model, passage } = setup();
    passage("a", "d2", "Capitolo", vector(0));
    const controller = new AbortController();
    controller.abort();
    await expect(checkSyllabus(db, model, "src", controller.signal, (async () => [vector(0)]) as never)).rejects.toThrow();
    db.close();
  });

  describe("stored after indexing", () => {
    const embedAlong = (calls: { n: number }) =>
      (async (_dir: string, texts: string[]) => {
        calls.n += 1;
        return texts.map(() => vector(0));
      }) as never;
    const stored = (db: ReturnType<typeof setup>["db"]) =>
      db.prepare(`SELECT value_json FROM settings WHERE key = 'syllabus.src'`).get();

    it("computes once, serves the stored result until the plan material or the source version changes", async () => {
      const { db, model, passage } = setup();
      passage("a", "d2", "Calore", vector(0));
      passage("b", "d2", "Ricette", vector(7));
      const calls = { n: 0 };
      const embed = embedAlong(calls);
      const first = await syllabusFor(db, model, "src", undefined, embed);
      expect(first[0]).toMatchObject({ state: "checked", sections: 2, off: 1 });
      expect(stored(db)).toBeTruthy();
      expect(await syllabusFor(db, model, "src", undefined, embed)).toEqual(first);
      expect(calls.n).toBe(1);
      // A new topic changes what the source is compared with.
      db.prepare(`INSERT INTO topics (id, plan_id, title, position, created_at) VALUES ('t4', 'plan', 'Ricette', 3, 1)`).run();
      await syllabusFor(db, model, "src", undefined, embed);
      expect(calls.n).toBe(2);
      // So does a new version of the source.
      db.prepare(`INSERT INTO source_documents (id, source_id, version, tree_json, created_at) VALUES ('d3', 'src', 3, '{}', 3)`).run();
      passage("c", "d3", "Calore", vector(0));
      await syllabusFor(db, model, "src", undefined, embed);
      expect(calls.n).toBe(3);
      // And so does the plan losing the source: nothing to compare, nothing kept.
      db.prepare(`DELETE FROM plan_sources`).run();
      expect(await syllabusFor(db, model, "src", undefined, embed)).toEqual([]);
      expect(stored(db)).toBeUndefined();
      db.close();
    });

    it("reads the stored result without embedding, and nothing once the plan material has changed", async () => {
      const { db, model, passage } = setup();
      passage("a", "d2", "Calore", vector(0));
      passage("b", "d2", "Ricette", vector(7));
      expect(storedSyllabus(db, "src")).toBeNull();
      const calls = { n: 0 };
      await syllabusFor(db, model, "src", undefined, embedAlong(calls));
      expect(storedSyllabus(db, "src")?.[0]).toMatchObject({ state: "checked", off: 1 });
      db.prepare(`INSERT INTO topics (id, plan_id, title, position, created_at) VALUES ('t4', 'plan', 'Ricette', 3, 1)`).run();
      expect(storedSyllabus(db, "src")).toBeNull();
      expect(calls.n).toBe(1);
      db.close();
    });

    it("keeps no result for a state that describes the app, not the material", async () => {
      const { db, model, passage } = setup();
      const calls = { n: 0 };
      expect((await syllabusFor(db, model, "src", undefined, embedAlong(calls)))[0]).toMatchObject({ state: "unindexed" });
      expect(stored(db)).toBeUndefined();
      passage("a", "d2", "Calore", vector(0));
      expect((await syllabusFor(db, model, "src", undefined, embedAlong(calls)))[0]).toMatchObject({ state: "checked" });
      expect(stored(db)).toBeTruthy();
      db.close();
    });

    it("compareToPlans swallows a failed comparison but passes a cancellation on", async () => {
      const { db, model, passage } = setup();
      passage("a", "d2", "Calore", vector(0));
      const broken = (async () => {
        throw new Error("embed-dim");
      }) as never;
      await expect(compareToPlans(db, model, "src", new AbortController().signal, broken)).resolves.toBeUndefined();
      expect(stored(db)).toBeUndefined();
      const controller = new AbortController();
      controller.abort();
      await expect(compareToPlans(db, model, "src", controller.signal, embedAlong({ n: 0 }))).rejects.toThrow();
      await compareToPlans(db, model, "src", new AbortController().signal, embedAlong({ n: 0 }));
      expect(stored(db)).toBeTruthy();
      db.close();
    });
  });
});
