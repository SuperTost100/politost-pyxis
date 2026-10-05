import type Database from "better-sqlite3";
import { removeBlob } from "../blobs";

/**
 * What deleting a chat takes with it besides its messages: the hidden documents it attached and the photo files. A
 * document is permanently deleted only when nothing else uses it. It stays when another chat's scope lists it, a plan
 * uses it, it is a smartbook, an unfinished job names it, or any plan item, card, exercise or other chat's citation
 * points at its passages. A file is removed only when
 * no source, attachment, document version, whiteboard or unfinished job still names its hash.
 */

/** Whether anything outside the deleted chat still depends on this source or its passages. */
function sourceInUse(db: Database.Database, sourceId: string): boolean {
  const cited = (table: string) =>
    `SELECT 1 FROM passages p JOIN ${table} x ON x.passage_id = p.id WHERE p.source_id = ?`;
  return (
    db
      .prepare(
        [
          `SELECT 1 FROM plan_sources WHERE source_id = ?`,
          // A smartbook row would cascade away with its source.
          `SELECT 1 FROM smartbooks WHERE source_id = ?`,
          `SELECT 1 FROM jobs WHERE state IN ('queued', 'running', 'interrupted') AND instr(params_json, ?) > 0`,
          ...[
            "message_passages",
            "topic_passages",
            "item_passages",
            "cards",
            "exercises",
          ].map(cited),
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

/**
 * Deletes the hidden (`library = 0`) sources among `candidates` that nothing else uses, with their passages, search and
 * vector rows. Call it inside the transaction that deletes the chat, after the chat's own citations are gone.
 * Returns the hashes those sources named, for `removeUnreferencedBlobs` to look at once the transaction has committed.
 */
export function deleteHiddenSources(
  db: Database.Database,
  candidates: string[],
): string[] {
  const hashes: string[] = [];
  for (const sourceId of candidates) {
    if (
      !db
        .prepare(`SELECT 1 FROM sources WHERE id = ? AND library = 0`)
        .get(sourceId)
    )
      continue;
    if (sourceInUse(db, sourceId)) continue;
    hashes.push(...sourceHashes(db, sourceId));
    const vector = db.prepare(
      `DELETE FROM passages_vec WHERE passage_rowid = ?`,
    );
    for (const row of db
      .prepare(`SELECT rowid AS n FROM passages WHERE source_id = ?`)
      .all(sourceId) as Array<{ n: number }>)
      vector.run(BigInt(row.n));
    // The passages_ad trigger removes the search rows. The document versions go with the source.
    db.prepare(`DELETE FROM passages WHERE source_id = ?`).run(sourceId);
    db.prepare(`DELETE FROM settings WHERE key = ?`).run(
      `syllabus.${sourceId}`,
    );
    db.prepare(`DELETE FROM sources WHERE id = ?`).run(sourceId);
  }
  return hashes;
}

function blobInUse(db: Database.Database, sha: string): boolean {
  return (
    db
      .prepare(
        `SELECT 1 FROM sources WHERE blob_sha = ?
         UNION ALL SELECT 1 FROM attachments WHERE blob_sha = ?
         UNION ALL SELECT 1 FROM whiteboards WHERE blob_sha = ?
         UNION ALL SELECT 1 FROM source_documents WHERE json_extract(tree_json, '$.blobSha') = ? OR json_extract(tree_json, '$.sourceSha') = ?
         UNION ALL SELECT 1 FROM jobs WHERE state IN ('queued', 'running', 'interrupted') AND instr(params_json, ?) > 0
         LIMIT 1`,
      )
      .get(sha, sha, sha, sha, sha, sha) !== undefined
  );
}

/**
 * Removes the files for `hashes` that no row names any more. It runs after the delete has committed and with no await,
 * so no other core code can add a row for one of them in between, and no worker writes blobs. A file that cannot be
 * removed (a locked file on Windows) stays as an unreferenced blob; the chat is already gone, so the failure is not raised.
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
      /* Ceiling: the file stays on disk, unreferenced, until the workspace is wiped. */
    }
  }
}
