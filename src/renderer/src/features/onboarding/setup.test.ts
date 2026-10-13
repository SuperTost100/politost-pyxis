import { describe, expect, it } from "vitest";
import { firstAnswers, savedProfile, type StoredProfile } from "./setup";

const stored: StoredProfile = {
  displayName: "Ada",
  educationLevel: "upper-secondary",
  year: "3rd year",
  school: "Liceo Volta",
  course: "Scientific",
  contentLanguage: "English",
  crashReports: false,
};

describe("setup answers", () => {
  it("first setup starts blank with crash reports on", () => {
    expect(firstAnswers(null)).toEqual({
      name: "",
      level: "university",
      year: "",
      school: "",
      course: "",
      crashReports: true,
    });
  });

  it("a rerun starts from the stored profile, including a crash report choice of off", () => {
    expect(firstAnswers(stored)).toEqual({
      name: "Ada",
      level: "upper-secondary",
      year: "3rd year",
      school: "Liceo Volta",
      course: "Scientific",
      crashReports: false,
    });
  });
});

describe("what finishing setup saves", () => {
  const answers = {
    name: "  Ada L.  ",
    level: "technical" as const,
    year: " 2 ",
    school: " Politecnico ",
    course: " Math ",
    crashReports: true,
  };

  it("first setup writes the interface language as the content language", () => {
    expect(savedProfile(answers, "Italian", null)).toEqual({
      displayName: "Ada L.",
      educationLevel: "technical",
      year: "2",
      school: "Politecnico",
      course: "Math",
      contentLanguage: "Italian",
      crashReports: true,
    });
  });

  it("a rerun keeps the stored content language and writes the shown answers", () => {
    expect(savedProfile(answers, "Italian", stored)).toEqual({
      displayName: "Ada L.",
      educationLevel: "technical",
      year: "2",
      school: "Politecnico",
      course: "Math",
      contentLanguage: "English",
      crashReports: true,
    });
  });

  it("an untouched rerun writes back exactly what is stored", () => {
    expect(savedProfile(firstAnswers(stored), "Italian", stored)).toEqual({
      displayName: stored.displayName,
      educationLevel: stored.educationLevel,
      year: stored.year,
      school: stored.school,
      course: stored.course,
      contentLanguage: stored.contentLanguage,
      crashReports: stored.crashReports,
    });
  });
});
