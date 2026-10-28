import { describe, expect, it } from "vitest";
import { openDatabase } from "../db/connection";
import { readProfile, saveProfile } from "./profile";

describe("profile", () => {
  it("starts empty and keeps the reading settings", () => {
    const db = openDatabase(":memory:");
    expect(readProfile(db)).toBeNull();
    const saved = saveProfile(db, {
      displayName: "Ada",
      educationLevel: "university",
      course: "Fisica 1",
      dyslexia: true,
      textSize: "lg",
      interests: ["bicicletta"],
    });
    expect(saved.displayName).toBe("Ada");
    const again = readProfile(db);
    expect(again?.course).toBe("Fisica 1");
    expect(again?.dyslexia).toBe(true);
    expect(again?.textSize).toBe("lg");
    expect(again?.interests).toEqual(["bicicletta"]);
    expect(again?.crashReports).toBe(false);
    const opted = saveProfile(db, { crashReports: true });
    expect(opted.crashReports).toBe(true);
  });

  it("keeps the grade scale unset until the student picks one, and keeps the pick through other saves", () => {
    const db = openDatabase(":memory:");
    expect(saveProfile(db, { displayName: "Ada" }).gradeScale).toBeNull();
    // Changing the level leaves an unpicked scale unset, so the window follows the new level.
    saveProfile(db, { educationLevel: "upper-secondary" });
    expect(readProfile(db)?.gradeScale).toBeNull();
    saveProfile(db, { gradeScale: 30 });
    saveProfile(db, { textSize: "lg" });
    // Setup sends the level on every save: the same level keeps the pick.
    saveProfile(db, { educationLevel: "upper-secondary", displayName: "Ada L." });
    expect(readProfile(db)?.gradeScale).toBe(30);
    saveProfile(db, { gradeScale: null });
    expect(readProfile(db)?.gradeScale).toBeNull();
  });

  it("lets a new study level reset a picked grade scale, so the scale follows the level again", () => {
    const db = openDatabase(":memory:");
    saveProfile(db, { educationLevel: "university", gradeScale: 100 });
    saveProfile(db, { educationLevel: "upper-secondary" });
    expect(readProfile(db)?.gradeScale).toBeNull();
    // A scale sent with the new level is the student's pick, so it stays.
    saveProfile(db, { educationLevel: "university", gradeScale: 100 });
    expect(readProfile(db)?.gradeScale).toBe(100);
  });

  describe("crash reports default", () => {
    const stored = (db: ReturnType<typeof openDatabase>) =>
      JSON.parse(
        (
          db
            .prepare(`SELECT value_json FROM settings WHERE key = 'privacy'`)
            .get() as { value_json: string }
        ).value_json,
      );

    it("stores true when first setup leaves the switch on", () => {
      const db = openDatabase(":memory:");
      saveProfile(db, { displayName: "Ada", crashReports: true });
      expect(readProfile(db)?.crashReports).toBe(true);
      expect(stored(db)).toEqual({ crashReports: true });
      // A later settings save keeps the student's choice.
      saveProfile(db, { textSize: "lg" });
      expect(readProfile(db)?.crashReports).toBe(true);
    });

    it("stores false when the student turns it off in setup", () => {
      const db = openDatabase(":memory:");
      saveProfile(db, { displayName: "Ada", crashReports: false });
      expect(stored(db)).toEqual({ crashReports: false });
    });

    it("leaves a skipped setup off", () => {
      const db = openDatabase(":memory:");
      saveProfile(db, { displayName: "" });
      expect(readProfile(db)?.crashReports).toBe(false);
      expect(stored(db)).toEqual({ crashReports: false });
    });

    it("keeps an existing stored false off through later saves", () => {
      const db = openDatabase(":memory:");
      saveProfile(db, { displayName: "Ada", crashReports: false });
      saveProfile(db, { textSize: "lg" });
      saveProfile(db, { displayName: "Ada B" });
      expect(readProfile(db)?.crashReports).toBe(false);
      expect(stored(db)).toEqual({ crashReports: false });
    });

    it("does not switch on a profile saved before the setting existed", () => {
      const db = openDatabase(":memory:");
      saveProfile(db, { displayName: "Ada" });
      // An older install has a profile row but no privacy row at all.
      db.prepare(`DELETE FROM settings WHERE key = 'privacy'`).run();
      expect(readProfile(db)?.crashReports).toBe(false);
      saveProfile(db, { school: "Politecnico" });
      expect(readProfile(db)?.crashReports).toBe(false);
      expect(stored(db)).toEqual({ crashReports: false });
    });
  });
});
