import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase } from "../db/connection";
import type { EngineResult } from "../engine/funnel";
import { extractPlain } from "../sources/documents";
import { heldFilesFor } from "./test-attach";
import { askTurn, deleteChat, readChat, regenerateTurn } from "./turn";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const reply: EngineResult = { text: "Ecco la risposta.", model: "claude-sonnet-5", provider: "claude", inputTokens: 1 };
/** Messages are ordered by their millisecond; a real turn takes longer than one, a test turn may not. */
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));
const down = async (): Promise<EngineResult> => {
  throw new Error("engine-down");
};

function setup() {
  const workspace = mkdtempSync(join(tmpdir(), "pyxis-turn-recovery-"));
  dirs.push(workspace);
  const db = openDatabase(":memory:");
  db.prepare("INSERT INTO feature_engines (feature, selection_json, updated_at) VALUES ('default', ?, 1)").run(
    JSON.stringify({ provider: "claude", model: "claude-sonnet-5" }),
  );
  const file = (name: string, text: string) => {
    const path = join(workspace, name);
    writeFileSync(path, text);
    return path;
  };
  const count = (sql: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${sql}`).get() as { n: number }).n;
  const files = heldFilesFor(db, workspace);
  /** Attaches a file as the composer does, so a turn can send it and a retry can send the same one. */
  const attached = async (path: string) => ({ attachments: (await files.attach(path)).ids, held: files.held });
  return { workspace, db, file, count, attached };
}

describe("a failed or stopped first turn leaves no chat behind", () => {
  it("removes the chat and its message when the model call fails, keeps the attached file held, so a retry makes one chat and one source", async () => {
    const { workspace, db, file, count, attached } = setup();
    const sent = await attached(file("appunti.txt", "Il calore si trasmette per conduzione."));
    const turn = (run: typeof down) =>
      askTurn(db, { text: "spiega", allowGeneral: true, ...sent, workspace, run });
    await expect(turn(down)).rejects.toThrow("engine-down");
    // The file was read when it was attached and stays in the composer for the retry, so its source is kept.
    expect({ chats: count("chats"), messages: count("messages"), sources: count("sources") }).toEqual({
      chats: 0,
      messages: 0,
      sources: 1,
    });
    const result = await turn(async () => reply);
    expect(count("chats")).toBe(1);
    expect(count("sources")).toBe(1);
    expect(readChat(db, result.chatId).map((row) => row.role)).toEqual(["user", "assistant"]);
    db.close();
  });

  it("removes the chat when the student stops before any text arrives", async () => {
    const { db, count } = setup();
    const controller = new AbortController();
    await expect(
      askTurn(db, {
        text: "spiega",
        allowGeneral: true,
        signal: controller.signal,
        run: async () => {
          controller.abort();
          throw new DOMException("aborted", "AbortError");
        },
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(count("chats")).toBe(0);
    db.close();
  });

  it("keeps an existing chat and stores the retried document once", async () => {
    const { workspace, db, file, count, attached } = setup();
    const first = await askTurn(db, { text: "ciao", allowGeneral: true, run: async () => reply });
    await tick();
    const sent = await attached(file("appunti.txt", "Il calore si trasmette per conduzione."));
    const turn = (run: typeof down) =>
      askTurn(db, { chatId: first.chatId, text: "spiega", allowGeneral: true, ...sent, workspace, run });
    await expect(turn(down)).rejects.toThrow("engine-down");
    await tick();
    // The question and its document stay with the chat, so it can be answered later.
    expect(count("messages")).toBe(3);
    await turn(async () => reply);
    expect(count("sources")).toBe(1);
    expect(count("sources WHERE library = 0")).toBe(1);
    expect(readChat(db, first.chatId).map((row) => row.role)).toEqual(["user", "assistant", "user", "assistant"]);
    db.close();
  });
});

describe("a failed send keeps its files held, ready, for the retry", () => {
  const NOTE = "Il calore si trasmette per conduzione.";

  it("keeps a file the chat already held, instead of dropping the copy made for this send", async () => {
    const { workspace, db, file, count, attached } = setup();
    const first = await attached(file("appunti.txt", NOTE));
    const opened = await askTurn(db, { text: "ciao", allowGeneral: true, ...first, workspace, run: async () => reply });
    await tick();
    // The same file again, in the same chat: its text is already there, so the new copy is only a duplicate.
    const again = await attached(file("appunti-bis.txt", NOTE));
    const turn = (run: typeof down) =>
      askTurn(db, { chatId: opened.chatId, text: "spiega", allowGeneral: true, ...again, workspace, run });
    await expect(turn(down)).rejects.toThrow("engine-down");
    // The composer gets it back as a ready chip: core still knows it, and nothing is shown as failed.
    expect(first.held.list(again.attachments)).toEqual([expect.objectContaining({ name: "appunti-bis.txt", state: "ready" })]);
    await tick();
    await turn(async () => reply);
    // The retry sent it, the question lists it, and the chat holds one copy of the text, not two.
    expect(first.held.list(again.attachments)).toEqual([]);
    expect(count("sources WHERE library = 0")).toBe(1);
    expect(readChat(db, opened.chatId).filter((row) => row.role === "user").at(-1)!.files).toEqual([
      expect.objectContaining({ name: "appunti-bis.txt", kind: "document" }),
    ]);
    db.close();
  });

  it("keeps a file that could not be read held and failed, and names it once the send goes through", async () => {
    const { workspace, db, file } = setup();
    const files = heldFilesFor(db, workspace, {
      extract: async ({ path }) => {
        if (readFileSync(path, "utf8").includes("rotto")) throw new Error("pdf-password-required");
        return { document: extractPlain(NOTE, false) };
      },
    });
    const ok = await files.held.attach(file("buono.txt", "buono"));
    const bad = await files.held.attach(file("chiuso.pdf", "rotto"));
    await files.held.settle([ok.id, bad.id]);
    const sent = { attachments: [ok.id, bad.id], held: files.held };
    await expect(askTurn(db, { text: "spiega", allowGeneral: true, ...sent, workspace, run: down })).rejects.toThrow("engine-down");
    expect(files.held.list([ok.id, bad.id]).map((view) => [view.name, view.state])).toEqual([
      ["buono.txt", "ready"],
      ["chiuso.pdf", "failed"],
    ]);
    const result = await askTurn(db, { text: "spiega", allowGeneral: true, ...sent, workspace, run: async () => reply });
    expect(result.leftOut).toEqual([{ name: "chiuso.pdf", error: "password" }]);
    expect(files.held.list([ok.id, bad.id])).toEqual([]);
    db.close();
  });
});

describe("taking off a chip that came back after a failed send", () => {
  it("keeps the document the stored question already names, so the question still opens it and Try again still has it", async () => {
    const { workspace, db, file, attached } = setup();
    const opened = await askTurn(db, { text: "ciao", allowGeneral: true, run: async () => reply });
    await tick();
    const sent = await attached(file("appunti.txt", "Il calore si trasmette per conduzione."));
    await expect(
      askTurn(db, { chatId: opened.chatId, text: "spiega gli appunti", allowGeneral: true, ...sent, workspace, run: down }),
    ).rejects.toThrow("engine-down");
    await tick();
    // The question and its document are stored. The student removes the chip that came back to the composer.
    sent.held.detach(sent.attachments[0]!);
    const question = readChat(db, opened.chatId).filter((row) => row.role === "user").at(-1)!;
    expect(question.files).toEqual([expect.objectContaining({ name: "appunti.txt", sourceId: expect.any(String) })]);
    expect(db.prepare(`SELECT COUNT(*) FROM passages WHERE source_id = ?`).pluck().get(question.files![0]!.sourceId)).toBeGreaterThan(0);
    let prompt = "";
    await regenerateTurn(db, {
      chatId: opened.chatId,
      allowGeneral: true,
      workspace,
      run: async (input) => {
        prompt = input.prompt;
        return reply;
      },
    });
    expect(prompt).toContain("Il calore si trasmette per conduzione.");
    db.close();
  });
});

describe("the earlier turns sent to the model", () => {
  const earlier = (prompt: string) => prompt.slice(prompt.indexOf("Earlier turns:"), prompt.lastIndexOf("Question:"));

  it("leave out check blocks, follow-up suggestions and the question being asked", async () => {
    const { db } = setup();
    const first = await askTurn(db, {
      text: "deriva x al quadrato",
      allowGeneral: true,
      way: "guided",
      run: async () => ({
        ...reply,
        text: 'La derivata è 2x.\n\n```check\n{"kind":"derivative","expr":"x^2","claimed":"2x"}\n```\n<followups>\nE x al cubo?\n</followups>',
      }),
    });
    await tick();
    let prompt = "";
    await askTurn(db, {
      chatId: first.chatId,
      text: "e la seconda derivata?",
      allowGeneral: true,
      way: "guided",
      run: async (input) => {
        prompt = input.prompt;
        return reply;
      },
    });
    const history = earlier(prompt);
    expect(history).toContain("La derivata è 2x.");
    expect(history).not.toContain("```check");
    expect(history).not.toContain("followups");
    expect(history).not.toContain("E x al cubo?");
    expect(prompt.split("e la seconda derivata?")).toHaveLength(2);
    db.close();
  });

  it("does not repeat the question on a regeneration", async () => {
    const { db } = setup();
    const first = await askTurn(db, { text: "domanda unica", allowGeneral: true, run: async () => reply });
    let prompt = "";
    await regenerateTurn(db, {
      chatId: first.chatId,
      allowGeneral: true,
      run: async (input) => {
        prompt = input.prompt;
        return reply;
      },
    });
    expect(prompt.split("domanda unica")).toHaveLength(2);
    db.close();
  });

  it("keep whole turns and drop the oldest ones that do not fit", async () => {
    const { db } = setup();
    const long = `${"a".repeat(4000)}FINE-A`;
    const first = await askTurn(db, { text: "prima", allowGeneral: true, run: async () => ({ ...reply, text: long }) });
    await tick();
    await askTurn(db, {
      chatId: first.chatId,
      text: "seconda",
      allowGeneral: true,
      run: async () => ({ ...reply, text: `INIZIO-B${"b".repeat(3000)}` }),
    });
    await tick();
    let prompt = "";
    await askTurn(db, {
      chatId: first.chatId,
      text: "terza",
      allowGeneral: true,
      run: async (input) => {
        prompt = input.prompt;
        return reply;
      },
    });
    const history = earlier(prompt);
    expect(history).toContain("INIZIO-B");
    // The 4,000-character answer no longer fits, so none of it is sent, rather than its tail.
    expect(history).not.toContain("FINE-A");
    expect(history).not.toContain("aaaa");
    db.close();
  });
});

describe("follow-up suggestions", () => {
  it("are read even when the closing tag is missing", async () => {
    const { db } = setup();
    const result = await askTurn(db, {
      text: "spiega",
      allowGeneral: true,
      way: "guided",
      run: async () => ({ ...reply, text: "Il corpo.\n<followups>\nUno?\nDue?" }),
    });
    expect(result.message?.body).toBe("Il corpo.");
    expect(result.message?.followups).toEqual(["Uno?", "Due?"]);
    expect(readChat(db, result.chatId).at(-1)).toMatchObject({ body: "Il corpo.", followups: ["Uno?", "Due?"] });
    db.close();
  });

  it("never end up in the text of a reply stopped while they were streaming", async () => {
    const { db } = setup();
    const result = await askTurn(db, {
      text: "spiega",
      allowGeneral: true,
      run: async (input) => {
        input.onDelta?.("Il corpo.\n<followups>\nUno");
        throw new DOMException("aborted", "AbortError");
      },
    });
    expect(result.message?.stopped).toBe(true);
    expect(readChat(db, result.chatId).at(-1)?.body).toBe("Il corpo.");
    db.close();
  });
});

describe("a chat deleted while its reply is written", () => {
  it("ends the turn as cancelled instead of failing on the missing chat", async () => {
    const { workspace, db, count } = setup();
    const first = await askTurn(db, { text: "ciao", allowGeneral: true, run: async () => reply });
    await expect(
      askTurn(db, {
        chatId: first.chatId,
        text: "spiega",
        allowGeneral: true,
        workspace,
        run: async () => {
          deleteChat(db, workspace, first.chatId);
          return reply;
        },
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(count("messages")).toBe(0);
    db.close();
  });

  it("does the same when the student stops after some text", async () => {
    const { workspace, db, count } = setup();
    const first = await askTurn(db, { text: "ciao", allowGeneral: true, run: async () => reply });
    await expect(
      askTurn(db, {
        chatId: first.chatId,
        text: "spiega",
        allowGeneral: true,
        workspace,
        run: async (input) => {
          input.onDelta?.("Parte della risposta");
          deleteChat(db, workspace, first.chatId);
          throw new DOMException("aborted", "AbortError");
        },
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(count("messages")).toBe(0);
    db.close();
  });
});

describe("a document attached to this turn", () => {
  it("is in the prompt even when the question shares no words with it", async () => {
    const { workspace, db, file, attached } = setup();
    let prompt = "";
    await askTurn(db, {
      text: "riassumi questo file",
      ...(await attached(file("appunti.txt", "Il calore si trasmette per conduzione."))),
      workspace,
      run: async (input) => {
        prompt = input.prompt;
        return reply;
      },
    });
    expect(prompt).toContain("Il calore si trasmette per conduzione.");
    expect(prompt).not.toContain("No passage matches");
    db.close();
  });
});

describe("an unanswered question", () => {
  it("is answered by a retry without being stored twice", async () => {
    const { db } = setup();
    const first = await askTurn(db, { text: "ciao", allowGeneral: true, run: async () => reply });
    await tick();
    await expect(askTurn(db, { chatId: first.chatId, text: "spiega", allowGeneral: true, run: down })).rejects.toThrow(
      "engine-down",
    );
    await tick();
    const retried = await regenerateTurn(db, { chatId: first.chatId, allowGeneral: true, run: async () => reply });
    expect(retried.message?.body).toBe("Ecco la risposta.");
    expect(readChat(db, first.chatId).map((row) => `${row.role}:${row.body}`)).toEqual([
      "user:ciao",
      "assistant:Ecco la risposta.",
      "user:spiega",
      "assistant:Ecco la risposta.",
    ]);
    db.close();
  });
});
