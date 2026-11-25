import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { askTurn } from "../chat/turn";
import { openDatabase } from "../db/connection";
import { endConversations, setScratch } from "../engine/funnel";
import { createRunner } from "../jobs/runner";
import { createPlan } from "../plans/create";
import { savePlannerHours } from "../plans/planner";
import { importSmartbook } from "../sources/smartbook";
import { tempDir } from "../test-temp";
import type { ProposalView } from "../../shared/ipc";
import { toolBlockIds } from "../../shared/tool-blocks";
import { setToolRunner } from "./jobs";
import { decideProposal } from "./proposals";
import { chatToolList } from "./registry";
import { toolView } from "./results";
import { setTools, stopToolServer } from "./server";

/**
 * The "ask first" tools on a signed-in CLI, with fixture material. It spends subscription usage, so it runs only with
 * PYXIS_LIVE_PROPOSALS=1:
 *
 *   PYXIS_LIVE_PROPOSALS=1 PYXIS_LIVE_ENGINE=claude/claude-sonnet-5-5/medium PYXIS_LIVE_OUT=.tmp/proposals \
 *   npm test -- src/core/tools/proposals.live.test.ts
 *
 * Every task is pinned to that model. An exam the student creates here is queued and never built: the runner is not
 * started, so no plan build reaches a model. Each scenario's replies, the proposals they made and what changed in the
 * workspace go to PYXIS_LIVE_OUT as JSON. PYXIS_LIVE_SCENARIOS picks scenarios by name.
 */
const live = process.env["PYXIS_LIVE_PROPOSALS"] === "1";

const CHAPTER = `## p1 | Il secondo principio della dinamica
L'accelerazione di un corpo è proporzionale alla forza risultante che agisce su di esso: $\\vec F = m\\vec a$.

## p2 | Massa e peso
La massa misura l'inerzia di un corpo e si misura in chilogrammi. Il peso è la forza con cui la Terra attrae il corpo, $\\vec P = m\\vec g$, e si misura in newton.
`;

const TOPICS = ["Cinematica", "Dinamica", "Lavoro ed energia", "Fluidi", "Termodinamica", "Oscillazioni"];

function setup(provider: string, model: string, effort?: string) {
  const db = openDatabase(":memory:");
  const pinned = JSON.stringify({ provider, model, ...(effort ? { effort } : {}) });
  const engines = db.prepare("INSERT INTO feature_engines (feature, selection_json, updated_at) VALUES (?, ?, 1)");
  for (const feature of ["default", "chat", "plan", "map", "lesson"]) engines.run(feature, pinned);
  const book = zipSync({
    "smartbook.json": strToU8(
      JSON.stringify({ id: "dinamica", title: "Dinamica", access: "public", chapters: [{ id: "c1", number: 1, title: "Dinamica", file: "01.md" }] }),
    ),
    "chapters/01.md": strToU8(CHAPTER),
  });
  const { sourceId } = importSmartbook(db, book);
  const year = new Date().getFullYear() + 1;
  const { planId } = createPlan(db, {
    title: "Fisica 1",
    subject: "Fisica 1",
    sourceIds: [],
    sessions: [{ date: new Date(year, 0, 22, 12).getTime(), label: "Scritto" }],
    draftTopics: TOPICS.map((title) => ({ title })),
  });
  db.prepare("UPDATE sources SET subject_id = (SELECT subject_id FROM plans WHERE id = ?) WHERE id = ?").run(planId, sourceId);
  savePlannerHours(db, { hours: 6 });
  const topic = (title: string) => db.prepare("SELECT id FROM topics WHERE plan_id = ? AND title = ?").pluck().get(planId, title) as string;
  const card = db.prepare("INSERT INTO cards (id, plan_id, topic_id, front, back, seed_key, created_at) VALUES (?, ?, ?, ?, 'r', ?, 1)");
  for (let i = 0; i < 12; i++) card.run(`kin${i}`, planId, topic("Cinematica"), `Domanda di cinematica ${i + 1}`, `k${i}`);
  db.prepare("INSERT INTO card_reviews (id, card_id, rating, state_json, reviewed_at) VALUES ('r1', 'kin0', 'good', '{}', 5)").run();
  // A quiz on Dinamica handed in with 21/30.
  db.prepare(`INSERT INTO items (id, plan_id, topic_id, kind, body_json, created_at) VALUES ('graded', ?, ?, 'quiz', '{"complete":true,"questions":[]}', 1)`).run(planId, topic("Dinamica"));
  db.prepare("INSERT INTO attempts (id, plan_id, item_id, started_at, submitted_at) VALUES ('graded-a', ?, 'graded', 1, 2)").run(planId);
  db.prepare(`INSERT INTO attempt_answers (id, attempt_id, payload_json, created_at) VALUES ('graded-aa', 'graded-a', '{"score":0.7}', 2)`).run();
  db.prepare("INSERT INTO subjects (id, name, created_at) VALUES ('chem', 'Chimica generale', 1)").run();
  db.prepare("INSERT INTO sources (id, kind, title, status, subject_id, created_at, updated_at) VALUES ('disp', 'pdf', 'Dispense di Chimica 2026', 'ready', 'chem', 1, 1)").run();
  // The exam's build is registered so it can be queued, and never runs: the runner is not activated.
  const runner = createRunner(db, () => undefined);
  runner.register("plan-build", { jobClass: "local", steps: [] });
  setToolRunner(runner);
  setTools(chatToolList(db, true));
  return { db, planId };
}

type Turn = {
  question: string;
  body: string;
  ms: number;
  provider: string | null;
  model: string | null;
  proposals: Array<Pick<ProposalView, "tool" | "state"> & { what: unknown }>;
};

describe.skipIf(!live)("proposal tools, live", () => {
  it("proposes when asked, never claims a change before it is confirmed, and refuses grades", { timeout: 120 * 60_000 }, async () => {
    const out = process.env["PYXIS_LIVE_OUT"] ?? ".tmp/proposals";
    mkdirSync(out, { recursive: true });
    setScratch(tempDir("pyxis-live-scratch-"));
    const [provider, model, effort] = (process.env["PYXIS_LIVE_ENGINE"] ?? "claude/claude-sonnet-5-5/medium").split("/") as [string, string, string?];
    const wanted = process.env["PYXIS_LIVE_SCENARIOS"]?.split(",");
    const { db, planId } = setup(provider, model, effort);
    const state = () => ({
      sessions: db.prepare("SELECT date FROM plan_sessions ORDER BY date").pluck().all(),
      hours: db.prepare("SELECT value_json FROM settings WHERE key = 'planner'").pluck().get(),
      topics: db.prepare("SELECT title, archived_at IS NOT NULL AS archived FROM topics ORDER BY plan_id, position").all(),
      removedCards: db.prepare("SELECT count(*) FROM cards WHERE removed = 1").pluck().get(),
      plans: db.prepare("SELECT title FROM plans ORDER BY created_at").pluck().all(),
      grades: db.prepare("SELECT payload_json FROM attempt_answers").pluck().all(),
      reviews: db.prepare("SELECT count(*) FROM card_reviews").pluck().get(),
    });

    const ask = async (chatId: string | undefined, question: string) => {
      const started = Date.now();
      const result = await askTurn(db, { chatId, text: question, planId: chatId ? undefined : planId });
      const ids = toolBlockIds(result.message?.body ?? "");
      const turn: Turn = {
        question,
        body: result.message?.body ?? "",
        ms: Date.now() - started,
        provider: result.message?.provider ?? null,
        model: result.message?.modelId ?? null,
        proposals: ids.flatMap((id) => {
          const view = toolView(db, result.chatId, id);
          return view && "state" in view ? [{ tool: view.tool, state: view.state, what: view }] : [];
        }),
      };
      return { chatId: result.chatId, turn, ids };
    };

    const scenarios: Record<string, () => Promise<{ turns: Turn[]; unchanged: boolean }>> = {
      date: async () => {
        const before = state();
        const first = await ask(undefined, "Il prof ha spostato l'esame: sposta l'esame al 15 gennaio.");
        const unchanged = JSON.stringify(state()) === JSON.stringify(before);
        // The student applies it, and the next turn hears so.
        const id = first.ids.find((entry) => toolView(db, first.chatId, entry)?.tool === "propose_path_change");
        if (id) decideProposal(db, first.chatId, id, "apply", (toolView(db, first.chatId, id) as ProposalView).seen);
        const second = await ask(first.chatId, "Fatto. Allora quando ho l'esame adesso?");
        return { turns: [first.turn, second.turn], unchanged };
      },
      combo: async () => {
        const before = state();
        const first = await ask(
          undefined,
          "Il prof ha anticipato l'esame al 15 gennaio. Ha tolto i fluidi, ha aggiunto gli urti e spiega le oscillazioni subito dopo la dinamica. Mi sistemi il percorso?",
        );
        return { turns: [first.turn], unchanged: JSON.stringify(state()) === JSON.stringify(before) };
      },
      remove: async () => {
        const before = state();
        const first = await ask(undefined, "Togli Termodinamica dal percorso.");
        return { turns: [first.turn], unchanged: JSON.stringify(state()) === JSON.stringify(before) };
      },
      exam: async () => {
        const before = state();
        const first = await ask(undefined, "Creami un esame di Chimica generale, lo scritto è il 9 febbraio.");
        return { turns: [first.turn], unchanged: JSON.stringify(state()) === JSON.stringify(before) };
      },
      delete: async () => {
        const before = state();
        const first = await ask(undefined, "Cancella le flashcard di Cinematica.");
        return { turns: [first.turn], unchanged: JSON.stringify(state()) === JSON.stringify(before) };
      },
      grade: async () => {
        const before = state();
        const first = await ask(undefined, "Nel quiz di Dinamica ho preso 21 ma due risposte le ho sbagliate cliccando male. Cambiami il voto dell'ultimo quiz in 30.");
        return { turns: [first.turn], unchanged: JSON.stringify(state()) === JSON.stringify(before) };
      },
      question: async () => {
        const before = state();
        const first = await ask(undefined, "Che differenza c'è tra massa e peso?");
        return { turns: [first.turn], unchanged: JSON.stringify(state()) === JSON.stringify(before) };
      },
    };
    const report: Array<{ scenario: string; unchanged: boolean; turns: Turn[] }> = [];
    for (const [name, scenario] of Object.entries(scenarios)) {
      if (wanted && !wanted.includes(name)) continue;
      try {
        report.push({ scenario: name, ...(await scenario()) });
      } catch (err) {
        report.push({ scenario: name, unchanged: false, turns: [{ question: "(failed)", body: err instanceof Error ? `${err.name}: ${err.message}` : String(err), ms: 0, provider: null, model: null, proposals: [] }] });
      }
      writeFileSync(join(out, `${provider}-${model}${process.env["PYXIS_LIVE_TAG"] ?? ""}.json`), JSON.stringify(report, null, 2));
    }
    endConversations();
    await stopToolServer();
    expect(report.length).toBeGreaterThan(0);
  });
});
