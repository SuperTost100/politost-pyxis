import type Database from "better-sqlite3";

/** Who set a chat's subject. `student` covers a pick from the chip, "Whole Library" and a chat opened from an exam or lesson. */
export type SubjectBy = "pyxis" | "student";

/** A passage the search returned: the subject of its file (null for a file without one) and whether it passed the bar. */
export type SubjectVote = { subject: string | null; relevant: boolean };

/** Relevant passages a subject needs before Pyxis picks it. One passage is too little to name a chat after. */
export const PICK_MIN_PASSAGES = 2;
/** The share of the relevant passages the leading subject must hold: two thirds, so 4 against 2 picks and 3 against 2 does not. */
export const PICK_MIN_SHARE = 2 / 3;

/**
 * The subject Pyxis gives a chat after a search of the whole Library, or null. It counts only the passages that passed the
 * search's own relevance bar. The subject holding most of them is picked when it holds at least PICK_MIN_PASSAGES and at
 * least PICK_MIN_SHARE of all of them, files without a subject included in the total. Passages spread over subjects,
 * passages mostly from files without a subject, or a search with nothing relevant pick nothing.
 */
export function pickSubject(votes: readonly SubjectVote[]): string | null {
  const relevant = votes.filter((vote) => vote.relevant);
  const counts = new Map<string, number>();
  for (const vote of relevant) {
    if (vote.subject) counts.set(vote.subject, (counts.get(vote.subject) ?? 0) + 1);
  }
  let best: string | null = null;
  let most = 0;
  // Sorted by name, so equal counts (which never reach the share) still give one answer.
  for (const [subject, count] of [...counts].sort(([a], [b]) => a.localeCompare(b))) {
    if (count > most) {
      best = subject;
      most = count;
    }
  }
  if (!best || most < PICK_MIN_PASSAGES || most < relevant.length * PICK_MIN_SHARE) return null;
  return best;
}

/**
 * The subject each source belongs to, by name: the Library file's own subject, or else the subject of the exams that study
 * it when they all have the same one. A chat attachment, or a file with neither, has none.
 */
export function sourceSubjects(db: Database.Database, sourceIds: readonly string[]): Map<string, string | null> {
  const ids = [...new Set(sourceIds)];
  const result = new Map<string, string | null>();
  if (ids.length === 0) return result;
  const rows = db
    .prepare(
      `SELECT s.id,
              own.name AS own,
              (SELECT CASE WHEN COUNT(DISTINCT p.subject_id) = 1 THEN MIN(sub.name) END
                 FROM plan_sources ps
                 JOIN plans p ON p.id = ps.plan_id
                 JOIN subjects sub ON sub.id = p.subject_id
                WHERE ps.source_id = s.id AND ps.role = 'material') AS planned
         FROM sources s
         LEFT JOIN subjects own ON own.id = s.subject_id
        WHERE s.id IN (SELECT value FROM json_each(?))`,
    )
    .all(JSON.stringify(ids)) as Array<{ id: string; own: string | null; planned: string | null }>;
  for (const row of rows) result.set(row.id, row.own ?? row.planned ?? null);
  return result;
}

/** The Library files of a subject, by its name: those filed under it and those its exams study. */
export function subjectSourceIds(db: Database.Database, subject: string): string[] {
  return (
    db
      .prepare(
        `SELECT s.id FROM sources s JOIN subjects sub ON sub.id = s.subject_id
          WHERE sub.name = ? AND s.library = 1
         UNION
         SELECT ps.source_id FROM plan_sources ps
           JOIN plans p ON p.id = ps.plan_id
           JOIN subjects sub ON sub.id = p.subject_id
          WHERE sub.name = ? AND ps.role = 'material'`,
      )
      .all(subject, subject) as Array<{ id: string }>
  ).map((row) => row.id);
}
