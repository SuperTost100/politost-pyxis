import { describe, expect, it } from "vitest";
import { openDatabase } from "../db/connection";
import { savePlanSettings } from "./settings";

describe("plan settings", () => {
  it("changes editable fields while keeping content language and material", () => {
    const db = openDatabase(":memory:");
    db.prepare(
      "INSERT INTO plans(id,title,status,content_language,created_at,updated_at) VALUES('p','Old','ready','it',1,1)",
    ).run();
    expect(
      savePlanSettings(
        db,
        { planId: "p", title: "  Mechanics  ", target: 0.8, examAt: 1000 },
        2000,
      ),
    ).toEqual({ ok: true });
    expect(
      db
        .prepare(
          "SELECT title,target,exam_at,content_language,updated_at FROM plans",
        )
        .get(),
    ).toEqual({
      title: "Mechanics",
      target: 0.8,
      exam_at: 1000,
      content_language: "it",
      updated_at: 2000,
    });
    expect(() =>
      savePlanSettings(db, {
        planId: "p",
        title: " ",
        target: 0.8,
        examAt: null,
      }),
    ).toThrow();
    expect(() =>
      savePlanSettings(db, {
        planId: "p",
        title: "Fine",
        target: 1.1,
        examAt: null,
      }),
    ).toThrow();
    expect(() =>
      savePlanSettings(db, {
        planId: "missing",
        title: "Fine",
        target: 0.8,
        examAt: null,
      }),
    ).toThrow("plan-missing-or-building");
    expect(db.prepare("SELECT title FROM plans").get()).toEqual({
      title: "Mechanics",
    });
    db.close();
  });
});
