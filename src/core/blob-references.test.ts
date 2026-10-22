import { expect, it } from "vitest";
import { BLOB_REFERENCES, blobNamed, namedBlobs } from "./blobs";
import { blobUse } from "./chat/delete";
import { openDatabase } from "./db/connection";

const sha = (n: number) => n.toString(16).padStart(64, "0");

it("lists every column of the schema that holds a file hash", () => {
  const db = openDatabase(":memory:");
  const tables = db
    .prepare(`SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`)
    .pluck()
    .all() as string[];
  const hashColumns = tables.flatMap((table) =>
    (db.prepare(`SELECT name FROM pragma_table_info(?)`).pluck().all(table) as string[])
      .filter((column) => /(^|_)sha(256)?$/.test(column))
      .map((column) => `${table}.${column}`),
  );
  const listed = BLOB_REFERENCES.map((place) => `${place.table}.${place.sha}`);
  // A new column naming a stored file must join BLOB_REFERENCES, or backups skip its file and deletes remove it.
  expect(hashColumns.filter((column) => !listed.includes(column))).toEqual([]);
  db.close();
});

it("backup and delete both see a file named in each place", () => {
  const db = openDatabase(":memory:");
  db.exec(`
    INSERT INTO sources (id, kind, title, blob_sha, created_at, updated_at) VALUES ('s', 'pdf', 'Libro', '${sha(1)}', 1, 1);
    INSERT INTO chats (id, scope_json, created_at, updated_at) VALUES ('c', '[]', 1, 1);
    INSERT INTO messages (id, chat_id, role, body, created_at) VALUES ('m', 'c', 'user', 'foto', 1);
    INSERT INTO attachments (id, message_id, blob_sha, mime, created_at) VALUES ('a', 'm', '${sha(2)}', 'image/png', 1);
    INSERT INTO whiteboards (id, blob_sha, created_at, updated_at) VALUES ('w', '${sha(3)}', 1, 1);
    INSERT INTO source_documents (id, source_id, version, tree_json, created_at)
      VALUES ('d1', 's', 1, '{"blobSha":"${sha(4)}"}', 1), ('d2', 's', 2, '{"sourceSha":"${sha(5)}"}', 1);
  `);
  const all = [1, 2, 3, 4, 5].map(sha);
  expect(BLOB_REFERENCES).toHaveLength(all.length);
  expect([...namedBlobs(db)].sort()).toEqual(all);
  const inUse = blobUse(db);
  for (const hash of all) {
    expect(blobNamed(db, hash)).toBe(true);
    expect(inUse(hash)).toBe(true);
  }
  expect(blobNamed(db, sha(6))).toBe(false);
  expect(inUse(sha(6))).toBe(false);
  db.close();
});
