import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { PNG } from "pngjs";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase } from "../db/connection";
import type { EngineResult } from "../engine/funnel";
import { clearBench } from "../engine/bench";
import { LOCAL_PROVIDER } from "../engine/local";
import { rememberReady } from "../engine/selection";
import { extractPlain, storeExtracted } from "../sources/documents";
import { tempDir } from "../test-temp";
import { heldFilesFor } from "./test-attach";
import type { AttachmentView } from "../../shared/ipc";
import { registerOcrJob, startScan } from "../sources/ocr-job";
import { docxOf } from "../sources/test-office";
import { askTurn, readChat, regenerateTurn } from "./turn";

afterEach(() => {
  rememberReady([]);
  clearBench();
});

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
    expect(result.leftOut).toEqual([{ name: "chiuso.pdf", kind: "document", error: "password" }]);
    expect(result.message?.body).toBe("Ecco la risposta.");
    expect(prompt).toContain("leggi");
    expect(readChat(db, result.chatId)[0]!.files).toBeUndefined();
    db.close();
  });
});

describe("a question that went unanswered keeps the text read from its photo", () => {
  it("sends it again when Try again answers the stored question, and does not store it twice", async () => {
    const { db, workspace, photo, attached } = setup({ visionAvailable: false });
    const opened = await askTurn(db, { text: "ciao", allowGeneral: true, workspace, run: async () => reply });
    await new Promise((resolve) => setTimeout(resolve, 5));
    await expect(
      askTurn(db, {
        chatId: opened.chatId,
        text: "cosa c'è scritto",
        allowGeneral: true,
        ...(await attached(photo)),
        workspace,
        recognize: async () => "Esercizio 2. Determinare il dominio",
        run: async () => {
          throw new Error("engine-down");
        },
      }),
    ).rejects.toThrow("engine-down");
    await new Promise((resolve) => setTimeout(resolve, 5));
    // The student presses Try again: the last row is still their question, so nothing is being replaced.
    let prompt = "";
    const retried = await regenerateTurn(db, {
      chatId: opened.chatId,
      allowGeneral: true,
      workspace,
      run: async (input) => {
        prompt = input.prompt;
        return reply;
      },
    });
    expect(retried.message?.body).toBe("Ecco la risposta.");
    expect(prompt).toContain("Esercizio 2. Determinare il dominio");
    expect(prompt.match(/Esercizio 2\. Determinare il dominio/g)).toHaveLength(1);
    expect(db.prepare(`SELECT COUNT(*) FROM messages WHERE role = 'user' AND body = 'cosa c''è scritto'`).pluck().get()).toBe(1);
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

/**
 * A subject whose Library notes are about maths. Its passages share the everyday words of a question that points at a file
 * ("sto studiando questo"), as passages of a long textbook do.
 */
function mathsSubject(db: ReturnType<typeof openDatabase>, workspace: string) {
  db.prepare("INSERT INTO subjects (id, name, created_at) VALUES ('s-an', 'Analisi', 1)").run();
  const notes = [
    "# Serie di potenze\n\nIn questo capitolo, studiando una serie di potenze, si trova il raggio di convergenza con il criterio del rapporto.",
    "# Teorema di Gauss-Green\n\nQuesto teorema, che sto per enunciare, lega l'integrale curvilineo sul bordo all'integrale doppio sul dominio.",
  ].join("\n\n");
  const { sourceId } = storeExtracted(db, workspace, {
    title: "Analisi 2",
    kind: "text",
    mime: "text/markdown",
    ext: ".md",
    bytes: new TextEncoder().encode(notes),
    extracted: extractPlain(notes, true),
  });
  db.prepare("UPDATE sources SET subject_id = 's-an' WHERE id = ?").run(sourceId);
}

const CHEMISTRY = "# Idrocarburi\n\nGli alcani sono idrocarburi saturi con formula CnH2n+2. Gli alcheni hanno un doppio legame carbonio carbonio.";

describe("a question that comes with a file is about that file first", () => {
  it("names the file before the question, puts its passages first, and leaves out Library passages unrelated to it", async () => {
    const { db, workspace, write, attached } = setup();
    mathsSubject(db, workspace);
    let prompt = "";
    await askTurn(db, {
      text: "sto studiando questo",
      subject: "Analisi",
      ...(await attached(write("chimica.md", CHEMISTRY))),
      workspace,
      run: async (input) => {
        prompt = input.prompt;
        return reply;
      },
    });
    // The model is told a file came with the question, by name, and what was read from it comes first, numbered first.
    expect(prompt).toMatch(/Files attached to this message:\n1\. chimica\.md \(document\)/);
    const attachedBlock = prompt.slice(prompt.indexOf("<attached>"), prompt.indexOf("</attached>"));
    expect(attachedBlock).toContain("[P1] chimica.md");
    expect(attachedBlock).toContain("Gli alcani sono idrocarburi saturi");
    expect(prompt.indexOf("</attached>")).toBeLessThan(prompt.indexOf("Question:\nsto studiando questo"));
    // The maths notes share only "questo" and "studiando" with the question: nothing in them is about the file.
    expect(prompt).not.toContain("raggio di convergenza");
    expect(prompt).not.toContain("Gauss-Green");
    expect(prompt).not.toContain("No passage matches");
    db.close();
  });

  it("still brings the Library passage a specific question asks about, after the file's", async () => {
    const { db, workspace, write, attached } = setup();
    mathsSubject(db, workspace);
    let prompt = "";
    const result = await askTurn(db, {
      text: "cosa dice il teorema di Gauss-Green?",
      subject: "Analisi",
      ...(await attached(write("chimica.md", CHEMISTRY))),
      workspace,
      run: async (input) => {
        prompt = input.prompt;
        return { ...reply, text: "Lega il bordo al dominio [P2]." };
      },
    });
    expect(prompt).toContain("[P1] chimica.md");
    const library = prompt.slice(prompt.indexOf("<passages>"), prompt.indexOf("</passages>"));
    expect(library).toContain("[P2] Teorema di Gauss-Green");
    expect(library).not.toContain("raggio di convergenza");
    // The line above the reply counts what it cites: one passage of the Library, none of the file.
    expect(result.message?.citations.map((cite) => cite.index)).toEqual([2]);
    db.close();
  });

  it("finds the Library's material on the same topic as the file, from what the file says", async () => {
    const { db, workspace, write, attached } = setup();
    mathsSubject(db, workspace);
    let prompt = "";
    await askTurn(db, {
      text: "sto studiando questo",
      subject: "Analisi",
      ...(await attached(write("serie.md", "# Esercizi\n\nCalcolare il raggio di convergenza della serie di potenze con il criterio del rapporto."))),
      workspace,
      run: async (input) => {
        prompt = input.prompt;
        return reply;
      },
    });
    expect(prompt).toContain("[P1] serie.md");
    const library = prompt.slice(prompt.indexOf("<passages>"), prompt.indexOf("</passages>"));
    expect(library).toContain("raggio di convergenza con il criterio del rapporto");
    expect(library).not.toContain("Gauss-Green");
    db.close();
  });

  it("lists every file of the message, says when nothing could be read from one, and names a photo read by OCR", async () => {
    const { db, workspace, write, photo, attached } = setup({ visionAvailable: false });
    mathsSubject(db, workspace);
    let prompt = "";
    await askTurn(db, {
      text: "sto studiando questo",
      subject: "Analisi",
      ...(await attached(write("chimica.md", CHEMISTRY), write("vuoto.txt", "   \n"), photo)),
      workspace,
      recognize: async () => "Esterificazione: acido più alcol",
      run: async (input) => {
        prompt = input.prompt;
        return reply;
      },
    });
    expect(prompt).toContain(
      "Files attached to this message:\n1. chimica.md (document)\n2. vuoto.txt (document): no text could be read from it\n3. foto.png (photo)",
    );
    const attachedBlock = prompt.slice(prompt.indexOf("<attached>"), prompt.indexOf("</attached>"));
    expect(attachedBlock).toContain("Text read from foto.png:\nEsterificazione: acido più alcol");
    db.close();
  });
});

describe("a Word file made of pictures is read like a scan", () => {
  it("is read by OCR picture by picture when attached, with no page count on its chip, and the question gets the text", async () => {
    const { db, workspace, write } = setup();
    mathsSubject(db, workspace);
    const views: AttachmentView[] = [];
    let files!: ReturnType<typeof heldFilesFor>;
    files = heldFilesFor(db, workspace, {
      emit: (view) => views.push(view),
      scan: async (sourceId) => {
        startScan(db, files.runner, sourceId);
        return "started";
      },
    });
    const asked: string[] = [];
    registerOcrJob(db, workspace, files.runner, {
      readPages: async (_path, wanted, _signal, ext) => {
        asked.push(ext);
        const text = ["Gli alcani sono idrocarburi saturi.", "Gli alcheni hanno un doppio legame."];
        return { count: 2, pages: wanted.filter((page) => page <= 2).map((page) => ({ page, section: `picture ${page}`, text: text[page - 1]! })) };
      },
      requireData: async () => {},
      onReady: () => {},
    });
    const picture = PNG.sync.write(new PNG({ width: 1, height: 1 }));
    const note = await files.attach(write("organica.docx", docxOf([picture, "", picture.subarray(0)])));
    expect(asked).toEqual([".docx"]);
    expect(views.filter((view) => view.phase === "scan").every((view) => view.pages === undefined)).toBe(true);
    expect(views.at(-1)).toMatchObject({ state: "ready" });
    let prompt = "";
    // The question's words match the second picture's text best: the passages still go in the file's order.
    await askTurn(db, {
      text: "sto studiando gli alcheni",
      subject: "Analisi",
      attachments: note.ids,
      held: files.held,
      workspace,
      run: async (input) => {
        prompt = input.prompt;
        return reply;
      },
    });
    expect(prompt).toContain("1. organica.docx (document)\n<attached>\n[P1] organica.docx, picture 1\nGli alcani sono idrocarburi saturi.");
    expect(prompt).toContain("[P2] organica.docx, picture 2\nGli alcheni hanno un doppio legame.");
    expect(prompt).not.toContain("raggio di convergenza");
    db.close();
  });
});

describe("a photo goes to a model that can read it", () => {
  it("runs the turn on the same tool's image model, and the chat after it, instead of reading the photo with OCR", async () => {
    const { db, workspace, photo, attached } = setup();
    // An automatic choice may move; a pinned one never does (see the tests below).
    db.prepare(`UPDATE feature_engines SET selection_json = ? WHERE feature = 'chat'`).run(
      JSON.stringify({ provider: "claude", model: "text-only-small", auto: true }),
    );
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

describe("the model chosen for a photo is still an automatic choice", () => {
  it("moves on to another tool's image model when the first one is at its limit, as an automatic chat does", async () => {
    const { db, workspace, photo, attached } = setup();
    // The chat's own model is automatic, and another tool is signed in with a model that reads images.
    db.prepare(`UPDATE feature_engines SET selection_json = ? WHERE feature = 'chat'`).run(
      JSON.stringify({ provider: "claude", model: "text-only-small", auto: true }),
    );
    rememberReady([
      {
        id: "claude",
        kind: "cli",
        effort: false,
        models: ["text-only-small", "claude-sonnet-5", "claude-sonnet-5-5", "claude-opus-5-5"].map((id) => ({ id, efforts: [] })),
      },
      {
        id: "codex",
        kind: "cli",
        effort: false,
        models: ["gpt-5.6-terra", "gpt-6.1-terra", "gpt-6.2-sol"].map((id) => ({ id, efforts: [] })),
      },
    ]);
    const limited = Object.assign(new Error("You've hit your usage limit"), {
      code: "cli-failed",
      limit: { kind: "rate", detail: "You've hit your usage limit" },
    });
    const asked: Array<{ provider: string; model: string; images: number }> = [];
    const result = await askTurn(db, {
      text: "cosa c'è scritto",
      allowGeneral: true,
      ...(await attached(photo)),
      workspace,
      run: async (input) => {
        asked.push({ provider: input.selection.provider, model: input.selection.model, images: input.attachments?.length ?? 0 });
        if (input.selection.provider === "claude") throw limited;
        return { ...reply, provider: "codex", model: "gpt-6.1-terra" };
      },
    });
    // Each tool's newest model for the picture work, as the model file names it, reads the photo. Claude's was asked
    // first and hit its limit; the call moved on to ChatGPT's, which answered with the photo.
    expect(asked).toEqual([
      { provider: "claude", model: "claude-sonnet-5-5", images: 1 },
      { provider: "codex", model: "gpt-6.1-terra", images: 1 },
    ]);
    expect(result.message?.provider).toBe("codex");
    db.close();
  });
});

describe("a photo never leaves the computer, or the model the student chose, against that choice", () => {
  const engine = (db: ReturnType<typeof openDatabase>, feature: string, selection: object) =>
    db.prepare(`INSERT OR REPLACE INTO feature_engines (feature, selection_json, updated_at) VALUES (?, ?, 1)`).run(feature, JSON.stringify(selection));
  const cloud = { id: "claude", kind: "cli" as const, effort: false, models: ["claude-sonnet-5-5"].map((id) => ({ id, efforts: [] })) };
  const local = (models: string[]) => ({ id: LOCAL_PROVIDER, kind: "local" as const, effort: false, models: models.map((id) => ({ id, efforts: [] })) });

  /** Sends one photo and reports where the turn ran and what it carried. */
  async function sendPhoto(setupDb: (db: ReturnType<typeof openDatabase>) => void, ready: Parameters<typeof rememberReady>[0]) {
    const { db, workspace, photo, attached } = setup();
    setupDb(db);
    rememberReady(ready);
    const ran: Array<{ provider: string; model: string; images: number; prompt: string }> = [];
    await askTurn(db, {
      text: "cosa c'è scritto",
      allowGeneral: true,
      ...(await attached(photo)),
      workspace,
      recognize: async () => "Esercizio 2. Determinare il dominio",
      run: async (input) => {
        ran.push({ provider: input.selection.provider, model: input.selection.model, images: input.attachments?.length ?? 0, prompt: input.prompt });
        return reply;
      },
    });
    db.close();
    return ran;
  }

  it("keeps a chat pinned to a local text-only model on this computer: the photo is read by local OCR, its text is sent", async () => {
    const ran = await sendPhoto((db) => {
      engine(db, "chat", { provider: LOCAL_PROVIDER, model: "llama3.2:3b" });
      // The picture work is set to a cloud tool, which a pinned local chat must never reach.
      engine(db, "vision", { provider: "claude", model: "claude-sonnet-5-5" });
    }, [cloud, local(["llama3.2:3b"])]);
    expect(ran).toEqual([expect.objectContaining({ provider: LOCAL_PROVIDER, model: "llama3.2:3b", images: 0 })]);
    expect(ran[0]!.prompt).toContain("Esercizio 2. Determinare il dominio");
  });

  it("keeps a chat pinned to a cloud text-only model on that model: the photo is read by local OCR, its text is sent", async () => {
    const ran = await sendPhoto((db) => {
      engine(db, "chat", { provider: "claude", model: "text-only-small" });
    }, [{ ...cloud, models: [{ id: "text-only-small", efforts: [] }, { id: "claude-sonnet-5-5", efforts: [] }] }]);
    expect(ran).toEqual([expect.objectContaining({ provider: "claude", model: "text-only-small", images: 0 })]);
    expect(ran[0]!.prompt).toContain("Esercizio 2. Determinare il dominio");
  });

  it("lets an automatic choice move to an image model, but not from a local model to a cloud tool", async () => {
    // Local-only setup: the chat is automatic on a local text model, and a cloud tool is the photo task's engine.
    const stays = await sendPhoto((db) => {
      engine(db, "chat", { provider: LOCAL_PROVIDER, model: "llama3.2:3b", auto: true });
      engine(db, "vision", { provider: "anthropic-api", model: "claude-sonnet-5-5", auto: true });
    }, [local(["llama3.2:3b"]), { id: "anthropic-api", kind: "api", effort: false, models: [{ id: "claude-sonnet-5-5", efforts: [] }] }]);
    expect(stays).toEqual([expect.objectContaining({ provider: LOCAL_PROVIDER, images: 0 })]);
    // The same tool's own image model is still fine on this computer.
    const sameLocal = await sendPhoto((db) => {
      engine(db, "chat", { provider: LOCAL_PROVIDER, model: "llama3.2:3b", auto: true });
    }, [local(["llama3.2:3b", "gemma3:4b"])]);
    expect(sameLocal).toEqual([expect.objectContaining({ provider: LOCAL_PROVIDER, model: "gemma3:4b", images: 1 })]);
    // With a subscription tool signed in, the automatic chat is on it, and the photo moves to its image model.
    const moves = await sendPhoto((db) => {
      engine(db, "chat", { provider: "claude", model: "text-only-small", auto: true });
    }, [{ ...cloud, models: [{ id: "text-only-small", efforts: [] }, { id: "claude-sonnet-5-5", efforts: [] }] }]);
    expect(moves).toEqual([expect.objectContaining({ provider: "claude", model: "claude-sonnet-5-5", images: 1 })]);
  });
});

describe("a photo whose local OCR fails goes out as left out", () => {
  it("names it and sends the question, and keeps the refusal to download the OCR data as it is", async () => {
    const { db, workspace, photo, attached } = setup({ visionAvailable: false });
    const sent = await attached(photo);
    let ran = 0;
    const result = await askTurn(db, {
      text: "cosa c'è scritto",
      allowGeneral: true,
      ...sent,
      workspace,
      recognize: async () => {
        throw new Error("tesseract crashed");
      },
      run: async () => (ran++, reply),
    });
    expect(ran).toBe(1);
    expect(result.leftOut).toEqual([{ name: "foto.png", kind: "photo", error: "unreadable" }]);
    expect(readChat(db, result.chatId)[0]!.files).toBeUndefined();
    // The failed photo is not held for the next send: its copy goes with the answer.
    expect(sent.held.list(sent.attachments)).toEqual([]);
    expect(db.prepare(`SELECT COUNT(*) FROM held_files`).pluck().get()).toBe(0);
    // A missing OCR data file is still a refusal with its own message, which the student answers.
    const again = await attached(photo);
    await expect(
      askTurn(db, {
        text: "ancora",
        allowGeneral: true,
        ...again,
        workspace,
        recognize: async () => {
          throw new Error("ocr-data-missing");
        },
        run: async () => reply,
      }),
    ).rejects.toMatchObject({ messageKey: "sources.ocrDataMissing" });
    db.close();
  });
});

describe("whether a photo is sent is decided for the tool that answers, after a fallback too", () => {
  const limited = Object.assign(new Error("You've hit your usage limit"), {
    code: "cli-failed",
    limit: { kind: "rate", detail: "You've hit your usage limit" },
  });
  const tools = (claude: string[], codex: string[]) => [
    { id: "claude", kind: "cli" as const, effort: false, models: claude.map((id) => ({ id, efforts: [] })) },
    { id: "codex", kind: "cli" as const, effort: false, models: codex.map((id) => ({ id, efforts: [] })) },
  ];

  /** Sends one photo to a chat whose first tool is at its limit, and reports what each tool that was asked received. */
  async function limitedFirst(chat: object, ready: ReturnType<typeof tools>, vision: object) {
    const { db, workspace, photo, attached } = setup();
    db.prepare(`UPDATE feature_engines SET selection_json = ? WHERE feature = 'chat'`).run(JSON.stringify(chat));
    // The picture work is set to a tool that cannot read it, so the chat's turn is planned on a text-only model.
    db.prepare(`INSERT OR REPLACE INTO feature_engines (feature, selection_json, updated_at) VALUES ('vision', ?, 1)`).run(JSON.stringify(vision));
    rememberReady(ready);
    const asked: Array<{ provider: string; model: string; images: number; text: boolean }> = [];
    const outcome = await askTurn(db, {
      text: "cosa c'è scritto",
      allowGeneral: true,
      ...(await attached(photo)),
      workspace,
      recognize: async () => "Esercizio 2. Determinare il dominio",
      run: async (input) => {
        asked.push({
          provider: input.selection.provider,
          model: input.selection.model,
          images: input.attachments?.length ?? 0,
          text: input.prompt.includes("Esercizio 2. Determinare il dominio"),
        });
        if (input.selection.provider === "claude") throw limited;
        return { ...reply, provider: "codex", model: "gpt-6.1-terra" };
      },
    }).then(
      (result): { result?: unknown; error?: unknown } => ({ result }),
      (error: unknown): { result?: unknown; error?: unknown } => ({ error }),
    );
    db.close();
    return { asked, ...outcome };
  }

  it("sends the photo to a tool that reads images when a planned text-only tool falls back to it, and not before", async () => {
    const { asked, result } = await limitedFirst(
      { provider: "claude", model: "text-only-small", auto: true },
      tools(["text-only-small"], ["gpt-6.1-terra"]),
      { provider: "claude", model: "text-only-small", auto: true },
    );
    expect(result).toBeDefined();
    // Claude had no image to read, so it got the text OCR read. After its limit, ChatGPT reads the photo itself.
    expect(asked).toEqual([
      { provider: "claude", model: "text-only-small", images: 0, text: true },
      { provider: "codex", model: "gpt-6.1-terra", images: 1, text: true },
    ]);
  });

  it("never sends the photo to a tool that cannot read it: a planned image tool does not fall back to one", async () => {
    const { asked, error } = await limitedFirst(
      { provider: "claude", model: "text-only-small", auto: true },
      tools(["text-only-small", "claude-sonnet-5-5"], ["text-only-codex"]),
      { provider: "claude", model: "claude-sonnet-5-5", auto: true },
    );
    // The chat moved to Claude's image model, which is at its limit. The only other tool cannot read the photo, so the
    // call does not go there, and the limit is what the student is told.
    expect(asked).toEqual([{ provider: "claude", model: "claude-sonnet-5-5", images: 1, text: false }]);
    expect(error).toMatchObject({ messageKey: expect.stringContaining("quota") });
  });

  it("keeps a pinned chat where it is: no fallback, no photo to another tool", async () => {
    const { asked, error } = await limitedFirst(
      { provider: "claude", model: "text-only-small" },
      tools(["text-only-small"], ["gpt-6.1-terra"]),
      { provider: "codex", model: "gpt-6.1-terra", auto: true },
    );
    expect(asked).toEqual([{ provider: "claude", model: "text-only-small", images: 0, text: true }]);
    expect(error).toBeDefined();
  });
});

describe("a chat on a local model keeps its photo, and what was read from it, on this computer", () => {
  const limited = Object.assign(new Error("You've hit your usage limit"), {
    code: "cli-failed",
    limit: { kind: "rate", detail: "You've hit your usage limit" },
  });
  const ready = [
    { id: LOCAL_PROVIDER, kind: "local" as const, effort: false, models: [{ id: "llama3.2:3b", efforts: [] }] },
    { id: "anthropic-api", kind: "api" as const, effort: false, models: [{ id: "claude-sonnet-5-5", efforts: [] }] },
  ];

  /** An automatic chat on a local model whose model fails, with a cloud tool that reads images signed in. */
  async function localFails(withPhoto: boolean) {
    const { db, workspace, photo, attached } = setup();
    db.prepare(`UPDATE feature_engines SET selection_json = ? WHERE feature = 'chat'`).run(
      JSON.stringify({ provider: LOCAL_PROVIDER, model: "llama3.2:3b", auto: true }),
    );
    db.prepare(`INSERT OR REPLACE INTO feature_engines (feature, selection_json, updated_at) VALUES ('vision', ?, 1)`).run(
      JSON.stringify({ provider: "anthropic-api", model: "claude-sonnet-5-5", auto: true }),
    );
    rememberReady(ready);
    const asked: Array<{ provider: string; images: number; recognisedText: boolean }> = [];
    const error = await askTurn(db, {
      text: "cosa c'è scritto",
      allowGeneral: true,
      ...(withPhoto ? await attached(photo) : {}),
      workspace,
      recognize: async () => "Esercizio 2. Determinare il dominio",
      run: async (input) => {
        asked.push({
          provider: input.selection.provider,
          images: input.attachments?.length ?? 0,
          recognisedText: `${input.prompt}${input.conversation?.followUp ?? ""}`.includes("Esercizio 2. Determinare il dominio"),
        });
        if (input.selection.provider === LOCAL_PROVIDER) throw limited;
        return { ...reply, provider: "anthropic-api", model: "claude-sonnet-5-5" };
      },
    }).then(
      () => undefined,
      (failure: unknown) => failure,
    );
    db.close();
    return { asked, error };
  }

  it("does not hand a photo turn to the cloud tool when the local model fails: it gets no picture, no recognised text, and the turn ends with the local model's error", async () => {
    const { asked, error } = await localFails(true);
    // Only the local model was asked. It got what the chat's own tool may get: the text OCR read from the photo, and no
    // picture (it cannot read one). The cloud tool, which reads images, got nothing at all: not the photo, not the text.
    expect(asked).toEqual([{ provider: LOCAL_PROVIDER, images: 0, recognisedText: true }]);
    expect(error).toBeDefined();
  });

  it("still falls back to the cloud tool for a chat with no photo, as an automatic chat does", async () => {
    const { asked, error } = await localFails(false);
    expect(asked.map((call) => call.provider)).toEqual([LOCAL_PROVIDER, "anthropic-api"]);
    expect(error).toBeUndefined();
  });
});

describe("a photo with no usable copy for the model is read locally", () => {
  it("uses OCR when a model that reads images got no copy, instead of sending it neither pixels nor text", async () => {
    const { db, workspace, write, attached } = setup();
    db.prepare(`UPDATE feature_engines SET selection_json = ? WHERE feature = 'chat'`).run(JSON.stringify({ provider: "claude", model: "claude-sonnet-5-5" }));
    // A valid photo past the provider's size limit: it could not be fitted, so there is nothing for the model to see.
    const files = heldFilesFor(db, workspace, {
      fit: async () => {
        throw new Error("vision-image-too-large");
      },
    });
    const photo = write("grande.webp", "pixels di una foto troppo grande");
    let prompt = "";
    let images = -1;
    await askTurn(db, {
      text: "cosa c'è scritto",
      allowGeneral: true,
      attachments: (await files.attach(photo)).ids,
      held: files.held,
      workspace,
      recognize: async () => "Esercizio 2. Determinare il dominio",
      run: async (input) => {
        prompt = input.prompt;
        images = input.attachments?.length ?? 0;
        return reply;
      },
    });
    expect(images).toBe(0);
    expect(prompt).toContain("Esercizio 2. Determinare il dominio");
    void attached;
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
