import { afterEach, describe, expect, it } from "vitest";
import { openDatabase } from "../db/connection";
import { askTurn } from "../chat/turn";
import { acknowledgeProviders, configureDisclosure, type EngineResult, type TurnInput } from "../engine/funnel";
import { putSetting } from "../settings";
import { chatToolList } from "./registry";
import { setTools, stopToolServer } from "./server";

afterEach(async () => {
  await stopToolServer();
});

/** A workspace whose chat answers on `provider`, with the notice store in place as core sets it up. */
function setup(provider: string) {
  const db = openDatabase(":memory:");
  db.prepare("INSERT INTO feature_engines (feature, selection_json, updated_at) VALUES ('default', ?, 1)").run(
    JSON.stringify({ provider, model: "model-1" }),
  );
  db.prepare("INSERT INTO subjects (id, name, created_at) VALUES ('phys', 'Fisica 1', 1)").run();
  db.prepare("INSERT INTO plans (id, subject_id, title, status, created_at, updated_at) VALUES ('mech', 'phys', 'Meccanica', 'ready', 1, 1)").run();
  configureDisclosure(db);
  setTools(chatToolList(db));
  return db;
}

const rpc = (tools: NonNullable<TurnInput["tools"]>, method: string, params: unknown = {}) =>
  fetch(tools.url, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${tools.token}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  }).then((response) => response.json() as Promise<{ result: Record<string, unknown> }>);

/** What the model saw of read_progress in one turn: whether it was listed, and what a call of it answered. */
async function turnSees(db: ReturnType<typeof setup>, provider: string) {
  let listed: string[] = [];
  let answer = "";
  await askTurn(db, {
    text: "Come vado nei quiz?",
    subject: "Fisica 1",
    planId: "mech",
    run: async (input): Promise<EngineResult> => {
      listed = ((await rpc(input.tools!, "tools/list")).result.tools as Array<{ name: string }>).map((tool) => tool.name);
      const called = await rpc(input.tools!, "tools/call", { name: "read_progress", arguments: {} });
      answer = (called.result.content as Array<{ text: string }>)[0]!.text;
      return { text: "Non vedo i tuoi risultati da qui.", model: "model-1", provider, inputTokens: 1 };
    },
  });
  return { listed, answer };
}

describe("read_progress and the notice", () => {
  it("is not offered to a cloud tool until the student confirms the notice that names their results", async () => {
    const db = setup("claude");
    // Confirmed before the notice named results: the tool runs, without read_progress.
    putSetting(db, "engine-disclosure:claude", true);
    const before = await turnSees(db, "claude");
    expect(before.listed).toEqual(["create_flashcards"]);
    expect(before.answer).toBe("Unknown tool.");

    acknowledgeProviders(["claude"]);
    const after = await turnSees(db, "claude");
    expect(after.listed).toEqual(["create_flashcards", "read_progress"]);
    expect(JSON.parse(after.answer)).toMatchObject({ subject: "Meccanica", scale: 30 });
    expect(db.prepare("SELECT value_json FROM settings WHERE key = 'engine-disclosure:claude'").pluck().get()).toBe("2");
  });

  it("is offered to the model on this computer without a confirmation", async () => {
    const db = setup("ollama");
    expect((await turnSees(db, "ollama")).listed).toContain("read_progress");
  });
});
