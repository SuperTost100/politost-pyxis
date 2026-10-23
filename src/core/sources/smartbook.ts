import type Database from "better-sqlite3";
import { strFromU8 } from "fflate";
import { openZip } from "./zip-bounded";
import {
  parseChapterMarkdown,
  parseExercises,
} from "@politost/smartbook-parser";
import { chunkText } from "./chunk";
import { latestDocument } from "./documents";
import { uuidv7 } from "../../shared/ids";
import type { PassageHit } from "./retrieve";
import { suggestSourceRebuild } from "../plans/views";

/**
 * Tool-call tags a book generator leaked into the text (`</markdown>`, `</invoke>`…). content-core's validator calls
 * them an error, with this same pattern; Pyxis drops them so they are never indexed or cited as passage text (#35).
 */
const GENERATOR_MARKUP = /<\/?(?:markdown|invoke|parameter|function_calls|antml:[\w-]+|tool_use|tool_result)(?=[\s/>])[^>]*>/gi;

function readText(bytes: Uint8Array): string {
  return strFromU8(bytes).replace(GENERATOR_MARKUP, "");
}

type ChapterMeta = { id: string; number: number; title: string; file: string };

type SmartbookConfig = {
  id: string;
  title: string;
  version?: unknown;
  subject?: string;
  access?: string;
  chapters: ChapterMeta[];
};

export type ImportedSmartbook = {
  sourceId: string;
  title: string;
  chapters: number;
  passages: number;
  exercises: number;
};

export type ParsedSmartbook = {
  config: SmartbookConfig;
  paragraphs: Array<{
    text: string;
    chapter: number;
    paragraph: string;
    section: string;
    start: number;
    end: number;
  }>;
  exercises: Array<{
    question: string;
    solution: string | null;
    chapter: number | null;
    id: string;
    kind: string;
  }>;
};

export function parseSmartbook(bytes: Uint8Array): ParsedSmartbook {
  if (isEncrypted(bytes)) {
    throw new Error("encrypted-smartbook");
  }
  // Real output is counted, not the size the headers declare, and a member that is never read is never inflated.
  const entries = openZip(bytes, { maxEntries: 20_000, maxEntryBytes: 64 * 1024 * 1024, maxTotalBytes: 256 * 1024 * 1024 });
  const configKey = entries.names.find(
    (key) => key.endsWith("smartbook.json") && !key.includes("__MACOSX"),
  );
  if (!configKey) throw new Error("smartbook-json-missing");
  const prefix = configKey.slice(0, -"smartbook.json".length);
  const config = JSON.parse(strFromU8(entries.read(configKey)!)) as SmartbookConfig;
  if (config.access === "licensed") throw new Error("licensed-smartbook");

  const paragraphs: ParsedSmartbook["paragraphs"] = [];
  for (const chapter of config.chapters) {
    const raw = entries.read(`${prefix}chapters/${chapter.file}`);
    if (!raw) throw new Error("chapter-missing");
    const parsed = parseChapterMarkdown(readText(raw), chapter.number);
    for (const paragraph of parsed.paragraphs) {
      const text = withFormulas(paragraph.content, parsed.formulas);
      if (text)
        for (const chunk of text.length > 2800
          ? chunkText(text)
          : [{ text, start: 0, end: text.length }]) {
          paragraphs.push({
            ...chunk,
            chapter: chapter.number,
            paragraph: paragraph.id,
            section: `${chapter.number}. ${chapter.title}`,
          });
        }
    }
  }
  const exercises: ParsedSmartbook["exercises"] = [];
  for (const name of ["esercizi.md", "esami.md"] as const) {
    const raw = entries.read(`${prefix}${name}`);
    if (!raw) continue;
    const kind = name === "esami.md" ? "esame" : "esercizio";
    for (const exercise of parseExercises(readText(raw), kind)) {
      exercises.push({
        question: exercise.question,
        solution: exercise.solution ?? null,
        chapter: exercise.chapter ?? null,
        id: exercise.id,
        kind,
      });
    }
  }
  return { config, paragraphs, exercises };
}

export function importSmartbook(
  db: Database.Database,
  bytes: Uint8Array,
  now = Date.now(),
): ImportedSmartbook {
  return storeSmartbook(db, parseSmartbook(bytes), now);
}

export function storeSmartbook(
  db: Database.Database,
  parsed: ParsedSmartbook,
  now = Date.now(),
  existingId?: string,
): ImportedSmartbook {
  const { config } = parsed;
  const sourceId = existingId ?? uuidv7(now);
  const documentId = uuidv7(now + 1);
  const smartbookId = uuidv7(now + 2);
  let passages = 0;
  let exercises = 0;

  const insertExercise = db.prepare(
    `INSERT INTO exercises (id, smartbook_id, passage_id, prompt, answer, locator_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );

  const run = db.transaction(() => {
    db.prepare(
      `INSERT INTO sources (id, kind, title, status, created_at, updated_at)
       VALUES (?, 'smartbook', ?, 'ready', ?, ?)
       ON CONFLICT(id) DO UPDATE SET kind = 'smartbook', title = excluded.title, status = 'ready', updated_at = excluded.updated_at`,
    ).run(sourceId, config.title, now, now);
    db.prepare(
      `INSERT INTO source_documents (id, source_id, version, tree_json, created_at)
       VALUES (?, ?, 1, ?, ?)`,
    ).run(
      documentId,
      sourceId,
      JSON.stringify({ chapters: config.chapters }),
      now,
    );
    db.prepare(
      `INSERT INTO smartbooks (id, source_id, meta_json, created_at) VALUES (?, ?, ?, ?)`,
    ).run(smartbookId, sourceId, JSON.stringify(config), now);

    passages = insertBookPassages(db, sourceId, documentId, 1, parsed, now);
    for (const exercise of parsed.exercises) {
      insertExercise.run(
        uuidv7(now + 10000 + exercises),
        smartbookId,
        null,
        exercise.question,
        exercise.solution,
        JSON.stringify({
          chapter: exercise.chapter,
          exercise: exercise.id,
          kind: exercise.kind,
        }),
        now,
      );
      exercises += 1;
    }
  });
  run();
  return {
    sourceId,
    title: config.title,
    chapters: config.chapters.length,
    passages,
    exercises,
  };
}

/**
 * A newer version of a smartbook the library already holds, published in place as the source's next document version.
 * Plans, cards and citations keep working: earlier passages stay, and only items citing a passage whose text is gone
 * from the new version are marked stale. Exercises keep their ids, matched by the book's own exercise id and kind, so
 * flags and history on them stay attached; one the new version dropped leaves the book (no `smartbook_id`) but its
 * row stays for whatever refers to it. The plans that use the book suggest Rebuild topics, which picks up new or
 * renumbered chapters. Everything is one transaction: a failure leaves the earlier version as it was.
 * `title` follows the book unless the student renamed it. Errors: `source-missing`.
 */
export function addSmartbookVersion(
  db: Database.Database,
  sourceId: string,
  parsed: ParsedSmartbook,
  input: { sha: string; catalog?: { id: string; version: string } },
  now = Date.now(),
): ImportedSmartbook {
  const { config } = parsed;
  let passages = 0;
  db.transaction(() => {
    const source = db
      .prepare(
        `SELECT s.title, b.id AS bookId, b.meta_json AS meta FROM sources s
         LEFT JOIN smartbooks b ON b.source_id = s.id
         WHERE s.id = ? AND s.kind = 'smartbook' AND s.status != 'removed'`,
      )
      .get(sourceId) as { title: string; bookId: string | null; meta: string | null } | undefined;
    if (!source) throw new Error("source-missing");
    const { n } = db
      .prepare(`SELECT COALESCE(MAX(version), 0) + 1 AS n FROM source_documents WHERE source_id = ?`)
      .get(sourceId) as { n: number };
    const documentId = uuidv7(now);
    db.prepare(
      `INSERT INTO source_documents (id, source_id, version, tree_json, created_at) VALUES (?, ?, ?, ?, ?)`,
    ).run(documentId, sourceId, n, JSON.stringify({ chapters: config.chapters }), now);
    passages = insertBookPassages(db, sourceId, documentId, n, parsed, now);

    // Only a citation whose exact text the new version no longer has goes out of date.
    const kept = new Set(parsed.paragraphs.map((paragraph) => paragraph.text));
    const markStale = db.prepare(`UPDATE item_passages SET stale = 1 WHERE passage_id = ?`);
    for (const cited of db
      .prepare(
        `SELECT DISTINCT p.id, p.text FROM item_passages ip JOIN passages p ON p.id = ip.passage_id
         WHERE p.source_id = ? AND p.document_id != ?`,
      )
      .all(sourceId, documentId) as Array<{ id: string; text: string }>)
      if (!kept.has(cited.text)) markStale.run(cited.id);

    let bookId = source.bookId;
    if (bookId)
      db.prepare(`UPDATE smartbooks SET meta_json = ? WHERE id = ?`).run(JSON.stringify(config), bookId);
    else {
      bookId = uuidv7(now + 1);
      db.prepare(`INSERT INTO smartbooks (id, source_id, meta_json, created_at) VALUES (?, ?, ?, ?)`).run(
        bookId,
        sourceId,
        JSON.stringify(config),
        now,
      );
    }
    const keyOf = (kind: unknown, id: unknown) => `${String(kind)}|${String(id)}`;
    const existing = new Map<string, string[]>();
    for (const row of db
      .prepare(`SELECT id, locator_json FROM exercises WHERE smartbook_id = ? ORDER BY created_at, rowid`)
      .all(bookId) as Array<{ id: string; locator_json: string | null }>) {
      const locator = row.locator_json
        ? (JSON.parse(row.locator_json) as { kind?: unknown; exercise?: unknown })
        : {};
      const key = keyOf(locator.kind, locator.exercise);
      existing.set(key, [...(existing.get(key) ?? []), row.id]);
    }
    const update = db.prepare(`UPDATE exercises SET prompt = ?, answer = ?, locator_json = ? WHERE id = ?`);
    const insert = db.prepare(
      `INSERT INTO exercises (id, smartbook_id, passage_id, prompt, answer, locator_json, created_at)
       VALUES (?, ?, NULL, ?, ?, ?, ?)`,
    );
    parsed.exercises.forEach((exercise, index) => {
      const locator = JSON.stringify({ chapter: exercise.chapter, exercise: exercise.id, kind: exercise.kind });
      const id = existing.get(keyOf(exercise.kind, exercise.id))?.shift();
      if (id) update.run(exercise.question, exercise.solution, locator, id);
      else insert.run(uuidv7(now + 10000 + index), bookId, exercise.question, exercise.solution, locator, now);
    });
    const detach = db.prepare(`UPDATE exercises SET smartbook_id = NULL WHERE id = ?`);
    for (const ids of existing.values()) for (const id of ids) detach.run(id);

    const oldTitle = source.meta ? (JSON.parse(source.meta) as { title?: unknown }).title : undefined;
    db.prepare(
      `UPDATE sources SET title = ?, blob_sha = ?, mime = 'application/vnd.politost.ptsb', status = 'ready',
         catalog_id = COALESCE(?, catalog_id), catalog_version = COALESCE(?, catalog_version), updated_at = ?
       WHERE id = ?`,
    ).run(
      source.title === oldTitle ? config.title : source.title,
      input.sha,
      input.catalog?.id ?? null,
      input.catalog?.version ?? null,
      now,
      sourceId,
    );
    suggestSourceRebuild(db, sourceId, now);
  })();
  return {
    sourceId,
    title: config.title,
    chapters: config.chapters.length,
    passages,
    exercises: parsed.exercises.length,
  };
}

function insertBookPassages(
  db: Database.Database,
  sourceId: string,
  documentId: string,
  version: number,
  parsed: ParsedSmartbook,
  now: number,
): number {
  const insert = db.prepare(
    `INSERT INTO passages
      (id, source_id, document_id, version, text, locator_json, section_path, char_start, char_end, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  parsed.paragraphs.forEach((paragraph, index) =>
    insert.run(
      uuidv7(now + index + 3),
      sourceId,
      documentId,
      version,
      paragraph.text,
      JSON.stringify({ chapter: paragraph.chapter, paragraph: paragraph.paragraph }),
      paragraph.section,
      paragraph.start,
      paragraph.end,
      now,
    ),
  );
  return parsed.paragraphs.length;
}

function displayLatex(latex: string): string {
  let body = latex.trim();
  if (body.startsWith("$$") && body.endsWith("$$"))
    body = body.slice(2, -2).trim();
  else if (body.startsWith("\\[") && body.endsWith("\\]"))
    body = body.slice(2, -2).trim();
  return `\n$$\n${body}\n$$\n`;
}

function withFormulas(
  content: string,
  formulas: Array<{ id: string; latex: string }>,
): string {
  let text = content;
  for (const formula of formulas) {
    text = text.replaceAll(`<!--FORMULA:${formula.id}-->`, () =>
      displayLatex(formula.latex),
    );
  }
  return text.trim();
}

function isEncrypted(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 4 &&
    bytes[0] === 0x50 &&
    bytes[1] === 0x54 &&
    bytes[2] === 0x53 &&
    bytes[3] === 0x42
  );
}

export type { PassageHit };

export function listSources(db: Database.Database) {
  return db
    .prepare(
      `SELECT id, title, kind, status, blob_sha AS blobSha, origin_url AS originUrl, fetched_at AS fetchedAt,
         (SELECT count(*) FROM passages p WHERE p.source_id = sources.id) AS sections,
         (SELECT count(*) FROM plan_sources ps WHERE ps.source_id = sources.id) AS planCount
       FROM sources
       WHERE status != 'removed' AND library = 1
       ORDER BY created_at DESC`,
    )
    .all() as Array<{
    id: string;
    title: string;
    kind: string;
    status: string;
    blobSha: string | null;
    originUrl: string | null;
    fetchedAt: number | null;
    sections: number;
    planCount: number;
  }>;
}

function mapPassages(
  rows: Array<{
    id: string;
    text: string;
    section_path: string | null;
    locator_json: string;
    char_start?: number;
  }>,
) {
  return rows.map((row) => ({
    id: row.id,
    text: row.text,
    sectionPath: row.section_path,
    locator: JSON.parse(row.locator_json) as {
      chapter: number;
      paragraph: string;
    },
  }));
}

/**
 * The reading order of one document's passages: by page, slide or chapter, then as stored. OCR stores a scanned page
 * after the pages that had text, so stored order alone would put page 2 after page 3. Within one page or section the
 * passages are stored in order; `char_start` restarts in each section, so it is not used to sort.
 */
export function readingOrder(alias?: string): string {
  const column = (name: string) => (alias ? `${alias}.${name}` : name);
  const at = (key: string) => `json_extract(${column("locator_json")}, '$.${key}')`;
  return `COALESCE(${at("page")}, ${at("slide")}, ${at("chapter")}), ${column("rowid")}`;
}

export function sourcePassages(db: Database.Database, sourceId: string) {
  return viewerPassages(db, sourceId);
}

export function chapterPassages(
  db: Database.Database,
  sourceId: string,
  chapter: number,
) {
  return viewerPassages(db, sourceId, chapter);
}

/** The latest document's passages for the viewer: all of them in reading order, or one chapter's in stored order. */
function viewerPassages(db: Database.Database, sourceId: string, chapter?: number) {
  const rows = db
    .prepare(
      `SELECT id, text, section_path, locator_json, char_start, char_end FROM passages
       WHERE source_id = ? AND (? IS NULL OR json_extract(locator_json, '$.chapter') = ?)
         AND document_id = ${latestDocument("passages.source_id")}
       ORDER BY ${chapter === undefined ? readingOrder() : "rowid"}`,
    )
    .all(sourceId, chapter ?? null, chapter ?? null) as Array<{
    id: string;
    text: string;
    section_path: string | null;
    locator_json: string;
    char_start: number;
    char_end: number;
  }>;
  return mergeViewerParagraphs(
    mapPassages(rows),
    rows.map((row) => row.char_start),
  );
}

export function passagesAround(db: Database.Database, passageId: string) {
  const row = db
    .prepare(
      `SELECT id, source_id, document_id, locator_json FROM passages WHERE id = ?`,
    )
    .get(passageId) as
    | {
        id: string;
        source_id: string | null;
        document_id: string | null;
        locator_json: string | null;
      }
    | undefined;
  if (!row) return [];
  const locator = row.locator_json
    ? (JSON.parse(row.locator_json) as PassageHit["locator"])
    : {};
  const filter =
    row.source_id && locator.chapter != null
      ? {
          sql: `json_extract(locator_json, '$.chapter') = ?`,
          value: locator.chapter,
        }
      : row.source_id && locator.page != null
        ? {
            sql: `json_extract(locator_json, '$.page') = ?`,
            value: locator.page,
          }
        : row.source_id && locator.slide != null
          ? {
              sql: `json_extract(locator_json, '$.slide') = ?`,
              value: locator.slide,
            }
          : null;
  const docClause = row.document_id ? "AND document_id = ?" : "";
  const docArgs = row.document_id ? [row.document_id] : [];
  const rows = (
    filter
      ? db
          .prepare(
            `SELECT id, text, section_path, locator_json, char_start, char_end FROM passages
             WHERE source_id = ? ${docClause} AND ${filter.sql}
             ORDER BY rowid`,
          )
          .all(row.source_id, ...docArgs, filter.value)
      : db
          .prepare(
            `SELECT id, text, section_path, locator_json, char_start, char_end FROM passages WHERE id = ?`,
          )
          .all(passageId)
  ) as Array<{
    id: string;
    text: string;
    section_path: string | null;
    locator_json: string | null;
    char_start?: number;
  }>;
  return mergeViewerParagraphs(
    rows.map((item) => ({
      id: item.id,
      sourceId: row.source_id ?? "",
      text: item.text,
      sectionPath: item.section_path,
      locator: item.locator_json
        ? (JSON.parse(item.locator_json) as PassageHit["locator"])
        : {},
      current: item.id === passageId,
    })),
    rows.map((item) => item.char_start ?? 0),
  );
}

function mergeViewerParagraphs<
  T extends {
    text: string;
    locator: { chapter?: number; paragraph?: string };
    sectionPath?: string | null;
    current?: boolean;
  },
>(rows: T[], starts: number[]): T[] {
  const result: T[] = [];
  let end = 0;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    const start = starts[i] ?? 0;
    const previous = result.at(-1);
    if (
      start > 0 &&
      previous &&
      JSON.stringify(previous.locator) === JSON.stringify(row.locator) &&
      previous.sectionPath === row.sectionPath
    ) {
      const overlap = Math.max(0, end - start);
      previous.text += (start > end ? "\n" : "") + row.text.slice(overlap);
      if (row.current) previous.current = true;
      end = Math.max(end, start + row.text.length);
    } else {
      result.push({ ...row });
      end = start + row.text.length;
    }
  }
  return result;
}

const knownSpecs = new Set(["1", "1.1"]);

export function smartbookMeta(db: Database.Database, sourceId: string) {
  const row = db
    .prepare(
      `SELECT b.meta_json FROM smartbooks b JOIN sources s ON s.id = b.source_id WHERE b.source_id = ? AND s.kind = 'smartbook'`,
    )
    .get(sourceId) as { meta_json: string } | undefined;
  if (!row) return null;
  const meta = JSON.parse(row.meta_json) as SmartbookConfig & {
    authors?: unknown;
    author?: unknown;
    version?: unknown;
    specVersion?: unknown;
  };
  const authors = Array.isArray(meta.authors)
    ? meta.authors.filter(
        (item): item is string =>
          typeof item === "string" && item.trim() !== "",
      )
    : typeof meta.author === "string" && meta.author.trim() !== ""
      ? [meta.author]
      : [];
  const spec =
    meta.specVersion == null || meta.specVersion === ""
      ? null
      : String(meta.specVersion);
  return {
    title: meta.title,
    authors,
    version:
      meta.version == null || meta.version === "" ? null : String(meta.version),
    specVersion: spec,
    knownSpec: spec == null || knownSpecs.has(spec),
  };
}

export function smartbookChapters(db: Database.Database, sourceId: string) {
  const row = db
    .prepare(
      `SELECT b.meta_json FROM smartbooks b JOIN sources s ON s.id = b.source_id WHERE b.source_id = ? AND s.kind = 'smartbook'`,
    )
    .get(sourceId) as { meta_json: string } | undefined;
  if (!row) return [];
  const meta = JSON.parse(row.meta_json) as SmartbookConfig;
  return meta.chapters.map((chapter) => ({
    number: chapter.number,
    title: chapter.title,
  }));
}
