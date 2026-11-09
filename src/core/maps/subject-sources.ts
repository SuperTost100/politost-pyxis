import type Database from "better-sqlite3";

/**
 * How much of a subject one map reads: one model call with up to 24 passages, each cut to 750 characters, about the
 * 18,000 characters a topic map's call holds. A map has at most 25 concepts and has to cite every passage it gets, so
 * more passages would not make a better overview.
 */
export const SUBJECT_MAP = { passages: 24, chars: 750 } as const;

type Row = { id: string; text: string; section_path: string | null; source_id: string; title: string };
export type SubjectPassage = { id: string; text: string; section: string };

/**
 * The passages a whole-subject map is built from. They come from the subject's sources: files in its linked folders and
 * material imported with the subject, at their newest version. Hidden copies (chat attachments, a plan file's
 * originals), files that are gone from a linked folder and past exam papers stay out, as a past paper never becomes a
 * topic either. The first passage of each section goes first, so the map sees how the material is organised; when a
 * subject has more sections than fit, they are taken evenly from start to end, and with fewer, the rest is filled
 * evenly from the other passages.
 */
export function subjectPassages(db: Database.Database, subjectId: string): SubjectPassage[] {
  const rows = db
    .prepare(
      `SELECT p.id, p.text, p.section_path, s.id AS source_id, s.title
       FROM sources s
       JOIN passages p ON p.source_id = s.id
         AND p.version = (SELECT MAX(version) FROM passages WHERE source_id = s.id)
       WHERE s.subject_id = ? AND s.library = 1 AND s.status = 'ready'
         AND NOT EXISTS (SELECT 1 FROM linked_files lf WHERE lf.source_id = s.id AND lf.missing_at IS NOT NULL)
         AND NOT EXISTS (SELECT 1 FROM plan_sources ps WHERE ps.source_id = s.id AND ps.role = 'past_paper')
       ORDER BY s.title COLLATE NOCASE, s.id, p.rowid`,
    )
    .all(subjectId) as Row[];
  const opens = new Set<number>();
  rows.forEach((row, index) => {
    const before = rows[index - 1];
    if (!before || before.source_id !== row.source_id || before.section_path !== row.section_path) opens.add(index);
  });
  const heads = [...opens];
  const picked = new Set(spread(heads, SUBJECT_MAP.passages));
  const rest = rows.map((_, index) => index).filter((index) => !opens.has(index));
  for (const index of spread(rest, SUBJECT_MAP.passages - picked.size)) picked.add(index);
  return [...picked]
    .sort((a, b) => a - b)
    .map((index) => {
      const row = rows[index]!;
      return {
        id: row.id,
        text: row.text.slice(0, SUBJECT_MAP.chars),
        section: row.section_path ? `${row.title} › ${row.section_path}` : row.title,
      };
    });
}

/** `count` items taken at even steps from the start of `list` to its end, or all of them when they fit. */
export function spread<T>(list: T[], count: number): T[] {
  if (count <= 0) return [];
  if (list.length <= count) return list;
  return Array.from({ length: count }, (_, step) => list[Math.floor((step * list.length) / count)]!);
}
