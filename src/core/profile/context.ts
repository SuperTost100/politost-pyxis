import type Database from "better-sqlite3";
import { planEducation } from "../plans/education";
import { readProfile, type Profile } from "./profile";

/** Free text as one short line: whitespace runs (line breaks too) become a space, then it is cut. Prompts only ever get text through this. */
export function oneLine(value: string | undefined, max = 120): string {
  return (value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
}

/** PER-04: one line for generated examples and problems. Empty when the switch is off or the list is empty. */
export function interestsLine(db: Database.Database): string {
  return interestsOf(readProfile(db));
}

function interestsOf(profile: Profile | null): string {
  if (!profile || !profile.interestsOn) return "";
  const items = profile.interests.map((item) => oneLine(item, 60)).filter(Boolean).slice(0, 20);
  if (items.length === 0) return "";
  return `When an example helps, prefer contexts from: ${items.join(", ")}.`;
}

/** School and course as one short line, or "". Free text from the profile: trimmed, one line, bounded, and only ever sent as data about the reader. */
export function schoolCourse(db: Database.Database): { school: string; course: string } {
  return schoolCourseOf(readProfile(db));
}

function schoolCourseOf(profile: Profile | null): { school: string; course: string } {
  return { school: oneLine(profile?.school), course: oneLine(profile?.course) };
}

/**
 * ASK-09: who the student is, as plain lines for the system prompt. A plan's own level replaces the profile's. The name
 * is not sent. Empty before the profile exists. `profile`: one the caller already read.
 */
export function profileContext(
  db: Database.Database,
  planId?: string | null,
  profile: Profile | null = readProfile(db),
): string {
  if (!profile) return "";
  const level = (planId && planEducation(db, planId)) || profile.educationLevel;
  const { school, course } = schoolCourseOf(profile);
  const year = oneLine(profile.year, 60);
  const facts = [
    `Level: ${level}.`,
    year ? `Year: ${year}.` : "",
    school ? `School: ${school}.` : "",
    course ? `Course: ${course}.` : "",
  ].filter(Boolean);
  return [facts.join(" "), interestsOf(profile)].filter(Boolean).join("\n");
}
