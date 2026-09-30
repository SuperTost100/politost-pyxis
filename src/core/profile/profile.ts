import type Database from "better-sqlite3";
import { uuidv7 } from "../../shared/ids";

export const educationLevels = [
  "primary",
  "lower-secondary",
  "upper-secondary",
  "technical",
  "vocational",
  "university",
  "other",
] as const;

export const textSizes = ["sm", "md", "lg"] as const;

export type EducationLevel = (typeof educationLevels)[number];
export type TextSize = (typeof textSizes)[number];

export type Profile = {
  displayName: string;
  educationLevel: EducationLevel;
  school: string;
  course: string;
  tutorMode: "solver" | "socratic";
  contentLanguage: string;
  interests: string[];
  interestsOn: boolean;
  dyslexia: boolean;
  textSize: TextSize;
};

const empty: Profile = {
  displayName: "",
  educationLevel: "university",
  school: "",
  course: "",
  tutorMode: "solver",
  contentLanguage: "Italian",
  interests: [],
  interestsOn: true,
  dyslexia: false,
  textSize: "md",
};

function setting(db: Database.Database, key: string): unknown {
  const row = db.prepare(`SELECT value_json FROM settings WHERE key = ?`).get(key) as
    | { value_json: string }
    | undefined;
  return row ? JSON.parse(row.value_json) : undefined;
}

function putSetting(db: Database.Database, key: string, value: unknown, now: number): void {
  db.prepare(
    `INSERT INTO settings (key, value_json, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
  ).run(key, JSON.stringify(value), now);
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
  const reading = setting(db, "reading") as
    | { dyslexia?: boolean; textSize?: string }
    | undefined;
  const level = educationLevels.find((item) => item === row.education_level) ?? "university";
  const size = textSizes.find((item) => item === reading?.textSize) ?? "md";
  return {
    displayName: row.display_name ?? "",
    educationLevel: level,
    school: row.school ?? "",
    course: row.course ?? "",
    tutorMode: row.tutor_mode === "socratic" ? "socratic" : "solver",
    contentLanguage: row.content_language ?? "Italian",
    interests: interests?.items ?? [],
    interestsOn: interests?.on !== false,
    dyslexia: reading?.dyslexia === true,
    textSize: size,
  };
}

export function saveProfile(db: Database.Database, input: Partial<Profile>, now = Date.now()): Profile {
  const current = readProfile(db) ?? empty;
  const next: Profile = { ...current, ...input };
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
  putSetting(db, "reading", { dyslexia: next.dyslexia, textSize: next.textSize }, now);
  return next;
}
