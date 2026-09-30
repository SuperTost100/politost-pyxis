import { readFileSync, realpathSync } from "node:fs";
import { extname } from "node:path";
import type Database from "better-sqlite3";
import { strFromU8, unzipSync } from "fflate";
import {
  parseChapterMarkdown,
  parseExercises,
} from "@politost/smartbook-parser";
import { putBlob } from "../blobs";
import { uuidv7 } from "../../shared/ids";
import { retrieve, type PassageHit } from "./retrieve";

type ChapterMeta = { id: string; number: number; title: string; file: string };

type SmartbookConfig = {
  id: string;
  title: string;
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

export function importSmartbook(
  db: Database.Database,
  bytes: Uint8Array,
  now = Date.now(),
): ImportedSmartbook {
  if (isEncrypted(bytes)) {
    throw new Error("encrypted-smartbook");
  }
  if (bytes.length > 80 * 1024 * 1024) throw new Error("archive-too-large");
  // ponytail: refuse a member whose declared size blows the cap before inflate. A header that lies about originalSize can still expand; switch to a streaming unzip that counts output bytes.
  let declared = 0;
  const maxExpanded = 256 * 1024 * 1024;
  const entries = unzipSync(bytes, {
    filter(file) {
      declared += file.originalSize;
      return declared <= maxExpanded;
    },
  });
  if (declared > maxExpanded) throw new Error("archive-too-large");
  const configKey = Object.keys(entries).find(
    (key) => key.endsWith("smartbook.json") && !key.includes("__MACOSX"),
  );
  if (!configKey || !entries[configKey]) throw new Error("smartbook-json-missing");
  const prefix = configKey.slice(0, -"smartbook.json".length);
  const config = JSON.parse(strFromU8(entries[configKey])) as SmartbookConfig;
  if (config.access === "licensed") throw new Error("licensed-smartbook");

  const sourceId = uuidv7(now);
  const documentId = uuidv7(now + 1);
  const smartbookId = uuidv7(now + 2);
  let passages = 0;
  let exercises = 0;

  const insertPassage = db.prepare(
    `INSERT INTO passages
      (id, source_id, document_id, version, text, locator_json, section_path, char_start, char_end, created_at)
     VALUES (?, ?, ?, 1, ?, ?, ?, 0, ?, ?)`,
  );
  const insertExercise = db.prepare(
    `INSERT INTO exercises (id, smartbook_id, passage_id, prompt, answer, locator_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );

  const run = db.transaction(() => {
    db.prepare(
      `INSERT INTO sources (id, kind, title, status, created_at, updated_at)
       VALUES (?, 'smartbook', ?, 'ready', ?, ?)`,
    ).run(sourceId, config.title, now, now);
    db.prepare(
      `INSERT INTO source_documents (id, source_id, version, tree_json, created_at)
       VALUES (?, ?, 1, ?, ?)`,
    ).run(documentId, sourceId, JSON.stringify({ chapters: config.chapters }), now);
    db.prepare(
      `INSERT INTO smartbooks (id, source_id, meta_json, created_at) VALUES (?, ?, ?, ?)`,
    ).run(smartbookId, sourceId, JSON.stringify(config), now);

    for (const chapter of config.chapters) {
      const fileKey = `${prefix}chapters/${chapter.file}`;
      const raw = entries[fileKey];
      if (!raw) throw new Error("chapter-missing");
      const parsed = parseChapterMarkdown(strFromU8(raw), chapter.number);
      for (const paragraph of parsed.paragraphs) {
        const text = withFormulas(paragraph.content, parsed.formulas);
        if (!text) continue;
        insertPassage.run(
          uuidv7(now + passages + 3),
          sourceId,
          documentId,
          text,
          JSON.stringify({ chapter: chapter.number, paragraph: paragraph.id }),
          `${chapter.number}. ${chapter.title}`,
          text.length,
          now,
        );
        passages += 1;
      }
    }

    for (const name of ["esercizi.md", "esami.md"] as const) {
      const raw = entries[`${prefix}${name}`];
      if (!raw) continue;
      const kind = name === "esami.md" ? "esame" : "esercizio";
      for (const exercise of parseExercises(strFromU8(raw), kind)) {
        insertExercise.run(
          uuidv7(now + 10000 + exercises),
          smartbookId,
          null,
          exercise.question,
          exercise.solution ?? null,
          JSON.stringify({ chapter: exercise.chapter ?? null, exercise: exercise.id }),
          now,
        );
        exercises += 1;
      }
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

function displayLatex(latex: string): string {
  let body = latex.trim();
  if (body.startsWith("$$") && body.endsWith("$$")) body = body.slice(2, -2).trim();
  else if (body.startsWith("\\[") && body.endsWith("\\]")) body = body.slice(2, -2).trim();
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

export function importSmartbookFile(
  db: Database.Database,
  workspace: string,
  filePath: string,
): ImportedSmartbook {
  const resolved = realpathSync(filePath);
  if (extname(resolved).toLowerCase() !== ".ptsb") {
    throw new Error("not-smartbook");
  }
  const bytes = readFileSync(resolved);
  const sha = putBlob(workspace, bytes, "application/zip", "ptsb");
  const imported = importSmartbook(db, bytes);
  db.prepare(`UPDATE sources SET blob_sha = ?, mime = ? WHERE id = ?`).run(
    sha,
    "application/vnd.politost.ptsb",
    imported.sourceId,
  );
  return imported;
}

export type { PassageHit };

export function searchPassages(
  db: Database.Database,
  query: string,
  limit = 8,
): PassageHit[] {
  return retrieve(db, query, { limit }).hits;
}

export function listSources(db: Database.Database) {
  return db
    .prepare(
      `SELECT id, title, kind, status FROM sources ORDER BY created_at DESC`,
    )
    .all() as Array<{
    id: string;
    title: string;
    kind: string;
    status: string;
  }>;
}

function mapPassages(
  rows: Array<{
    id: string;
    text: string;
    section_path: string | null;
    locator_json: string;
  }>,
) {
  return rows.map((row) => ({
    id: row.id,
    text: row.text,
    sectionPath: row.section_path,
    locator: JSON.parse(row.locator_json) as { chapter: number; paragraph: string },
  }));
}

export function sourcePassages(db: Database.Database, sourceId: string) {
  const rows = db
    .prepare(
      `SELECT id, text, section_path, locator_json FROM passages
       WHERE source_id = ? ORDER BY rowid`,
    )
    .all(sourceId) as Array<{
    id: string;
    text: string;
    section_path: string | null;
    locator_json: string;
  }>;
  return mapPassages(rows);
}

export function chapterPassages(
  db: Database.Database,
  sourceId: string,
  chapter: number,
) {
  const rows = db
    .prepare(
      `SELECT id, text, section_path, locator_json FROM passages
       WHERE source_id = ? AND json_extract(locator_json, '$.chapter') = ?
       ORDER BY rowid`,
    )
    .all(sourceId, chapter) as Array<{
    id: string;
    text: string;
    section_path: string | null;
    locator_json: string;
  }>;
  return mapPassages(rows);
}

export function passagesAround(db: Database.Database, passageId: string) {
  const row = db
    .prepare(
      `SELECT id, source_id, locator_json FROM passages WHERE id = ?`,
    )
    .get(passageId) as
    | { id: string; source_id: string | null; locator_json: string | null }
    | undefined;
  if (!row?.source_id) return [];
  const locator = row.locator_json
    ? (JSON.parse(row.locator_json) as PassageHit["locator"])
    : {};
  const filter =
    locator.chapter != null
      ? { sql: `json_extract(locator_json, '$.chapter') = ?`, value: locator.chapter }
      : locator.page != null
        ? { sql: `json_extract(locator_json, '$.page') = ?`, value: locator.page }
        : locator.slide != null
          ? { sql: `json_extract(locator_json, '$.slide') = ?`, value: locator.slide }
          : null;
  const rows = (
    filter
      ? db
          .prepare(
            `SELECT id, text, section_path, locator_json FROM passages
             WHERE source_id = ? AND ${filter.sql}
             ORDER BY rowid`,
          )
          .all(row.source_id, filter.value)
      : db
          .prepare(
            `SELECT id, text, section_path, locator_json FROM passages WHERE id = ?`,
          )
          .all(passageId)
  ) as Array<{
    id: string;
    text: string;
    section_path: string | null;
    locator_json: string | null;
  }>;
  return rows.map((item) => ({
    id: item.id,
    sourceId: row.source_id ?? "",
    text: item.text,
    sectionPath: item.section_path,
    locator: item.locator_json
      ? (JSON.parse(item.locator_json) as PassageHit["locator"])
      : {},
    current: item.id === passageId,
  }));
}

const knownSpecs = new Set(["1", "1.1"]);

export function smartbookMeta(db: Database.Database, sourceId: string) {
  const row = db
    .prepare(`SELECT meta_json FROM smartbooks WHERE source_id = ?`)
    .get(sourceId) as { meta_json: string } | undefined;
  if (!row) return null;
  const meta = JSON.parse(row.meta_json) as SmartbookConfig & {
    authors?: unknown;
    author?: unknown;
    version?: unknown;
    specVersion?: unknown;
  };
  const authors = Array.isArray(meta.authors)
    ? meta.authors.filter((item): item is string => typeof item === "string" && item.trim() !== "")
    : typeof meta.author === "string" && meta.author.trim() !== ""
      ? [meta.author]
      : [];
  const spec = meta.specVersion == null || meta.specVersion === "" ? null : String(meta.specVersion);
  return {
    title: meta.title,
    authors,
    version: meta.version == null || meta.version === "" ? null : String(meta.version),
    specVersion: spec,
    knownSpec: spec == null || knownSpecs.has(spec),
  };
}

export function smartbookChapters(db: Database.Database, sourceId: string) {
  const row = db
    .prepare(`SELECT meta_json FROM smartbooks WHERE source_id = ?`)
    .get(sourceId) as { meta_json: string } | undefined;
  if (!row) return [];
  const meta = JSON.parse(row.meta_json) as SmartbookConfig;
  return meta.chapters.map((chapter) => ({
    number: chapter.number,
    title: chapter.title,
  }));
}
