import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../db/connection";
import { askTurn } from "../chat/turn";
import { endConversations, runTurn, setScratch, type TurnInput } from "../engine/funnel";
import { setFeatureOff } from "../engine/selection";
import { tempDir } from "../test-temp";
import { chatToolList } from "./registry";
import { setTools, stopToolServer } from "./server";
import { isSolverCall, solverInput, solverTool } from "./solver";

/**
 * `ask_stronger_model` on a signed-in CLI. It spends subscription usage on the strong model, so it runs only with
 * PYXIS_LIVE_SOLVER=1, and each scenario once:
 *
 *   PYXIS_LIVE_SOLVER=1 PYXIS_LIVE_CHAT=codex/gpt-6.1-terra/medium PYXIS_LIVE_SOLVE=codex/gpt-6.2-sol/high \
 *   PYXIS_LIVE_OUT=.tmp/solver npm test -- src/core/tools/solver.live.test.ts
 *
 * PYXIS_LIVE_SCENARIOS picks scenarios by name (comma-separated). A scenario ending in `-alone` asks the same exercise
 * with the task switched off, so the chat's model answers by itself, for comparison. One ending in `-direct` skips the
 * chat and calls the tool with the exercise as its argument, to time the stronger model alone. Each turn's reply, the solver's
 * text and the times go to PYXIS_LIVE_OUT as JSON. A usage notice ends the run: nothing is retried against it.
 */
const live = process.env["PYXIS_LIVE_SOLVER"] === "1";

const SCENARIOS: Record<string, string> = {
  integral:
    "Calcola l'integrale doppio di $x^2 + y^2$ sul dominio $D = \\{(x,y) : 1 \\le x^2 + y^2 \\le 4,\\ y \\ge 0\\}$. Voglio la soluzione completa.",
  ode: "Risolvi il problema di Cauchy $y'' + 4y = \\sin(2x)$, $y(0) = 0$, $y'(0) = 0$. Mostrami tutti i passaggi.",
  induction:
    "Dimostra per induzione che $2^n \\ge n^2$ per ogni intero $n \\ge 1$. Mi serve la dimostrazione completa.",
  definition: "Che cosa dice il teorema di Fubini, in parole semplici?",
  short: "Quanto fa la derivata di $x^2 \\sin x$?",
};

type Turn = {
  scenario: string;
  question: string;
  body: string;
  turnMs: number;
  called: boolean;
  solverMs: number | null;
  solver: string | null;
  solverModel: string | null;
  error: string | null;
};

describe.skipIf(!live)("ask_stronger_model, live", () => {
  it("hands hard exercises on, and only those", { timeout: 120 * 60_000 }, async () => {
    const out = process.env["PYXIS_LIVE_OUT"] ?? ".tmp/solver";
    mkdirSync(out, { recursive: true });
    setScratch(tempDir("pyxis-live-scratch-"));
    const [provider, model, effort] = process.env["PYXIS_LIVE_CHAT"]!.split("/") as [string, string, string?];
    const [solveProvider, solveModel, solveEffort] = process.env["PYXIS_LIVE_SOLVE"]!.split("/") as [string, string, string?];
    // No call may run on Fable or on Opus: the Claude path is checked with Sonnet pinned for hard exercises.
    for (const id of [model, solveModel]) expect(id).not.toMatch(/fable|opus/i);
    const wanted = process.env["PYXIS_LIVE_SCENARIOS"]?.split(",") ?? Object.keys(SCENARIOS);

    const db = openDatabase(":memory:");
    const chat = JSON.stringify({ provider, model, ...(effort ? { effort } : {}) });
    db.prepare("INSERT INTO feature_engines (feature, selection_json, updated_at) VALUES ('default', ?, 1), ('chat', ?, 1), ('solve', ?, 1)").run(
      chat,
      chat,
      JSON.stringify({ provider: solveProvider, model: solveModel, ...(solveEffort ? { effort: solveEffort } : {}) }),
    );
    db.prepare("INSERT INTO subjects (id, name, created_at) VALUES ('math', 'Analisi 2', 1)").run();
    setTools(chatToolList(db, false));

    const report: Turn[] = [];
    db.prepare("INSERT INTO chats (id, title, created_at, updated_at) VALUES ('direct', 'direct', 1, 1)").run();
    for (const name of wanted.filter((entry) => entry.endsWith("-direct"))) {
      const question = SCENARIOS[name.slice(0, -"-direct".length)]!;
      const t0 = Date.now();
      let solverModel: string | null = null;
      const outcome = await Promise.resolve(solverTool(db).run(
        {
          chatId: "direct",
          tally: {},
          kept: {},
          place: () => ({ planId: null, subject: "Analisi 2" }),
          engine: () => ({ provider, model }),
          call: () => ({
            run: async (input: TurnInput) => {
              const answer = await runTurn(input);
              solverModel = answer.model;
              return answer;
            },
            usage: { kind: "chat" },
            language: "Italian",
          }),
          started: () => null,
          finished: () => undefined,
        },
        solverInput.parse({ exercise: question, request: "Lo studente chiede la soluzione completa." }),
      )).catch((err: unknown) => ({ text: `error: ${String(err)}` }));
      report.push({ scenario: name, question, body: "", turnMs: Date.now() - t0, called: true, solverMs: Date.now() - t0, solver: outcome.text, solverModel, error: null });
      writeFileSync(join(out, `${provider}-${model}.json`), JSON.stringify(report, null, 2));
    }
    for (const name of wanted.filter((entry) => !entry.endsWith("-direct"))) {
      const alone = name.endsWith("-alone");
      const question = SCENARIOS[alone ? name.slice(0, -"-alone".length) : name]!;
      setFeatureOff(db, "solve", alone);
      let solver: string | null = null;
      let solverMs: number | null = null;
      let solverModel: string | null = null;
      const started = Date.now();
      let body = "";
      let error: string | null = null;
      try {
        const result = await askTurn(db, {
          text: question,
          subject: "Analisi 2",
          run: async (input: TurnInput) => {
            if (!isSolverCall(input.system)) return runTurn(input);
            const t0 = Date.now();
            const answer = await runTurn(input);
            solverMs = Date.now() - t0;
            solver = answer.text;
            solverModel = answer.model;
            return answer;
          },
        });
        body = result.message?.body ?? "";
      } catch (err) {
        error = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      }
      report.push({ scenario: name, question, body, turnMs: Date.now() - started, called: solverMs !== null, solverMs, solver, solverModel, error });
      writeFileSync(join(out, `${provider}-${model}.json`), JSON.stringify(report, null, 2));
      endConversations();
      // A usage limit: nothing more runs against it.
      if (error && /quota|limit/i.test(error)) break;
    }
    await stopToolServer();
    expect(report.length).toBeGreaterThan(0);
  });
});
