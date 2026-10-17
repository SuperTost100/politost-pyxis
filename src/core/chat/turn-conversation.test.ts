import { describe, expect, it, vi } from "vitest";
import { strToU8, zipSync } from "fflate";
import { openDatabase } from "../db/connection";
import type { EngineResult } from "../engine/funnel";
import { importSmartbook } from "../sources/smartbook";
import { clearBench } from "../engine/bench";
import { rememberReady } from "../engine/selection";
import { askTurn, readChat, regenerateTurn } from "./turn";

const ended = vi.hoisted(() => [] as string[]);
vi.mock("../engine/funnel", async (original) => {
  const actual = await original<typeof import("../engine/funnel")>();
  return {
    ...actual,
    endConversation: (key: string) => {
      ended.push(key);
      actual.endConversation(key);
    },
  };
});

const reply: EngineResult = {
  text: "Il vettore descrive il punto [P1].",
  model: "claude-sonnet-5",
  provider: "claude",
  inputTokens: 12,
};

type Seen = {
  prompt: string;
  conversation?: { key: string; followUp: string };
  cache?: boolean;
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
    "chapters/01.md": strToU8(
      "## p1 | Posizione\nIl vettore posizione descrive il punto.\n",
    ),
  });
  const { sourceId } = importSmartbook(db, book);
  return { db, sourceId };
}

describe("a chat turn's prompt", () => {
  it("puts the earlier turns before this question's passages and the question last", async () => {
    const { db, sourceId } = setup();
    const first = await askTurn(db, {
      text: "Che cos'è il vettore posizione?",
      sourceIds: [sourceId],
      run: async () => reply,
    });
    let seen: Seen | undefined;
    await askTurn(db, {
      chatId: first.chatId,
      text: "E il vettore spostamento?",
      run: async (input) => {
        seen = input;
        return reply;
      },
    });
    const prompt = seen!.prompt;
    const history = prompt.indexOf("Earlier turns:");
    const passages = prompt.indexOf("[P1]");
    const question = prompt.lastIndexOf("Question:\nE il vettore spostamento?");
    expect(history).toBeGreaterThanOrEqual(0);
    expect(passages).toBeGreaterThan(history);
    expect(question).toBeGreaterThan(passages);
    db.close();
  });

  it("offers the engine a follow-up with only the new question and its passages, cached", async () => {
    const { db, sourceId } = setup();
    const first = await askTurn(db, {
      text: "Che cos'è il vettore posizione?",
      sourceIds: [sourceId],
      run: async () => reply,
    });
    let seen: Seen | undefined;
    await askTurn(db, {
      chatId: first.chatId,
      text: "E il vettore spostamento?",
      run: async (input) => {
        seen = input;
        return reply;
      },
    });
    expect(seen!.cache).toBe(true);
    expect(seen!.conversation?.key).toBe(first.chatId);
    const followUp = seen!.conversation!.followUp;
    expect(followUp).not.toContain("Earlier turns:");
    expect(followUp).not.toContain("Che cos'è il vettore posizione?");
    expect(followUp).toContain("[P1]");
    expect(followUp).toContain("numbered from P1 again");
    expect(followUp.endsWith("Question:\nE il vettore spostamento?")).toBe(
      true,
    );
    db.close();
  });

  it("starts the conversation over when a reply is regenerated", async () => {
    const { db } = setup();
    const first = await askTurn(db, {
      text: "domanda",
      allowGeneral: true,
      run: async () => reply,
    });
    ended.length = 0;
    await regenerateTurn(db, {
      chatId: first.chatId,
      allowGeneral: true,
      run: async () => reply,
    });
    expect(ended).toContain(first.chatId);
    db.close();
  });
});

describe("a stopped reply after the engine switched", () => {
  it("records the engine that answered", async () => {
    const db = openDatabase(":memory:");
    db.prepare(
      "INSERT INTO feature_engines (feature, selection_json, updated_at) VALUES ('chat', ?, 1)",
    ).run(JSON.stringify({ provider: "claude", model: "claude-sonnet-5", auto: true }));
    rememberReady([
      { id: "claude", kind: "cli", effort: true, models: [{ id: "claude-sonnet-5", efforts: [] }] },
      { id: "codex", kind: "cli", effort: true, models: [{ id: "gpt-5.6-terra", efforts: [] }] },
    ]);
    const controller = new AbortController();
    try {
      const result = await askTurn(db, {
        text: "domanda",
        allowGeneral: true,
        signal: controller.signal,
        run: async (input) => {
          if (input.selection.provider === "claude")
            throw Object.assign(new Error("usage limit"), {
              code: "cli-failed",
              limit: { kind: "rate", detail: "usage limit" },
            });
          input.onDelta?.("Una risposta a metà");
          controller.abort();
          throw new DOMException("stopped", "AbortError");
        },
      });
      expect(result.message).toMatchObject({
        stopped: true,
        provider: "codex",
        modelId: "gpt-5.6-terra",
      });
      expect(readChat(db, result.chatId).at(-1)).toMatchObject({
        provider: "codex",
        modelId: "gpt-5.6-terra",
      });
    } finally {
      rememberReady([]);
      clearBench();
      db.close();
    }
  });
});
