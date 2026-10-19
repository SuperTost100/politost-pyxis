import { describe, expect, it } from "vitest";
import { strToU8, zipSync } from "fflate";
import { openDatabase } from "../db/connection";
import type { EngineResult } from "../engine/funnel";
import { importSmartbook } from "../sources/smartbook";
import { askTurn, readChat, regenerateTurn } from "./turn";

const reply: EngineResult = {
  text: "Il vettore descrive il punto [P1].",
  model: "claude-sonnet-5",
  provider: "claude",
  inputTokens: 12,
};

function setup() {
  const db = openDatabase(":memory:");
  db.prepare(
    "INSERT INTO feature_engines (feature, selection_json, updated_at) VALUES ('default', ?, 1)",
  ).run(JSON.stringify({ provider: "claude", model: "claude-sonnet-5" }));
  const book = zipSync({
    "smartbook.json": strToU8(
      JSON.stringify({
        id: "vectors",
        title: "Vectors",
        access: "public",
        chapters: [{ id: "c1", number: 1, title: "Vettori", file: "01.md" }],
      }),
    ),
    "chapters/01.md": strToU8("## p1 | Posizione\nIl vettore posizione descrive il punto.\n"),
  });
  const { sourceId } = importSmartbook(db, book);
  return { db, sourceId };
}

/** An engine call that waits until the test lets it answer. */
function held() {
  let answer: (result: EngineResult) => void = () => undefined;
  let fail: (err: unknown) => void = () => undefined;
  let begin: () => void = () => undefined;
  const started = new Promise<void>((ready) => {
    begin = ready;
  });
  const run = (): Promise<EngineResult> => {
    begin();
    return new Promise<EngineResult>((resolve, reject) => {
      answer = resolve;
      fail = reject;
    });
  };
  return { run, started, answer: (result = reply) => answer(result), fail: (err: unknown) => fail(err) };
}

describe("a chat that is still generating", () => {
  it("refuses a second question by name and stores nothing for it", async () => {
    const { db, sourceId } = setup();
    const first = await askTurn(db, { text: "Che cos'è il vettore?", sourceIds: [sourceId], run: async () => reply });
    const slow = held();
    const running = askTurn(db, { chatId: first.chatId, text: "E lo spostamento?", sourceIds: [sourceId], run: slow.run });
    await slow.started;

    await expect(
      askTurn(db, { chatId: first.chatId, text: "Una terza domanda", run: async () => reply }),
    ).rejects.toMatchObject({ code: "chat-busy", messageKey: "errors.chatBusy" });
    await expect(regenerateTurn(db, { chatId: first.chatId, run: async () => reply })).rejects.toMatchObject({
      code: "chat-busy",
    });

    slow.answer();
    await running;
    expect(readChat(db, first.chatId).map((row) => row.body)).toEqual([
      "Che cos'è il vettore?",
      expect.any(String),
      "E lo spostamento?",
      expect.any(String),
    ]);
  });

  it("takes the next question once the reply is saved, or once it failed", async () => {
    const { db, sourceId } = setup();
    const first = await askTurn(db, { text: "Che cos'è il vettore?", sourceIds: [sourceId], run: async () => reply });
    const failing = held();
    const running = askTurn(db, { chatId: first.chatId, text: "E lo spostamento?", run: failing.run });
    await failing.started;
    failing.fail(new Error("engine down"));
    await expect(running).rejects.toThrow("engine down");

    await expect(regenerateTurn(db, { chatId: first.chatId, run: async () => reply })).resolves.toMatchObject({
      chatId: first.chatId,
    });
    await expect(
      askTurn(db, { chatId: first.chatId, text: "Ancora una", run: async () => reply }),
    ).resolves.toMatchObject({ chatId: first.chatId });
  });

  it("leaves other chats free to ask", async () => {
    const { db, sourceId } = setup();
    const first = await askTurn(db, { text: "Che cos'è il vettore?", sourceIds: [sourceId], run: async () => reply });
    const slow = held();
    const running = askTurn(db, { chatId: first.chatId, text: "E lo spostamento?", run: slow.run });
    await slow.started;
    const other = await askTurn(db, { text: "Un'altra chat", run: async () => reply });
    expect(other.chatId).not.toBe(first.chatId);
    slow.answer();
    await running;
  });
});

describe("a chat turn's passages", () => {
  it("are reported before the reply streams, with the numbers the reply cites", async () => {
    const { db, sourceId } = setup();
    const order: string[] = [];
    let passages: Array<{ index: number; label: string }> = [];
    await askTurn(db, {
      text: "Che cos'è il vettore posizione?",
      sourceIds: [sourceId],
      onPassages: (list) => {
        order.push("passages");
        passages = list;
      },
      onDelta: () => order.push("delta"),
      run: async (input) => {
        input.onDelta?.("Il vettore [P1]");
        return reply;
      },
    });
    expect(order).toEqual(["passages", "delta"]);
    expect(passages).toEqual([{ index: 1, label: expect.any(String) }]);
  });
});
