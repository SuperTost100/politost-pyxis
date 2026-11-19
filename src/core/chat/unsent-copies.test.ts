import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { hasBlob } from "../blobs";
import { openDatabase } from "../db/connection";
import { createRunner, defaultLimits } from "../jobs/runner";
import { registerSourceJobs } from "../sources/jobs";
import { extractPlain, storeExtracted } from "../sources/documents";
import { sha256 } from "../sources/quality";
import { tempDir } from "../test-temp";
import { dropUnsentCopies } from "./held-files";
import { commitStaged } from "./test-attach";

const opened: Array<{ close: () => void }> = [];
afterEach(() => {
  for (const database of opened.splice(0)) database.close();
});

/** A workspace with every kind of copy a restart can find: what no message holds, and what one does. */
function setup() {
  const workspace = tempDir("pyxis-unsent-");
  const db = openDatabase(join(workspace, "pyxis.db"));
  opened.push(db);
  // No local job may run, so an import queued before the quit is still waiting.
  const runner = createRunner(db, () => {}, { ...defaultLimits(), local: 0 });
  registerSourceJobs(db, workspace, runner, async () => ({ document: extractPlain("x", false) }));
  db.prepare(`INSERT INTO chats (id, title, scope_json, created_at, updated_at) VALUES ('c', 't', '[]', 1, 1)`).run();
  db.prepare(`INSERT INTO messages (id, chat_id, role, body, created_at) VALUES ('m', 'c', 'user', 'q', 1)`).run();
  const text = (name: string) => `Contenuto di ${name}, che nessun altro file ha.`;
  const hidden = (name: string) =>
    commitStaged(db, workspace, {
      documents: [
        { filePath: `/x/${name}.txt`, ext: ".txt", bytes: new TextEncoder().encode(text(name)), extracted: extractPlain(text(name), false) },
      ],
    }).sourceIds[0]!;
  const exists = (id: string) => db.prepare(`SELECT 1 FROM sources WHERE id = ?`).get(id) !== undefined;
  const blob = (name: string) => hasBlob(workspace, sha256(new TextEncoder().encode(text(name))));
  return { workspace, db, runner, hidden, exists, blob };
}

describe("hidden copies that no message holds are removed at start", () => {
  it("removes an attached file that was never sent, with its passages and its stored file, and its reading", () => {
    const { workspace, db, runner, hidden, exists, blob } = setup();
    const unsent = hidden("inviato-mai");
    // Its import was still queued when the app quit.
    const jobId = runner.start("source-import", { sourceId: unsent });
    expect(dropUnsentCopies(db, workspace, runner)).toBe(1);
    expect(exists(unsent)).toBe(false);
    expect(db.prepare(`SELECT COUNT(*) FROM passages WHERE source_id = ?`).pluck().get(unsent)).toBe(0);
    expect(blob("inviato-mai")).toBe(false);
    expect(db.prepare(`SELECT dismissed FROM jobs WHERE id = ?`).pluck().get(jobId)).toBeGreaterThan(0);
  });

  it("never removes a copy a stored message refers to, in the chat's scope or not", () => {
    const { workspace, db, runner, hidden, exists, blob } = setup();
    const inScope = hidden("nello-scope");
    const onMessage = hidden("sul-messaggio");
    db.prepare(`UPDATE chats SET scope_json = ? WHERE id = 'c'`).run(JSON.stringify([inScope]));
    // The chat's scope was overwritten since, so only the message's own row names this one.
    db.prepare(
      `INSERT INTO attachments (id, message_id, blob_sha, mime, created_at, name, kind, size, source_id)
       VALUES ('a', 'm', ?, 'text/plain', 1, 'sul-messaggio.txt', 'document', 10, ?)`,
    ).run(sha256(new TextEncoder().encode("Contenuto di sul-messaggio, che nessun altro file ha.")), onMessage);
    expect(dropUnsentCopies(db, workspace, runner)).toBe(0);
    expect(exists(inScope)).toBe(true);
    expect(exists(onMessage)).toBe(true);
    expect(blob("nello-scope")).toBe(true);
    expect(blob("sul-messaggio")).toBe(true);
  });

  it("never touches the Library, a plan's sources or a passage something cites", () => {
    const { workspace, db, runner, hidden, exists } = setup();
    const library = storeExtracted(db, workspace, {
      title: "libreria",
      kind: "text",
      mime: "text/plain",
      ext: ".txt",
      bytes: new TextEncoder().encode("Un file della libreria."),
      extracted: extractPlain("Un file della libreria.", false),
    }).sourceId;
    const planned = hidden("del-piano");
    db.prepare(`INSERT INTO plans (id, title, status, created_at, updated_at) VALUES ('p', 'Fisica', 'ready', 1, 1)`).run();
    db.prepare(`INSERT INTO plan_sources (plan_id, source_id) VALUES ('p', ?)`).run(planned);
    const cited = hidden("citato");
    const passage = db.prepare(`SELECT id FROM passages WHERE source_id = ?`).pluck().get(cited) as string;
    db.prepare(`INSERT INTO message_passages (message_id, passage_id, label) VALUES ('m', ?, 'P1')`).run(passage);
    const gone = hidden("orfano");
    expect(dropUnsentCopies(db, workspace, runner)).toBe(1);
    expect(exists(library)).toBe(true);
    expect(exists(planned)).toBe(true);
    expect(exists(cited)).toBe(true);
    expect(exists(gone)).toBe(false);
  });

  it("is a no-op on a workspace with nothing unsent", () => {
    const { workspace, db, runner } = setup();
    expect(dropUnsentCopies(db, workspace, runner)).toBe(0);
  });
});
