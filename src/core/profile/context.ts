import type Database from "better-sqlite3";
import { planEducation } from "../plans/education";
import { readProfile } from "./profile";

/** Free text as one short line: whitespace runs (line breaks too) become a space, then it is cut. Prompts only ever get text through this. */
export function oneLine(value: string | undefined, max = 120): string {
  return (value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
}

/** PER-04: one line for generated examples and problems. Empty when the switch is off or the list is empty. */
export function interestsLine(db: Database.Database): string {
  const profile = readProfile(db);
  if (!profile || !profile.interestsOn) return "";
  const items = profile.interests.map((item) => oneLine(item, 60)).filter(Boolean).slice(0, 20);
  if (items.length === 0) return "";
  return `When an example helps, prefer contexts from: ${items.join(", ")}.`;
}

/** School and course as one short line, or "". Free text from the profile: trimmed, one line, bounded, and only ever sent as data about the reader. */
export function schoolCourse(db: Database.Database): { school: string; course: string } {
  const profile = readProfile(db);
  return { school: oneLine(profile?.school), course: oneLine(profile?.course) };
}

/** ASK-09: who the student is, as plain lines for the system prompt. A plan's own level replaces the profile's. The name is not sent. Empty before the profile exists. */
export function profileContext(db: Database.Database, planId?: string | null): string {
  const profile = readProfile(db);
  if (!profile) return "";
  const level = (planId && planEducation(db, planId)) || profile.educationLevel;
  const { school, course } = schoolCourse(db);
  const year = oneLine(profile.year, 60);
  const facts = [
    `Level: ${level}.`,
    year ? `Year: ${year}.` : "",
    school ? `School: ${school}.` : "",
    course ? `Course: ${course}.` : "",
  ].filter(Boolean);
  return [facts.join(" "), interestsLine(db)].filter(Boolean).join("\n");
}
