import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { hasBlob, putBlob } from "../blobs";
import { openDatabase } from "../db/connection";
import { extractPlain, storeExtracted } from "../sources/documents";
import { indexVectors } from "../sources/embed";
import { promoteSource } from "../sources/manage";
import { sha256 } from "../sources/quality";
import { commitStaged } from "./attach";
import { chatHandlers } from "./handlers";
import { deleteChat } from "./turn";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

const bytesOf = (text: string) => new TextEncoder().encode(text);
const NOTE = "Il calore si trasmette per conduzione.";
const PHOTO = new Uint8Array([137, 80, 78, 71, 1, 2, 3, 4]);

function setup() {
  const workspace = mkdtempSync(join(tmpdir(), "pyxis-chat-delete-"));
  dirs.push(workspace);
  const db = openDatabase(":memory:");
  const count = (table: string) =>
    (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
  const chat = (id: string, scope: unknown = []) =>
    db
      .prepare(
        `INSERT INTO chats (id, title, scope_json, created_at, updated_at) VALUES (?, 't', ?, 1, 1)`,
      )
      .run(id, JSON.stringify(scope));
  const scopeOf = (id: string) =>
    JSON.parse(
      (
        db.prepare(`SELECT scope_json FROM chats WHERE id = ?`).get(id) as {
          scope_json: string;
        }
      ).scope_json,
    ) as string[];
  /** A document attached to a chat the way a turn does it: a hidden source in the chat's scope. */
  const attachDocument = (chatId: string, text = NOTE): string => {
    const { sourceIds } = commitStaged(
      db,
      workspace,
      {
        blobs: [],
        documents: [
          {
            filePath: "/x/appunti.txt",
            ext: ".txt",
            bytes: bytesOf(text),
            extracted: extractPlain(text, false),
          },
        ],
      },
      (ids) =>
        db
          .prepare(`UPDATE chats SET scope_json = ? WHERE id = ?`)
          .run(JSON.stringify([...scopeOf(chatId), ...ids]), chatId),
    );
    return sourceIds[0]!;
  };
  const attachPhoto = (chatId: string, bytes = PHOTO): string => {
    const sha = putBlob(workspace, bytes, "image/png", ".png");
    const message = `m-${chatId}-${count("messages")}`;
    db.prepare(
      `INSERT INTO messages (id, chat_id, role, body, created_at) VALUES (?, ?, 'user', 'ecco', 1)`,
    ).run(message, chatId);
    db.prepare(
      `INSERT INTO attachments (id, message_id, blob_sha, mime, created_at) VALUES (?, ?, ?, 'image/png', 1)`,
    ).run(`a-${message}`, message, sha);
    return sha;
  };
  const libraryCopy = (text = NOTE): string =>
    storeExtracted(db, workspace, {
      title: "libreria",
      kind: "text",
      mime: "text/plain",
      ext: ".txt",
      bytes: bytesOf(text),
      extracted: extractPlain(text, false),
    }).sourceId;
  const index = () => indexVectors(db, () => new Float32Array(384).fill(0.1));
  const found = () => count("sources");
  const search = (word: string) =>
    (
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM passages_fts WHERE passages_fts MATCH ?`,
        )
        .get(word) as { n: number }
    ).n;
  return {
    workspace,
    db,
    count,
    chat,
    scopeOf,
    attachDocument,
    attachPhoto,
    libraryCopy,
    index,
    found,
    search,
  };
}

describe("deleting a chat", () => {
  it("permanently deletes its unreferenced hidden documents, their passages and files, and its photos", () => {
    const {
      workspace,
      db,
      count,
      chat,
      attachDocument,
      attachPhoto,
      index,
      search,
    } = setup();
    chat("c");
    const sourceId = attachDocument("c");
    const photo = attachPhoto("c");
    index();
    const documentBlob = sha256(bytesOf(NOTE));
    expect(count("passages")).toBeGreaterThan(0);
    expect(count("passages_vec")).toBeGreaterThan(0);
    expect(search("calore")).toBeGreaterThan(0);

    chatHandlers(db, workspace).remove({ chatId: "c" });

    expect(
      db.prepare(`SELECT 1 FROM sources WHERE id = ?`).get(sourceId),
    ).toBeUndefined();
    for (const table of [
      "chats",
      "messages",
      "attachments",
      "sources",
      "source_documents",
      "passages",
      "passages_vec",
    ])
      expect([table, count(table)]).toEqual([table, 0]);
    expect(search("calore")).toBe(0);
    expect(hasBlob(workspace, documentBlob)).toBe(false);
    expect(hasBlob(workspace, photo)).toBe(false);
    db.close();
  });

  it("keeps a document, and its file, that a library source shares, or that the student promoted", () => {
    const { workspace, db, count, chat, attachDocument, libraryCopy } = setup();
    chat("c");
    const hidden = attachDocument("c");
    const library = libraryCopy();
    chat("d");
    const second = attachDocument(
      "d",
      "Un altro appunto sul lavoro e sull'energia.",
    );
    promoteSource(db, second);

    deleteChat(db, workspace, "c");
    // The hidden copy is gone, and the library source still has its passages and its original.
    expect(
      db.prepare(`SELECT 1 FROM sources WHERE id = ?`).get(hidden),
    ).toBeUndefined();
    expect(
      db.prepare(`SELECT library FROM sources WHERE id = ?`).get(library),
    ).toEqual({ library: 1 });
    expect(
      db
        .prepare(`SELECT COUNT(*) AS n FROM passages WHERE source_id = ?`)
        .get(library),
    ).not.toEqual({ n: 0 });
    expect(hasBlob(workspace, sha256(bytesOf(NOTE)))).toBe(true);

    deleteChat(db, workspace, "d");
    expect(
      db.prepare(`SELECT library FROM sources WHERE id = ?`).get(second),
    ).toEqual({ library: 1 });
    expect(
      hasBlob(
        workspace,
        sha256(bytesOf("Un altro appunto sul lavoro e sull'energia.")),
      ),
    ).toBe(true);
    expect(count("chats")).toBe(0);
    db.close();
  });

  it("keeps a document another chat still has in its scope until that chat goes too", () => {
    const { workspace, db, chat, attachDocument, scopeOf, found } = setup();
    chat("c");
    const sourceId = attachDocument("c");
    // Another chat was started from this one's sources, as a seeded chat can be.
    chat("d", [sourceId]);
    deleteChat(db, workspace, "c");
    expect(found()).toBe(1);
    expect(hasBlob(workspace, sha256(bytesOf(NOTE)))).toBe(true);
    expect(scopeOf("d")).toEqual([sourceId]);

    deleteChat(db, workspace, "d");
    expect(found()).toBe(0);
    expect(hasBlob(workspace, sha256(bytesOf(NOTE)))).toBe(false);
    db.close();
  });

  it("keeps a document a plan uses, a card was written from, or another chat cited", () => {
    const { workspace, db, chat, attachDocument, found, count } = setup();
    const claim = (kind: "plan" | "card" | "citation") => {
      const chatId = `c-${kind}`;
      chat(chatId);
      const sourceId = attachDocument(
        chatId,
        `Testo del caso ${kind} con contenuto proprio.`,
      );
      const passage = (
        db
          .prepare(`SELECT id FROM passages WHERE source_id = ?`)
          .get(sourceId) as { id: string }
      ).id;
      db.prepare(
        `INSERT OR IGNORE INTO plans (id, title, created_at, updated_at) VALUES ('p', 'Piano', 1, 1)`,
      ).run();
      if (kind === "plan")
        db.prepare(
          `INSERT INTO plan_sources (plan_id, source_id) VALUES ('p', ?)`,
        ).run(sourceId);
      if (kind === "card")
        db.prepare(
          `INSERT INTO cards (id, plan_id, front, back, passage_id, created_at) VALUES ('k', 'p', 'f', 'b', ?, 1)`,
        ).run(passage);
      if (kind === "citation") {
        chat("other");
        db.prepare(
          `INSERT INTO messages (id, chat_id, role, body, created_at) VALUES ('m', 'other', 'assistant', 'b', 1)`,
        ).run();
        db.prepare(
          `INSERT INTO message_passages (message_id, passage_id, label) VALUES ('m', ?, 'P1')`,
        ).run(passage);
      }
      return {
        chatId,
        sourceId,
        text: `Testo del caso ${kind} con contenuto proprio.`,
      };
    };
    const claims = [claim("plan"), claim("card"), claim("citation")];
    for (const { chatId } of claims) deleteChat(db, workspace, chatId);
    expect(found()).toBe(3);
    for (const { sourceId, text } of claims) {
      expect(
        db
          .prepare(`SELECT COUNT(*) AS n FROM passages WHERE source_id = ?`)
          .get(sourceId),
      ).not.toEqual({ n: 0 });
      expect(hasBlob(workspace, sha256(bytesOf(text)))).toBe(true);
    }
    // The card still points at its passage.
    expect(
      db.prepare(`SELECT passage_id FROM cards WHERE id = 'k'`).get(),
    ).not.toEqual({ passage_id: null });
    expect(count("chats")).toBe(1);
    db.close();
  });

  it("keeps a document that is a smartbook or that an unfinished job names", () => {
    const { workspace, db, chat, attachDocument, found } = setup();
    chat("c");
    chat("d");
    const book = attachDocument("c", "Contenuto di uno smartbook importato.");
    const busy = attachDocument("d", "Contenuto ancora in lavorazione.");
    db.prepare(
      `INSERT INTO smartbooks (id, source_id, meta_json, created_at) VALUES ('b', ?, '{}', 1)`,
    ).run(book);
    db.prepare(
      `INSERT INTO jobs (id, kind, params_json, state, created_at, updated_at) VALUES ('j', 'plan-build', ?, 'running', 1, 1)`,
    ).run(JSON.stringify({ sourceIds: [busy] }));

    deleteChat(db, workspace, "c");
    deleteChat(db, workspace, "d");
    expect(found()).toBe(2);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM smartbooks`).get()).toEqual({
      n: 1,
    });
    expect(
      hasBlob(
        workspace,
        sha256(bytesOf("Contenuto di uno smartbook importato.")),
      ),
    ).toBe(true);
    expect(
      hasBlob(workspace, sha256(bytesOf("Contenuto ancora in lavorazione."))),
    ).toBe(true);
    db.close();
  });

  it("keeps a photo another chat or a running job still names, and removes it once nothing does", () => {
    const { workspace, db, chat, attachPhoto, count } = setup();
    chat("c");
    chat("d");
    const sha = attachPhoto("c");
    expect(attachPhoto("d")).toBe(sha);
    const solo = attachPhoto("c", new Uint8Array([137, 80, 78, 71, 9, 9, 9]));
    db.prepare(
      `INSERT INTO jobs (id, kind, params_json, state, created_at, updated_at) VALUES ('j', 'source-import', ?, 'running', 1, 1)`,
    ).run(JSON.stringify({ sha: solo }));

    deleteChat(db, workspace, "c");
    expect(hasBlob(workspace, sha)).toBe(true);
    // A running import still reads this file, so it stays.
    expect(hasBlob(workspace, solo)).toBe(true);

    db.prepare(`UPDATE jobs SET state = 'succeeded'`).run();
    deleteChat(db, workspace, "d");
    expect(count("attachments")).toBe(0);
    expect(hasBlob(workspace, sha)).toBe(false);
    db.close();
  });

  it("rolls everything back when a row cannot be deleted, and leaves the files", () => {
    const { workspace, db, count, chat, attachDocument, attachPhoto } = setup();
    chat("c");
    attachDocument("c");
    const photo = attachPhoto("c");
    db.exec(
      `CREATE TRIGGER stuck BEFORE DELETE ON sources BEGIN SELECT RAISE(ABORT, 'stuck'); END`,
    );
    expect(() => deleteChat(db, workspace, "c")).toThrow("stuck");
    expect(count("chats")).toBe(1);
    expect(count("messages")).toBe(1);
    expect(count("sources")).toBe(1);
    expect(count("passages")).toBeGreaterThan(0);
    expect(hasBlob(workspace, photo)).toBe(true);
    expect(hasBlob(workspace, sha256(bytesOf(NOTE)))).toBe(true);
    db.close();
  });

  it("says when the chat is not there, and touches nothing", () => {
    const { workspace, db, count, chat, attachDocument } = setup();
    chat("c");
    attachDocument("c");
    expect(() => deleteChat(db, workspace, "missing")).toThrow("chat-missing");
    expect(count("sources")).toBe(1);
    db.close();
  });
});
