import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../db/connection";
import { askTurn } from "../chat/turn";
import { endConversations, setScratch } from "../engine/funnel";
import { createRunner } from "../jobs/runner";
import { registerMapJobs } from "../maps/generate";
import { readStoredMap } from "../maps/store";
import { importSmartbook } from "../sources/smartbook";
import { readQuiz, registerQuizJobs } from "../study/quizJobs";
import { tempDir } from "../test-temp";
import type { MapResultView, QuizResultView } from "../../shared/ipc";
import { toolBlockIds } from "../../shared/tool-blocks";
import { setToolRunner } from "./jobs";
import { chatToolList } from "./registry";
import { toolView } from "./results";
import { setTools, stopToolServer } from "./server";

/**
 * The chat's map and quiz tools on a signed-in CLI, with fixture material, and the map and quiz jobs on the same tool.
 * It spends subscription usage, so it runs only with PYXIS_LIVE_MAP_QUIZ=1:
 *
 *   PYXIS_LIVE_MAP_QUIZ=1 PYXIS_LIVE_ENGINE=claude/claude-sonnet-5-5/medium PYXIS_LIVE_OUT=.tmp/map-quiz \
 *   npm test -- src/core/tools/map-quiz.live.test.ts
 *
 * Every task (chat, map, quiz) is pinned to that model, so no job moves to a stronger one. PYXIS_LIVE_SCENARIOS picks
 * scenarios by name; PYXIS_LIVE_RUNS repeats the map and the quiz. Each turn's reply, what its tools made and the map's
 * concepts or the quiz's questions go to PYXIS_LIVE_OUT as JSON, for reading.
 */
const live = process.env["PYXIS_LIVE_MAP_QUIZ"] === "1";

const CHAPTER = `## p1 | Il primo principio della dinamica
Un corpo non soggetto a forze, o soggetto a forze con risultante nulla, mantiene il suo stato di quiete o di moto rettilineo uniforme. Questo principio, detto anche principio d'inerzia, vale nei sistemi di riferimento inerziali.

## p2 | Il secondo principio della dinamica
L'accelerazione di un corpo è proporzionale alla forza risultante che agisce su di esso e inversamente proporzionale alla sua massa: $\\vec F = m\\vec a$. Nel Sistema Internazionale la forza si misura in newton, con $1\\,\\mathrm{N} = 1\\,\\mathrm{kg\\,m/s^2}$.

## p3 | Il terzo principio della dinamica
Se un corpo A esercita una forza su un corpo B, allora B esercita su A una forza uguale in modulo e direzione e opposta in verso: $\\vec F_{AB} = -\\vec F_{BA}$. Le due forze agiscono su corpi diversi e quindi non si annullano.

## p4 | L'attrito
La forza di attrito si oppone al moto relativo di due superfici a contatto. L'attrito statico impedisce l'inizio del moto fino a un valore massimo $\\mu_s N$; l'attrito dinamico agisce durante lo strisciamento e vale $\\mu_d N$, con $\\mu_d < \\mu_s$.

## p5 | Massa e peso
La massa misura l'inerzia di un corpo e si misura in chilogrammi. Il peso è la forza con cui la Terra attrae il corpo, $\\vec P = m\\vec g$, con $g \\approx 9{,}81\\,\\mathrm{m/s^2}$, e si misura in newton.
`;

function setup(provider: string, model: string, effort?: string) {
  const db = openDatabase(":memory:");
  const pinned = JSON.stringify({ provider, model, ...(effort ? { effort } : {}) });
  const engines = db.prepare("INSERT INTO feature_engines (feature, selection_json, updated_at) VALUES (?, ?, 1)");
  for (const feature of ["default", "chat", "map", "lesson"]) engines.run(feature, pinned);
  const book = zipSync({
    "smartbook.json": strToU8(
      JSON.stringify({ id: "dinamica", title: "Dinamica", access: "public", chapters: [{ id: "c1", number: 1, title: "Dinamica", file: "01.md" }] }),
    ),
    "chapters/01.md": strToU8(CHAPTER),
  });
  const { sourceId } = importSmartbook(db, book);
  db.prepare("INSERT INTO subjects (id, name, created_at) VALUES ('phys', 'Fisica 1', 1)").run();
  db.prepare("UPDATE sources SET subject_id = 'phys' WHERE id = ?").run(sourceId);
  // The exam of the quiz chats, with the dynamics as one topic over the whole chapter.
  db.prepare("INSERT INTO plans (id, subject_id, title, status, created_at, updated_at) VALUES ('mech', 'phys', 'Fisica 1', 'ready', 1, 1)").run();
  db.prepare("INSERT INTO topics (id, plan_id, title, position, created_at) VALUES ('dyn', 'mech', 'Dinamica', 0, 1)").run();
  db.prepare("INSERT INTO topic_passages (topic_id, passage_id) SELECT 'dyn', id FROM passages").run();
  const runner = createRunner(db, () => undefined);
  registerMapJobs(db, runner);
  registerQuizJobs(db, runner);
  setToolRunner(runner);
  setTools(chatToolList(db, true));
  return db;
}

type Made = { tool: string; view: MapResultView | QuizResultView | null; content: unknown };
/** A real 1×1 PNG, so a figure the model writes is kept as drawn. */
const PIXEL = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

type Turn = {
  question: string;
  body: string;
  ms: number;
  jobMs: number;
  provider: string | null;
  model: string | null;
  made: Made[];
  /** The kinds of the figures the model wrote, in order. */
  figures: string[];
};

describe.skipIf(!live)("map and quiz tools, live", () => {
  it("creates a map or a quiz when asked, and only then", { timeout: 180 * 60_000 }, async () => {
    const out = process.env["PYXIS_LIVE_OUT"] ?? ".tmp/map-quiz";
    mkdirSync(out, { recursive: true });
    setScratch(tempDir("pyxis-live-scratch-"));
    const [provider, model, effort] = (process.env["PYXIS_LIVE_ENGINE"] ?? "claude/claude-sonnet-5-5/medium").split("/") as [string, string, string?];
    const runs = Number(process.env["PYXIS_LIVE_RUNS"] ?? 3);
    const wanted = process.env["PYXIS_LIVE_SCENARIOS"]?.split(",");
    const db = setup(provider, model, effort);

    /** What one result made, once its job is over: the map's concepts by branch, or the quiz's questions. */
    const content = (view: MapResultView | QuizResultView) => {
      if (view.tool === "create_map") {
        const map = readStoredMap(db, { subjectId: view.subjectId }, view.mapId);
        const nodes = map?.graph.nodes ?? [];
        return {
          title: map?.title,
          branches: nodes.filter((node) => node.parent === nodes.find((root) => root.parent === null)?.id).map((branch) => ({
            branch: branch.label,
            under: nodes.filter((node) => node.parent === branch.id).map((node) => node.label),
          })),
        };
      }
      try {
        return readQuiz(db, view.attemptId).questions.map((question) => ({ stem: question.stem, options: question.options }));
      } catch {
        return null;
      }
    };

    const ask = async (question: string, planId: string | null) => {
      const started = Date.now();
      const figures: string[] = [];
      const result = await askTurn(db, {
        text: question,
        subject: "Fisica 1",
        ...(planId ? { planId } : {}),
        // Every figure kind is offered, as with the drawing packs downloaded; nothing is drawn.
        python: async (_code, _timeout, figure) => {
          figures.push(figure?.kind ?? "plot");
          return { stdout: "", stderr: "", images: [PIXEL], timedOut: false, truncated: false };
        },
      });
      const body = result.message?.body ?? "";
      const ended = Date.now();
      const ids = toolBlockIds(body);
      // The reply is over; the jobs it started go on. Each is waited for, at most ten minutes.
      for (let i = 0; i < 1200; i++) {
        const views = ids.map((id) => toolView(db, result.chatId, id));
        if (views.every((view) => !view || !("job" in view) || view.job !== "working")) break;
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      const made = ids.map((id) => {
        const view = toolView(db, result.chatId, id);
        return {
          tool: view?.tool ?? "?",
          view: view && (view.tool === "create_map" || view.tool === "create_quiz") ? view : null,
          content: view && (view.tool === "create_map" || view.tool === "create_quiz") && view.job === "done" ? content(view) : null,
        };
      });
      const turn: Turn = {
        question,
        body,
        ms: ended - started,
        jobMs: Date.now() - ended,
        provider: result.message?.provider ?? null,
        model: result.message?.modelId ?? null,
        made,
        figures,
      };
      return turn;
    };

    const scenarios: Record<string, () => Promise<Turn>> = {
      map: () => ask("Fammi una mappa concettuale sulla dinamica.", null),
      quiz: () => ask("Preparami un quiz sull'attrito, voglio vedere se sono pronta.", "mech"),
      question: () => ask("Che differenza c'è tra massa e peso?", "mech"),
      figure: () =>
        ask(
          "Disegnami il grafo di questo automa: stati q0, q1, q2; da q0 con a si va in q1, da q1 con b in q2, da q2 con a si torna in q0. q2 è finale.",
          null,
        ),
    };
    const repeat = new Set(["map", "quiz"]);
    const report: Array<{ scenario: string; run: number; turn: Turn }> = [];
    for (const [name, scenario] of Object.entries(scenarios)) {
      if (wanted && !wanted.includes(name)) continue;
      for (let run = 1; run <= (repeat.has(name) ? runs : 1); run += 1) {
        let turn: Turn;
        try {
          turn = await scenario();
        } catch (err) {
          turn = { question: name, body: err instanceof Error ? `${err.name}: ${err.message}` : String(err), ms: 0, jobMs: 0, provider: null, model: null, made: [], figures: [] };
        }
        report.push({ scenario: name, run, turn });
        writeFileSync(join(out, `${provider}-${model}.json`), JSON.stringify(report, null, 2));
      }
    }
    endConversations();
    await stopToolServer();
    setToolRunner(undefined);
    expect(report.length).toBeGreaterThan(0);
    // The report is written whatever happened; the run passes only when each map and quiz asked for was made and
    // finished, and the plain question and the figure made nothing.
    const wrong = report.flatMap(({ scenario, run, turn }) => {
      const made = turn.made.map((entry) => `${entry.tool}:${entry.view?.job ?? "?"}`);
      const expected = scenario === "map" ? ["create_map:done"] : scenario === "quiz" ? ["create_quiz:done"] : [];
      return JSON.stringify(made) === JSON.stringify(expected) ? [] : [`${scenario} ${run}: made ${JSON.stringify(made)}`];
    });
    expect(wrong).toEqual([]);
  });
});
