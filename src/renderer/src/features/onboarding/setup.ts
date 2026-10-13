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
>;

/** What the profile and privacy screens show. */
export type Answers = {
  name: string;
  level: Level;
  year: string;
  school: string;
  course: string;
  crashReports: boolean;
};

/**
 * Where the screens start. First setup is blank, with crash reports on for the student to turn off. A rerun starts
 * from the stored profile, so finishing without a change saves what was already there, crash reports included.
 */
export function firstAnswers(profile: StoredProfile | null): Answers {
  if (!profile)
    return {
      name: "",
      level: "university",
      year: "",
      school: "",
      course: "",
      crashReports: true,
    };
  return {
    name: profile.displayName,
    level: profile.educationLevel,
    year: profile.year,
    school: profile.school,
    course: profile.course,
    crashReports: profile.crashReports,
  };
}

/**
 * What finishing setup saves. First setup takes the content language from the interface. A rerun keeps the stored one,
 * because the student did not pick a language here.
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
    crashReports: answers.crashReports,
  };
}
