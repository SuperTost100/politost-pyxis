import type Database from "better-sqlite3";
import { uuidv7 } from "../../shared/ids";
import { putSetting } from "../settings";

export const educationLevels = [
  "primary",
  "lower-secondary",
  "upper-secondary",
  "technical",
  "vocational",
  "university",
  "other",
] as const;

const textSizes = ["sm", "md", "lg"] as const;

export type EducationLevel = (typeof educationLevels)[number];
export type TextSize = (typeof textSizes)[number];

export type Profile = {
  displayName: string;
  educationLevel: EducationLevel;
  /** Free text such as "2nd year" (PER-01). */
  year: string;
  school: string;
  course: string;
  tutorMode: "solver" | "socratic";
  contentLanguage: string;
  interests: string[];
  interestsOn: boolean;
  /** Suggested follow-up questions after a tutor reply (ASK-03). */
  followups: boolean;
  dyslexia: boolean;
  textSize: TextSize;
  crashReports: boolean;
  /** Grades, goals and mastery shown out of 30 or 100. Null until the student picks one: the window then follows the study level. */
  gradeScale: GradeScale | null;
};

export type GradeScale = 30 | 100;

const empty: Profile = {
  displayName: "",
  educationLevel: "university",
  year: "",
  school: "",
  course: "",
  tutorMode: "solver",
  contentLanguage: "Italian",
  interests: [],
  interestsOn: true,
  followups: true,
  dyslexia: false,
  textSize: "md",
  // Off unless a save says otherwise. First setup sends true when the student turns its switch on. An install that
  // never saw that switch reads as off and stays off, because every save writes the value it read.
  crashReports: false,
  gradeScale: null,
};

function setting(db: Database.Database, key: string): unknown {
  const row = db.prepare(`SELECT value_json FROM settings WHERE key = ?`).get(key) as
    | { value_json: string }
    | undefined;
  return row ? JSON.parse(row.value_json) : undefined;
}

export function readProfile(db: Database.Database): Profile | null {
  const row = db
    .prepare(
      `SELECT display_name, education_level, school, course, tutor_mode, content_language
       FROM profile LIMIT 1`,
    )
    .get() as
    | {
        display_name: string | null;
        education_level: string | null;
        school: string | null;
        course: string | null;
        tutor_mode: string | null;
        content_language: string | null;
      }
    | undefined;
  if (!row) return null;
  const interests = setting(db, "interests") as
    | { on?: boolean; items?: string[] }
    | undefined;
  // ponytail: year and the follow-up switch live in settings rows, so no migration.
  // Move them to profile columns if they ever need querying.
  const tutor = setting(db, "tutor") as
    | { followups?: boolean; year?: string }
    | undefined;
  const reading = setting(db, "reading") as
    | { dyslexia?: boolean; textSize?: string }
    | undefined;
  const privacy = setting(db, "privacy") as { crashReports?: boolean } | undefined;
  const grades = setting(db, "grades") as { scale?: unknown } | undefined;
  const level = educationLevels.find((item) => item === row.education_level) ?? "university";
  const size = textSizes.find((item) => item === reading?.textSize) ?? "md";
  return {
    displayName: row.display_name ?? "",
    educationLevel: level,
    year: typeof tutor?.year === "string" ? tutor.year : "",
    school: row.school ?? "",
    course: row.course ?? "",
    tutorMode: row.tutor_mode === "socratic" ? "socratic" : "solver",
    contentLanguage: row.content_language ?? "Italian",
    interests: interests?.items ?? [],
    interestsOn: interests?.on !== false,
    followups: tutor?.followups !== false,
    dyslexia: reading?.dyslexia === true,
    textSize: size,
    crashReports: privacy?.crashReports === true,
    gradeScale: grades?.scale === 30 || grades?.scale === 100 ? grades.scale : null,
  };
}

export function saveProfile(db: Database.Database, input: Partial<Profile>, now = Date.now()): Profile {
  const current = readProfile(db) ?? empty;
  const next: Profile = { ...current, ...input };
  // A new study level brings its own scale back (30 at university, 100 elsewhere) until the student picks one again.
  // The same level, which setup sends on every save, keeps the pick; so does a scale sent with the new level.
  if (input.educationLevel !== undefined && input.educationLevel !== current.educationLevel && input.gradeScale === undefined)
    next.gradeScale = null;
  const existing = db.prepare(`SELECT id FROM profile LIMIT 1`).get() as { id: string } | undefined;
  if (existing) {
    db.prepare(
      `UPDATE profile
       SET display_name = ?, education_level = ?, school = ?, course = ?, tutor_mode = ?,
           content_language = ?, updated_at = ?
       WHERE id = ?`,
    ).run(
      next.displayName,
      next.educationLevel,
      next.school,
      next.course,
      next.tutorMode,
      next.contentLanguage,
      now,
      existing.id,
    );
  } else {
    db.prepare(
      `INSERT INTO profile
        (id, display_name, education_level, school, course, tutor_mode, content_language, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      uuidv7(now),
      next.displayName,
      next.educationLevel,
      next.school,
      next.course,
      next.tutorMode,
      next.contentLanguage,
      now,
      now,
    );
  }
  putSetting(db, "interests", { on: next.interestsOn, items: next.interests }, now);
  putSetting(db, "tutor", { followups: next.followups, year: next.year }, now);
  putSetting(db, "reading", { dyslexia: next.dyslexia, textSize: next.textSize }, now);
  putSetting(db, "privacy", { crashReports: next.crashReports }, now);
  putSetting(db, "grades", { scale: next.gradeScale }, now);
  return next;
}
