import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { openDatabase } from "../db/connection";
import { createRunner } from "../jobs/runner";
import { askTurn, readChat, settleChecks } from "../chat/turn";
import { generate } from "./generate";
import type { EngineResult } from "./funnel";
import { chatUsage, setUsageRecorder, storeUsage, usageSince } from "./usage";

const opened: Array<{ close: () => void }> = [];

function workspace() {
  const db = openDatabase(join(mkdtempSync(join(tmpdir(), "pyxis-usage-")), "pyxis.db"));
  opened.push(db);
  db.prepare(
    "INSERT INTO feature_engines (feature, selection_json, updated_at) VALUES ('default', ?, 1)",
  ).run(JSON.stringify({ provider: "anthropic-api", model: "claude-sonnet-5" }));
  setUsageRecorder((usage, where) => storeUsage(db, usage, where));
  return db;
}

afterEach(() => {
  setUsageRecorder(undefined);
  for (const db of opened) db.close();
  opened.length = 0;
});

const answer = (text: string, tokens: Partial<EngineResult> = {}): EngineResult => ({
  text,
  model: "claude-sonnet-5",
  provider: "anthropic-api",
  inputTokens: 1000,
  outputTokens: 200,
  cacheReadTokens: 600,
  cacheWriteTokens: 100,
  ...tokens,
});

describe("token usage", () => {
  it("counts every model call, schema repairs included", async () => {
    const db = workspace();
    const replies = [answer("not json"), answer('{"ok":true}', { inputTokens: 300, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0 })];
    await generate({
      prompt: "Return ok",
      selection: { provider: "anthropic-api", model: "claude-sonnet-5" },
      schema: z.object({ ok: z.boolean() }),
      run: async () => replies.shift()!,
    });
    expect(usageSince(db, 0)).toEqual([
      {
        provider: "anthropic-api",
        calls: 2,
        inputTokens: 1300,
        outputTokens: 220,
        cacheReadTokens: 600,
        cacheWriteTokens: 100,
      },
    ]);
  });

  it("skips a call that reported no tokens", async () => {
    const db = workspace();
    await generate({
      prompt: "Hi",
      selection: { provider: "agent", model: "auto" },
      run: async () => answer("Hi", { inputTokens: 0, outputTokens: 0 }),
    });
    expect(usageSince(db, 0)).toEqual([]);
  });

  it("sums the week per engine, most used first, and leaves out older calls", () => {
    const db = workspace();
    const week = Date.parse("2026-10-12T00:00:00");
    storeUsage(db, answer("a", { provider: "codex", inputTokens: 50, outputTokens: 5 }), {}, week - 1);
    storeUsage(db, answer("b", { provider: "codex", inputTokens: 50, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 }), {}, week + 10);
    storeUsage(db, answer("c"), {}, week + 20);
    expect(usageSince(db, week).map((row) => [row.provider, row.calls, row.inputTokens])).toEqual([
      ["anthropic-api", 1, 1000],
      ["codex", 1, 50],
    ]);
  });

  it("ties a chat turn and its math check to the chat and the reply", async () => {
    const db = workspace();
    const step = "La derivata di $x^2$ è $2x$.";
    const result = await askTurn(db, {
      text: "Deriva x^2",
      allowGeneral: true,
      run: async (input) => (input.responseSchema ? answer('{"checks":[]}', { inputTokens: 90, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 }) : answer(step)),
    });
    await settleChecks();
    const messageId = result.message!.id;
    const rows = db
      .prepare("SELECT kind, chat_id, message_id, input_tokens FROM engine_usage ORDER BY at, input_tokens DESC")
      .all();
    expect(rows).toEqual([
      { kind: "chat", chat_id: result.chatId, message_id: messageId, input_tokens: 1000 },
      { kind: "chat", chat_id: result.chatId, message_id: messageId, input_tokens: 90 },
    ]);
    expect(chatUsage(db, result.chatId)).toMatchObject({ calls: 2, inputTokens: 1090, outputTokens: 210, cacheReadTokens: 600 });
    expect(readChat(db, result.chatId).at(-1)?.id).toBe(messageId);
    expect(chatUsage(db, "another-chat")).toBeNull();
  });

  it("ties the calls of a job's steps to the job", async () => {
    const db = workspace();
    const runner = createRunner(db, () => {}, undefined, true);
    runner.register("lesson", {
      jobClass: "model-api",
      steps: [
        {
          name: "write",
          label: "write",
          run: async () =>
            generate({
              prompt: "Write",
              selection: { provider: "anthropic-api", model: "claude-sonnet-5" },
              run: async () => answer("Lesson"),
            }),
        },
      ],
    });
    const jobId = runner.start("lesson");
    runner.activate();
    for (let i = 0; i < 100 && !db.prepare("SELECT 1 FROM engine_usage").get(); i += 1)
      await new Promise((resolve) => setTimeout(resolve, 10));
    expect(db.prepare("SELECT kind, job_id, chat_id FROM engine_usage").all()).toEqual([
      { kind: "lesson", job_id: jobId, chat_id: null },
    ]);
  });
});
