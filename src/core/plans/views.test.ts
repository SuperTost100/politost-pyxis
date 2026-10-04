import { describe, expect, it } from "vitest";
import { openDatabase } from "../db/connection";
import { readPlan, rebuildPlan } from "./create";
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
  db.prepare(
    "INSERT INTO passages(id,source_id,text,locator_json,section_path,created_at) VALUES('passage','s','Velocity changes position','{}','Motion',1)",
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
  it("attaches library material transactionally, then rebuilds newly attached sources", () => {
    const db = fixture();
    expect(() => attachPlanSources(db, "p", ["s", "unready"])).toThrow(
      "source-not-ready",
    );
    expect(db.prepare("SELECT * FROM plan_sources").all()).toEqual([]);
    attachPlanSources(db, "p", ["s", "s"]);
    expect(planOrigin(db, "p")).toEqual({
      imported: false,
      needsRebuild: true,
    });
    rebuildPlan(db, "p", ["s"]);
    finishSourceRebuild(db, "p", ["s"]);
    expect(topicContent(db, "p", "t").passageCount).toBe(1);
    expect(planOrigin(db, "p").needsRebuild).toBe(false);
    expect(readPlan(db, "p")!.sources[0]).toMatchObject({
      kind: "file",
      status: "ready",
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
