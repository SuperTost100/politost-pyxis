import type Database from "better-sqlite3";
import { foldText } from "../../shared/fold-text";

/**
 * How much of a subject one map reads: one model call with up to 24 passages, each cut to 750 characters, about the
 * 18,000 characters a topic map's call holds. A map has at most 25 concepts and has to cite every passage it gets, so
 * more passages would not make a better overview.
 */
export const SUBJECT_MAP = { passages: 24, chars: 750 } as const;

type Row = { id: string; rid: number; section_path: string | null; source_id: string; title: string };

/** The study material of the subject's exams, which a subject's sources take in (bound as `@subject`). */
const STUDIED = `WITH studied AS (
  SELECT ps.source_id FROM plan_sources ps JOIN plans p ON p.id = ps.plan_id
  WHERE p.subject_id = @subject AND ps.role = 'material'
)`;
/** Which sources `s` count as the subject's readable material; the rules are in `subjectPassages`. */
const OF_SUBJECT = `(s.subject_id = @subject OR s.id IN studied) AND s.library = 1 AND s.status = 'ready'
  AND (s.blob_sha IS NOT NULL
       OR NOT EXISTS (SELECT 1 FROM linked_files lf WHERE lf.source_id = s.id AND lf.missing_at IS NOT NULL))
  AND (s.id IN studied OR NOT EXISTS (
    SELECT 1 FROM plan_sources ps WHERE ps.source_id = s.id AND ps.role = 'past_paper'))`;

/** The subject's sources that `subjectPassages` reads from and that have any text, in title order. */
export function subjectSourceIds(db: Database.Database, subjectId: string): string[] {
  return db
    .prepare(
      `${STUDIED}
       SELECT s.id FROM sources s
       WHERE ${OF_SUBJECT} AND EXISTS (SELECT 1 FROM passages WHERE source_id = s.id)
       ORDER BY s.title COLLATE NOCASE, s.id`,
    )
    .pluck()
    .all({ subject: subjectId }) as string[];
}
export type SubjectPassage = { id: string; text: string; section: string };

/**
 * The passages a whole-subject map is built from. They come from the subject's sources at their newest version: files in
 * its linked folders, material imported with the subject, and the study material of the subject's exams, whose sources
 * often have no subject of their own. Hidden copies (chat attachments, a plan file's originals), files that are gone
 * from a linked folder (unless Pyxis keeps a copy of them) and sources still being read stay out, and so does a past exam paper that none of the subject's
 * exams studies from, as a past paper never becomes a topic either. The first passage of each section goes first, so
 * the map sees how the material is organised; when a subject has more sections than fit, they are taken evenly from the
 * first to the last, and with fewer, the rest is filled evenly from the other passages. Only the chosen passages' text
 * is read, so a subject with many books costs one pass over passage ids.
 *
 * A map on one topic (`focus`, the student's words) takes the passages that name it first, by the full-text index and by
 * their section's name, and fills the rest as above: the even sample alone can miss a topic's only section.
 */
export function subjectPassages(db: Database.Database, subjectId: string, focus?: string): SubjectPassage[] {
  const rows = db
    .prepare(
      `${STUDIED}
       SELECT p.id, p.rowid AS rid, p.section_path, s.id AS source_id, s.title
       FROM sources s
       JOIN passages p ON p.source_id = s.id
         AND p.version = (SELECT MAX(version) FROM passages WHERE source_id = s.id)
       WHERE ${OF_SUBJECT}
       ORDER BY s.title COLLATE NOCASE, s.id, p.rowid`,
    )
    .all({ subject: subjectId }) as Row[];
  const opens = new Set<number>();
  rows.forEach((row, index) => {
    const before = rows[index - 1];
    if (!before || before.source_id !== row.source_id || before.section_path !== row.section_path) opens.add(index);
  });
  const named = focus ? naming(db, rows, focus) : [];
  const picked = new Set(spread(named, SUBJECT_MAP.passages));
  const heads = [...opens].filter((index) => !picked.has(index));
  for (const index of spread(heads, SUBJECT_MAP.passages - picked.size)) picked.add(index);
  const rest = rows.map((_, index) => index).filter((index) => !opens.has(index) && !picked.has(index));
  for (const index of spread(rest, SUBJECT_MAP.passages - picked.size)) picked.add(index);
  const chosen = [...picked].sort((a, b) => a - b).map((index) => rows[index]!);
  const text = db.prepare(`SELECT substr(text, 1, ${SUBJECT_MAP.chars}) FROM passages WHERE id = ?`).pluck();
  return chosen.map((row) => ({
    id: row.id,
    text: text.get(row.id) as string,
    section: row.section_path ? `${row.title} › ${row.section_path}` : row.title,
  }));
}

/**
 * The indexes of `rows` whose passage holds a word of `focus` (four letters or more, any ending: "attrito" finds
 * "attriti"), or whose section's name does, in their order.
 */
function naming(db: Database.Database, rows: Row[], focus: string): number[] {
  const stems = [...new Set(foldText(focus).split(/[^\p{L}\p{N}]+/u).filter((word) => word.length >= 4))].map((word) =>
    word.length >= 5 ? word.slice(0, -1) : word,
  );
  if (!stems.length) return [];
  const query = stems.map((stem) => `"${stem}"*`).join(" OR ");
  const hits = new Set(db.prepare("SELECT rowid FROM passages_fts WHERE passages_fts MATCH ?").pluck().all(query) as number[]);
  return rows.flatMap((row, index) => {
    const section = foldText(row.section_path ?? "");
    return hits.has(row.rid) || stems.some((stem) => section.includes(stem)) ? [index] : [];
  });
}

/** `count` items taken at even steps from the first item of `list` to its last, or all of them when they fit. */
export function spread<T>(list: T[], count: number): T[] {
  if (count <= 0) return [];
  if (list.length <= count) return list;
  if (count === 1) return [list[0]!];
  return Array.from({ length: count }, (_, step) => list[Math.round((step * (list.length - 1)) / (count - 1))]!);
}
