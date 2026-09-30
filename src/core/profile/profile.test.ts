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
  });
});
