import { describe, expect, it } from "vitest";
import { openDatabase } from "../db/connection";
import { aboutAttempt } from "./jobAbout";

/** A plan with three topics and a submitted-or-not attempt on an item of the given kind. */
function fixture(kind: string, itemTopic: string | null, questions: Array<{ topicId?: string }>) {
  const db = openDatabase(":memory:");
  db.exec(`
    INSERT INTO plans(id,title,status,created_at,updated_at) VALUES('p','Fisica 1','ready',1,1);
    INSERT INTO topics(id,plan_id,title,position,created_at) VALUES
      ('t1','p','Misure e vettori',0,1),('t2','p','Cinematica',1,1),('t3','p','Dinamica',2,1);
  `);
  db.prepare("INSERT INTO items(id,plan_id,topic_id,kind,body_json,created_at) VALUES('i','p',?,?,?,1)").run(
    itemTopic,
    kind,
    JSON.stringify({ questions }),
  );
  db.exec("INSERT INTO attempts(id,plan_id,item_id,started_at) VALUES('a','p','i',1)");
  return db;
}

describe("what an attempt's grading is about", () => {
  it("names the topics a Review asked about, once each, in question order", () => {
    const db = fixture("review", null, [{ topicId: "t2" }, { topicId: "t1" }, { topicId: "t2" }, {}]);
    expect(aboutAttempt(db, "a")).toEqual({ exam: "Fisica 1", activity: "review", topics: ["Cinematica", "Misure e vettori"] });
    db.close();
  });

  it("leaves a Review of no topic without any, and a topic quiz with its one topic", () => {
    expect(aboutAttempt(fixture("review", null, [{}]), "a")).toEqual({ exam: "Fisica 1", activity: "review" });
    expect(aboutAttempt(fixture("quiz", "t3", [{ topicId: "t3" }]), "a")).toEqual({ exam: "Fisica 1", topic: "Dinamica" });
  });
});
