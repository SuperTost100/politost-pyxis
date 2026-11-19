import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { PNG } from "pngjs";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase } from "../db/connection";
import type { EngineResult } from "../engine/funnel";
import { rememberReady } from "../engine/selection";
import { extractPlain } from "../sources/documents";
import { tempDir } from "../test-temp";
import { heldFilesFor } from "./test-attach";
import { askTurn, readChat, regenerateTurn } from "./turn";

afterEach(() => rememberReady([]));

const reply: EngineResult = { text: "Ecco la risposta.", model: "claude-sonnet-5", provider: "claude", inputTokens: 1 };

/** A chat whose own model cannot read images (`text-only-small`) and a tool that has one (`claude-sonnet-5`). */
function setup(options: { visionAvailable: boolean } = { visionAvailable: true }) {
  const workspace = tempDir("pyxis-turn-files-");
  const db = openDatabase(":memory:");
  const engine = (feature: string, model: string) =>
    db
      .prepare(`INSERT INTO feature_engines (feature, selection_json, updated_at) VALUES (?, ?, 1)`)
      .run(feature, JSON.stringify({ provider: "claude", model }));
  engine("default", "text-only-small");
  engine("chat", "text-only-small");
  // The student's tools, as the last automatic choice read them.
  rememberReady([
    {
      id: "claude",
      kind: "cli",
      effort: false,
      models: [{ id: "text-only-small", efforts: [] }, ...(options.visionAvailable ? [{ id: "claude-sonnet-5", efforts: [] }] : [])],
    },
  ]);
  if (!options.visionAvailable) engine("vision", "text-only-small");
  const write = (name: string, content: string | Uint8Array) => {
    const path = join(workspace, name);
    writeFileSync(path, content);
    return path;
  };
  const photo = write("foto.png", PNG.sync.write(new PNG({ width: 1, height: 1 })));
  const files = heldFilesFor(db, workspace);
  const attached = async (...paths: string[]) => ({ attachments: (await files.attach(...paths)).ids, held: files.held });
  return { workspace, db, write, photo, attached };
}

describe("the files a message carried belong to it", () => {
  it("are listed with the message that was sent: name, kind, size and, for a document, the hidden source", async () => {
    const { db, workspace, write, photo, attached } = setup();
    const note = write("appunti.txt", "Il calore si trasmette per conduzione.");
    const result = await askTurn(db, {
      text: "riassumi",
      allowGeneral: true,
      ...(await attached(note, photo)),
      workspace,
      recognize: async () => "",
      run: async () => reply,
    });
    const [question] = readChat(db, result.chatId);
    const sourceId = db.prepare(`SELECT id FROM sources WHERE library = 0`).pluck().get() as string;
    expect(question!.files).toEqual([
      expect.objectContaining({ name: "appunti.txt", kind: "document", size: 38, sourceId, sha: null }),
      expect.objectContaining({ name: "foto.png", kind: "photo", sourceId: null, mime: "image/png", sha: expect.stringMatching(/^[a-f0-9]{64}$/) }),
    ]);
    // The message itself is what the student typed.
    expect(question!.body).toBe("riassumi");
    // A document that was removed since is still listed, with nothing to open.
    db.prepare(`UPDATE sources SET status = 'removed' WHERE id = ?`).run(sourceId);
    expect(readChat(db, result.chatId)[0]!.files![0]).toMatchObject({ name: "appunti.txt", sourceId: null });
    db.close();
  });

  it("lists a photo sent before names were kept as a photo, and leaves its message as it is", () => {
    const { db } = setup();
    db.prepare("INSERT INTO chats (id, title, created_at, updated_at) VALUES ('c', 't', 1, 1)").run();
    // A question from an older build: the text OCR read is part of the stored body, and the photo row has no name.
    db.prepare(`INSERT INTO messages (id, chat_id, role, body, created_at) VALUES ('m', 'c', 'user', 'cosa dice?\n\nF uguale m a', 1)`).run();
    db.prepare(`INSERT INTO attachments (id, message_id, blob_sha, mime, created_at) VALUES ('a', 'm', ?, 'image/png', 1)`).run("a".repeat(64));
    const [question] = readChat(db, "c");
    expect(question!.body).toBe("cosa dice?\n\nF uguale m a");
    expect(question!.files).toEqual([expect.objectContaining({ name: null, kind: "photo", size: null, sourceId: null })]);
    db.close();
  });

  it("names the files that could not be read and goes on without them", async () => {
    const { db, workspace, write, attached } = setup();
    const files = heldFilesFor(db, workspace, {
      extract: async ({ path }) => {
        throw new Error(path ? "pdf-password-required" : "");
      },
    });
    const locked = await files.attach(write("chiuso.pdf", "%PDF"));
    const good = await heldFilesFor(db, workspace).attach(write("buono.txt", "Testo."));
    void good;
    void attached;
    let prompt = "";
    const result = await askTurn(db, {
      text: "leggi",
      allowGeneral: true,
      attachments: locked.ids,
      held: files.held,
      workspace,
      run: async (input) => {
        prompt = input.prompt;
        return reply;
      },
    });
    expect(result.leftOut).toEqual([{ name: "chiuso.pdf", error: "password" }]);
    expect(result.message?.body).toBe("Ecco la risposta.");
    expect(prompt).toContain("leggi");
    expect(readChat(db, result.chatId)[0]!.files).toBeUndefined();
    db.close();
  });
});

describe("a reply to a question that came with a file", () => {
  it("does not say it comes from general knowledge when the file's passages were sent and the reply cites none of them", async () => {
    const { db, workspace, write, attached } = setup();
    let prompt = "";
    const result = await askTurn(db, {
      text: "riassumi gli appunti",
      ...(await attached(write("appunti.txt", "Il calore si trasmette per conduzione."))),
      workspace,
      run: async (input) => {
        prompt = input.prompt;
        return reply;
      },
    });
    expect(prompt).toContain("Il calore si trasmette per conduzione.");
    // The file was this question's own source, as a photo is: the reply is not marked as general knowledge, so the
    // line above it does not claim that nothing was found.
    expect(result.message?.grounding).toBe("sources");
    expect(result.message?.searched).toBeUndefined();
    expect(readChat(db, result.chatId).at(-1)).toMatchObject({ grounding: "sources" });
    db.close();
  });

  it("says it used the attached file when the reply cites it", async () => {
    const { db, workspace, write, attached } = setup();
    const result = await askTurn(db, {
      text: "riassumi gli appunti",
      ...(await attached(write("appunti.txt", "Il calore si trasmette per conduzione."))),
      workspace,
      run: async () => ({ ...reply, text: "Il calore si trasmette per conduzione [P1]." }),
    });
    expect(result.message?.grounding).toBe("sources");
    expect(result.message?.citations).toHaveLength(1);
    expect(readChat(db, result.chatId).at(-1)!.citations[0]).toMatchObject({ attached: true });
    db.close();
  });

  it("still says general knowledge for a question about a file attached earlier that finds nothing in it", async () => {
    const { db, workspace, write, attached } = setup();
    const first = await askTurn(db, {
      text: "riassumi",
      ...(await attached(write("appunti.txt", "Il calore si trasmette per conduzione."))),
      workspace,
      run: async () => reply,
    });
    // No new file: the claim is about this turn's own file only, so the existing rule decides.
    const later = await askTurn(db, {
      chatId: first.chatId,
      text: "Who wrote Hamlet?",
      workspace,
      run: async () => ({ ...reply, text: "Shakespeare." }),
    });
    expect(later.message?.grounding).toBe("general");
    db.close();
  });
});

describe("a photo goes to a model that can read it", () => {
  it("runs the turn on the same tool's image model, and the chat after it, instead of reading the photo with OCR", async () => {
    const { db, workspace, photo, attached } = setup();
    let ocr = 0;
    const seen: Array<{ model: string; images: number }> = [];
    const run = async (input: { selection: { model: string }; attachments?: unknown[] }) => {
      seen.push({ model: input.selection.model, images: input.attachments?.length ?? 0 });
      return reply;
    };
    const first = await askTurn(db, {
      text: "cosa c'è scritto",
      allowGeneral: true,
      ...(await attached(photo)),
      workspace,
      recognize: async () => (ocr++, "non serve"),
      run: run as never,
    });
    // The next question has no photo of its own, but the chat holds one, so it runs where the photo is seen.
    await askTurn(db, { chatId: first.chatId, text: "e il secondo esercizio?", allowGeneral: true, workspace, run: run as never });
    expect(seen).toEqual([
      { model: "claude-sonnet-5", images: 1 },
      { model: "claude-sonnet-5", images: 1 },
    ]);
    expect(ocr).toBe(0);
    expect(db.prepare(`SELECT recognised FROM attachments`).pluck().all()).toEqual([null]);
    db.close();
  });

  it("keeps the chat's own model for a chat with no photo", async () => {
    const { db, workspace } = setup();
    let model = "";
    await askTurn(db, {
      text: "ciao",
      allowGeneral: true,
      workspace,
      run: async (input) => {
        model = input.selection.model;
        return reply;
      },
    });
    expect(model).toBe("text-only-small");
    db.close();
  });
});

describe("local OCR reads a photo only when no tool has a model for images", () => {
  it("sends the recognised text with the question, stores it apart from the message, and shows it nowhere as message text", async () => {
    const { db, workspace, photo, attached } = setup({ visionAvailable: false });
    let prompt = "";
    const result = await askTurn(db, {
      text: "cosa c'è scritto",
      allowGeneral: true,
      ...(await attached(photo)),
      workspace,
      recognize: async () => "Esercizio 2. Determinare il dominio delle funzioni",
      run: async (input) => {
        prompt = input.prompt;
        expect(input.selection.model).toBe("text-only-small");
        expect(input.attachments ?? []).toHaveLength(0);
        return reply;
      },
    });
    expect(prompt).toContain("Esercizio 2. Determinare il dominio delle funzioni");
    const [question] = readChat(db, result.chatId);
    expect(question!.body).toBe("cosa c'è scritto");
    expect(db.prepare(`SELECT body FROM messages WHERE role = 'user'`).pluck().get()).toBe("cosa c'è scritto");
    expect(db.prepare(`SELECT recognised FROM attachments WHERE kind = 'photo'`).pluck().get()).toBe(
      "Esercizio 2. Determinare il dominio delle funzioni",
    );
    // The model still reads it on the next turn, and when the answer is written again.
    let next = "";
    await askTurn(db, {
      chatId: result.chatId,
      text: "ripeti",
      allowGeneral: true,
      workspace,
      run: async (input) => {
        next = input.prompt;
        return reply;
      },
    });
    expect(next).toContain("Esercizio 2. Determinare il dominio delle funzioni");
    let again = "";
    await regenerateTurn(db, {
      chatId: result.chatId,
      allowGeneral: true,
      workspace,
      run: async (input) => {
        again = input.prompt;
        return reply;
      },
    });
    expect(again).toContain("Esercizio 2. Determinare il dominio delle funzioni");
    expect(db.prepare(`SELECT COUNT(*) FROM messages WHERE body LIKE '%Esercizio 2%'`).pluck().get()).toBe(0);
    db.close();
  });
});

void extractPlain;
