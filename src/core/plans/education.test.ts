import { describe, expect, it } from "vitest";
import { openDatabase } from "../db/connection";
import { saveProfile } from "../profile/profile";
import { profileContext } from "../profile/context";
import { createPlan } from "./create";
import { exportPlan, importPlan } from "./file";
import { planHandlers } from "./handlers";
import { planEducation, setPlanEducation } from "./education";

function db(level: "university" | "upper-secondary" = "university") {
  const database = openDatabase(":memory:");
  saveProfile(database, { displayName: "Ada", educationLevel: level, course: "Fisica" });
  return database;
}

describe("ASK-09 plan education level", () => {
  it("snapshots the profile level at creation and ignores later profile edits", () => {
    const database = db("upper-secondary");
    const { planId } = createPlan(database, { title: "Fisica", sourceIds: [], draftTopics: [{ title: "Moto" }] });
    saveProfile(database, { educationLevel: "university" });
    expect(planEducation(database, planId)).toBe("upper-secondary");
    expect(profileContext(database, planId)).toContain("Level: upper-secondary.");
    expect(profileContext(database)).toContain("Level: university.");
    expect(profileContext(database, "missing")).toContain("Level: university.");
    database.close();
  });

  it("gives an existing plan the profile level once, then keeps it", () => {
    const database = db("university");
    database.prepare("INSERT INTO plans(id,title,status,created_at,updated_at) VALUES('old','Old','ready',1,1)").run();
    expect(database.prepare("SELECT COUNT(*) AS n FROM settings WHERE key = 'plan-education:old'").get()).toEqual({ n: 0 });
    expect(planEducation(database, "old")).toBe("university");
    saveProfile(database, { educationLevel: "technical" });
    expect(planEducation(database, "old")).toBe("university");
    expect(database.prepare("SELECT COUNT(*) AS n FROM settings WHERE key = 'plan-education:old'").get()).toEqual({ n: 1 });
    expect(planEducation(database, "nope")).toBeNull();
    database.close();
  });

  it("reads and sets through the handlers, and delete removes the setting", () => {
    const database = db();
    const handlers = planHandlers(database);
    const { planId } = createPlan(database, { title: "Fisica", sourceIds: [], draftTopics: [{ title: "Moto" }] });
    expect(handlers.education({ planId })).toEqual({ level: "university" });
    expect(handlers.setEducation({ planId, level: "primary" })).toEqual({ level: "primary" });
    expect(() => setPlanEducation(database, "missing", "primary")).toThrow("plan-missing");
    expect(profileContext(database, planId)).toContain("Level: primary.");
    handlers.delete({ planId });
    expect(database.prepare("SELECT COUNT(*) AS n FROM settings WHERE key LIKE 'plan-education:%'").get()).toEqual({ n: 0 });
    database.close();
  });

  it("travels in the plan file, and an older file takes the importer's profile level", () => {
    const source = db("upper-secondary");
    const { planId } = createPlan(source, { title: "Fisica", sourceIds: [], draftTopics: [{ title: "Moto" }] });
    const file = exportPlan(source, planId);
    expect(file.educationLevel).toBe("upper-secondary");
    const target = db("university");
    expect(planEducation(target, importPlan(target, file))).toBe("upper-secondary");
    const { educationLevel: _dropped, ...older } = file;
    expect(planEducation(target, importPlan(target, older))).toBe("university");
    source.close();
    target.close();
  });
});
