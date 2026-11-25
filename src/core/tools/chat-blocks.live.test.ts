import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { mapChatBlocks, type ChartData, type ChatQuestion } from "../../shared/chat-blocks";
import { openDatabase } from "../db/connection";
import { askTurn } from "../chat/turn";
import { endConversations, setScratch } from "../engine/funnel";
import { importSmartbook } from "../sources/smartbook";
import { tempDir } from "../test-temp";
import { chatToolList } from "./registry";
import { setTools, stopToolServer, type Tool } from "./server";

/**
 * The chat's chart and question blocks and read_progress on a signed-in CLI, with fixture material and a throwaway
 * workspace. It spends subscription usage, so it runs only with PYXIS_LIVE_CHAT_BLOCKS=1:
 *
 *   PYXIS_LIVE_CHAT_BLOCKS=1 PYXIS_LIVE_ENGINE=claude/claude-sonnet-5-5/medium PYXIS_LIVE_OUT=.tmp/chat-blocks \
 *   npm test -- src/core/tools/chat-blocks.live.test.ts
 *
 * PYXIS_LIVE_SCENARIOS picks scenarios by name (comma-separated); PYXIS_LIVE_RUNS repeats `grades` and `test-me`. Each
 * reply, what read_progress returned, the charts and questions it holds, and the numbers in its charts that the tool
 * did not return go to PYXIS_LIVE_OUT as JSON, for reading.
 */
const live = process.env["PYXIS_LIVE_CHAT_BLOCKS"] === "1";

const CHAPTER = `## p1 | Il secondo principio della dinamica
L'accelerazione di un corpo è proporzionale alla forza risultante che agisce su di esso e inversamente proporzionale alla sua massa: $\\vec F = m\\vec a$. Nel Sistema Internazionale la forza si misura in newton, con $1\\,\\mathrm{N} = 1\\,\\mathrm{kg\\,m/s^2}$.

## p2 | L'attrito statico
Un corpo fermo su una superficie scabra resta fermo finché la forza applicata non supera $\\mu_s N$. Fino a quel limite la forza di attrito statico vale esattamente quanto serve a equilibrare le altre forze lungo la superficie.
`;

/** A workspace with Fisica 1, its exam "Meccanica" and, with `grades`, five quizzes handed in over three topics. */
function setup(provider: string, model: string, effort: string | undefined, grades: boolean) {
  const db = openDatabase(":memory:");
  db.prepare("INSERT INTO feature_engines (feature, selection_json, updated_at) VALUES ('default', ?, 1), ('chat', ?, 1)").run(
    JSON.stringify({ provider, model, ...(effort ? { effort } : {}) }),
    JSON.stringify({ provider, model, ...(effort ? { effort } : {}) }),
  );
  const book = zipSync({
    "smartbook.json": strToU8(
      JSON.stringify({ id: "dinamica", title: "Dinamica", access: "public", chapters: [{ id: "c1", number: 1, title: "Dinamica", file: "01.md" }] }),
    ),
    "chapters/01.md": strToU8(CHAPTER),
  });
  const { sourceId } = importSmartbook(db, book);
  const run = (sql: string, ...args: unknown[]) => db.prepare(sql).run(...args);
  run("INSERT INTO subjects (id, name, created_at) VALUES ('phys', 'Fisica 1', 1)");
  run("UPDATE sources SET subject_id = 'phys' WHERE id = ?", sourceId);
  run("INSERT INTO plans (id, subject_id, title, status, target, created_at, updated_at) VALUES ('mech', 'phys', 'Fisica 1', 'ready', 0.75, 1, 1)");
  const topics = ["Cinematica", "Dinamica del punto", "Lavoro ed energia", "Oscillazioni", "Termodinamica"];
  topics.forEach((title, index) =>
    run("INSERT INTO topics (id, plan_id, title, position, created_at) VALUES (?, 'mech', ?, ?, 1)", `t${index}`, title, index),
  );
  if (grades) {
    const nov = (day: number) => new Date(2026, 10, day, 12).getTime();
    [
      [0, 2, 0.6],
      [0, 9, 0.8667],
      [1, 19, 0.7],
      [2, 14, 0.8],
      [3, 16, 0.5667],
    ].forEach(([topic, day, score], index) => {
      run("INSERT INTO items (id, plan_id, topic_id, kind, body_json, created_at) VALUES (?, 'mech', ?, 'quiz', '{}', ?)", `i${index}`, `t${topic}`, nov(day!));
      run("INSERT INTO attempts (id, plan_id, item_id, started_at, submitted_at) VALUES (?, 'mech', ?, ?, ?)", `a${index}`, `i${index}`, nov(day!) - 600_000, nov(day!));
      run("INSERT INTO attempt_answers (id, attempt_id, payload_json, created_at) VALUES (?, ?, ?, ?)", `aa${index}`, `a${index}`, JSON.stringify({ picks: {}, score }), nov(day!));
    });
  }
  const calls: Array<{ tool: string; text: string }> = [];
  // Every call and what the model read back, so a chart's numbers can be held against the tool's.
  setTools(
    chatToolList(db).map(
      (tool): Tool => ({
        ...tool,
        async run(turn, args) {
          const outcome = await tool.run(turn, args);
          calls.push({ tool: tool.name, text: outcome.text });
          return outcome;
        },
      }),
    ),
  );
  return { db, calls };
}

type Report = {
  scenario: string;
  run: number;
  question: string;
  ms: number;
  body: string;
  tools: Array<{ tool: string; text: string }>;
  charts: Array<ChartData | null>;
  questions: Array<ChatQuestion | null>;
  /** Numbers drawn in a chart that read_progress did not return. */
  invented: number[];
  /** The engine failure that cut the reply short, such as a quota notice. */
  error: string | null;
};

/** Every number in the tool's answer, as written there. */
function numbersIn(text: string): Set<number> {
  return new Set([...text.matchAll(/-?\d+(?:\.\d+)?/g)].map((match) => Number(match[0])));
}

describe.skipIf(!live)("chat blocks, live", () => {
  it("draws the student's real grades, asks practice questions when asked, and only then", { timeout: 120 * 60_000 }, async () => {
    const out = process.env["PYXIS_LIVE_OUT"] ?? ".tmp/chat-blocks";
    mkdirSync(out, { recursive: true });
    setScratch(tempDir("pyxis-live-scratch-"));
    const [provider, model, effort] = (process.env["PYXIS_LIVE_ENGINE"] ?? "claude/claude-sonnet-5-5/medium").split("/") as [string, string, string?];
    const runs = Number(process.env["PYXIS_LIVE_RUNS"] ?? 3);
    const wanted = process.env["PYXIS_LIVE_SCENARIOS"]?.split(",");

    const ask = async (scenario: string, run: number, question: string, grades: boolean): Promise<Report> => {
      const { db, calls } = setup(provider, model, effort, grades);
      const started = Date.now();
      let body = "";
      let error: string | null = null;
      try {
        const result = await askTurn(db, { text: question, subject: "Fisica 1", planId: "mech" });
        body = result.message?.body ?? "";
        error = result.message?.error ?? null;
      } catch (err) {
        error = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      }
      const charts: Report["charts"] = [];
      const questions: Report["questions"] = [];
      mapChatBlocks(body, (block) => {
        if (block.kind === "chart") charts.push(block.chart);
        else questions.push(block.question);
        return null;
      });
      const known = numbersIn(calls.filter((call) => call.tool === "read_progress").map((call) => call.text).join(" "));
      const drawn = charts.flatMap((chart) =>
        chart ? [...chart.series.flatMap((series) => series.points.flatMap((point) => (point.value === null ? [] : [point.value]))), ...(chart.reference ? [chart.reference.value] : [])] : [],
      );
      db.close();
      return {
        scenario,
        run,
        question,
        ms: Date.now() - started,
        body,
        tools: calls,
        charts,
        questions,
        invented: drawn.filter((value) => !known.has(value)),
        error,
      };
    };

    const scenarios: Record<string, { question: string; grades: boolean }> = {
      grades: { question: "Fammi un grafico dei miei voti nei quiz di Fisica 1.", grades: true },
      "no-grades": { question: "Fammi un grafico dei miei voti nei quiz di Fisica 1.", grades: false },
      "test-me": { question: "Mettimi alla prova sull'attrito statico: fammi una domanda.", grades: true },
      plain: { question: "Che differenza c'è tra massa e peso?", grades: true },
    };
    const repeat = new Set(["grades", "test-me"]);
    const report: Report[] = [];
    // A failure (a quota notice, a sign-in) ends the whole run: asking again would only spend another refused call.
    scenarios: for (const [name, { question, grades }] of Object.entries(scenarios)) {
      if (wanted && !wanted.includes(name)) continue;
      for (let run = 1; run <= (repeat.has(name) ? runs : 1); run += 1) {
        const turn = await ask(name, run, question, grades);
        report.push(turn);
        endConversations();
        writeFileSync(join(out, `${provider}-${model}.json`), JSON.stringify(report, null, 2));
        if (turn.error) break scenarios;
      }
    }
    await stopToolServer();
    expect(report.length).toBeGreaterThan(0);
  });
});
