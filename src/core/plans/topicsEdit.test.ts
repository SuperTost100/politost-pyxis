import { describe, expect, it } from "vitest";
import { openDatabase } from "../db/connection";
import { createPlan } from "./create";
import { editPlanTopics } from "./topicsEdit";

function plan() {
  const db = openDatabase(":memory:");
  const { planId } = createPlan(db, { title: "Fisica", sourceIds: [], draftTopics: [{ title: "Moto" }, { title: "Forze" }, { title: "Fluidi" }] });
  const id = (title: string) => db.prepare("SELECT id FROM topics WHERE plan_id = ? AND title = ?").pluck().get(planId, title) as string;
  const active = () => db.prepare("SELECT title FROM topics WHERE plan_id = ? AND archived_at IS NULL ORDER BY position").pluck().all(planId);
  return { db, planId, id, active };
}

describe("editPlanTopics", () => {
  it("archives a topic left out and brings it back, with its history, when its title is added again", () => {
    const { db, planId, id, active } = plan();
    const fluids = id("Fluidi");
    db.prepare("INSERT INTO cards (id, plan_id, topic_id, front, back, created_at) VALUES ('card', ?, ?, 'f', 'b', 1)").run(planId, fluids);
    expect(editPlanTopics(db, planId, [{ id: id("Forze") }, { id: id("Moto") }])).toEqual({ added: 0, restored: 0, archived: 1 });
    expect(active()).toEqual(["Forze", "Moto"]);
    expect(db.prepare("SELECT topic_id FROM cards WHERE id = 'card'").pluck().get()).toBe(fluids);
    expect(editPlanTopics(db, planId, [{ id: id("Forze") }, { title: "fluidi" }, { id: id("Moto") }])).toEqual({ added: 0, restored: 1, archived: 0 });
    expect(active()).toEqual(["Forze", "Fluidi", "Moto"]);
    expect(id("Fluidi")).toBe(fluids);
    // Its steps came back into the path in its new place, after Forze's.
    const kinds = db
      .prepare("SELECT t.title FROM path_nodes n JOIN topics t ON t.id = n.topic_id WHERE n.plan_id = ? ORDER BY n.position")
      .pluck()
      .all(planId) as string[];
    expect([...new Set(kinds)]).toEqual(["Forze", "Fluidi", "Moto"]);
  });

  it("adds a new topic with its steps and refuses a list it cannot apply", () => {
    const { db, planId, id, active } = plan();
    editPlanTopics(db, planId, [{ id: id("Moto") }, { title: "Urti" }, { id: id("Forze") }, { id: id("Fluidi") }]);
    expect(active()).toEqual(["Moto", "Urti", "Forze", "Fluidi"]);
    expect(db.prepare("SELECT count(*) FROM path_nodes WHERE topic_id = ?").pluck().get(id("Urti"))).toBe(4);
    expect(() => editPlanTopics(db, planId, [])).toThrow("topics-count");
    expect(() => editPlanTopics(db, planId, [{ id: "elsewhere" }])).toThrow("topic-missing");
    expect(() => editPlanTopics(db, planId, [{ id: id("Moto") }, { id: id("Moto") }])).toThrow("topic-missing");
    expect(() => editPlanTopics(db, planId, [{ id: id("Moto") }, { title: "forze" }])).toThrow("topic-exists");
    db.prepare("UPDATE plans SET status = 'building' WHERE id = ?").run(planId);
    expect(() => editPlanTopics(db, planId, [{ id: id("Moto") }])).toThrow("plan-missing-or-building");
    expect(active()).toEqual(["Moto", "Urti", "Forze", "Fluidi"]);
  });
});
