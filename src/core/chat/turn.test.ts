import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PNG } from "pngjs";
import { openDatabase } from "../db/connection";
import type { EngineResult } from "../engine/funnel";
import { importSmartbook } from "../sources/smartbook";
import { strToU8, zipSync } from "fflate";
import { askTurn, chatContext, chatScope, deleteChat, heldSources, listChats, rateMessage, readChat, renameChat, seedChat } from "./turn";

function pack(files: Record<string, string>): Uint8Array {
  return zipSync(
    Object.fromEntries(Object.entries(files).map(([name, text]) => [name, strToU8(text)])),
  );
}

const reply: EngineResult = {
  text: "Il vettore descrive il punto [P1].\n<followups>\nCos'è la posizione?\nE la velocità?\nUn esempio?\n</followups>",
  model: "gpt-6.1-sol",
  provider: "codex",
  inputTokens: 12,
};

describe("askTurn", () => {
  it("ASK-01 clears an existing subject when an empty selection is sent", async () => {
    const db = openDatabase(":memory:");
    const first = await askTurn(db, { text: "Ciao", subject: "Fisica", run: async () => reply });
    let system = "";
    await askTurn(db, { chatId: first.chatId, text: "Ora parliamo d altro", subject: "", run: async (input) => { system = input.system ?? ""; return reply; } });
    expect(db.prepare("SELECT subject FROM chats WHERE id = ?").get(first.chatId)).toEqual({ subject: null });
    expect(system).not.toContain("Subject: Fisica");
    db.close();
  });
  it("answers from a passage and stores the citation", async () => {
    const db = openDatabase(":memory:");
    const imported = importSmartbook(
      db,
      pack({
        "smartbook.json": JSON.stringify({
          id: "demo",
          title: "Demo",
          access: "public",
          chapters: [{ id: "c1", number: 1, title: "Moti", file: "01.md" }],
        }),
        "chapters/01.md": "## p1 | Energia\nIl vettore posizione descrive il punto.\n",
      }),
    );
    const result = await askTurn(db, {
      text: "Che cos'è il vettore?",
      sourceIds: [imported.sourceId],
      run: async () => reply,
    });
    expect(result.covered).toBe(true);
    expect(result.message?.modelId).toBe("gpt-6.1-sol");
    expect(result.message?.provider).toBe("codex");
    expect(readChat(db, result.chatId).at(-1)?.provider).toBe("codex");
    expect(result.message?.followups).toHaveLength(3);
    expect(result.message?.citations).toHaveLength(1);
    expect(result.message?.body).toContain("[P1]");
    const stored = readChat(db, result.chatId);
    expect(stored.at(-1)?.citations[0]?.locator).toEqual({
      chapter: 1,
      paragraph: "p1",
    });
    expect(chatScope(db, result.chatId)).toEqual([imported.sourceId]);
    const messageId = result.message?.id ?? "";
    expect(rateMessage(db, messageId, "up")).toBe("up");
    expect(readChat(db, result.chatId).at(-1)?.reaction).toBe("up");
    expect(rateMessage(db, messageId, "up")).toBe(null);
    expect(rateMessage(db, messageId, "down")).toBe("down");
    renameChat(db, result.chatId, "Moti");
    expect(listChats(db)[0]?.title).toBe("Moti");
    expect(() => renameChat(db, result.chatId, "  ")).toThrow(/chat-title/);
    deleteChat(db, result.chatId);
    expect(listChats(db)).toEqual([]);
    expect(readChat(db, result.chatId)).toEqual([]);
  });

  it("keeps a short follow-up on the passage already cited", async () => {
    const db = openDatabase(":memory:");
    const imported = importSmartbook(
      db,
      pack({
        "smartbook.json": JSON.stringify({
          id: "demo",
          title: "Demo",
          access: "public",
          chapters: [{ id: "c1", number: 1, title: "Moti", file: "01.md" }],
        }),
        "chapters/01.md": "## p1 | Energia\nIl vettore posizione descrive il punto.\n",
      }),
    );
    const first = await askTurn(db, {
      text: "Che cos'è il vettore?",
      sourceIds: [imported.sourceId],
      run: async () => reply,
    });
    let prompt = "";
    const second = await askTurn(db, {
      chatId: first.chatId,
      text: "un esempio",
      run: async (input) => {
        prompt = input.prompt;
        return reply;
      },
    });
    expect(second.covered).toBe(true);
    expect(prompt).toContain("vettore");
    const outside = await askTurn(db, {
      chatId: first.chatId,
      text: "un esempio",
      sourceIds: ["missing-source"],
      run: async () => reply,
    });
    expect(outside.covered).toBe(false);
  });

  it("does not keep a source answer that cites nothing", async () => {
    const db = openDatabase(":memory:");
    const imported = importSmartbook(
      db,
      pack({
        "smartbook.json": JSON.stringify({
          id: "demo",
          title: "Demo",
          access: "public",
          chapters: [{ id: "c1", number: 1, title: "Moti", file: "01.md" }],
        }),
        "chapters/01.md": "## p1 | Energia\nIl vettore posizione descrive il punto.\n",
      }),
    );
    const result = await askTurn(db, {
      text: "vettore",
      sourceIds: [imported.sourceId],
      run: async () => ({ ...reply, text: "Senza un rimando." }),
    });
    expect(result.covered).toBe(false);
    expect(readChat(db, result.chatId).some((row) => row.role === "assistant")).toBe(false);
  });

  it("reuses the pending question for a general answer", async () => {
    const db = openDatabase(":memory:");
    const first = await askTurn(db, {
      text: "fotosintesi delle banane",
      run: async () => reply,
    });
    await askTurn(db, {
      chatId: first.chatId,
      text: "fotosintesi delle banane",
      allowGeneral: true,
      run: async () => ({
        ...reply,
        text: "Dalle conoscenze generali.\n<followups>\nA\nB\nC\n</followups>",
      }),
    });
    const users = readChat(db, first.chatId).filter((row) => row.role === "user");
    expect(users).toHaveLength(1);
  });

  it("skips the model when the material does not cover the question", async () => {
    const db = openDatabase(":memory:");
    importSmartbook(
      db,
      pack({
        "smartbook.json": JSON.stringify({
          id: "demo",
          title: "Demo",
          access: "public",
          chapters: [{ id: "c1", number: 1, title: "Moti", file: "01.md" }],
        }),
        "chapters/01.md": "## p1 | Energia\nIl vettore posizione descrive il punto.\n",
      }),
    );
    let calls = 0;
    const result = await askTurn(db, {
      text: "fotosintesi delle banane",
      run: async () => {
        calls += 1;
        return reply;
      },
    });
    expect(result.covered).toBe(false);
    expect(calls).toBe(0);
    expect(readChat(db, result.chatId).some((row) => row.role === "assistant")).toBe(false);
  });

  it("answers from general knowledge when asked", async () => {
    const db = openDatabase(":memory:");
    const result = await askTurn(db, {
      text: "fotosintesi delle banane",
      allowGeneral: true,
      run: async () => ({
        ...reply,
        text: "Dalle conoscenze generali: la fotosintesi usa la luce.\n<followups>\nA\nB\nC\n</followups>",
      }),
    });
    expect(result.message?.grounding).toBe("general");
    expect(result.message?.citations).toHaveLength(0);
  });

  it("puts the profile into the tutor prompt", async () => {
    const db = openDatabase(":memory:");
    db.prepare(
      `INSERT INTO profile
        (id, display_name, education_level, course, content_language, created_at, updated_at)
       VALUES ('p', 'Ada', 'university', 'Fisica 1', 'Italian', 1, 1)`,
    ).run();
    let system = "";
    await askTurn(db, {
      text: "ciao",
      allowGeneral: true,
      run: async (input) => {
        system = input.system ?? "";
        return reply;
      },
    });
    expect(system).toContain("Ada");
    expect(system).toContain("Fisica 1");
    expect(system).toContain("Italian");
  });

  it("uses the chat engine selected for that turn", async () => {
    const db = openDatabase(":memory:");
    const seen: string[] = [];
    const run = async (input: { selection: { model: string } }) => {
      seen.push(input.selection.model);
      return { ...reply, model: input.selection.model };
    };
    await askTurn(db, { text: "prima", allowGeneral: true, run });
    db.prepare(
      `INSERT INTO feature_engines (feature, selection_json, updated_at) VALUES ('chat', ?, 1)`,
    ).run(JSON.stringify({ provider: "codex", model: "gpt-6.1-sol" }));
    await askTurn(db, { text: "dopo", allowGeneral: true, run });
    expect(seen).toEqual(["claude-sonnet-5", "gpt-6.1-sol"]);
  });

  it("does not store a reply when the turn is aborted", async () => {
    const db = openDatabase(":memory:");
    const controller = new AbortController();
    await expect(
      askTurn(db, {
        text: "vettore",
        allowGeneral: true,
        signal: controller.signal,
        run: () => {
          controller.abort();
          throw new DOMException("aborted", "AbortError");
        },
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    const chats = db.prepare(`SELECT id FROM chats`).all() as Array<{ id: string }>;
    expect(readChat(db, chats[0]?.id ?? "").some((row) => row.role === "assistant")).toBe(
      false,
    );
  });

  it("keeps the text already streamed when the student stops", async () => {
    const db = openDatabase(":memory:");
    const seen: string[] = [];
    const result = await askTurn(db, {
      text: "deriva x al quadrato",
      allowGeneral: true,
      subject: "Fisica",
      onDelta: (text) => seen.push(text),
      run: async (input) => {
        input.onDelta?.("La derivata ");
        input.onDelta?.("La derivata è 2x");
        throw new DOMException("aborted", "AbortError");
      },
    });
    expect(seen.at(-1)).toBe("La derivata è 2x");
    expect(result.message?.stopped).toBe(true);
    expect(result.message?.body).toBe("La derivata è 2x");
    const stored = readChat(db, result.chatId).at(-1);
    expect(stored?.stopped).toBe(true);
    expect(
      db.prepare(`SELECT subject FROM chats WHERE id = ?`).get(result.chatId),
    ).toEqual({ subject: "Fisica" });
  });

  it("keeps the subject on the next turn and links a stopped citation", async () => {
    const db = openDatabase(":memory:");
    const imported = importSmartbook(
      db,
      pack({
        "smartbook.json": JSON.stringify({
          id: "demo",
          title: "Demo",
          access: "public",
          chapters: [{ id: "c1", number: 1, title: "Moti", file: "01.md" }],
        }),
        "chapters/01.md": "## p1 | Energia\nIl vettore posizione descrive il punto.\n",
      }),
    );
    const stopped = await askTurn(db, {
      text: "Che cos'è il vettore?",
      sourceIds: [imported.sourceId],
      subject: "Fisica",
      run: async (input) => {
        input.onDelta?.("Il vettore descrive il punto [P1].");
        throw new DOMException("aborted", "AbortError");
      },
    });
    expect(stopped.message?.citations).toHaveLength(1);
    expect(readChat(db, stopped.chatId).at(-1)?.citations).toHaveLength(1);
    let system = "";
    await askTurn(db, {
      chatId: stopped.chatId,
      text: "un esempio",
      allowGeneral: true,
      run: async (input) => {
        system = input.system ?? "";
        return reply;
      },
    });
    expect(system).toContain("Subject: Fisica");
  });

  it("pins a wrong answer in the next prompt", async () => {
    const db = openDatabase(":memory:");
    const seeded = seedChat(db, {
      kind: "answer",
      title: "Vettore",
      body: "Question: che cos'è il vettore?\nYour answer: una linea\nExpected: un punto",
    });
    expect(chatContext(db, seeded.chatId)?.kind).toBe("answer");
    let prompt = "";
    await askTurn(db, {
      chatId: seeded.chatId,
      text: "perché?",
      allowGeneral: true,
      run: async (input) => {
        prompt = input.prompt;
        return reply;
      },
    });
    expect(prompt).toContain("Pinned context: Vettore");
    expect(prompt).toContain("una linea");
  });

  it("retrieves a document attached to the message and keeps it out of the library", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pyxis-attach-"));
    const file = join(dir, "note.txt");
    writeFileSync(file, "la velocita e la derivata dello spazio rispetto al tempo");
    const db = openDatabase(":memory:");
    let prompt = "";
    const result = await askTurn(db, {
      text: "velocita",
      files: [file],
      workspace: dir,
      run: async (input) => {
        prompt = input.prompt;
        return reply;
      },
    });
    expect(result.covered).toBe(true);
    expect(prompt).toContain("derivata");
    expect(heldSources(db, result.chatId)).toHaveLength(1);
    const again = await askTurn(db, {
      chatId: result.chatId,
      text: "ancora sulla velocita",
      workspace: dir,
      run: async () => reply,
    });
    expect(again.covered).toBe(true);
    const aside = await askTurn(db, {
      chatId: result.chatId,
      text: "Who wrote Hamlet?",
      workspace: dir,
      run: async () => reply,
    });
    expect(aside.covered).toBe(false);
  });

  it("reads an image with local OCR when the model cannot see it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pyxis-ocr-"));
    const file = join(dir, "board.png");
    writeFileSync(file, PNG.sync.write(new PNG({ width: 1, height: 1 })));
    const db = openDatabase(":memory:");
    db.prepare(
      `INSERT INTO feature_engines (feature, selection_json, updated_at) VALUES ('chat', ?, 1)`,
    ).run(JSON.stringify({ provider: "claude", model: "text-only-small" }));
    let prompt = "";
    await askTurn(db, {
      text: "cosa c'è scritto",
      allowGeneral: true,
      files: [file],
      workspace: dir,
      recognize: async () => "F uguale m a",
      run: async (input) => {
        prompt = input.prompt;
        expect(input.attachments ?? []).toHaveLength(0);
        return reply;
      },
    });
    expect(prompt).toContain("F uguale m a");
    let again = "";
    await askTurn(db, {
      chatId: (
        db.prepare(`SELECT id FROM chats`).get() as { id: string }
      ).id,
      text: "ripeti",
      allowGeneral: true,
      workspace: dir,
      run: async (input) => {
        again = input.prompt;
        return reply;
      },
    });
    expect(again).toContain("F uguale m a");
  });

  it("answers from an image even when no passage covers the question", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pyxis-vision-"));
    const file = join(dir, "board.png");
    writeFileSync(file, PNG.sync.write(new PNG({ width: 1, height: 1 })));
    const db = openDatabase(":memory:");
    db.prepare(
      `INSERT INTO feature_engines (feature, selection_json, updated_at) VALUES ('chat', ?, 1)`,
    ).run(JSON.stringify({ provider: "claude", model: "text-only-small" }));
    const result = await askTurn(db, {
      text: "cosa c'è scritto",
      files: [file],
      workspace: dir,
      recognize: async () => "F uguale m a",
      run: async () => reply,
    });
    expect(result.covered).toBe(true);
    expect(result.message?.body).toContain("[P1]");
  });

  it("does not treat a blank image as covered when the model cannot see it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pyxis-blank-"));
    const file = join(dir, "board.png");
    writeFileSync(file, PNG.sync.write(new PNG({ width: 1, height: 1 })));
    const db = openDatabase(":memory:");
    db.prepare(
      `INSERT INTO feature_engines (feature, selection_json, updated_at) VALUES ('chat', ?, 1)`,
    ).run(JSON.stringify({ provider: "claude", model: "text-only-small" }));
    const result = await askTurn(db, {
      text: "cosa c'è scritto",
      files: [file],
      workspace: dir,
      recognize: async () => "",
      run: async () => reply,
    });
    expect(result.covered).toBe(false);
  });

  it("refuses an attachment over 15 MB", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pyxis-big-"));
    const file = join(dir, "huge.txt");
    writeFileSync(file, "x");
    const { openSync, ftruncateSync, closeSync } = await import("node:fs");
    const fd = openSync(file, "r+");
    ftruncateSync(fd, 16 * 1024 * 1024);
    closeSync(fd);
    const db = openDatabase(":memory:");
    await expect(
      askTurn(db, {
        text: "leggi",
        files: [file],
        workspace: dir,
        allowGeneral: true,
        run: async () => reply,
      }),
    ).rejects.toMatchObject({ messageKey: "errors.attachTooBig" });
  });
});
