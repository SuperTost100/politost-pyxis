import { afterEach, describe, expect, it } from "vitest";
import { openDatabase } from "../db/connection";
import type { EngineResult, TurnInput } from "../engine/funnel";
import { askTurn, deleteChat, readChat, regenerateTurn } from "../chat/turn";
import { undoToolResult } from "./results";
import { toolBlockIds } from "../../shared/tool-blocks";
import { chatToolList } from "./registry";
import { chatTools, setTools, stopToolServer } from "./server";
import { markToolsRefused } from "../engine/funnel";

afterEach(async () => {
  await stopToolServer();
});

function setup() {
  const db = openDatabase(":memory:");
  db.prepare("INSERT INTO feature_engines (feature, selection_json, updated_at) VALUES ('default', ?, 1)").run(
    JSON.stringify({ provider: "claude", model: "claude-sonnet-5" }),
  );
  db.prepare("INSERT INTO subjects (id, name, created_at) VALUES ('phys', 'Fisica 1', 1)").run();
  setTools(chatToolList(db));
  return db;
}

const callTool = (tools: NonNullable<TurnInput["tools"]>, name: string, args: unknown) =>
  fetch(tools.url, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${tools.token}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  }).then((response) => response.json() as Promise<{ result: { content: Array<{ text: string }>; isError?: boolean } }>);

/** The server's address, which every chat shares. */
const chatToolsUrl = async () => (await chatTools("any-chat")).url;

const cards = [
  { front: "Che cosa dice il primo principio?", back: "Un corpo con risultante nulla mantiene il suo stato di moto." },
  { front: "Scrivi il secondo principio.", back: "$\\vec F = m\\vec a$" },
];

describe("a chat turn with tools", () => {
  it("places the result where the model called the tool, stores it with the reply and tells the next turn", async () => {
    const db = setup();
    let seen: TurnInput["tools"];
    const streamed: string[] = [];
    const views: string[] = [];
    const first = await askTurn(db, {
      text: "Fammi 2 flashcard sui principi.",
      subject: "Fisica 1",
      onDelta: (text) => streamed.push(text),
      onTool: (view) => views.push(view.id),
      run: async (input): Promise<EngineResult> => {
        seen = input.tools;
        input.onDelta?.("Ecco le flashcard.");
        input.tools!.onTool?.({ phase: "start", id: "call-1", tool: "create_flashcards" });
        const answer = await callTool(input.tools!, "create_flashcards", { cards, title: "sui principi" });
        expect(answer.result.isError).toBeUndefined();
        input.tools!.onTool?.({ phase: "end", id: "call-1", tool: "create_flashcards" });
        input.onDelta?.("Ecco le flashcard.Le trovi nel mazzo.");
        // A CLI's final text can be only what it wrote after the call.
        return { text: "Le trovi nel mazzo.", model: "claude-sonnet-5", provider: "claude", inputTokens: 1 };
      },
    });
    expect(seen?.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
    // While the tool ran, the reply showed its working state where the call was made.
    expect(streamed).toContain("Ecco le flashcard.\n\n```pyxis-tool\npending:create_flashcards\n```");
    const message = first.message!;
    const [resultId] = toolBlockIds(message.body);
    expect(views).toEqual([resultId]);
    expect(message.body).toBe(`Ecco le flashcard.\n\n\`\`\`pyxis-tool\n${resultId}\n\`\`\`\n\nLe trovi nel mazzo.`);
    expect(message.tools?.[resultId!]).toMatchObject({ count: 2, title: "sui principi", deck: "Fisica 1", undone: null });
    // Read again, as after a restart, the reply carries its result.
    const stored = readChat(db, first.chatId).find((row) => row.role === "assistant")!;
    expect(stored.tools?.[resultId!]).toMatchObject({ count: 2 });
    expect(db.prepare("SELECT message_id FROM chat_tool_results").pluck().get()).toBe(message.id);

    // Between turns the token acts on nothing.
    const late = await callTool(seen!, "create_flashcards", { cards: [{ front: "Altro?", back: "No." }] });
    expect(late.result.isError).toBe(true);
    expect(db.prepare("SELECT COUNT(*) FROM cards").pluck().get()).toBe(2);

    // A new session gets the conversation with what the tool did, in place of the block.
    let prompt = "";
    await askTurn(db, {
      chatId: first.chatId,
      text: "Grazie.",
      run: async (input) => {
        prompt = input.prompt;
        return { text: "Prego.", model: "claude-sonnet-5", provider: "claude", inputTokens: 1 };
      },
    });
    expect(prompt).toContain(
      "Ecco le flashcard.\n\n[Pyxis tool create_flashcards: created 2 flashcards (sui principi) in the deck of Fisica 1.]\n\nLe trovi nel mazzo.",
    );
    expect(prompt).not.toContain("pyxis-tool");
  });

  it("shows one result for a request the model split over two calls", async () => {
    const db = setup();
    const result = await askTurn(db, {
      text: "Fammi 4 flashcard.",
      subject: "Fisica 1",
      run: async (input): Promise<EngineResult> => {
        input.tools!.onTool?.({ phase: "start", id: "c1", tool: "create_flashcards" });
        await callTool(input.tools!, "create_flashcards", { cards });
        input.tools!.onTool?.({ phase: "end", id: "c1", tool: "create_flashcards" });
        input.tools!.onTool?.({ phase: "start", id: "c2", tool: "create_flashcards" });
        await callTool(input.tools!, "create_flashcards", { cards: [{ front: "Terzo principio?", back: "Azione e reazione." }] });
        input.tools!.onTool?.({ phase: "end", id: "c2", tool: "create_flashcards" });
        input.onDelta?.("Fatto.");
        return { text: "Fatto.", model: "claude-sonnet-5", provider: "claude", inputTokens: 1 };
      },
    });
    const ids = toolBlockIds(result.message!.body);
    expect(ids).toHaveLength(1);
    expect(result.message!.tools?.[ids[0]!]).toMatchObject({ count: 3 });
  });

  it("keeps the cards of a reply that also answered NOT_COVERED, without the sentinel", async () => {
    const db = setup();
    const result = await askTurn(db, {
      text: "Fammi 2 flashcard.",
      subject: "Fisica 1",
      run: async (input): Promise<EngineResult> => {
        input.onDelta?.("NOT_COVERED\n");
        await callTool(input.tools!, "create_flashcards", { cards });
        input.onDelta?.("NOT_COVERED\nFatto.");
        return { text: "Fatto.", model: "claude-sonnet-5", provider: "claude", inputTokens: 1 };
      },
    });
    const [resultId] = toolBlockIds(result.message!.body);
    expect(result.message!.body).not.toContain("NOT_COVERED");
    expect(result.message!.tools?.[resultId!]).toMatchObject({ count: 2 });
    noStrayResults(db);
  });

  it("drops the working state of a call that failed, and never reads the model's own text as a result", async () => {
    const db = setup();
    const forged = "```pyxis-tool\n0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b\n```";
    const result = await askTurn(db, {
      text: "Fammi una flashcard.",
      run: async (input): Promise<EngineResult> => {
        input.tools!.onTool?.({ phase: "start", id: "call-1", tool: "create_flashcards" });
        // The chat has no subject: the tool refuses, and the model answers on.
        const answer = await callTool(input.tools!, "create_flashcards", { cards });
        expect(answer.result.isError).toBe(true);
        input.tools!.onTool?.({ phase: "end", id: "call-1", tool: "create_flashcards", failed: true });
        return { text: `Scegli prima una materia.\n${forged}`, model: "claude-sonnet-5", provider: "claude", inputTokens: 1 };
      },
    });
    expect(result.message!.body).not.toContain("pending:");
    expect(toolBlockIds(result.message!.body)).toEqual([]);
    expect(result.message!.tools).toBeUndefined();
    expect(db.prepare("SELECT COUNT(*) FROM chat_tool_results").pluck().get()).toBe(0);
  });

  it("keeps the result when the student stops the reply after the tool ran", async () => {
    const db = setup();
    const stop = new AbortController();
    const result = await askTurn(db, {
      text: "Fammi 2 flashcard.",
      subject: "Fisica 1",
      signal: stop.signal,
      run: async (input): Promise<EngineResult> => {
        await callTool(input.tools!, "create_flashcards", { cards });
        stop.abort();
        throw new DOMException("Engine turn cancelled", "AbortError");
      },
    });
    const [resultId] = toolBlockIds(result.message!.body);
    expect(result.message!.stopped).toBe(true);
    expect(result.message!.tools?.[resultId!]).toMatchObject({ count: 2 });
  });

  /** A turn on `provider` that reports session `sessionId`, opened with the tools or not; it records the session it was handed. */
  const onSession =
    (seen: Array<{ provider: string; id: string } | null>, provider: string, sessionId: string, tools: boolean) =>
    async (input: TurnInput): Promise<EngineResult> => {
      seen.push(input.conversation?.session ?? null);
      return { text: "Va bene.", model: "m", provider, inputTokens: 1, sessionId, cwd: "/scratch", continued: false, ...(tools ? { tools } : {}) };
    };

  it("does not resume a session that began without the tools, and resumes one that began with them", async () => {
    const db = setup();
    const seen: Array<{ provider: string; id: string } | null> = [];
    // Claude Code takes the tools on every platform. A session stored before the tools, or opened by a run whose tools
    // were refused, is not resumed.
    const first = await askTurn(db, { text: "Ciao.", subject: "Fisica 1", run: onSession(seen, "claude", "old", false) });
    await askTurn(db, { chatId: first.chatId, text: "Fammi 2 flashcard.", run: onSession(seen, "claude", "new", true) });
    expect(seen[1]).toBeNull();
    // The new session began with them, so the next turn resumes it.
    await askTurn(db, { chatId: first.chatId, text: "Grazie.", run: onSession(seen, "claude", "new", true) });
    expect(seen[2]).toMatchObject({ provider: "claude", id: "new" });
  });

  it.each([
    ["linux", null],
    ["darwin", null],
    ["win32", "old"],
  ] as const)("on %s, a stored Antigravity session that began without the tools resumes only where they do not attach", async (platform, resumed) => {
    const real = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { ...real, value: platform });
    try {
      const db = setup();
      const seen: Array<{ provider: string; id: string } | null> = [];
      const first = await askTurn(db, { text: "Ciao.", subject: "Fisica 1", run: onSession(seen, "antigravity", "old", false) });
      await askTurn(db, { chatId: first.chatId, text: "Fammi 2 flashcard.", run: onSession(seen, "antigravity", "new", false) });
      expect(seen[1]?.id ?? null).toBe(resumed);
    } finally {
      Object.defineProperty(process, "platform", real);
    }
  });
});

/** A reply on Claude that calls create_flashcards with `made`, or none, and says `text`. */
function replying(text: string, made?: typeof cards) {
  return async (input: TurnInput): Promise<EngineResult> => {
    if (made) {
      const answer = await callTool(input.tools!, "create_flashcards", { cards: made });
      expect(answer.result.isError).toBeUndefined();
    }
    input.onDelta?.(text);
    return { text, model: "claude-sonnet-5", provider: "claude", inputTokens: 1 };
  };
}

const removed = (db: ReturnType<typeof setup>) =>
  db.prepare("SELECT front, removed FROM cards ORDER BY rowid").all() as Array<{ front: string; removed: number }>;

/** No result points at a message that is gone, and none is left without a reply. */
function noStrayResults(db: ReturnType<typeof setup>) {
  expect(
    db
      .prepare(
        `SELECT COUNT(*) FROM chat_tool_results r
         WHERE r.message_id IS NULL OR NOT EXISTS (SELECT 1 FROM messages m WHERE m.id = r.message_id AND m.chat_id = r.chat_id)`,
      )
      .pluck()
      .get(),
  ).toBe(0);
}

describe("regenerating a reply that created cards", () => {
  async function firstReply(db: ReturnType<typeof setup>) {
    const first = await askTurn(db, { text: "Fammi 2 flashcard.", subject: "Fisica 1", run: replying("Fatto.", cards) });
    const [resultId] = toolBlockIds(first.message!.body);
    return { chatId: first.chatId, resultId: resultId!, replyId: first.message!.id };
  }

  it("takes the old cards out before the new answer runs, so the same cards are new again", async () => {
    const db = setup();
    const { chatId, resultId } = await firstReply(db);
    const again = await regenerateTurn(db, { chatId, run: replying("Eccole di nuovo.", cards) });
    const [newId] = toolBlockIds(again.message!.body);
    expect(newId).not.toBe(resultId);
    expect(again.message!.tools?.[newId!]).toMatchObject({ count: 2, duplicates: 0, undone: null });
    expect(toolBlockIds(again.message!.body)).toEqual([newId]);
    // The old cards stay out of the deck, with their reviews; only the new ones are in it.
    expect(removed(db).map((card) => card.removed)).toEqual([1, 1, 0, 0]);
    noStrayResults(db);
  });

  it("shows the undone line above a new answer that creates none, with Ripristina still working", async () => {
    const db = setup();
    const { chatId, resultId } = await firstReply(db);
    const again = await regenerateTurn(db, { chatId, run: replying("Ecco una spiegazione senza flashcard.") });
    expect(again.message!.body).toBe(`\`\`\`pyxis-tool\n${resultId}\n\`\`\`\n\nEcco una spiegazione senza flashcard.`);
    expect(again.message!.tools?.[resultId]).toMatchObject({ count: 2, undone: 2 });
    expect(readChat(db, chatId).at(-1)!.tools?.[resultId]).toMatchObject({ undone: 2 });
    expect(removed(db).map((card) => card.removed)).toEqual([1, 1]);
    noStrayResults(db);
  });

  it("keeps an earlier Annulla: the line moves to the new answer, and nothing comes back", async () => {
    const db = setup();
    const { chatId, resultId } = await firstReply(db);
    undoToolResult(db, chatId, resultId);
    const again = await regenerateTurn(db, { chatId, run: replying("Senza flashcard.") });
    expect(again.message!.tools?.[resultId]).toMatchObject({ undone: 2 });
    expect(removed(db).map((card) => card.removed)).toEqual([1, 1]);
    noStrayResults(db);
  });

  it("puts the old cards back when the new answer is stopped while its tool runs, and drops the new ones", async () => {
    const db = setup();
    const { chatId, resultId, replyId } = await firstReply(db);
    const stop = new AbortController();
    await expect(
      regenerateTurn(db, {
        chatId,
        signal: stop.signal,
        run: async (input) => {
          const call = callTool(input.tools!, "create_flashcards", { cards: [{ front: "Terzo principio?", back: "Azione e reazione." }] });
          stop.abort();
          await call;
          throw new DOMException("Engine turn cancelled", "AbortError");
        },
      }),
    ).rejects.toThrow();
    const last = readChat(db, chatId).at(-1)!;
    expect(last.id).toBe(replyId);
    expect(last.tools?.[resultId]).toMatchObject({ count: 2, undone: null });
    expect(removed(db)).toEqual([
      { front: cards[0]!.front, removed: 0 },
      { front: cards[1]!.front, removed: 0 },
      { front: "Terzo principio?", removed: 1 },
    ]);
    noStrayResults(db);
  });

  it("puts the old cards back when the new answer is stopped right after the tool showed it was at work", async () => {
    const db = setup();
    const { chatId, resultId, replyId } = await firstReply(db);
    const stop = new AbortController();
    const shown: string[] = [];
    await expect(
      regenerateTurn(db, {
        chatId,
        signal: stop.signal,
        onDelta: (text) => shown.push(text),
        run: async (input) => {
          input.tools!.onTool?.({ phase: "start", id: "c1", tool: "create_flashcards" });
          stop.abort();
          throw new DOMException("Engine turn cancelled", "AbortError");
        },
      }),
    ).rejects.toThrow();
    expect(shown.at(-1)).toContain("pending:create_flashcards");
    const last = readChat(db, chatId).at(-1)!;
    expect(last.id).toBe(replyId);
    expect(last.body).not.toContain("pending:");
    expect(last.tools?.[resultId]).toMatchObject({ undone: null });
    expect(removed(db).map((card) => card.removed)).toEqual([0, 0]);
    noStrayResults(db);
  });

  it("puts the old cards back when the new answer is stopped halfway through its text", async () => {
    const db = setup();
    const { chatId, resultId } = await firstReply(db);
    const stop = new AbortController();
    await expect(
      regenerateTurn(db, {
        chatId,
        signal: stop.signal,
        run: async (input) => {
          await callTool(input.tools!, "create_flashcards", { cards });
          input.onDelta?.("Ecco le flash");
          stop.abort();
          throw new DOMException("Engine turn cancelled", "AbortError");
        },
      }),
    ).rejects.toThrow();
    expect(readChat(db, chatId).at(-1)!.tools?.[resultId]).toMatchObject({ undone: null });
    // The old cards are back; the copies the stopped answer made are out of the deck again.
    expect(removed(db).map((card) => card.removed)).toEqual([0, 0, 1, 1]);
    noStrayResults(db);
  });

  it("puts the old cards back when the new answer fails, and leaves an undone result undone", async () => {
    const db = setup();
    const { chatId, resultId } = await firstReply(db);
    const fail = async (): Promise<EngineResult> => {
      throw new Error("engine-down");
    };
    await expect(regenerateTurn(db, { chatId, run: fail })).rejects.toThrow();
    expect(removed(db).map((card) => card.removed)).toEqual([0, 0]);
    undoToolResult(db, chatId, resultId);
    await expect(regenerateTurn(db, { chatId, run: fail })).rejects.toThrow();
    expect(readChat(db, chatId).at(-1)!.tools?.[resultId]).toMatchObject({ undone: 2 });
    expect(removed(db).map((card) => card.removed)).toEqual([1, 1]);
    noStrayResults(db);
  });

  it("deletes a chat's results with the chat and keeps the cards", async () => {
    const db = setup();
    const { chatId } = await firstReply(db);
    deleteChat(db, "", chatId);
    expect(db.prepare("SELECT COUNT(*) FROM chat_tool_results").pluck().get()).toBe(0);
    expect(removed(db).map((card) => card.removed)).toEqual([0, 0]);
  });
});

describe("a tool that refuses Pyxis's server", () => {
  it("resumes its session on the next question instead of starting a new one", async () => {
    const db = setup();
    const seen: Array<{ provider: string; id: string } | null> = [];
    // What runTurn does when Codex refuses the server: it notes the refusal and answers without the tools.
    const refusing = async (input: TurnInput): Promise<EngineResult> => {
      seen.push(input.conversation?.session ?? null);
      markToolsRefused("codex");
      return { text: "Va bene.", model: "gpt-6.1-terra", provider: "codex", inputTokens: 1, sessionId: "x1", cwd: "/scratch", continued: Boolean(input.conversation?.session) };
    };
    const first = await askTurn(db, { text: "Ciao.", run: refusing });
    await askTurn(db, { chatId: first.chatId, text: "E poi?", run: refusing });
    expect(seen).toEqual([null, expect.objectContaining({ provider: "codex", id: "x1" })]);
  });
});

describe("the token of a chat tried on Antigravity", () => {
  it("stops working when the turn ends even if another tool answered after Antigravity", async () => {
    const db = setup();
    db.prepare("UPDATE feature_engines SET selection_json = ?").run(JSON.stringify({ provider: "antigravity", model: "gemini-3.8-flash" }));
    const tokens: string[] = [];
    // The turn was planned on Antigravity, whose attempt saw the token, and Claude answered in its place.
    const answer = async (input: TurnInput): Promise<EngineResult> => {
      tokens.push(input.tools!.token);
      return { text: "Va bene.", model: "claude-sonnet-5", provider: "claude", inputTokens: 1 };
    };
    const first = await askTurn(db, { text: "Ciao.", run: answer });
    await askTurn(db, { chatId: first.chatId, text: "Ancora.", run: answer });
    expect(tokens[1]).not.toBe(tokens[0]);
  });
});

describe("the token of a chat answered on Antigravity", () => {
  it("stops working when the turn ends, since agy keeps the header in its conversation store; on Claude it stays", async () => {
    const db = setup();
    const tokens: string[] = [];
    const answer = (provider: string) => async (input: TurnInput): Promise<EngineResult> => {
      tokens.push(input.tools!.token);
      return { text: "Va bene.", model: "m", provider, inputTokens: 1 };
    };
    const first = await askTurn(db, { text: "Ciao.", run: answer("claude") });
    await askTurn(db, { chatId: first.chatId, text: "Ancora.", run: answer("claude") });
    expect(tokens[1]).toBe(tokens[0]);
    db.prepare("UPDATE feature_engines SET selection_json = ?").run(JSON.stringify({ provider: "antigravity", model: "gemini-3.8-flash" }));
    await askTurn(db, { chatId: first.chatId, text: "E con Gemini?", run: answer("antigravity") });
    const ping = await fetch(new URL("/mcp", "http://" + new URL((await chatToolsUrl())).host), {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${tokens[2]}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
    });
    expect(ping.status).toBe(401);
    await askTurn(db, { chatId: first.chatId, text: "Di nuovo.", run: answer("antigravity") });
    expect(tokens[3]).not.toBe(tokens[2]);
  });
});
