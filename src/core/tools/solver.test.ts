import { afterEach, describe, expect, it } from "vitest";
import { openDatabase } from "../db/connection";
import { askTurn, readChat, regenerateTurn } from "../chat/turn";
import { currentSession } from "../chat/sessions";
import { clearBench, isBenched } from "../engine/bench";
import { acknowledgeProviders, configureDisclosure, type EngineResult, type TurnInput } from "../engine/funnel";
import { rememberReady, setFeatureOff, solverSelection } from "../engine/selection";
import { setUsageRecorder, type UsageScope } from "../engine/usage";
import type { AutoProvider } from "../engine/auto";
import { forgetModels, rememberModels } from "../engine/efforts";
import { toolBlockIds } from "../../shared/tool-blocks";
import { chatToolList } from "./registry";
import { setTools, stopToolServer, type ToolTurn } from "./server";
import { isSolverCall, SOLVER_TOOL, setSolverDeadline, solverInput, solverTool } from "./solver";

afterEach(async () => {
  await stopToolServer();
  rememberReady([]);
  clearBench();
  setSolverDeadline(undefined);
  setUsageRecorder(undefined);
  forgetModels();
});

const efforts = ["low", "medium", "high"].map((id) => ({ id }));
const tool = (id: string, models: string[]): AutoProvider => ({
  id,
  kind: "cli",
  effort: true,
  models: models.map((model) => ({ id: model, efforts })),
});
const claude = tool("claude", ["claude-haiku-5-5", "claude-sonnet-5-5", "claude-opus-5-5"]);
const codex = tool("codex", ["gpt-6-luna", "gpt-6.1-terra", "gpt-6.2-sol"]);
const gemini = tool("antigravity", ["gemini-3.8-flash", "gemini-4-hydrogen", "gemini-4-carbon"]);

function setup(chat = { provider: "claude", model: "claude-sonnet-5-5" }) {
  const db = openDatabase(":memory:");
  db.prepare("INSERT INTO feature_engines (feature, selection_json, updated_at) VALUES ('default', ?, 1)").run(JSON.stringify(chat));
  db.prepare("INSERT INTO subjects (id, name, created_at) VALUES ('phys', 'Analisi 2', 1)").run();
  db.prepare("INSERT INTO chats (id, title, subject, created_at, updated_at) VALUES ('chat', 'Integrali', 'Analisi 2', 1, 1)").run();
  setTools(chatToolList(db, false));
  return db;
}

const pin = (db: ReturnType<typeof setup>, selection: object) =>
  db.prepare("INSERT OR REPLACE INTO feature_engines (feature, selection_json, updated_at) VALUES ('solve', ?, 1)").run(JSON.stringify(selection));

const rpc = (tools: NonNullable<TurnInput["tools"]>, method: string, params: unknown = {}) =>
  fetch(tools.url, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${tools.token}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  }).then((response) => response.json() as Promise<{ result: { content?: Array<{ text: string }>; isError?: boolean; tools?: Array<{ name: string }> } }>);

const EXERCISE = {
  exercise: "Calcola l'integrale doppio di x^2 + y^2 sulla corona circolare 1 <= x^2 + y^2 <= 4.",
  request: "Lo studente chiede la soluzione completa.",
};

describe("ask_stronger_model: arguments", () => {
  it("takes a whole statement and the request, refuses empty, oversized or unknown fields", () => {
    expect(solverInput.safeParse(EXERCISE).success).toBe(true);
    expect(solverInput.safeParse({ ...EXERCISE, material: "Coordinate polari: x = r cos t, y = r sin t, dA = r dr dt." }).success).toBe(true);
    expect(solverInput.safeParse({ ...EXERCISE, exercise: "Risolvi." }).success).toBe(false);
    expect(solverInput.safeParse({ ...EXERCISE, request: "" }).success).toBe(false);
    expect(solverInput.safeParse({ ...EXERCISE, exercise: "x".repeat(8001) }).success).toBe(false);
    expect(solverInput.safeParse({ ...EXERCISE, material: "x".repeat(16001) }).success).toBe(false);
    expect(solverInput.safeParse({ ...EXERCISE, model: "claude-opus-5-5" }).success).toBe(false);
  });
});

describe("ask_stronger_model: which model", () => {
  it("is the strong model of the tool that answers the chat, never another tool's", () => {
    const db = setup();
    rememberReady([claude, codex, gemini]);
    expect(solverSelection(db, { provider: "claude", model: "claude-sonnet-5-5" })).toMatchObject({ provider: "claude", model: "claude-opus-5-5", effort: "high" });
    expect(solverSelection(db, { provider: "codex", model: "gpt-6.1-terra" })).toMatchObject({ provider: "codex", model: "gpt-6.2-sol", effort: "high" });
    expect(solverSelection(db, { provider: "antigravity", model: "gemini-3.8-flash" })).toMatchObject({ provider: "antigravity", model: "gemini-4-carbon" });
    // The chat's tool is out: no other tool's strong model takes its place.
    rememberReady([codex]);
    expect(solverSelection(db, { provider: "claude", model: "claude-sonnet-5-5" })).toBeNull();
  });

  it("follows the effort the student picked for the task, a pinned model, and Spento", () => {
    const db = setup();
    rememberReady([claude, codex]);
    rememberModels("claude", claude.models);
    pin(db, { provider: "claude", model: "claude-opus-5-5", effort: "high", auto: true, effortChoice: "medium" });
    expect(solverSelection(db, { provider: "claude", model: "claude-sonnet-5-5" })).toMatchObject({ model: "claude-opus-5-5", effort: "medium" });
    // A model pinned for hard exercises runs as pinned, whatever tool answers the chat.
    pin(db, { provider: "claude", model: "claude-sonnet-5-5", effort: "high" });
    expect(solverSelection(db, { provider: "claude", model: "claude-haiku-5-5" })).toMatchObject({ provider: "claude", model: "claude-sonnet-5-5", effort: "high" });
    expect(solverSelection(db, { provider: "codex", model: "gpt-6.1-terra" })).toMatchObject({ provider: "claude", model: "claude-sonnet-5-5" });
    // The pinned model is the one answering: nothing stronger to hand the exercise to.
    expect(solverSelection(db, { provider: "claude", model: "claude-sonnet-5-5" })).toBeNull();
    setFeatureOff(db, "solve", true);
    expect(solverSelection(db, { provider: "claude", model: "claude-haiku-5-5" })).toBeNull();
    setFeatureOff(db, "solve", false);
    expect(solverSelection(db, { provider: "claude", model: "claude-haiku-5-5" })).toMatchObject({ model: "claude-sonnet-5-5" });
  });

  it("is not offered to a chat already on the strong model", () => {
    const db = setup();
    rememberReady([claude]);
    expect(solverSelection(db, { provider: "claude", model: "claude-opus-5-5" })).toBeNull();
  });
});

/** A ToolTurn of a chat on Claude Sonnet whose engine runner is `run`. */
function toolTurn(run: (input: TurnInput) => Promise<EngineResult>, tally: Record<string, number> = {}): ToolTurn {
  return {
    chatId: "chat",
    tally,
    kept: {},
    place: () => ({ planId: null, subject: "Analisi 2" }),
    engine: () => ({ provider: "claude", model: "claude-sonnet-5-5" }),
    call: () => ({ run, usage: { chatId: "chat", messageId: "m1", kind: "chat" }, language: "Italian" }),
    started: () => null,
    finished: () => undefined,
  };
}

const solved = (input: TurnInput): EngineResult => ({
  text: "1. In coordinate polari l'integrale diventa $\\int_0^{2\\pi}\\int_1^2 r^3\\,dr\\,d\\theta$.\n\nRisultato: $\\frac{15\\pi}{2}$.",
  model: input.selection.model,
  provider: input.selection.provider,
  inputTokens: 900,
  outputTokens: 300,
});

describe("ask_stronger_model: the sub-call", () => {
  it("gives a clean result when the stronger model does not answer in time, and stops it", async () => {
    const db = setup();
    rememberReady([claude]);
    setSolverDeadline(50);
    let stopped = false;
    const outcome = await solverTool(db).run(
      toolTurn(
        (input) =>
          new Promise((_, reject) =>
            input.signal!.addEventListener("abort", () => {
              stopped = true;
              reject(new DOMException("Engine turn cancelled", "AbortError"));
            }),
          ),
      ),
      solverInput.parse(EXERCISE),
    );
    expect(stopped).toBe(true);
    expect(outcome.text).toContain("did not answer within 0 seconds");
    expect(outcome.text).toContain("Solve the exercise yourself");
    expect(outcome.shown).toBeUndefined();
    expect(db.prepare("SELECT COUNT(*) FROM chat_tool_results").pluck().get()).toBe(0);
  });

  it("tells the chat's model when the strong model is out of requests, and records the limit as any call does", async () => {
    const db = setup();
    rememberReady([claude]);
    const limited = Object.assign(new Error("Opus weekly limit reached"), { code: "cli-failed", limit: { kind: "quota" } });
    const outcome = await solverTool(db).run(
      toolTurn(async () => {
        throw limited;
      }),
      solverInput.parse(EXERCISE),
    );
    expect(outcome.text).toContain("usage limit on the student's subscription is reached");
    expect(isBenched("claude")).toBe(true);
  });

  it("keeps the student's results from a solver whose tool is not cleared for them", async () => {
    const db = setup();
    configureDisclosure(db);
    acknowledgeProviders(["claude"]);
    rememberReady([claude, codex]);
    let ran = 0;
    const run = async (input: TurnInput) => {
      ran += 1;
      return solved(input);
    };
    // Pinned to another tool, whose notice naming the results the student never confirmed.
    pin(db, { provider: "codex", model: "gpt-6.2-sol" });
    const refused = await solverTool(db).run(toolTurn(run, { results: 1 }), solverInput.parse(EXERCISE));
    expect(refused.text).toContain("may not receive the student's results");
    expect(ran).toBe(0);
    // The chat's own tool has the confirmation: the sub-call runs.
    pin(db, { provider: "claude", model: "claude-opus-5-5", auto: true });
    const allowed = await solverTool(db).run(toolTurn(run, { results: 1 }), solverInput.parse(EXERCISE));
    expect(allowed.text).toContain("15\\pi");
    expect(allowed.shown).toBeDefined();
    expect(ran).toBe(1);
  });
});

describe("ask_stronger_model in a chat turn", () => {
  it("runs once per answer on its own, counts its tokens under its model and leaves the chat's session as it was", async () => {
    const db = setup();
    rememberReady([claude]);
    const usage: Array<{ model: string; scope: UsageScope }> = [];
    setUsageRecorder((result, scope) => usage.push({ model: result.model, scope }));
    const first = await askTurn(db, {
      text: "Ciao",
      subject: "Analisi 2",
      run: async () => ({ text: "Ciao!", model: "claude-sonnet-5-5", provider: "claude", inputTokens: 1, sessionId: "chat-session", cwd: "/scratch", continued: false, tools: true }),
    });
    const before = currentSession(db, first.chatId);
    const subCalls: TurnInput[] = [];
    const streamed: string[] = [];
    let listed: string[] = [];
    let second = "";
    const result = await askTurn(db, {
      chatId: first.chatId,
      text: "Calcola l'integrale doppio di x^2+y^2 sulla corona 1 <= r <= 2.",
      onDelta: (text) => streamed.push(text),
      run: async (input): Promise<EngineResult> => {
        if (isSolverCall(input.system)) {
          subCalls.push(input);
          return solved(input);
        }
        listed = ((await rpc(input.tools!, "tools/list")).result.tools ?? []).map((entry) => entry.name);
        input.onDelta?.("Passo in coordinate polari.");
        input.tools!.onTool?.({ phase: "start", id: "s1", tool: SOLVER_TOOL });
        const answer = await rpc(input.tools!, "tools/call", { name: SOLVER_TOOL, arguments: EXERCISE });
        input.tools!.onTool?.({ phase: "end", id: "s1", tool: SOLVER_TOOL });
        expect(answer.result.content![0]!.text).toContain("Risultato: $\\frac{15\\pi}{2}$.");
        second = (await rpc(input.tools!, "tools/call", { name: SOLVER_TOOL, arguments: EXERCISE })).result.content![0]!.text;
        input.onDelta?.("Passo in coordinate polari.Il risultato è $\\frac{15\\pi}{2}$.");
        return { text: "Il risultato è $\\frac{15\\pi}{2}$.", model: "claude-sonnet-5-5", provider: "claude", inputTokens: 1, sessionId: "chat-session", cwd: "/scratch", continued: true, tools: true };
      },
    });
    expect(listed).toContain(SOLVER_TOOL);
    // One sub-call per answer, with no conversation and no tools of its own, on the strong model in the chat's language.
    expect(subCalls).toHaveLength(1);
    expect(second).toContain("already asked the stronger model");
    expect(subCalls[0]!.selection).toMatchObject({ provider: "claude", model: "claude-opus-5-5" });
    expect(subCalls[0]!.conversation).toBeUndefined();
    expect(subCalls[0]!.tools).toBeUndefined();
    expect(subCalls[0]!.prompt).toContain("Language: Italian.");
    expect(subCalls[0]!.prompt).toContain("<exercise>\nCalcola l'integrale doppio");
    // While it ran the reply showed the working line; saved, it names the model that solved it and shows nothing more.
    expect(streamed).toContain(`Passo in coordinate polari.\n\n\`\`\`pyxis-tool\npending:${SOLVER_TOOL}\n\`\`\``);
    const message = result.message!;
    const [id] = toolBlockIds(message.body);
    expect(message.tools?.[id!]).toEqual({ id, tool: SOLVER_TOOL, provider: "claude", model: "claude-opus-5-5" });
    expect(readChat(db, result.chatId).at(-1)!.tools?.[id!]).toMatchObject({ model: "claude-opus-5-5" });
    // Its tokens count with this reply, under the model that ran them.
    expect(usage).toContainEqual({ model: "claude-opus-5-5", scope: { chatId: result.chatId, messageId: message.id, kind: "chat" } });
    // The chat's stored session is the one it had, still in step.
    const after = currentSession(db, result.chatId)!;
    expect(after).toMatchObject({ id: before!.id, sessionId: "chat-session", inStep: true });

    // Answered again without the stronger model, the new reply does not carry the old sub-call or its model.
    const again = await regenerateTurn(db, {
      chatId: result.chatId,
      run: async () => ({ text: "Ecco di nuovo.", model: "claude-sonnet-5-5", provider: "claude", inputTokens: 1 }),
    });
    expect(again.message!.tools).toBeUndefined();
    expect(db.prepare("SELECT COUNT(*) FROM chat_tool_results").pluck().get()).toBe(0);
  });

  it("is not listed when switched off, nor to a turn already on the strong model", async () => {
    const db = setup();
    rememberReady([claude]);
    const names = async () => {
      let listed: string[] = [];
      await askTurn(db, {
        text: "Ciao",
        subject: "Analisi 2",
        run: async (input) => {
          listed = ((await rpc(input.tools!, "tools/list")).result.tools ?? []).map((entry) => entry.name);
          return { text: "Ciao!", model: "m", provider: "claude", inputTokens: 1 };
        },
      });
      return listed;
    };
    expect(await names()).toContain(SOLVER_TOOL);
    setFeatureOff(db, "solve", true);
    expect(await names()).not.toContain(SOLVER_TOOL);
    expect(await names()).toContain("create_flashcards");
    setFeatureOff(db, "solve", false);
    db.prepare("UPDATE feature_engines SET selection_json = ? WHERE feature = 'default'").run(JSON.stringify({ provider: "claude", model: "claude-opus-5-5" }));
    expect(await names()).not.toContain(SOLVER_TOOL);
  });
});
