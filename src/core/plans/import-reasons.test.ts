import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../db/connection";
import { IpcError } from "../../shared/ipc";
import { planFileSchema, type PlanFile, type PlanFileReason } from "../../shared/plan-file";
import { importableWithout, importPlan, PlanFileError } from "./file";
import { planHandlers } from "./handlers";
import { planImportedFrom } from "./views";

const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const QUOTE = "Il lavoro e la forza per lo spostamento.";

const passage = {
  id: "passage",
  sourceId: null,
  documentId: null,
  version: 1,
  text: QUOTE,
  textSha: sha(QUOTE),
  sourceSha: null,
  locator: null,
  section: null,
  charStart: null,
  charEnd: null,
};
const node = (id: string, label: string, parent: string | null) => ({
  id,
  label,
  parent,
  x: 0,
  y: 0,
  pinned: false,
});
const graph = (nodes: ReturnType<typeof node>[]) => ({
  layout: "tree" as const,
  nodes,
  edges: [],
  undo: null,
});
const goodMap = {
  id: "map",
  topic: 0,
  entries: [
    {
      id: "entry",
      title: "Lavoro",
      passageIds: ["passage"],
      graph: graph([node("root", "Lavoro", null), node("leaf", "Forza", "root")]),
    },
  ],
};
const goodExercise = {
  id: "exercise",
  sourceId: null,
  passageId: "passage",
  prompt: "Quanto vale il lavoro?",
  answer: "F s",
  locator: { kind: "generated", topicId: "topic" },
  grounding: "sources" as const,
};

/** A small version 2 plan with a topic, a quoted passage, a card that cites it, an exercise, a map and some progress. */
function plan(extra: Partial<PlanFile> = {}): PlanFile {
  return planFileSchema.parse({
    version: 2,
    id: "plan-a",
    createdAt: 5_000,
    title: "Fisica 1",
    topics: [{ id: "topic", title: "Lavoro", position: 0 }],
    nodes: [{ id: "node", title: "Lavoro", kind: "learn", position: 1, topic: 0 }],
    cards: [{ id: "card", front: "$W$", back: "Lavoro", topic: 0, passageId: "passage" }],
    passages: [passage],
    exercises: [goodExercise],
    maps: [goodMap],
    progress: [
      { kind: "lesson_opened", topic: 0, payload: {}, at: 10 },
      { kind: "answer_given", topic: 0, payload: { exerciseId: "exercise", rating: "good", score: 1 }, at: 11 },
    ],
    ...extra,
  });
}

function refusal(run: () => unknown): PlanFileError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(PlanFileError);
    return error as PlanFileError;
  }
  throw new Error("the import was not refused");
}

const count = (db: ReturnType<typeof openDatabase>, table: string) =>
  (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

describe("a refused plan file names its reason", () => {
  const cases: Array<[PlanFileReason, (file: PlanFile) => unknown]> = [
    ["missing-topic", (f) => ({ ...f, nodes: [{ ...f.nodes[0]!, topic: 4 }] })],
    ["missing-passage", (f) => ({ ...f, cards: [{ ...f.cards[0]!, passageId: "nowhere" }] })],
    ["passage-text", (f) => ({ ...f, passages: [{ ...f.passages![0]!, text: "Changed" }] })],
    ["missing-source", (f) => ({ ...f, passages: [{ ...f.passages![0]!, sourceId: "gone" }] })],
    [
      "source-mismatch",
      (f) => ({
        ...f,
        sources: [{ id: "book", title: "Libro", sha: sha("a"), bytes: 1 }],
        passages: [{ ...f.passages![0]!, sourceId: "book", sourceSha: sha("b") }],
      }),
    ],
    [
      "source-data",
      (f) => ({ ...f, sources: [{ id: "book", title: "Libro", sha: null, bytes: 3, data: "not base64!" }] }),
    ],
    ["duplicate-id", (f) => ({ ...f, cards: [{ ...f.cards[0]!, id: "topic" }] })],
    [
      "document-mismatch",
      (f) => ({
        ...f,
        sources: [{ id: "book", title: "Libro", sha: null, bytes: 0 }],
        documents: [{ id: "doc", sourceId: "book", version: 2, tree: {} }],
        passages: [{ ...f.passages![0]!, sourceId: "book", documentId: "doc", version: 1 }],
      }),
    ],
    [
      "bad-body",
      (f) => ({
        ...f,
        items: [
          {
            id: "lesson",
            kind: "lesson",
            topic: 0,
            grounding: "sources",
            body: { cacheKey: "{not json", markdown: "x" },
            passageIds: [],
            provider: null,
            model: null,
          },
        ],
      }),
    ],
    ["bad-progress", (f) => ({ ...f, gapAnswers: [{ gap: "g", attempt: "a", question: "q" }] })],
    ["bad-reference", (f) => ({ ...f, progress: [{ kind: "lesson_completed", topic: 0, payload: { nodeId: 9 }, at: 1 }] })],
  ];

  for (const [reason, break_] of cases)
    it(`says ${reason}`, () => {
      const db = openDatabase(":memory:");
      const file = break_(plan()) as PlanFile;
      const error = refusal(() => importPlan(db, file, 1, "/tmp/pyxis-reasons"));
      expect(error.reason).toBe(reason);
      expect(error.message).toBe("plan-file");
      expect(error.toBody()).toEqual({
        code: "plan-file",
        messageKey: `shared.reason.${reason}`,
        params: {},
        detail: reason,
      });
      expect(count(db, "plans")).toBe(0);
    });

  it("says no-workspace for an embedded file with nowhere to keep it", () => {
    const db = openDatabase(":memory:");
    const data = Buffer.from("abc").toString("base64");
    const file = plan({ sources: [{ id: "book", title: "Libro", sha: sha("abc"), bytes: 3, data }] });
    expect(refusal(() => importPlan(db, file)).reason).toBe("no-workspace");
  });

  it("says unknown-version, oversized-source and invalid-file for a file the schema refuses", () => {
    const db = openDatabase(":memory:");
    const bad = (extra: object) => ({ ...plan(), ...extra }) as unknown as PlanFile;
    expect(refusal(() => importPlan(db, bad({ version: 3 }))).reason).toBe("unknown-version");
    expect(
      refusal(() => importPlan(db, bad({ sources: [{ title: "Libro", sha: null, bytes: 999 * 1024 * 1024 }] }))).reason,
    ).toBe("oversized-source");
    expect(refusal(() => importPlan(db, bad({ title: 7 }))).reason).toBe("invalid-file");
  });

  it("gives a version 1 file the same reasons", () => {
    const db = openDatabase(":memory:");
    const file = planFileSchema.parse({
      version: 1,
      title: "Old",
      topics: [{ title: "T", position: 0 }],
      nodes: [{ title: "T", kind: "learn", position: 0, topic: 3 }],
      cards: [],
    });
    expect(refusal(() => importPlan(db, file)).reason).toBe("missing-topic");
  });
});

describe("importing a plan without its broken exercises or maps", () => {
  const brokenExercise = (f: PlanFile): PlanFile => ({
    ...f,
    exercises: [{ ...goodExercise, passageId: "nowhere" }],
  });
  const brokenMap = (f: PlanFile): PlanFile => ({
    ...f,
    maps: [
      {
        ...goodMap,
        entries: [{ ...goodMap.entries[0]!, graph: graph([node("a", "A", null), node("b", "B", null)]) }],
      },
    ],
  });

  it("tags a broken exercise and a broken map with their part, and writes nothing", () => {
    const db = openDatabase(":memory:");
    const exercise = refusal(() => importPlan(db, brokenExercise(plan())));
    expect([exercise.reason, exercise.part]).toEqual(["missing-passage", "exercises"]);
    const map = refusal(() => importPlan(db, brokenMap(plan())));
    expect([map.reason, map.part]).toEqual(["bad-map", "maps"]);
    const dangling = refusal(() =>
      importPlan(db, { ...plan(), maps: [{ ...goodMap, entries: [{ ...goodMap.entries[0]!, passageIds: ["nowhere"] }] }] }),
    );
    expect([dangling.reason, dangling.part]).toEqual(["missing-passage", "maps"]);
    const duplicate = refusal(() => importPlan(db, { ...plan(), exercises: [goodExercise, goodExercise] }));
    expect([duplicate.reason, duplicate.part]).toEqual(["duplicate-id", "exercises"]);
    for (const table of ["plans", "topics", "cards", "passages", "exercises", "maps"]) expect(count(db, table)).toBe(0);
  });

  it("does not tag a failure elsewhere in the file", () => {
    const db = openDatabase(":memory:");
    const file = { ...plan(), cards: [{ ...plan().cards[0]!, passageId: "nowhere" }] };
    const error = refusal(() => importPlan(db, file));
    expect([error.reason, error.part]).toEqual(["missing-passage", null]);
    expect(importableWithout(db, file, "", error)).toBeNull();
  });

  it("offers what to leave out only when that is enough", () => {
    const db = openDatabase(":memory:");
    const lone = brokenExercise(plan());
    expect(importableWithout(db, lone, "", refusal(() => importPlan(db, lone)))).toEqual(["exercises"]);
    const both = brokenMap(brokenExercise(plan()));
    expect(importableWithout(db, both, "", refusal(() => importPlan(db, both)))).toEqual(["exercises", "maps"]);
    const hopeless = { ...both, cards: [{ ...both.cards[0]!, passageId: "nowhere" }] };
    expect(importableWithout(db, hopeless, "", refusal(() => importPlan(db, hopeless)))).toBeNull();
    expect(importableWithout(db, lone, "", new Error("plan-file"))).toBeNull();
    expect(count(db, "plans")).toBe(0);
  });

  it("imports everything else when the broken exercises are left out", () => {
    const db = openDatabase(":memory:");
    const planId = importPlan(db, brokenExercise(plan()), 7_000, "", { without: ["exercises"] });
    expect(count(db, "plans")).toBe(1);
    expect(count(db, "exercises")).toBe(0);
    expect(count(db, "maps")).toBe(1);
    expect(count(db, "cards")).toBe(1);
    expect(count(db, "passages")).toBe(1);
    expect(count(db, "path_nodes")).toBe(1);
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    // The rating of the exercise that is gone has nothing left to rate; the other event stays.
    expect(
      (db.prepare("SELECT kind FROM learning_events WHERE plan_id=?").all(planId) as { kind: string }[]).map((e) => e.kind),
    ).toEqual(["lesson_opened"]);
    expect(planImportedFrom(db, { id: "plan-a", createdAt: 5_000 })).toEqual({ planId, importedAt: 7_000 });
  });

  it("imports everything else when the broken maps are left out", () => {
    const db = openDatabase(":memory:");
    importPlan(db, brokenMap(plan()), 7_000, "", { without: ["maps"] });
    expect(count(db, "maps")).toBe(0);
    expect(count(db, "exercises")).toBe(1);
    expect(count(db, "learning_events")).toBe(2);
  });

  it("keeps refusing a part that was not left out", () => {
    const db = openDatabase(":memory:");
    const both = brokenMap(brokenExercise(plan()));
    const error = refusal(() => importPlan(db, both, 1, "", { without: ["exercises"] }));
    expect([error.reason, error.part]).toEqual(["bad-map", "maps"]);
    expect(count(db, "plans")).toBe(0);
    importPlan(db, both, 1, "", { without: ["exercises", "maps"] });
    expect(count(db, "plans")).toBe(1);
  });

  it("does not change a sound file, and checking writes nothing", () => {
    const db = openDatabase(":memory:");
    importPlan(db, plan(), 1, "", { check: true });
    expect(count(db, "plans")).toBe(0);
    importPlan(db, plan(), 2, "", { without: ["maps"] });
    expect(count(db, "exercises")).toBe(1);
    expect(count(db, "maps")).toBe(0);
    expect(count(db, "learning_events")).toBe(2);
  });

  it("answers the import request with the parts it can go without, and then imports without them", () => {
    const db = openDatabase(":memory:");
    const handlers = planHandlers(db);
    const file = brokenMap(brokenExercise(plan()));
    let error: unknown;
    try {
      handlers.import(file);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(IpcError);
    expect((error as IpcError).toBody()).toEqual({
      code: "plan-file",
      messageKey: "shared.reason.missing-passage",
      params: { without: "exercises,maps" },
      detail: "missing-passage",
    });
    expect(count(db, "plans")).toBe(0);
    const { planId } = handlers.import({ ...file, without: ["exercises", "maps"] });
    expect(count(db, "exercises") + count(db, "maps")).toBe(0);
    expect(db.prepare("SELECT COUNT(*) AS n FROM plans WHERE id=?").get(planId)).toEqual({ n: 1 });
  });

  it("offers nothing for a refusal outside the exercises and maps", () => {
    const db = openDatabase(":memory:");
    let error: unknown;
    try {
      planHandlers(db).import({ ...plan(), nodes: [{ ...plan().nodes[0]!, topic: 4 }] });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(PlanFileError);
    expect((error as PlanFileError).toBody().params).toEqual({});
  });
});

describe("the plan file an import came from", () => {
  it("finds the newest plan imported from the same file, and no other", () => {
    const db = openDatabase(":memory:");
    const file = plan();
    expect(planImportedFrom(db, file)).toBeNull();
    importPlan(db, file, 1_000);
    const second = importPlan(db, file, 2_000);
    expect(planImportedFrom(db, file)).toEqual({ planId: second, importedAt: 2_000 });
    // A later export of the same plan is a new version of the file, not the same one.
    expect(planImportedFrom(db, { id: "plan-a", createdAt: 5_001 })).toBeNull();
    expect(planImportedFrom(db, { id: "plan-b", createdAt: 5_000 })).toBeNull();
    expect(planImportedFrom(db, { id: "plan-a" })).toBeNull();
    expect(planImportedFrom(db, {})).toBeNull();
  });

  it("stops matching once the imported plan is deleted", () => {
    const db = openDatabase(":memory:");
    const handlers = planHandlers(db);
    const first = handlers.import(plan()).planId;
    const second = handlers.import(plan()).planId;
    expect(handlers.importedFile({ id: "plan-a", createdAt: 5_000 })?.planId).toBe(second);
    handlers.delete({ planId: second });
    expect(handlers.importedFile({ id: "plan-a", createdAt: 5_000 })?.planId).toBe(first);
    handlers.delete({ planId: first });
    expect(handlers.importedFile({ id: "plan-a", createdAt: 5_000 })).toBeNull();
  });

  it("ignores plans made here, older import records and files without an identity", () => {
    const db = openDatabase(":memory:");
    const own = importPlan(db, plan(), 1_000);
    // An import recorded before the file identity was kept holds no file id.
    db.prepare("UPDATE settings SET value_json=? WHERE key=?").run(JSON.stringify({ author: null, exportedAt: 5_000 }), `plan-import:${own}`);
    expect(planImportedFrom(db, plan())).toBeNull();
    db.prepare("UPDATE settings SET value_json='true' WHERE key=?").run(`plan-import:${own}`);
    expect(planImportedFrom(db, plan())).toBeNull();
    const { id: _id, createdAt: _at, ...anonymous } = plan();
    importPlan(db, anonymous, 2_000);
    expect(planImportedFrom(db, plan())).toBeNull();
  });
});
