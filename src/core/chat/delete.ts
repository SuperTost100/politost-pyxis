import type Database from "better-sqlite3";
import { removeBlob } from "../blobs";

/**
 * What deleting a chat or a plan takes with it besides its own rows: the hidden documents it brought and their files.
 * A document is permanently deleted only when nothing else uses it. It stays when a chat's scope lists it, a plan uses
 * it, it is a smartbook (unless the caller owns the book, see `books`), a job that may still run names it, or any plan
 * item, card, exercise or chat citation points at its passages. A file is removed only when no source, attachment,
 * document version, whiteboard or job that may still run names its hash.
 */

/**
 * Jobs that may still read what their params or finished steps name: unfinished ones, and failed or cancelled ones a
 * Retry starts again from the steps that succeeded. Only a succeeded job is done with its files.
 */
const OPEN_JOBS = `SELECT params_json AS text FROM jobs WHERE state != 'succeeded'
  UNION ALL SELECT s.output_json FROM job_steps s JOIN jobs j ON j.id = s.job_id
  WHERE j.state != 'succeeded' AND s.output_json IS NOT NULL`;

/** Whether anything outside the deleted chat or plan still depends on this source or its passages. */
function sourceInUse(db: Database.Database, sourceId: string, books: boolean): boolean {
  const cited = (table: string) =>
    `SELECT 1 FROM passages p JOIN ${table} x ON x.passage_id = p.id WHERE p.source_id = ?`;
  return (
    db
      .prepare(
        [
          `SELECT 1 FROM plan_sources WHERE source_id = ?`,
          // A smartbook row would cascade away with its source, and its exercises with it.
          books ? `SELECT 1 WHERE ? IS NULL` : `SELECT 1 FROM smartbooks WHERE source_id = ?`,
          `SELECT 1 FROM (${OPEN_JOBS}) WHERE instr(text, ?) > 0`,
          ...["message_passages", "topic_passages", "item_passages", "cards"].map(cited),
          // A book's own exercises go with it when the caller owns the book.
          `SELECT 1 FROM passages p JOIN exercises x ON x.passage_id = p.id WHERE p.source_id = ?${
            books ? " AND x.smartbook_id IS NOT (SELECT id FROM smartbooks WHERE source_id = p.source_id)" : ""
          }`,
        ].join(" UNION ALL ") + ` LIMIT 1`,
      )
      .get(...Array.from({ length: 8 }, () => sourceId)) !== undefined
  );
}

/** Hashes a source's stored files name: the original, and the one each document version recorded. */
function sourceHashes(db: Database.Database, sourceId: string): string[] {
  const own = db
    .prepare(`SELECT blob_sha AS sha FROM sources WHERE id = ?`)
    .all(sourceId) as Array<{ sha: string | null }>;
  const versions = db
    .prepare(
      `SELECT json_extract(tree_json, '$.blobSha') AS a, json_extract(tree_json, '$.sourceSha') AS b
       FROM source_documents WHERE source_id = ?`,
    )
    .all(sourceId) as Array<{ a: string | null; b: string | null }>;
  return [
    ...own.map((row) => row.sha),
    ...versions.flatMap((row) => [row.a, row.b]),
  ].filter((sha): sha is string => typeof sha === "string");
}

/** Every source a chat lists by hand or attached, in either scope shape (an ID array, or `{ planId, sourceIds }`). */
export function chatListedSources(db: Database.Database): Set<string> {
  const ids = new Set<string>();
  for (const row of db.prepare(`SELECT scope_json FROM chats`).all() as Array<{ scope_json: string }>) {
    const parsed = JSON.parse(row.scope_json) as unknown;
    const list = Array.isArray(parsed) ? parsed : (parsed as { sourceIds?: unknown } | null)?.sourceIds;
    if (Array.isArray(list)) for (const id of list) if (typeof id === "string") ids.add(id);
  }
  return ids;
}

/** Deletes a source nothing uses, with its passages, search and vector rows, document versions and, with `books`, its smartbook. */
function dropSource(db: Database.Database, sourceId: string, books: boolean): string[] {
  const hashes = sourceHashes(db, sourceId);
  if (books) {
    const book = `SELECT e.id FROM exercises e JOIN smartbooks sb ON sb.id = e.smartbook_id WHERE sb.source_id = ?`;
    db.prepare(`DELETE FROM flags WHERE target_kind = 'exercise' AND target_id IN (${book})`).run(sourceId);
    // The book's exercises cascade with it.
    db.prepare(`DELETE FROM smartbooks WHERE source_id = ?`).run(sourceId);
  }
  const vector = db.prepare(`DELETE FROM passages_vec WHERE passage_rowid = ?`);
  for (const row of db
    .prepare(`SELECT rowid AS n FROM passages WHERE source_id = ?`)
    .all(sourceId) as Array<{ n: number }>)
    vector.run(BigInt(row.n));
  // The passages_ad trigger removes the search rows. The document versions go with the source.
  db.prepare(`DELETE FROM passages WHERE source_id = ?`).run(sourceId);
  db.prepare(`DELETE FROM settings WHERE key = ?`).run(`syllabus.${sourceId}`);
  db.prepare(`DELETE FROM sources WHERE id = ?`).run(sourceId);
  return hashes;
}

/**
 * Deletes the hidden (`library = 0`) sources among `candidates` that nothing else uses. Call it inside the transaction
 * that deletes the chat or plan, after its own citations are gone. `books`: the candidates' smartbook rows belong to
 * the caller (a plan file import made them), so they go too. Returns the hashes those sources named, for
 * `removeUnreferencedBlobs` to look at once the transaction has committed.
 */
export function deleteHiddenSources(
  db: Database.Database,
  candidates: string[],
  options: { books?: boolean } = {},
): string[] {
  const books = options.books === true;
  const hashes: string[] = [];
  for (const sourceId of candidates) {
    if (
      !db
        .prepare(`SELECT 1 FROM sources WHERE id = ? AND library = 0`)
        .get(sourceId)
    )
      continue;
    if (sourceInUse(db, sourceId, books)) continue;
    hashes.push(...dropSource(db, sourceId, books));
  }
  return hashes;
}

/**
 * Deletes removed library sources among `candidates` that nothing cites any more. A removed source keeps its passages
 * so old citations still read; once nothing cites them the source is only taking space. A removed smartbook stays.
 */
export function deleteRemovedSources(db: Database.Database, candidates: string[]): string[] {
  const hashes: string[] = [];
  for (const sourceId of candidates) {
    if (!db.prepare(`SELECT 1 FROM sources WHERE id = ? AND status = 'removed'`).get(sourceId)) continue;
    if (sourceInUse(db, sourceId, false)) continue;
    hashes.push(...dropSource(db, sourceId, false));
  }
  return hashes;
}

/**
 * Deletes passages without a source (a skipped original's quotes) among `candidates` that nothing cites any more.
 * Search finds such passages, so a deleted plan's quotes would otherwise keep turning up.
 */
export function deleteLoosePassages(db: Database.Database, candidates: string[]): void {
  const vector = db.prepare(`DELETE FROM passages_vec WHERE passage_rowid = ?`);
  for (const id of new Set(candidates)) {
    const row = db
      .prepare(
        `SELECT rowid AS n FROM passages p WHERE id = ? AND source_id IS NULL
         AND NOT EXISTS (SELECT 1 FROM topic_passages WHERE passage_id = p.id)
         AND NOT EXISTS (SELECT 1 FROM item_passages WHERE passage_id = p.id)
         AND NOT EXISTS (SELECT 1 FROM message_passages WHERE passage_id = p.id)
         AND NOT EXISTS (SELECT 1 FROM cards WHERE passage_id = p.id)
         AND NOT EXISTS (SELECT 1 FROM exercises WHERE passage_id = p.id)`,
      )
      .get(id) as { n: number } | undefined;
    if (!row) continue;
    vector.run(BigInt(row.n));
    db.prepare(`DELETE FROM passages WHERE id = ?`).run(id);
  }
}

/** Every place a row names a stored file. */
const NAMED_BLOBS = `SELECT blob_sha AS sha FROM sources
  UNION ALL SELECT blob_sha FROM attachments
  UNION ALL SELECT blob_sha FROM whiteboards
  UNION ALL SELECT json_extract(tree_json, '$.blobSha') FROM source_documents
  UNION ALL SELECT json_extract(tree_json, '$.sourceSha') FROM source_documents`;

function blobInUse(db: Database.Database, sha: string): boolean {
  return (
    db
      .prepare(
        `SELECT 1 FROM (${NAMED_BLOBS}) WHERE sha = ?
         UNION ALL SELECT 1 FROM (${OPEN_JOBS}) WHERE instr(text, ?) > 0
         LIMIT 1`,
      )
      .get(sha, sha) !== undefined
  );
}

/**
 * The hashes rows name now, and the text of jobs that may still run, for checking many files at once. Read it and
 * remove files with no await in between, so no other core code can add a row in the meantime.
 */
export function blobUse(db: Database.Database): (sha: string) => boolean {
  const named = new Set(
    (db.prepare(NAMED_BLOBS).all() as Array<{ sha: unknown }>).flatMap((row) =>
      typeof row.sha === "string" ? [row.sha] : [],
    ),
  );
  const jobs = (db.prepare(OPEN_JOBS).all() as Array<{ text: string }>).map((row) => row.text);
  return (sha) => named.has(sha) || jobs.some((text) => text.includes(sha));
}

/**
 * Removes the files for `hashes` that no row names any more. It runs after the delete has committed and with no await,
 * so no other core code can add a row for one of them in between, and no worker writes blobs. A file that cannot be
 * removed (a locked file on Windows) stays as an unreferenced blob; the chat or plan is already gone, so the failure is
 * not raised, and Free up space in Settings tries again.
 */
export function removeUnreferencedBlobs(
  db: Database.Database,
  workspace: string,
  hashes: Iterable<string>,
): void {
  for (const sha of new Set(hashes)) {
    if (blobInUse(db, sha)) continue;
    try {
      removeBlob(workspace, sha);
    } catch {
      /* Ceiling: the file stays on disk, unreferenced, until Free up space or a wipe. */
    }
  }
}
