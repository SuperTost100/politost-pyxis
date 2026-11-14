import type { RequestInput, RequestOutput } from "../../../../shared/ipc";

export const levels = [
  "primary",
  "lower-secondary",
  "upper-secondary",
  "technical",
  "vocational",
  "university",
  "other",
] as const;
export type Level = (typeof levels)[number];

/**
 * First setup asks "university or school", then which school. Every stored level fits one of the two, so a rerun
 * opens on the same answer. "Other" sits with the schools, because its grades are out of 100 as theirs are.
 */
export type Studies = "university" | "school";
export const schoolLevels = levels.filter(
  (level): level is Exclude<Level, "university"> => level !== "university",
);
export function studiesOf(level: Level): Studies {
  return level === "university" ? "university" : "school";
}

/** The stored fields setup reads and writes. */
export type StoredProfile = Pick<
  NonNullable<RequestOutput<"profile.get">>,
  | "displayName"
  | "educationLevel"
  | "year"
  | "school"
  | "course"
  | "contentLanguage"
  | "crashReports"
  | "interests"
  | "interestsOn"
>;

/** What the profile and privacy screens show. */
export type Answers = {
  name: string;
  level: Level;
  year: string;
  school: string;
  course: string;
  interests: string[];
  crashReports: boolean;
};

/**
 * Where the screens start. First setup is blank at university level, with crash reports off until the student turns
 * them on. A rerun starts from the stored profile, so finishing without a change saves what was already there, crash
 * reports included.
 */
export function firstAnswers(profile: StoredProfile | null): Answers {
  if (!profile)
    return {
      name: "",
      level: "university",
      year: "",
      school: "",
      course: "",
      interests: [],
      crashReports: false,
    };
  return {
    name: profile.displayName,
    level: profile.educationLevel,
    year: profile.year,
    school: profile.school,
    course: profile.course,
    interests: profile.interests,
    crashReports: profile.crashReports,
  };
}

/**
 * What finishing setup saves. First setup takes the content language from the interface and uses the interests in
 * examples. A rerun keeps the stored language and the stored interests switch, because the student did not pick either
 * here.
 */
export function savedProfile(
  answers: Answers,
  interfaceLanguage: string,
  stored: StoredProfile | null,
): RequestInput<"profile.save"> {
  return {
    displayName: answers.name.trim(),
    educationLevel: answers.level,
    year: answers.year.trim(),
    school: answers.school.trim(),
    course: answers.course.trim(),
    contentLanguage: stored?.contentLanguage ?? interfaceLanguage,
    interests: answers.interests,
    interestsOn: stored?.interestsOn ?? true,
    crashReports: answers.crashReports,
  };
}

/** Whether the screens now hold something other than `saved`, as saving would write it (text trimmed). */
export function answersDiffer(now: Answers, saved: Answers): boolean {
  const same = (a: string, b: string) => a.trim() === b.trim();
  return (
    !same(now.name, saved.name) ||
    now.level !== saved.level ||
    !same(now.year, saved.year) ||
    !same(now.school, saved.school) ||
    !same(now.course, saved.course) ||
    now.interests.length !== saved.interests.length ||
    now.interests.some((interest, at) => interest !== saved.interests[at]) ||
    now.crashReports !== saved.crashReports
  );
}
