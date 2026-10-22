import { strToU8, zipSync } from "fflate";
import { existsSync, mkdtempSync, readdirSync, rmSync, truncateSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase } from "../db/connection";
import { putBlob, readBlob } from "../blobs";
import { createPlan } from "./create";
import { exportPlan, importPlan } from "./file";
import { planHandlers } from "./handlers";
import { saveProfile } from "../profile/profile";
import { savePlanSettings } from "./settings";
import { importSmartbook } from "../sources/smartbook";
import {
  MAX_EXAM_AT,
  MAX_PLAN_FILE_BYTES,
  planFileSchema,
  type PlanFile,
} from "../../shared/plan-file";

type Db = ReturnType<typeof openDatabase>;

const workspaces: string[] = [];
afterEach(() => {
  for (const dir of workspaces.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "pyxis-plan-edges-"));
  workspaces.push(dir);
  return dir;
}
function blobFiles(dir: string): string[] {
  const root = join(dir, "blobs");
  if (!existsSync(root)) return [];
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name);
}

function book(db: Db, id = "demo") {
  return importSmartbook(
    db,
    zipSync({
      "smartbook.json": strToU8(
        JSON.stringify({
          id,
          title: `Fisica ${id}`,
          access: "public",
          chapters: [{ id: "c1", number: 1, title: "Moti", file: "01.md" }],
        }),
      ),
      "chapters/01.md": strToU8(`## p1 | Energia\nIl vettore ${id}.\n`),
      "esercizi.md": strToU8(""),
    }),
  );
}
function topicOf(db: Db, planId: string): string {
  return (db.prepare("SELECT id FROM topics WHERE plan_id=?").get(planId) as { id: string }).id;
}
function passageOf(db: Db, sourceId: string): string {
  return (db.prepare("SELECT id FROM passages WHERE source_id=?").get(sourceId) as { id: string }).id;
}
function generated(db: Db, id: string, topicId: string, passageIds: string[]) {
  db.prepare(
    "INSERT INTO exercises(id,smartbook_id,passage_id,prompt,answer,locator_json,grounding,created_at) VALUES(?,NULL,?,?,?,?,'sources',1)",
  ).run(
    id,
    passageIds[0],
    "Quanto vale?",
    "2",
    JSON.stringify({ kind: "generated", batchId: `batch-${id}`, topicId, passageIds, steps: [], hints: [] }),
  );
}
/** The rule every case checks: the importer takes what the exporter wrote. */
function roundTrip(file: PlanFile, dir = "") {
  expect(planFileSchema.safeParse(file).success).toBe(true);
  const fresh = openDatabase(":memory:");
  const planId = importPlan(fresh, file, 10_000, dir);
  return { fresh, planId };
}

describe("introduction citation order (#94)", () => {
  function introPlan(body: Record<string, unknown>) {
    const db = openDatabase(":memory:");
    const source = book(db);
    const plan = createPlan(db, { title: "Intro", sourceIds: [source.sourceId] });
    const passage = passageOf(db, source.sourceId);
    db.prepare(
      "INSERT INTO items(id,plan_id,topic_id,kind,body_json,grounding,created_at) VALUES('intro',?,NULL,'intro',?,'sources',1)",
    ).run(plan.planId, JSON.stringify({ markdown: "Benvenuto [P1].", ...body }));
    db.prepare("INSERT INTO item_passages(item_id,passage_id) VALUES('intro',?)").run(passage);
    return { db, planId: plan.planId, passage };
  }

  it("exports an older introduction with an empty order and imports it", () => {
    const { db, planId, passage } = introPlan({ passageIds: [] });
    const file = exportPlan(db, planId);
    const intro = file.items!.find((item) => item.kind === "intro")!;
    expect((intro.body as { passageIds: string[] }).passageIds).toEqual([passage]);
    const { fresh, planId: copy } = roundTrip(file);
    const body = JSON.parse(
      (fresh.prepare("SELECT body_json FROM items WHERE plan_id=? AND kind='intro'").get(copy) as { body_json: string }).body_json,
    ) as { passageIds: string[] };
    expect(body.passageIds).toHaveLength(1);
  });

  it("exports an introduction whose order names a passage twice and imports it", () => {
    const { db, planId, passage } = introPlan({ passageIds: [] });
    db.prepare("UPDATE items SET body_json=? WHERE id='intro'").run(
      JSON.stringify({ markdown: "Benvenuto [P1].", passageIds: [passage, passage] }),
    );
    roundTrip(exportPlan(db, planId));
  });

  it("still imports a file an older version wrote with an empty or repeated order", () => {
    const { db, planId, passage } = introPlan({});
    const file = exportPlan(db, planId);
    for (const order of [[], [passage, passage]]) {
      const old = structuredClone(file);
      const intro = old.items!.find((item) => item.kind === "intro")!;
      intro.body = { ...(intro.body as object), passageIds: order };
      const { fresh, planId: copy } = roundTrip(old);
      const row = fresh.prepare("SELECT id, body_json FROM items WHERE plan_id=? AND kind='intro'").get(copy) as {
        id: string;
        body_json: string;
      };
      const linked = fresh.prepare("SELECT passage_id FROM item_passages WHERE item_id=?").pluck().all(row.id);
      expect((JSON.parse(row.body_json) as { passageIds: string[] }).passageIds).toEqual(linked);
    }
  });

  it("still rejects an order that names a passage the item does not cite", () => {
    const { db, planId } = introPlan({});
    const file = exportPlan(db, planId);
    const intro = file.items!.find((item) => item.kind === "intro")!;
    intro.body = { ...(intro.body as object), passageIds: ["elsewhere"] };
    expect(planFileSchema.safeParse(file).success).toBe(false);
  });
});

describe("generated exercises in the export (#101)", () => {
  it("leaves out another plan's exercises on the same book", () => {
    const db = openDatabase(":memory:");
    const source = book(db);
    const a = createPlan(db, { title: "A", sourceIds: [source.sourceId] });
    const b = createPlan(db, { title: "B", sourceIds: [source.sourceId] });
    const passage = passageOf(db, source.sourceId);
    generated(db, "mine", topicOf(db, a.planId), [passage]);
    generated(db, "theirs", topicOf(db, b.planId), [passage]);
    const file = exportPlan(db, a.planId);
    expect(file.exercises!.map((e) => e.id)).toEqual(["mine"]);
    roundTrip(file);
  });

  it("carries every passage an exercise names, also from a source the plan no longer uses", () => {
    const db = openDatabase(":memory:");
    const source = book(db);
    const other = book(db, "other");
    const plan = createPlan(db, { title: "A", sourceIds: [source.sourceId] });
    const outside = passageOf(db, other.sourceId);
    generated(db, "mixed", topicOf(db, plan.planId), [passageOf(db, source.sourceId), outside]);
    const file = exportPlan(db, plan.planId);
    expect(file.passages!.map((p) => p.id)).toContain(outside);
    const { fresh, planId } = roundTrip(file);
    const locator = JSON.parse(
      (fresh.prepare("SELECT locator_json FROM exercises WHERE smartbook_id IS NULL").get() as { locator_json: string })
        .locator_json,
    ) as { topicId: string; passageIds: string[] };
    expect(locator.topicId).toBe(topicOf(fresh, planId));
    expect(locator.passageIds).toHaveLength(2);
  });

  it("imports a file an older version wrote with another plan's exercises in it", () => {
    const db = openDatabase(":memory:");
    const source = book(db);
    const plan = createPlan(db, { title: "A", sourceIds: [source.sourceId] });
    const passage = passageOf(db, source.sourceId);
    generated(db, "mine", topicOf(db, plan.planId), [passage]);
    const file = exportPlan(db, plan.planId);
    const theirs = {
      ...file.exercises![0]!,
      id: "theirs",
      locator: { kind: "generated", topicId: "b-topic", passageIds: [passage, "b-only-passage"], steps: [], hints: [] },
    };
    const old = { ...file, exercises: [...file.exercises!, theirs] };
    expect(planFileSchema.safeParse(old).success).toBe(true);
    const fresh = openDatabase(":memory:");
    importPlan(fresh, old, 10_000);
    expect(fresh.prepare("SELECT COUNT(*) FROM exercises WHERE smartbook_id IS NULL").pluck().get()).toBe(1);

    // One the file's progress names stays, tied to the plan instead of a topic it does not have.
    const named = {
      ...old,
      progress: [{ kind: "answer_given" as const, topic: 0, payload: { exerciseId: "theirs", correct: true }, at: 5 }],
    };
    const again = openDatabase(":memory:");
    const planId = importPlan(again, named, 10_000);
    const kept = again
      .prepare("SELECT locator_json FROM exercises WHERE smartbook_id IS NULL AND prompt = 'Quanto vale?'")
      .pluck()
      .all()
      .map((json) => JSON.parse(json as string) as { topicId?: string; planId?: string; passageIds: string[] });
    expect(kept).toHaveLength(2);
    const detached = kept.find((locator) => locator.planId === planId)!;
    expect(detached.topicId).toBeUndefined();
    expect(detached.passageIds).toHaveLength(1);
  });

  it("keeps a plan's exercises after its topics moved to new passages", () => {
    const db = openDatabase(":memory:");
    const source = book(db);
    const plan = createPlan(db, { title: "A", sourceIds: [source.sourceId] });
    const topic = topicOf(db, plan.planId);
    generated(db, "kept", topic, [passageOf(db, source.sourceId)]);
    // A rebuild after re-extraction links the topic to the new version's passages only.
    db.prepare("DELETE FROM topic_passages WHERE topic_id=?").run(topic);
    const file = exportPlan(db, plan.planId);
    expect(file.exercises!.map((e) => e.id)).toEqual(["kept"]);
    roundTrip(file);
  });
});

describe("source files in the export (#110, #126)", () => {
  function filePlan(dir: string, sizes: number[]) {
    const db = openDatabase(":memory:");
    const plan = createPlan(db, { title: "Files", sourceIds: [] });
    sizes.forEach((size, i) => {
      const sha = putBlob(dir, Buffer.from(`file ${i}`), "application/pdf", "pdf");
      // A sparse file: the size the exporter sees, without writing it.
      if (size) truncateSync(readBlob(dir, sha).file, size);
      db.prepare(
        "INSERT INTO sources(id,kind,title,blob_sha,mime,status,created_at,updated_at) VALUES(?,'pdf',?,?,'application/pdf','ready',1,1)",
      ).run(`source-${i}`, `Libro ${i}`, sha);
      db.prepare("INSERT INTO plan_sources(plan_id,source_id) VALUES(?,?)").run(plan.planId, `source-${i}`);
    });
    return { db, planId: plan.planId };
  }

  it("writes a valid file for a source between 200 and 256 MiB", () => {
    const dir = workspace();
    const { db, planId } = filePlan(dir, [210 * 1024 * 1024]);
    for (const embed of [false, true]) {
      const file = exportPlan(db, planId, { workspace: dir, embed });
      expect(file.sources![0]).toMatchObject({ bytes: 210 * 1024 * 1024 });
      expect(file.sources![0]!.data).toBeUndefined();
      roundTrip(file, workspace());
    }
  });

  it("embeds only the originals that keep the file small enough to save", () => {
    const dir = workspace();
    const { db, planId } = filePlan(dir, [0, 80 * 1024 * 1024]);
    const file = exportPlan(db, planId, { workspace: dir, embed: true });
    expect(file.sources!.map((s) => s.data !== undefined)).toEqual([true, false]);
    expect(Buffer.byteLength(JSON.stringify(file, null, 2))).toBeLessThan(MAX_PLAN_FILE_BYTES);
    roundTrip(file, workspace());
  });
});

describe("repeated passage IDs (#126)", () => {
  function embeddedFile() {
    const db = openDatabase(":memory:");
    const source = book(db);
    const plan = createPlan(db, { title: "Twice", sourceIds: [source.sourceId] });
    const passage = passageOf(db, source.sourceId);
    db.prepare(
      "INSERT INTO items(id,plan_id,topic_id,kind,body_json,grounding,created_at) VALUES('quiz',?,NULL,'quiz',?,'sources',1)",
    ).run(plan.planId, JSON.stringify({ questions: [] }));
    db.prepare("INSERT INTO item_passages(item_id,passage_id) VALUES('quiz',?)").run(passage);
    const file = exportPlan(db, plan.planId);
    const data = Buffer.from("original");
    file.sources = [
      {
        ...file.sources![0]!,
        sha: null,
        bytes: data.length,
        data: data.toString("base64"),
      },
    ];
    for (const p of file.passages!) p.sourceSha = null;
    return { file, passage };
  }

  it("rejects a topic or item that lists a passage twice, before writing any file", () => {
    for (const where of ["topic", "item"] as const) {
      const { file, passage } = embeddedFile();
      if (where === "topic") file.topics[0]!.passageIds = [passage, passage];
      else file.items![0]!.passageIds = [passage, passage];
      const dir = workspace();
      const fresh = openDatabase(":memory:");
      expect(() => importPlan(fresh, file, 10_000, dir)).toThrow("plan-file");
      expect(blobFiles(dir)).toEqual([]);
      expect(fresh.prepare("SELECT COUNT(*) FROM plans").pluck().get()).toBe(0);
    }
  });

  it("removes the files it wrote when the database refuses the plan", () => {
    const { file } = embeddedFile();
    const dir = workspace();
    const fresh = openDatabase(":memory:");
    fresh.exec("CREATE TRIGGER refuse BEFORE INSERT ON items BEGIN SELECT RAISE(ABORT, 'refused'); END");
    expect(() => importPlan(fresh, file, 10_000, dir)).toThrow("refused");
    expect(blobFiles(dir)).toEqual([]);
  });
});

describe("profile name and exam date (#126)", () => {
  it("shortens a long display name to what the file allows", () => {
    const db = openDatabase(":memory:");
    const plan = createPlan(db, { title: "Nome", sourceIds: [] });
    saveProfile(db, { displayName: `${"a".repeat(199)}😀${"b".repeat(100)}` });
    const file = planHandlers(db).export({ planId: plan.planId });
    expect(file.author!.length).toBeLessThanOrEqual(200);
    expect(file.author).toBe("a".repeat(199));
    roundTrip(file);
  });

  it("keeps the exam date within year 9999 in settings, on export and on import", () => {
    const db = openDatabase(":memory:");
    const plan = createPlan(db, { title: "Lontano", sourceIds: [] });
    expect(() =>
      savePlanSettings(db, {
        planId: plan.planId,
        title: "Lontano",
        target: 0.8,
        sessions: [{ date: MAX_EXAM_AT + 1 }],
      }),
    ).toThrow();
    db.prepare("UPDATE plans SET exam_at=? WHERE id=?").run(8_000_000_000_000_000, plan.planId);
    const file = exportPlan(db, plan.planId);
    expect(file.examAt).toBe(MAX_EXAM_AT);
    const { fresh, planId } = roundTrip({ ...file, examAt: 8_000_000_000_000_000 });
    expect(fresh.prepare("SELECT exam_at FROM plans WHERE id=?").pluck().get(planId)).toBe(MAX_EXAM_AT);
  });
});
