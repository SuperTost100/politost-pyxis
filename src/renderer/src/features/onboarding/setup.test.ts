import { describe, expect, it } from "vitest";
import {
  answersDiffer,
  firstAnswers,
  levels,
  savedProfile,
  schoolLevels,
  studiesOf,
  type StoredProfile,
} from "./setup";

describe("studies", () => {
  it("puts university apart and every other level, other included, at school", () => {
    expect(studiesOf("university")).toBe("university");
    for (const level of schoolLevels) expect(studiesOf(level)).toBe("school");
    // No stored level is lost: the two answers cover all of them, once each.
    expect([...schoolLevels, "university"].sort()).toEqual([...levels].sort());
  });
});

const stored: StoredProfile = {
  displayName: "Ada",
  educationLevel: "upper-secondary",
  year: "3rd year",
  school: "Liceo Volta",
  course: "Scientific",
  contentLanguage: "English",
  crashReports: false,
  interests: ["chess"],
  interestsOn: false,
};

describe("setup answers", () => {
  it("first setup starts blank, at university, with crash reports off", () => {
    expect(firstAnswers(null)).toEqual({
      name: "",
      level: "university",
      year: "",
      school: "",
      course: "",
      interests: [],
      crashReports: false,
    });
  });

  it("a rerun starts from the stored profile, including a crash report choice of off", () => {
    expect(firstAnswers(stored)).toEqual({
      name: "Ada",
      level: "upper-secondary",
      year: "3rd year",
      school: "Liceo Volta",
      course: "Scientific",
      interests: ["chess"],
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
    interests: ["football", "guitar"],
    crashReports: true,
  };

  it("first setup writes the interface language as the content language, and uses the interests in examples", () => {
    expect(savedProfile(answers, "Italian", null)).toEqual({
      displayName: "Ada L.",
      educationLevel: "technical",
      year: "2",
      school: "Politecnico",
      course: "Math",
      contentLanguage: "Italian",
      interests: ["football", "guitar"],
      interestsOn: true,
      crashReports: true,
    });
  });

  it("a rerun keeps the stored content language and interests switch, and writes the shown answers", () => {
    expect(savedProfile(answers, "Italian", stored)).toEqual({
      displayName: "Ada L.",
      educationLevel: "technical",
      year: "2",
      school: "Politecnico",
      course: "Math",
      contentLanguage: "English",
      interests: ["football", "guitar"],
      interestsOn: false,
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
      interests: stored.interests,
      interestsOn: stored.interestsOn,
      crashReports: stored.crashReports,
    });
  });
});

describe("setup again's changes", () => {
  const stored: StoredProfile = {
    displayName: "Ada",
    educationLevel: "upper-secondary",
    year: "3",
    school: "Liceo Volta",
    course: "",
    contentLanguage: "it",
    crashReports: true,
    interests: ["calcio", "chitarra"],
    interestsOn: true,
  };

  it("sees nothing changed in the answers it started from, or in spaces around them", () => {
    expect(answersDiffer(firstAnswers(stored), firstAnswers(stored))).toBe(false);
    expect(answersDiffer({ ...firstAnswers(stored), name: "  Ada " }, firstAnswers(stored))).toBe(false);
  });

  it("sees every answer that changed, an interest removed or reordered included", () => {
    const saved = firstAnswers(stored);
    expect(answersDiffer({ ...saved, name: "Ada L." }, saved)).toBe(true);
    expect(answersDiffer({ ...saved, level: "technical" }, saved)).toBe(true);
    expect(answersDiffer({ ...saved, crashReports: false }, saved)).toBe(true);
    expect(answersDiffer({ ...saved, interests: ["calcio"] }, saved)).toBe(true);
    expect(answersDiffer({ ...saved, interests: ["chitarra", "calcio"] }, saved)).toBe(true);
  });
});
