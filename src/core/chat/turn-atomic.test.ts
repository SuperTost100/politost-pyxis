import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { hasBlob, putBlob } from "../blobs";
import { openDatabase } from "../db/connection";
import type { EngineResult } from "../engine/funnel";
import { sha256 } from "../sources/quality";
import * as attach from "./attach";
import { extractPlain, storeExtracted } from "../sources/documents";
import { askTurn, chatPickedSources, chatScope, deleteChat, heldSources, regenerateTurn } from "./turn";

// The real staging, with the document read swapped for a stub a test can hold open.
let extract: Parameters<typeof attach.stageFiles>[8];
vi.mock("./attach", async (original) => {
  const actual = await original<typeof import("./attach")>();
  return {
    ...actual,
    stageFiles: (...args: Parameters<typeof actual.stageFiles>) =>
      actual.stageFiles(args[0], args[1], args[2], args[3], args[4], args[5], undefined, undefined, extract),
  };
});

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const reply: EngineResult = { text: "Ecco la risposta.", model: "claude-sonnet-5", provider: "claude", inputTokens: 1 };

function setup() {
  const workspace = mkdtempSync(join(tmpdir(), "pyxis-turn-atomic-"));
  dirs.push(workspace);
  const db = openDatabase(":memory:");
  db.prepare("INSERT INTO feature_engines (feature, selection_json, updated_at) VALUES ('default', ?, 1)").run(
    JSON.stringify({ provider: "claude", model: "claude-sonnet-5" }),
  );
  db.prepare("INSERT INTO chats (id, title, created_at, updated_at) VALUES ('c', 't', 1, 1)").run();
  const file = (name: string, text: string) => {
    const path = join(workspace, name);
    writeFileSync(path, text);
    return path;
  };
  const count = (table: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
  const rows = () => ({
    sources: count("sources"),
    documents: count("source_documents"),
    passages: count("passages"),
    messages: count("messages"),
    attachments: count("attachments"),
  });
  const ask = (files: string[]) =>
    askTurn(db, { chatId: "c", text: "spiega", allowGeneral: true, files, workspace, run: async () => reply });
  return { workspace, db, file, rows, ask, count };
}

const nothing = { sources: 0, documents: 0, passages: 0, messages: 0, attachments: 0 };

describe("an attached file and its turn are stored together or not at all", () => {
  it("a chat deleted while the files are read leaves no hidden source, passage or new blob, and never a shared one", async () => {
    const { workspace, db, file, rows, ask } = setup();
    const fresh = file("nuovo.txt", "Il calore si trasmette per conduzione.");
    const shared = file("condiviso.txt", "Questo testo e gia in una fonte della libreria.");
    // The second file's bytes are already a blob, as when a library source holds the same file.
    const sharedSha = putBlob(workspace, new TextEncoder().encode("Questo testo e gia in una fonte della libreria."), "text/plain", "txt");
    let deleted = false;
    extract = async (_path, _ext, bytes) => {
      if (!deleted) deleteChat(db, workspace, "c");
      deleted = true;
      return extractPlain(new TextDecoder().decode(bytes), false);
    };
    await expect(ask([fresh, shared])).rejects.toThrow("chat-missing");
    expect(rows()).toEqual(nothing);
    expect(hasBlob(workspace, sha256(new TextEncoder().encode("Il calore si trasmette per conduzione.")))).toBe(false);
    expect(hasBlob(workspace, sharedSha)).toBe(true);
    db.close();
  });

  it("a failure after the sources are stored rolls them back with the scope and message, keeps a shared blob, and a retry then succeeds", async () => {
    const { workspace, db, file, rows, ask } = setup();
    const fresh = file("nuovo.txt", "Il calore si trasmette per conduzione.");
    const shared = file("condiviso.txt", "Questo testo e gia in una fonte della libreria.");
    const sharedSha = putBlob(workspace, new TextEncoder().encode("Questo testo e gia in una fonte della libreria."), "text/plain", "txt");
    extract = async (_path, _ext, bytes) => extractPlain(new TextDecoder().decode(bytes), false);
    db.exec(`CREATE TRIGGER late BEFORE INSERT ON messages WHEN NEW.role = 'user' BEGIN SELECT RAISE(ABORT, 'late-failure'); END`);
    await expect(ask([fresh, shared])).rejects.toThrow("late-failure");
    expect(rows()).toEqual(nothing);
    expect(db.prepare(`SELECT scope_json FROM chats WHERE id = 'c'`).get()).toEqual({ scope_json: "[]" });
    expect(hasBlob(workspace, sha256(new TextEncoder().encode("Il calore si trasmette per conduzione.")))).toBe(false);
    expect(hasBlob(workspace, sharedSha)).toBe(true);

    db.exec(`DROP TRIGGER late`);
    const result = await ask([fresh, shared]);
    expect(result.message?.body).toBe("Ecco la risposta.");
    expect(rows()).toMatchObject({ sources: 2, messages: 2 });
    expect(db.prepare(`SELECT COUNT(*) AS n FROM sources WHERE library = 0`).get()).toEqual({ n: 2 });
    expect(JSON.parse((db.prepare(`SELECT scope_json FROM chats WHERE id = 'c'`).get() as { scope_json: string }).scope_json)).toHaveLength(2);
    db.close();
  });

  it("a stored turn keeps the sources even when the model call then fails", async () => {
    const { workspace, db, file, rows } = setup();
    extract = async (_path, _ext, bytes) => extractPlain(new TextDecoder().decode(bytes), false);
    await expect(
      askTurn(db, {
        chatId: "c",
        text: "spiega",
        allowGeneral: true,
        files: [file("nuovo.txt", "Il calore si trasmette per conduzione.")],
        workspace,
        run: async () => {
          throw new Error("engine-down");
        },
      }),
    ).rejects.toThrow("engine-down");
    // The user's message and its source are saved, so the student can retry the turn without attaching the file again.
    expect(rows()).toMatchObject({ sources: 1, messages: 1 });
    db.close();
  });

  describe("a document attached on a later turn stays in the chat's scope", () => {
    const NOTE = "Il calore si trasmette per conduzione.";
    const bytes = new TextEncoder().encode(NOTE);
    const cite: EngineResult = { ...reply, text: "Il calore si trasmette per conduzione [P1]." };
    const hiddenCount = (db: ReturnType<typeof setup>["db"]) =>
      (db.prepare(`SELECT COUNT(*) AS n FROM sources WHERE library = 0`).get() as { n: number }).n;

    /** Turn 1 with no files, turn 2 attaches the document, turn 3 sends `sourceIds: []` as an unrefreshed picker does. */
    async function threeTurns(libraryCopy: boolean, sourceIds: (lib: string | null) => string[] = () => []) {
      const t = setup();
      extract = async (_path, _ext, data) => extractPlain(new TextDecoder().decode(data), false);
      const lib = libraryCopy
        ? storeExtracted(t.db, t.workspace, {
            title: "libreria",
            kind: "text",
            mime: "text/plain",
            ext: ".txt",
            bytes,
            extracted: extractPlain(NOTE, false),
          }).sourceId
        : null;
      await askTurn(t.db, { chatId: "c", text: "ciao", allowGeneral: true, sourceIds: sourceIds(lib), run: async () => reply });
      await askTurn(t.db, {
        chatId: "c",
        text: "spiega",
        allowGeneral: true,
        sourceIds: sourceIds(lib),
        files: [t.file("appunti.txt", NOTE)],
        workspace: t.workspace,
        run: async () => reply,
      });
      const hidden = chatPickedSources(t.db, "c").filter((id) => id !== lib);
      return { ...t, lib, hidden, sha: sha256(bytes) };
    }

    it("keeps it in the scope, in retrieval and in the held chips on the third turn and on regeneration", async () => {
      const { db, hidden } = await threeTurns(false);
      expect(hidden).toHaveLength(1);
      const third = await askTurn(db, {
        chatId: "c",
        text: "calore conduzione",
        sourceIds: [],
        run: async () => cite,
      });
      expect(third.covered).toBe(true);
      expect(third.message?.citations.map((c) => c.sourceId)).toEqual([hidden[0]]);
      expect(chatPickedSources(db, "c")).toEqual(hidden);
      expect(heldSources(db, "c").map((s) => s.id)).toEqual(hidden);
      const again = await regenerateTurn(db, { chatId: "c", sourceIds: [], run: async () => cite });
      expect(again.message?.citations.map((c) => c.sourceId)).toEqual([hidden[0]]);
      expect(chatScope(db, "c")).toEqual(hidden);
      db.close();
    });

    it("deletes the chat with no hidden source, passage, search row or file left", async () => {
      const { workspace, db, hidden, sha, count } = await threeTurns(false);
      await askTurn(db, { chatId: "c", text: "calore conduzione", sourceIds: [], run: async () => cite });
      expect(hasBlob(workspace, sha)).toBe(true);
      deleteChat(db, workspace, "c");
      expect(hiddenCount(db)).toBe(0);
      expect(db.prepare(`SELECT 1 FROM sources WHERE id = ?`).get(hidden[0])).toBeUndefined();
      for (const table of ["sources", "source_documents", "passages", "passages_fts", "messages", "message_passages"])
        expect(count(table)).toBe(0);
      expect(hasBlob(workspace, sha)).toBe(false);
      db.close();
    });

    it("deletes a hidden document a library copy shares bytes with, keeps the copy and its file", async () => {
      const { workspace, db, lib, hidden, sha, count } = await threeTurns(true);
      const libraryPassages = (db.prepare(`SELECT COUNT(*) AS n FROM passages WHERE source_id = ?`).get(lib) as { n: number }).n;
      await askTurn(db, { chatId: "c", text: "ciao", sourceIds: [], allowGeneral: true, run: async () => reply });
      deleteChat(db, workspace, "c");
      expect(hiddenCount(db)).toBe(0);
      expect(db.prepare(`SELECT 1 FROM sources WHERE id = ?`).get(hidden[0])).toBeUndefined();
      expect(db.prepare(`SELECT 1 FROM sources WHERE id = ?`).get(lib)).toBeDefined();
      expect(count("passages")).toBe(libraryPassages);
      expect(hasBlob(workspace, sha)).toBe(true);
      db.close();
    });

    it("lets the student drop a library source but not the chat's own document", async () => {
      const { db, lib, hidden } = await threeTurns(true, (id) => [id!]);
      expect(chatPickedSources(db, "c").sort()).toEqual([lib!, ...hidden].sort());
      await askTurn(db, { chatId: "c", text: "ciao", sourceIds: [], allowGeneral: true, run: async () => reply });
      expect(chatPickedSources(db, "c")).toEqual(hidden);
      db.close();
    });

    it("a third turn that fails after its scope write leaves the scope as it was", async () => {
      const { db, hidden } = await threeTurns(false);
      db.exec(`CREATE TRIGGER late BEFORE INSERT ON messages WHEN NEW.role = 'user' BEGIN SELECT RAISE(ABORT, 'late-failure'); END`);
      await expect(
        askTurn(db, { chatId: "c", text: "nuova", sourceIds: [], allowGeneral: true, run: async () => reply }),
      ).rejects.toThrow("late-failure");
      expect(chatPickedSources(db, "c")).toEqual(hidden);
      db.close();
    });

    it("deletes a hidden document the chat cited even when an older turn dropped it from the scope", async () => {
      const { workspace, db, hidden, sha } = await threeTurns(false);
      await askTurn(db, { chatId: "c", text: "calore conduzione", sourceIds: [], run: async () => cite });
      db.prepare(`UPDATE chats SET scope_json = '[]' WHERE id = 'c'`).run();
      deleteChat(db, workspace, "c");
      expect(db.prepare(`SELECT 1 FROM sources WHERE id = ?`).get(hidden[0])).toBeUndefined();
      expect(hasBlob(workspace, sha)).toBe(false);
      db.close();
    });
  });
});
