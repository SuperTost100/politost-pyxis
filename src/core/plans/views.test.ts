import { describe, expect, it } from "vitest";
import { openDatabase } from "../db/connection";
import { readPlan } from "./create";
import { applyRebuild, computeRebuild } from "./rebuild";
import {
  attachPlanSources,
  finishSourceRebuild,
  markPlanImported,
  openPlanQuiz,
  planOrigin,
  readPlanItem,
  removePlanSource,
  topicContent,
  topicTree,
} from "./views";
import { exportPlan, importPlan } from "./file";

function fixture() {
  const db = openDatabase(":memory:");
  db.prepare(
    "INSERT INTO plans(id,title,status,created_at,updated_at) VALUES('p','Physics','ready',1,1),('other','Other','ready',1,1)",
  ).run();
  db.prepare(
    "INSERT INTO topics(id,plan_id,title,position,created_at) VALUES('t','p','Motion',0,1),('ot','other','Motion',0,1)",
  ).run();
  db.prepare(
    "INSERT INTO sources(id,kind,title,status,created_at,updated_at) VALUES('s','file','Physics notes','ready',1,1),('unready','file','Preparing','indexing',1,1)",
  ).run();
  // Sections are counted per document, as the Library does, so the passage belongs to one.
  db.prepare("INSERT INTO source_documents(id,source_id,version,tree_json,created_at) VALUES('doc','s',1,'{}',1)").run();
  db.prepare(
    "INSERT INTO passages(id,source_id,document_id,text,locator_json,section_path,created_at) VALUES('passage','s','doc','Velocity changes position','{}','Motion',1)",
  ).run();
  return db;
}
describe("plan views and material", () => {
  it("keeps partial imported topic metadata readable", () => {
    expect(
      topicTree(
        '{"summary":null,"subtopics":["Velocity",{"title":"unsupported"}]}',
      ),
    ).toEqual({ summary: "", subtopics: ["Velocity"] });
  });
  it("cleans the subtopics of a plan built before book paragraph titles were kept", () => {
    expect(
      topicTree(
        JSON.stringify({
          summary: "Misure",
          subtopics: ["p2 ### Grandezze fisiche [testo](ref:chapter/1#p2) e $P$", "Energia cinetica"],
        }),
      ).subtopics,
    ).toEqual(["Grandezze fisiche testo e $P$", "Energia cinetica"]);
  });
  it("attaches library material transactionally, then rebuilds newly attached sources", async () => {
    const db = fixture();
    expect(() => attachPlanSources(db, "p", ["s", "unready"])).toThrow(
      "source-not-ready",
    );
    expect(db.prepare("SELECT * FROM plan_sources").all()).toEqual([]);
    attachPlanSources(db, "p", ["s", "s"]);
    expect(planOrigin(db, "p")).toEqual({
      imported: false,
      importedFrom: null,
      needsRebuild: true,
    });
    applyRebuild(
      db,
      "p",
      await computeRebuild(db, "p", [
        { title: "Motion", summary: "", subtopics: [], passageIds: ["passage"] },
      ]),
    );
    finishSourceRebuild(db, "p", ["s"]);
    expect(topicContent(db, "p", "t").passageCount).toBe(1);
    expect(planOrigin(db, "p").needsRebuild).toBe(false);
    // The plan's Sources tab shows how many sections each source has, like the Library.
    expect(readPlan(db, "p")!.sources[0]).toMatchObject({
      kind: "file",
      status: "ready",
      sections: 1,
    });
    db.close();
  });
  it("removes only this plan's links, keeps stored citations, and exports their source closure", () => {
    const db = fixture();
    db.prepare(
      "INSERT INTO plan_sources(plan_id,source_id) VALUES('p','s'),('other','s')",
    ).run();
    db.prepare(
      "INSERT INTO topic_passages(topic_id,passage_id) VALUES('t','passage'),('ot','passage')",
    ).run();
    db.prepare(
      "INSERT INTO items(id,plan_id,topic_id,kind,body_json,created_at) VALUES('lesson','p','t','lesson',?,1)",
    ).run(
      JSON.stringify({ markdown: "Velocity [P1]", passageIds: ["passage"] }),
    );
    db.prepare(
      "INSERT INTO item_passages(item_id,passage_id) VALUES('lesson','passage')",
    ).run();
    removePlanSource(db, "p", "s");
    expect(readPlan(db, "p")!.sources).toEqual([]);
    expect(topicContent(db, "p", "t").passageCount).toBe(0);
    expect(topicContent(db, "other", "ot").passageCount).toBe(1);
    expect(readPlanItem(db, "p", "lesson").passageIds).toEqual(["passage"]);
    expect(() => readPlanItem(db, "other", "lesson")).toThrow("item-missing");
    const exported = exportPlan(db, "p");
    expect(exported.sources?.some((source) => source.id === "s")).toBe(true);
    const imported = importPlan(db, exported, 1000);
    expect(readPlan(db, imported)?.imported).toBe(true);
    expect(db.prepare("SELECT 1 FROM sources WHERE id='s'").get()).toBeTruthy();
    db.close();
  });
  it("lists only what a student can open: no book text a model lesson replaced, no quiz that never got a question", () => {
    const db = fixture();
    const insert = db.prepare(
      "INSERT INTO items(id,plan_id,topic_id,kind,body_json,engine_provider,created_at) VALUES(?,'p','t',?,?,?,?)",
    );
    // The engine failed first: the lesson page showed the book text, saved without an engine under the book key.
    const bookKey = JSON.stringify({ kind: "lesson", scopeId: "t", promptVersion: "book-1", passageIds: ["passage"] });
    insert.run("book", "lesson", JSON.stringify({ cacheKey: bookKey, markdown: "Velocity" }), null, 1);
    // A lesson from a shared plan file whose engine is unknown is the student's to open, whatever else exists.
    insert.run("imported", "lesson", JSON.stringify({ cacheKey: "shared", markdown: "Their notes" }), null, 0);
    // A quiz whose build failed before writing any question.
    insert.run("empty-quiz", "quiz", JSON.stringify({ questions: [], complete: false }), null, 2);
    expect(topicContent(db, "p", "t").items.map((item) => item.id)).toEqual(["book", "imported"]);
    // The lesson written again by a model replaces the book text in the list.
    insert.run("model", "lesson", JSON.stringify({ cacheKey: "model", markdown: "Velocity [P1]" }), "claude", 3);
    insert.run("quiz", "quiz", JSON.stringify({ questions: [{ id: "q" }] }), "claude", 4);
    expect(topicContent(db, "p", "t").items.map((item) => item.id)).toEqual(["quiz", "model", "imported"]);
    db.close();
  });
  it("keeps the book text of new material that the older model lesson does not cover", () => {
    const db = fixture();
    db.prepare(
      "INSERT INTO passages(id,source_id,text,locator_json,section_path,created_at) VALUES('rebuilt','s','Acceleration changes velocity','{}','Motion',2)",
    ).run();
    const insert = db.prepare(
      "INSERT INTO items(id,plan_id,topic_id,kind,body_json,engine_provider,created_at) VALUES(?,'p','t','lesson',?,?,?)",
    );
    const link = db.prepare("INSERT INTO item_passages(item_id,passage_id) VALUES(?,?)");
    const bookKey = (passage: string) =>
      JSON.stringify({ kind: "lesson", scopeId: "t", promptVersion: "book-1", passageIds: [passage] });
    // A model lesson on the topic's first material, and the book text shown before it, on the same passage.
    insert.run("model", JSON.stringify({ cacheKey: "model", markdown: "Velocity [P1]" }), "claude", 1);
    link.run("model", "passage");
    insert.run("old-book", JSON.stringify({ cacheKey: bookKey("passage"), markdown: "Velocity" }), null, 2);
    link.run("old-book", "passage");
    // A rebuild gave the topic other passages, and the engine failed on them: their book text is all there is.
    insert.run("new-book", JSON.stringify({ cacheKey: bookKey("rebuilt"), markdown: "Acceleration" }), null, 3);
    link.run("new-book", "rebuilt");
    expect(topicContent(db, "p", "t").items.map((item) => item.id)).toEqual(["new-book", "model"]);
    db.close();
  });
  it("marks real imports and opens an existing topic quiz without duplicating an unfinished attempt", () => {
    const db = fixture();
    markPlanImported(db, "p", 1);
    db.prepare(
      "INSERT INTO items(id,plan_id,topic_id,kind,body_json,created_at) VALUES('quiz','p','t','quiz',?,1)",
    ).run(
      JSON.stringify({
        questions: [
          { id: "q", stem: "True?", answer: { kind: "tf", correct: true } },
        ],
      }),
    );
    const first = openPlanQuiz(db, "p", "quiz");
    expect(openPlanQuiz(db, "p", "quiz")).toEqual(first);
    expect(() => openPlanQuiz(db, "other", "quiz")).toThrow("quiz-missing");
    expect(planOrigin(db, "p").imported).toBe(true);
    db.close();
  });
});
