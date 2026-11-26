import { afterEach, describe, expect, it } from "vitest";
import { openDatabase } from "../db/connection";
import { acknowledgeProviders, configureDisclosure, type EngineResult, type TurnInput } from "../engine/funnel";
import { putSetting } from "../settings";
import { chatToolList } from "../tools/registry";
import { setTools, stopToolServer } from "../tools/server";
import { askTurn } from "./turn";

afterEach(async () => {
  await stopToolServer();
});

/**
 * A chat of Fisica 1 with one graded quiz (26/30). Claude was confirmed with the notice that names results, Codex only
 * with the one before it.
 */
function setup() {
  const db = openDatabase(":memory:");
  const run = (sql: string, ...args: unknown[]) => db.prepare(sql).run(...args);
  run("INSERT INTO feature_engines (feature, selection_json, updated_at) VALUES ('default', ?, 1)", JSON.stringify({ provider: "claude", model: "m" }));
  run("INSERT INTO subjects (id, name, created_at) VALUES ('phys', 'Fisica 1', 1)");
  run("INSERT INTO plans (id, subject_id, title, status, created_at, updated_at) VALUES ('mech', 'phys', 'Meccanica', 'ready', 1, 1)");
  run("INSERT INTO topics (id, plan_id, title, position, created_at) VALUES ('kin', 'mech', 'Cinematica', 0, 1)");
  run("INSERT INTO items (id, plan_id, topic_id, kind, body_json, created_at) VALUES ('q', 'mech', 'kin', 'quiz', '{}', 1)");
  run("INSERT INTO attempts (id, plan_id, item_id, started_at, submitted_at) VALUES ('a', 'mech', 'q', 1, 2)");
  run(`INSERT INTO attempt_answers (id, attempt_id, payload_json, created_at) VALUES ('aa', 'a', '{"picks":{},"results":[],"score":0.8667}', 2)`);
  configureDisclosure(db);
  acknowledgeProviders(["claude"]);
  putSetting(db, "engine-disclosure:codex", true);
  setTools(chatToolList(db, false));
  return db;
}

const use = (db: ReturnType<typeof setup>, provider: string) =>
  db.prepare("UPDATE feature_engines SET selection_json = ? WHERE feature = 'default'").run(JSON.stringify({ provider, model: "m" }));

const GRADES_REPLY =
  'Ecco i tuoi voti.\n\n```pyxis-chart\n{"title":"Voti","kind":"bar","series":[{"name":"Voto","points":[{"label":"Cinematica","value":26}]}]}\n```\n\nIn Cinematica hai preso 26/30.';
const PRESSURE_REPLY =
  'Ecco i dati del testo.\n\n```pyxis-chart\n{"title":"Pressione","kind":"bar","series":[{"name":"kPa","points":[{"label":"Livello del mare","value":101.3}]}]}\n```';

const callProgress = (tools: NonNullable<TurnInput["tools"]>) =>
  fetch(tools.url, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${tools.token}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "read_progress", arguments: {} } }),
  }).then((response) => response.json() as Promise<{ result: { content: Array<{ text: string }> } }>);

/** One turn on `provider`: what it was sent as a new session's prompt and as a follow-up, and its reply. */
async function ask(
  db: ReturnType<typeof setup>,
  text: string,
  options: { chatId?: string; provider: string; sessionId: string; reply?: string; readsResults?: boolean },
) {
  use(db, options.provider);
  let prompt = "";
  let followUp = "";
  const result = await askTurn(db, {
    chatId: options.chatId,
    text,
    subject: options.chatId ? undefined : "Fisica 1",
    planId: options.chatId ? undefined : "mech",
    allowGeneral: true,
    run: async (input): Promise<EngineResult> => {
      prompt = input.prompt;
      followUp = input.conversation?.followUp ?? "";
      if (options.readsResults) expect((await callProgress(input.tools!)).result.content[0]!.text).toContain('"grade":26');
      const continued = input.conversation?.session?.id === options.sessionId && input.conversation.session.provider === options.provider;
      return { text: options.reply ?? "Va bene.", model: "m", provider: options.provider, inputTokens: 1, sessionId: options.sessionId, cwd: "/s", continued };
    },
  });
  return { chatId: result.chatId, message: result.message!, prompt, followUp };
}

const NEUTRAL = "used the student's own results";

describe("results in earlier replies and the tool that answers", () => {
  it("keeps a reply built from the student's results out of the history a tool without the new notice gets", async () => {
    const db = setup();
    const first = await ask(db, "Come vado nei quiz?", { provider: "claude", sessionId: "c1", reply: GRADES_REPLY, readsResults: true });
    expect(db.prepare("SELECT results FROM messages WHERE id = ?").pluck().get(first.message.id)).toBe(1);
    // The chat moves to Codex, which starts a new session with the conversation handed across.
    const next = await ask(db, "E adesso?", { chatId: first.chatId, provider: "codex", sessionId: "x1" });
    expect(next.prompt).toContain("Come vado nei quiz?");
    expect(next.prompt).toContain(NEUTRAL);
    expect(next.prompt).not.toContain("26");
    // Claude, confirmed with the notice that names results, gets the whole reply.
    const back = await ask(db, "E ancora?", { chatId: first.chatId, provider: "claude", sessionId: "c2" });
    expect(back.prompt).toContain("26/30");
  });

  it("keeps it out of the replay a resumed session out of step gets", async () => {
    const db = setup();
    use(db, "codex");
    // Codex names its session, and another tool answers the turn in its place with the student's results, so the Codex
    // session is out of step. The fallback itself happens inside generate(); here the reply is stored as one whose turn
    // read the results.
    const first = await askTurn(db, {
      text: "Come vado nei quiz?",
      subject: "Fisica 1",
      planId: "mech",
      allowGeneral: true,
      run: async (input) => {
        input.conversation?.onSession?.("x1", "codex", "/s", true);
        return { text: GRADES_REPLY, model: "m", provider: "claude", inputTokens: 1 };
      },
    });
    db.prepare("UPDATE messages SET results = 1 WHERE id = ?").run(first.message!.id);
    const back = await ask(db, "E adesso?", { chatId: first.chatId, provider: "codex", sessionId: "x1" });
    expect(back.followUp).toContain("since the last turn you completed");
    expect(back.followUp).toContain("Come vado nei quiz?");
    expect(back.followUp).toContain(NEUTRAL);
    expect(back.followUp).not.toContain("26");
  });

  it("hands on a chart of numbers from the material, which are not the student's results", async () => {
    const db = setup();
    const first = await ask(db, "Fammi un grafico della pressione", { provider: "claude", sessionId: "c1", reply: PRESSURE_REPLY });
    expect(db.prepare("SELECT results FROM messages WHERE id = ?").pluck().get(first.message.id)).toBe(0);
    const next = await ask(db, "E adesso?", { chatId: first.chatId, provider: "codex", sessionId: "x1" });
    expect(next.prompt).toContain("101.3");
  });

  it("gives the model on this computer the whole history", async () => {
    const db = setup();
    const first = await ask(db, "Come vado nei quiz?", { provider: "claude", sessionId: "c1", reply: GRADES_REPLY, readsResults: true });
    const local = await ask(db, "E adesso?", { chatId: first.chatId, provider: "ollama", sessionId: "o1" });
    expect(local.prompt).toContain("26/30");
  });
});
