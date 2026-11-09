import type Database from "better-sqlite3";
import { requireTopic } from "../study/openLesson";

/**
 * What a map row belongs to: one topic of an exam, or a whole subject. A topic map also belongs to its exam's subject,
 * which the database keeps in step (migration 26). Job params store this object as it is, so a job saved before
 * subject maps existed, with `{ planId, topicId }`, still names its maps.
 */
export type MapScope =
  | { planId: string; topicId: string }
  | { subjectId: string };

/** What a map request names: a topic, with or without its exam, or a subject alone. */
export type MapAddress = { subjectId?: string; planId?: string; topicId?: string };

export const isTopicScope = (
  scope: MapScope,
): scope is { planId: string; topicId: string } => "topicId" in scope;

/** Checks that the scope's topic or subject exists; a topic must belong to the exam the scope names. */
export function requireScope(db: Database.Database, scope: MapScope): void {
  if (isTopicScope(scope)) requireTopic(db, scope.planId, scope.topicId);
  else if (!db.prepare("SELECT 1 FROM subjects WHERE id = ?").get(scope.subjectId))
    throw new Error("subject-missing");
}

/**
 * The scope a request means. A topic wins over the subject the address also names, because a topic's subject is its
 * exam's and may have changed since the link was made; its exam is read from the topic when the address leaves it out.
 */
export function mapScope(db: Database.Database, address: MapAddress): MapScope {
  if (address.topicId) {
    const planId =
      address.planId ??
      (db.prepare("SELECT plan_id FROM topics WHERE id = ?").pluck().get(address.topicId) as string | undefined);
    if (!planId) throw new Error("topic-missing");
    const scope = { planId, topicId: address.topicId };
    requireScope(db, scope);
    return scope;
  }
  if (address.subjectId && !address.planId) {
    const scope = { subjectId: address.subjectId };
    requireScope(db, scope);
    return scope;
  }
  throw new Error("map-scope");
}

/** The names a map page shows above a map: its subject, and its exam and topic for a topic map. */
export function describeScope(db: Database.Database, scope: MapScope) {
  if (isTopicScope(scope)) {
    const row = db
      .prepare(
        `SELECT p.id AS planId, p.title AS planTitle, t.id AS topicId, t.title AS topicTitle,
           s.id AS subjectId, s.name AS subjectName
         FROM topics t JOIN plans p ON p.id = t.plan_id LEFT JOIN subjects s ON s.id = p.subject_id
         WHERE t.id = ? AND p.id = ?`,
      )
      .get(scope.topicId, scope.planId) as {
      planId: string;
      planTitle: string;
      topicId: string;
      topicTitle: string;
      subjectId: string | null;
      subjectName: string | null;
    };
    return row;
  }
  const subject = db
    .prepare("SELECT id, name FROM subjects WHERE id = ?")
    .get(scope.subjectId) as { id: string; name: string };
  return {
    planId: null,
    planTitle: null,
    topicId: null,
    topicTitle: null,
    subjectId: subject.id,
    subjectName: subject.name,
  };
}
