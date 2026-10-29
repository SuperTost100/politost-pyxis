import type Database from "better-sqlite3";
import { latestDocument } from "./documents";

/** One section of a source's current version, with how many lessons and quizzes cite it. */
export type SectionCitations = {
  section: string;
  /** Lessons and quizzes citing a passage of this section, each counted once. */
  count: number;
  /** The section's first passage, which the viewer opens at. */
  passageId: string;
  chapter?: number;
  firstPage?: number;
  lastPage?: number;
};

export type SourceDetails = {
  addedAt: number;
  /** Distinct sections of the current version. */
  sections: number;
  /** How a document read page by page got its text. Absent for books, notes, slides and photos. */
  pages?: {
    /** The last page that has text. A blank page after it leaves no trace, so it is not counted. */
    count: number;
    /** Pages whose text came from local OCR. */
    ocr: number[];
    /** Pages up to `count` with no text at all. */
    blank: number[];
    /** When the last OCR page was stored. */
    ocrAt?: number;
  };
  /** Sum of `count` over the sections. */
  citations: number;
  /** Every section of the current version, most cited first, then in reading order. */
  bySection: SectionCitations[];
  /** The exams the source is attached to, with the topics that draw on it. */
  exams: Array<{
    planId: string;
    title: string;
    role: "material" | "past_paper";
    archived: boolean;
    topics: string[];
  }>;
};

/**
 * What the source details panel shows, read from what is stored: passages and their page locators, the pages OCR added,
 * the links from lessons and quizzes to passages, and the exams and topics that use the source. Nothing is estimated;
 * what cannot be read for a source is left out. Null for a missing or removed source.
 */
export function sourceDetails(db: Database.Database, sourceId: string): SourceDetails | null {
  const source = db
    .prepare(
      `SELECT s.kind, s.created_at AS addedAt, d.id AS documentId, d.created_at AS documentAt
       FROM sources s LEFT JOIN source_documents d ON d.id = ${latestDocument("s.id")}
       WHERE s.id = ? AND s.status != 'removed'`,
    )
    .get(sourceId) as
    | { kind: string; addedAt: number; documentId: string | null; documentAt: number | null }
    | undefined;
  if (!source) return null;
  const exams = examsUsing(db, sourceId);
  if (!source.documentId) return { addedAt: source.addedAt, sections: 0, citations: 0, bySection: [], exams };

  const sections = db
    .prepare(
      // A bare column next to several MIN()/MAX() is taken from an unspecified row, so the first passage is picked by
      // its rank instead, in the same single pass over the document.
      `WITH ranked AS (
         SELECT id, rowid AS row, section_path, locator_json,
           ROW_NUMBER() OVER (PARTITION BY section_path ORDER BY rowid) AS n
         FROM passages WHERE document_id = ? AND section_path IS NOT NULL)
       SELECT section_path AS section, MAX(CASE WHEN n = 1 THEN id END) AS passageId, MIN(row) AS firstRow,
         MIN(json_extract(locator_json, '$.page')) AS firstPage,
         MAX(json_extract(locator_json, '$.page')) AS lastPage,
         MIN(json_extract(locator_json, '$.chapter')) AS chapter
       FROM ranked GROUP BY section_path`,
    )
    .all(source.documentId) as Array<{
    section: string;
    passageId: string;
    firstRow: number;
    firstPage: number | null;
    lastPage: number | null;
    chapter: number | null;
  }>;
  // A citation of an older version still counts for the section of the same name in the current one.
  const counts = new Map(
    (
      db
        .prepare(
          `SELECT p.section_path AS section, COUNT(DISTINCT ip.item_id) AS n
           FROM item_passages ip JOIN passages p ON p.id = ip.passage_id
           WHERE p.source_id = ? AND p.section_path IS NOT NULL
           GROUP BY p.section_path`,
        )
        .all(sourceId) as Array<{ section: string; n: number }>
    ).map((row) => [row.section, row.n]),
  );
  const at = (row: (typeof sections)[number]) => row.firstPage ?? row.chapter ?? Number.MAX_SAFE_INTEGER;
  const bySection = sections
    .map((row) => ({ row, count: counts.get(row.section) ?? 0 }))
    .sort((a, b) => b.count - a.count || at(a.row) - at(b.row) || a.row.firstRow - b.row.firstRow)
    .map(({ row, count }) => ({
      section: row.section,
      count,
      passageId: row.passageId,
      ...(row.chapter != null ? { chapter: row.chapter } : {}),
      ...(row.firstPage != null ? { firstPage: row.firstPage } : {}),
      ...(row.lastPage != null ? { lastPage: row.lastPage } : {}),
    }));

  const pages = source.kind === "image" || source.kind === "smartbook"
    ? undefined
    : pageReads(db, source.documentId, source.documentAt ?? 0);
  return {
    addedAt: source.addedAt,
    sections: sections.length,
    ...(pages ? { pages } : {}),
    citations: bySection.reduce((sum, row) => sum + row.count, 0),
    bySection,
    exams,
  };
}

/**
 * Which pages of a document have text, and which of them OCR read. The import stores the text layer with the document,
 * in the same instant; the OCR job stores each scanned page later, as it reads it (`applyOcrPage`). A passage newer than
 * its document is therefore an OCR page.
 */
function pageReads(db: Database.Database, documentId: string, documentAt: number): SourceDetails["pages"] {
  const rows = db
    .prepare(
      `SELECT json_extract(locator_json, '$.page') AS page, MAX(created_at > ?) AS ocr, MAX(created_at) AS at
       FROM passages WHERE document_id = ? AND json_extract(locator_json, '$.page') IS NOT NULL
       GROUP BY page ORDER BY page`,
    )
    .all(documentAt, documentId) as Array<{ page: number; ocr: number; at: number }>;
  const valid = rows.filter((row) => Number.isInteger(row.page) && row.page >= 1);
  if (!valid.length) return undefined;
  const count = valid[valid.length - 1]!.page;
  const read = new Set(valid.map((row) => row.page));
  const ocr = valid.filter((row) => row.ocr);
  const blank: number[] = [];
  for (let page = 1; page <= count; page += 1) if (!read.has(page)) blank.push(page);
  return {
    count,
    ocr: ocr.map((row) => row.page),
    blank,
    ...(ocr.length ? { ocrAt: Math.max(...ocr.map((row) => row.at)) } : {}),
  };
}

function examsUsing(db: Database.Database, sourceId: string): SourceDetails["exams"] {
  const plans = db
    .prepare(
      `SELECT p.id AS planId, p.title, ps.role, p.archived_at IS NOT NULL AS archived
       FROM plan_sources ps JOIN plans p ON p.id = ps.plan_id
       WHERE ps.source_id = ? ORDER BY p.created_at, p.id`,
    )
    .all(sourceId) as Array<{ planId: string; title: string; role: "material" | "past_paper"; archived: number }>;
  const topics = db.prepare(
    `SELECT t.title FROM topics t
     WHERE t.plan_id = ? AND t.archived_at IS NULL AND EXISTS (
       SELECT 1 FROM topic_passages tp JOIN passages p ON p.id = tp.passage_id
       WHERE tp.topic_id = t.id AND p.source_id = ?)
     ORDER BY t.position, t.id`,
  );
  return plans.map((plan) => ({
    planId: plan.planId,
    title: plan.title,
    role: plan.role,
    archived: plan.archived === 1,
    topics: (topics.all(plan.planId, sourceId) as Array<{ title: string }>).map((row) => row.title),
  }));
}
