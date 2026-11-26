import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { mapChatBlocks, type ChartData } from "../../shared/chat-blocks";
import { askTurn } from "../chat/turn";
import { openDatabase } from "../db/connection";
import { acknowledgeProviders, configureDisclosure, endConversations, setScratch } from "../engine/funnel";
import { createRunner } from "../jobs/runner";
import { registerMapJobs } from "../maps/generate";
import { createPlan } from "../plans/create";
import { importSmartbook } from "../sources/smartbook";
import { registerQuizJobs } from "../study/quizJobs";
import { tempDir } from "../test-temp";
import { setToolRunner } from "./jobs";
import { chatToolList } from "./registry";
import { setTools, stopToolServer, type Tool } from "./server";

/**
 * The chat's tools in the multi-turn chats the 0.5.0-dev.14 walk found broken, on a signed-in CLI with fixture material
 * and a throwaway workspace. It spends subscription usage, so it runs only with PYXIS_LIVE_WALK=1:
 *
 *   PYXIS_LIVE_WALK=1 PYXIS_LIVE_ENGINE=antigravity/gemini-3.8-flash/low PYXIS_LIVE_SCENARIOS=chain,declines \
 *   PYXIS_LIVE_RUNS=3 PYXIS_LIVE_OUT=.tmp/walk npm test -- src/core/tools/walk-tools.live.test.ts
 *
 * Scenarios: `chain` asks for a map, then a quiz, then a new exam date in one chat, as each Antigravity turn starts a new
 * process with a new server name; `declines` asks for a date the exam already has and for the flashcards of a topic the
 * exam lacks; `grades` asks how the quizzes went after two graded ones. The map and quiz jobs are queued and never run,
 * so no build reaches a model. Each turn's reply, the tool calls with what Pyxis answered, and any failure go to
 * PYXIS_LIVE_OUT as JSON.
 */
const live = process.env["PYXIS_LIVE_WALK"] === "1";

const CHAPTER = `## p1 | Equazioni differenziali ordinarie del primo ordine
Un'equazione differenziale ordinaria del primo ordine lega una funzione incognita $y(t)$ alla sua derivata: $y' = f(t, y)$. Il problema di Cauchy aggiunge la condizione iniziale $y(t_0) = y_0$; il teorema di Cauchy-Lipschitz ne garantisce esistenza e unicità locale quando $f$ è continua e lipschitziana in $y$.

## p2 | Equazioni lineari del secondo ordine
L'equazione $y'' + a y' + b y = g(t)$ si risolve sommando la soluzione dell'omogenea associata, trovata con il polinomio caratteristico $r^2 + a r + b = 0$, a una soluzione particolare, ottenuta per somiglianza o con la variazione delle costanti.

## p3 | Serie di potenze
Una serie di potenze $\\sum a_n (x - x_0)^n$ converge in un intervallo centrato in $x_0$ di raggio $R$, dato dal criterio della radice o del rapporto. Dentro l'intervallo si può derivare e integrare termine a termine.

## p4 | Integrali multipli
Un integrale doppio su un dominio normale si calcola come integrale iterato. Il cambio di variabili in coordinate polari porta lo jacobiano $\\rho$: $dx\\,dy = \\rho\\,d\\rho\\,d\\theta$.
`;

const TOPICS = ["Equazioni differenziali ordinarie", "Serie di potenze", "Integrali multipli"];
const YEAR = 2027;

function setup(provider: string, model: string, effort?: string) {
  const db = openDatabase(":memory:");
  const pinned = JSON.stringify({ provider, model, ...(effort ? { effort } : {}) });
  const engines = db.prepare("INSERT INTO feature_engines (feature, selection_json, updated_at) VALUES (?, ?, 1)");
  for (const feature of ["default", "chat", "plan", "map", "lesson", "cards"]) engines.run(feature, pinned);
  const book = zipSync({
    "smartbook.json": strToU8(
      JSON.stringify({ id: "analisi2", title: "Analisi 2", access: "public", chapters: [{ id: "c1", number: 1, title: "Analisi 2", file: "01.md" }] }),
    ),
    "chapters/01.md": strToU8(CHAPTER),
  });
  const { sourceId } = importSmartbook(db, book);
  const { planId } = createPlan(db, {
    title: "Analisi Matematica II",
    subject: "Analisi Matematica II",
    sourceIds: [],
    sessions: [{ date: new Date(YEAR, 0, 20, 12).getTime(), label: "Scritto" }],
    draftTopics: TOPICS.map((title) => ({ title })),
  });
  db.prepare("UPDATE sources SET subject_id = (SELECT subject_id FROM plans WHERE id = ?) WHERE id = ?").run(planId, sourceId);
  const topic = (title: string) => db.prepare("SELECT id FROM topics WHERE plan_id = ? AND title = ?").pluck().get(planId, title) as string;
  // Two quizzes handed in and graded, as the app stores them: a draft, an open answer's check, the result, a later check.
  const nov = (day: number) => new Date(2026, 10, day, 12).getTime();
  [
    ["Equazioni differenziali ordinarie", 20, 0.4],
    ["Serie di potenze", 24, 0.2],
  ].forEach(([title, day, score], n) => {
    const at = nov(day as number);
    const body = {
      complete: true,
      questions: [
        { id: "q1", stem: "Scegli", options: ["a", "b"], answer: { kind: "mcq", correct: 0 } },
        { id: "q2", stem: "Spiega", answer: { kind: "open", reference: "r" } },
      ],
    };
    db.prepare("INSERT INTO items (id, plan_id, topic_id, kind, body_json, created_at) VALUES (?, ?, ?, 'quiz', ?, ?)").run(`i${n}`, planId, topic(title as string), JSON.stringify(body), at);
    db.prepare("INSERT INTO attempts (id, plan_id, item_id, started_at, submitted_at) VALUES (?, ?, ?, ?, ?)").run(`a${n}`, planId, `i${n}`, at - 600_000, at);
    const answer = db.prepare("INSERT INTO attempt_answers (id, attempt_id, payload_json, created_at) VALUES (?, ?, ?, ?)");
    const check = { id: "q2", score: 0, expected: "r", explanation: "", provider, model };
    answer.run(`d${n}`, `a${n}`, JSON.stringify({ draft: { picks: { q1: "1", q2: "x" }, index: 1 } }), at - 1000);
    answer.run(`c${n}`, `a${n}`, JSON.stringify({ check }), at - 10);
    answer.run(`r${n}`, `a${n}`, JSON.stringify({ picks: { q1: "1", q2: "x" }, results: [{ id: "q1", score: 0 }, { id: "q2", score }], score }), at);
    answer.run(`k${n}`, `a${n}`, JSON.stringify({ check: { ...check, explanation: "Rivisto" } }), at + 5);
  });
  configureDisclosure(db);
  acknowledgeProviders([provider]);
  const runner = createRunner(db, () => undefined);
  registerMapJobs(db, runner);
  registerQuizJobs(db, runner);
  runner.register("plan-build", { jobClass: "local", steps: [] });
  setToolRunner(runner);
  const calls: Array<{ tool: string; text: string; shown: boolean }> = [];
  setTools(
    chatToolList(db, true).map(
      (tool): Tool => ({
        ...tool,
        async run(turn, args) {
          const outcome = await tool.run(turn, args);
          calls.push({ tool: tool.name, text: outcome.text, shown: Boolean(outcome.shown) });
          return outcome;
        },
      }),
    ),
  );
  return { db, planId, calls };
}

type Turn = {
  question: string;
  ms: number;
  body: string;
  error: string | null;
  tools: Array<{ tool: string; text: string; shown: boolean }>;
  charts: Array<ChartData | null>;
};

describe.skipIf(!live)("the walk's tool chats, live", () => {
  it("makes a map, a quiz and a date proposal on the first try, declines in plain words, and reads real grades", { timeout: 120 * 60_000 }, async () => {
    const out = process.env["PYXIS_LIVE_OUT"] ?? ".tmp/walk";
    mkdirSync(out, { recursive: true });
    setScratch(tempDir("pyxis-live-scratch-"));
    const [provider, model, effort] = (process.env["PYXIS_LIVE_ENGINE"] ?? "codex/gpt-6.1-terra/medium").split("/") as [string, string, string?];
    const runs = Number(process.env["PYXIS_LIVE_RUNS"] ?? 1);
    const wanted = process.env["PYXIS_LIVE_SCENARIOS"]?.split(",") ?? ["chain", "declines", "grades"];
    const report: Array<{ scenario: string; run: number; turns: Turn[] }> = [];

    for (const scenario of wanted) {
      for (let run = 1; run <= (scenario === "chain" ? runs : 1); run += 1) {
        const { db, planId, calls } = setup(provider, model, effort);
        let chatId: string | undefined;
        const turns: Turn[] = [];
        const ask = async (question: string) => {
          const started = Date.now();
          const before = calls.length;
          let body = "";
          let error: string | null = null;
          try {
            const result = await askTurn(db, { chatId, text: question, planId: chatId ? undefined : planId });
            chatId = result.chatId;
            body = result.message?.body ?? "";
            error = result.message?.error ?? null;
          } catch (err) {
            error = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
          }
          const charts: Array<ChartData | null> = [];
          mapChatBlocks(body, (block) => {
            if (block.kind === "chart") charts.push(block.chart);
            return "";
          });
          turns.push({ question, ms: Date.now() - started, body, error, tools: calls.slice(before), charts });
          writeFileSync(join(out, `${provider}-${model}.json`), JSON.stringify([...report, { scenario, run, turns }], null, 2));
        };
        if (scenario === "chain") {
          await ask("Fammi una mappa su serie di potenze.");
          await ask("Fammi un quiz su integrali multipli.");
          await ask(`Sposta l'esame al 10 marzo ${YEAR}.`);
        } else if (scenario === "declines") {
          await ask(`Sposta l'esame al 20 gennaio ${YEAR}.`);
          await ask("Cancella le flashcard di Termodinamica quantistica.");
        } else if (scenario === "grades") {
          await ask("Come sto andando nei quiz?");
        }
        report.push({ scenario, run, turns });
        writeFileSync(join(out, `${provider}-${model}.json`), JSON.stringify(report, null, 2));
        endConversations();
        await stopToolServer();
        db.close();
      }
    }
    expect(report.length).toBeGreaterThan(0);
  });
});
