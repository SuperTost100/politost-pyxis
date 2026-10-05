import type Database from "better-sqlite3";
import { planEducation } from "../plans/education";
import { readProfile } from "./profile";

/** PER-04: one line for generated examples and problems. Empty when the switch is off or the list is empty. */
export function interestsLine(db: Database.Database): string {
  const profile = readProfile(db);
  if (!profile || !profile.interestsOn || profile.interests.length === 0)
    return "";
  return `When an example helps, prefer contexts from: ${profile.interests.join(", ")}.`;
}

/** School and course as one short line, or "". Free text from the profile: trimmed, one line, bounded, and only ever sent as data about the reader. */
export function schoolCourse(db: Database.Database): { school: string; course: string } {
  const profile = readProfile(db);
  const clean = (value: string | undefined) => (value ?? "").replace(/\s+/g, " ").trim().slice(0, 120);
  return { school: clean(profile?.school), course: clean(profile?.course) };
}

/** ASK-09: who the student is, as plain lines for the system prompt. A plan's own level replaces the profile's. The name is not sent. Empty before the profile exists. */
export function profileContext(db: Database.Database, planId?: string | null): string {
  const profile = readProfile(db);
  if (!profile) return "";
  const level = (planId && planEducation(db, planId)) || profile.educationLevel;
  const facts = [
    `Level: ${level}.`,
    profile.year ? `Year: ${profile.year}.` : "",
    profile.school ? `School: ${profile.school}.` : "",
    profile.course ? `Course: ${profile.course}.` : "",
  ].filter(Boolean);
  return [facts.join(" "), interestsLine(db)].filter(Boolean).join("\n");
}
