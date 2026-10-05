import { describe, expect, it } from "vitest";
import { openDatabase } from "../db/connection";
import type { GenerateInput } from "../engine/generate";
import type { Runner } from "../jobs/runner";
import { createRunner } from "../jobs/runner";
import { planSeries, syncGaps } from "../plans/progress";
import { registerQuizGradingJobs, submitQuiz } from "./quizGrading";
import { saveQuiz, startAttempt } from "./attempt";
import { insertGap } from "./gapRows";
import { enqueueGapInsights, gapEvidence, gapMisses, registerGapInsightJobs } from "./gapInsight";

const NOW = Date.UTC(2026, 5, 1, 12);

const LONG = `${"Velocity is a vector quantity with both magnitude and direction. ".repeat(6)}Speed has no direction.`;

type Wrong = { id: string; stem: string; pick?: string; kind?: "mcq" | "open"; score?: number };

/** One topic with a passage and an open gap, plus helpers that add graded review attempts. */
function fixture() {
  const db = openDatabase(":memory:");
  db.prepare(
    "INSERT INTO feature_engines (feature, selection_json, updated_at) VALUES ('default', ?, 1)",
  ).run(JSON.stringify({ provider: "claude", model: "claude-sonnet-5" }));
  db.prepare(
    "INSERT INTO plans (id, title, status, content_language, created_at, updated_at) VALUES ('plan', 'Physics', 'ready', 'en', 1, 1)",
  ).run();
  db.prepare("INSERT INTO topics (id, plan_id, title, position, created_at) VALUES ('topic', 'plan', 'Motion', 0, 1)").run();
  db.prepare(
    "INSERT INTO sources (id, kind, title, status, created_at, updated_at) VALUES ('src', 'pdf', 'Notes', 'ready', 1, 1)",
  ).run();
  db.prepare("INSERT INTO source_documents (id, source_id, version, tree_json, created_at) VALUES ('doc', 'src', 1, '{}', 1)").run();
  db.prepare(
    "INSERT INTO passages (id, source_id, document_id, text, created_at) VALUES ('p', 'src', 'doc', 'Velocity is displacement per time.', 1)",
  ).run();
  db.prepare("INSERT INTO topic_passages (topic_id, passage_id) VALUES ('topic', 'p')").run();
  addReview(db, "att", NOW + 1000, [
    { id: "q1", stem: "Which quantity has a direction?", pick: "0" },
    { id: "q3", stem: "Does speed include direction?", pick: "0" },
  ]);
  return db;
}

/** A submitted review: its item keeps no topic, so each question names its own, as real reviews do. */
function addReview(db: ReturnType<typeof openDatabase>, id: string, at: number, wrongs: Wrong[], topicId = "topic") {
  const questions = wrongs.map((wrong) => ({
    id: wrong.id,
    topicId,
    stem: wrong.stem,
    sourceIds: ["p"],
    options: ["Speed", "Velocity"],
    answer: { kind: wrong.kind ?? "mcq", correct: 1 },
  }));
  db.prepare(
    "INSERT INTO items (id, plan_id, kind, body_json, grounding, created_at) VALUES (?, 'plan', 'review', ?, 'sources', 1)",
  ).run(`item-${id}`, JSON.stringify({ questions }));
  db.prepare("INSERT INTO attempts (id, plan_id, item_id, started_at, submitted_at) VALUES (?, 'plan', ?, ?, ?)").run(
    id,
    `item-${id}`,
    at - 1000,
    at,
  );
  db.prepare("INSERT INTO attempt_answers (id, attempt_id, payload_json, created_at) VALUES (?, ?, ?, ?)").run(
    `ans-${id}`,
    id,
    JSON.stringify({
      picks: Object.fromEntries(wrongs.map((wrong) => [wrong.id, wrong.pick ?? "0"])),
      results: wrongs.map((wrong) => ({
        id: wrong.id,
        score: wrong.score ?? 0,
        expected: "Velocity",
        explanation: id === "att" ? "Velocity is a vector. Speed is not." : LONG,
      })),
      score: 0,
    }),
    at,
  );
  // What grading records for each topic of a graded attempt, then the sync it runs.
  db.prepare(
    "INSERT INTO learning_events (id, kind, plan_id, topic_id, payload_json, created_at) VALUES (?, 'answer_given', 'plan', ?, ?, ?)",
  ).run(
    `ev-${id}`,
    topicId,
    JSON.stringify({
      attemptId: id,
      evidenceKind: "quiz",
      score: 0,
      scores: wrongs.map((wrong) => wrong.score ?? 0),
      questionScores: wrongs.map((wrong) => ({ id: wrong.id, kind: wrong.kind ?? "mcq", score: wrong.score ?? 0 })),
    }),
    at,
  );
  syncGaps(db, "plan", at);
}

/** Records registrations and started jobs; `runJob` executes the registered step like the runner would, persisting params. */
function fakeRunner(db: ReturnType<typeof fixture>) {
  const specs = new Map<string, Parameters<Runner["register"]>[1]>();
  const runner = {
    register: (kind: string, spec: Parameters<Runner["register"]>[1]) => specs.set(kind, spec),
    start: (kind: string, params: object) => {
      const id = `job-${Math.random()}`;
      db.prepare(
        "INSERT INTO jobs (id, kind, state, params_json, created_at, updated_at) VALUES (?, ?, 'queued', ?, ?, 1)",
      ).run(id, kind, JSON.stringify(params), Date.now());
      return id;
    },
  } as unknown as Runner;
  const jobs = () =>
    db.prepare("SELECT id, params_json FROM jobs WHERE kind = 'gap-insight' ORDER BY created_at, rowid").all() as Array<{
      id: string;
      params_json: string;
    }>;
  const runJob = async (job: { id: string; params_json: string }, controller = new AbortController()) =>
    specs.get("gap-insight")!.steps[0]!.run({
      params: JSON.parse(job.params_json) as unknown,
      signal: controller.signal,
      setParams: (params: unknown) =>
        db.prepare("UPDATE jobs SET params_json = ? WHERE id = ?").run(JSON.stringify(params), job.id),
    } as never);
  const stored = (job: { id: string }) =>
    (JSON.parse((db.prepare("SELECT params_json FROM jobs WHERE id = ?").get(job.id) as { params_json: string }).params_json) as {
      analysis?: { misconception: string; severity: string; outcome: string; provider: string; model: string };
    }).analysis;
  return { runner, jobs, runJob, stored };
}

const answering =
  (...replies: Array<{ misconception: string; severity: "severe" | "minor" }>): GenerateInput["run"] =>
  async () =>
    ({ text: "", structured: replies.shift(), provider: "claude", model: "model-x" }) as never;

/** Vectors for the embedding tests: the misconceptions below are told apart by their first coordinate. */
const vectors: Record<string, [number, number]> = {
  "Treats velocity as if it had no direction.": [1, 0],
  "Thinks velocity ignores direction.": [0.99, 0.05],
  "Confuses displacement with distance travelled.": [0, 1],
  "Mixes up acceleration with speed.": [0.7, -0.7],
};
const embedding =
  (map = vectors) =>
  async (text: string) => {
    const hit = map[text.replace(/^query: /, "")];
    return hit ? Float32Array.from(hit) : null;
  };

type GapRow = {
  id: string;
  origin: string;
  misconception: string | null;
  severity: string | null;
  comparison: string | null;
  closed_at: number | null;
  merged_into: string | null;
};
/** The topic's gaps, oldest first, open or not. */
const allGaps = (db: ReturnType<typeof fixture>) =>
  db
    .prepare("SELECT id, origin, misconception, severity, comparison, closed_at, merged_into FROM gaps WHERE topic_id = 'topic' ORDER BY opened_at, id")
    .all() as GapRow[];
const openGapsOf = (db: ReturnType<typeof fixture>) => allGaps(db).filter((gap) => gap.closed_at == null);
/** The topic's only gap. */
const gapRow = (db: ReturnType<typeof fixture>) => {
  const rows = openGapsOf(db);
  expect(rows).toHaveLength(1);
  return rows[0]!;
};
/** The attempts whose wrong answers count for one gap. */
const linked = (db: ReturnType<typeof fixture>, gapId: string) =>
  (db.prepare("SELECT DISTINCT attempt_id FROM gap_answers WHERE gap_id = ? ORDER BY attempt_id").pluck().all(gapId) as string[]);

describe("gap insight (PRO-02, 4.7)", () => {
  it("reads review mistakes with the student's own answer, and only for the gap's topic", () => {
    const db = fixture();
    db.prepare("INSERT INTO topics (id, plan_id, title, position, created_at) VALUES ('other', 'plan', 'Other', 1, 1)").run();
    addReview(db, "other", NOW + 2000, [{ id: "x1", stem: "Unrelated A" }, { id: "x2", stem: "Unrelated B" }], "other");
    expect(gapMisses(db, gapRow(db).id)).toEqual([
      {
        question: "Which quantity has a direction?",
        answer: "Speed",
        expected: "Velocity",
        explanation: "Velocity is a vector.",
        passageIds: ["p"],
      },
      {
        question: "Does speed include direction?",
        answer: "Speed",
        expected: "Velocity",
        explanation: "Velocity is a vector.",
        passageIds: ["p"],
      },
    ]);
  });

  it("filters by topic before the row limit, so other topics' recent attempts cannot push the evidence out", () => {
    const db = fixture();
    db.prepare("INSERT INTO topics (id, plan_id, title, position, created_at) VALUES ('other', 'plan', 'Other', 1, 1)").run();
    for (let n = 0; n < 10; n++)
      addReview(db, `mixed-${n}`, NOW + 2000 + n, [{ id: `m${n}a`, stem: `Other A${n}` }, { id: `m${n}b`, stem: `Other B${n}` }], "other");
    const gap = gapRow(db);
    // The gap's own links read exactly its attempts...
    expect(gapEvidence(db, gap.id).map((wrong) => wrong.question)).toEqual([
      "Which quantity has a direction?",
      "Does speed include direction?",
    ]);
    // ...and a gap with no links (flag-only, or older than links) reads its topic's misses, not the newest eight rows.
    db.prepare("DELETE FROM gap_answers").run();
    expect(gapEvidence(db, gap.id).map((wrong) => wrong.question).sort()).toEqual([
      "Does speed include direction?",
      "Which quantity has a direction?",
    ]);
  });

  it("keeps bounded but meaningful evidence for the model apart from the short UI form", () => {
    const db = fixture();
    addReview(db, "long", NOW + 3000, [{ id: "l1", stem: `${"Which quantity has a direction? ".repeat(10)}End.`, pick: "0" }, { id: "l2", stem: "Second." }]);
    const id = gapRow(db).id;
    const full = gapEvidence(db, id).find((wrong) => wrong.question.startsWith("Which quantity has a direction? Which"))!;
    expect(full.explanation.length).toBeGreaterThan(200);
    expect(full.explanation.length).toBeLessThanOrEqual(900);
    expect(full.explanation).toContain("Speed has no direction");
    expect(full.question.length).toBeGreaterThan(160);
    const short = gapMisses(db, id, 5).find((miss) => miss.question.startsWith("Which quantity has a direction? Which"))!;
    expect(short.question.length).toBeLessThanOrEqual(160);
    expect(short.explanation).toBe("Velocity is a vector quantity with both magnitude and direction.");
  });

  it("starts one analysis per qualifying attempt and topic, not one per gap", () => {
    const db = fixture();
    const { runner, jobs } = fakeRunner(db);
    enqueueGapInsights(db, runner, "att");
    enqueueGapInsights(db, runner, "att");
    expect(jobs()).toHaveLength(1);
    expect(JSON.parse(jobs()[0]!.params_json)).toMatchObject({ topicId: "topic", attemptId: "att" });
    // A later qualifying attempt on the same open gap is analysed too.
    addReview(db, "att2", NOW + 5000, [{ id: "a", stem: "A?" }, { id: "b", stem: "B?" }]);
    enqueueGapInsights(db, runner, "att2");
    expect(jobs()).toHaveLength(2);
  });

  it("skips attempts that do not qualify, topics without an open gap, and archived topics", () => {
    const db = fixture();
    const { runner, jobs } = fakeRunner(db);
    // One wrong closed answer is not enough; one wrong open answer scored under 0.3 is.
    addReview(db, "single", NOW + 2000, [{ id: "s", stem: "Single?" }]);
    enqueueGapInsights(db, runner, "single");
    expect(jobs()).toHaveLength(0);
    addReview(db, "open-high", NOW + 2500, [{ id: "o", stem: "Explain.", kind: "open", score: 0.5 }]);
    enqueueGapInsights(db, runner, "open-high");
    expect(jobs()).toHaveLength(0);
    addReview(db, "open-low", NOW + 3000, [{ id: "o2", stem: "Explain again.", kind: "open", score: 0.1 }]);
    enqueueGapInsights(db, runner, "open-low");
    expect(jobs()).toHaveLength(1);
    db.prepare("DELETE FROM jobs").run();
    db.prepare("UPDATE gaps SET closed_at = ?").run(NOW + 4000);
    enqueueGapInsights(db, runner, "att");
    expect(jobs()).toHaveLength(0);
    db.prepare("UPDATE gaps SET closed_at = NULL").run();
    db.prepare("UPDATE topics SET archived_at = 1").run();
    enqueueGapInsights(db, runner, "att");
    expect(jobs()).toHaveLength(0);
  });

  it("sends one attempt's full evidence in one call, stores the result once, and records the provenance", async () => {
    const db = fixture();
    // A later attempt on the topic must not leak into the evidence of this one.
    addReview(db, "later", NOW + 2000, [{ id: "o1", stem: "From a later attempt A?" }, { id: "o2", stem: "B?" }]);
    const calls: Array<{ system?: string; prompt: string }> = [];
    const run: GenerateInput["run"] = async (input) => {
      calls.push({ system: input.system, prompt: input.prompt });
      return {
        text: "",
        structured: { misconception: "Treats velocity as if it had no direction.", severity: "severe" },
        provider: "codex",
        model: "gpt-x",
      } as never;
    };
    const { runner, jobs, runJob, stored } = fakeRunner(db);
    registerGapInsightJobs(db, runner, run, embedding());
    enqueueGapInsights(db, runner, "att");
    const job = jobs()[0]!;
    await runJob(job);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.system).toContain("English");
    const sent = JSON.parse(calls[0]!.prompt) as { mistakes: Array<Record<string, string>>; passages: string[] };
    expect(sent.mistakes).toEqual([
      { question: "Which quantity has a direction?", answer: "Speed", expected: "Velocity", explanation: "Velocity is a vector. Speed is not." },
      { question: "Does speed include direction?", answer: "Speed", expected: "Velocity", explanation: "Velocity is a vector. Speed is not." },
    ]);
    expect(sent.passages).toEqual(["Velocity is displacement per time."]);
    const gap = gapRow(db);
    expect(gap).toMatchObject({ misconception: "Treats velocity as if it had no direction.", severity: "severe" });
    expect(stored(job)).toMatchObject({ outcome: "first", gapId: gap.id, provider: "codex", model: "gpt-x", severity: "severe" });
    // A repeat of the finished job costs no model call.
    await runJob({ id: job.id, params_json: JSON.stringify({ ...JSON.parse(job.params_json), analysis: stored(job) }) });
    expect(calls).toHaveLength(1);
  });

  it("analyses a second qualifying attempt on the same gap and merges a close misconception into it", async () => {
    const db = fixture();
    const { runner, jobs, runJob, stored } = fakeRunner(db);
    registerGapInsightJobs(
      db,
      runner,
      answering(
        { misconception: "Treats velocity as if it had no direction.", severity: "minor" },
        { misconception: "Thinks velocity ignores direction.", severity: "severe" },
      ),
      embedding(),
    );
    enqueueGapInsights(db, runner, "att");
    await runJob(jobs()[0]!);
    addReview(db, "att2", NOW + 5000, [{ id: "a", stem: "A?" }, { id: "b", stem: "B?" }]);
    enqueueGapInsights(db, runner, "att2");
    await runJob(jobs()[1]!);
    // One gap: the text of the first stays; severity follows the more severe reading; both attempts count for it.
    const gap = gapRow(db);
    expect(gap).toMatchObject({ misconception: "Treats velocity as if it had no direction.", severity: "severe" });
    expect(stored(jobs()[1]!)).toMatchObject({ outcome: "merged", gapId: gap.id, misconception: "Thinks velocity ignores direction." });
    expect(linked(db, gap.id)).toEqual(["att", "att2"]);
  });

  it("opens a separate gap for a distinct misconception, with its own id, evidence and wrong answers", async () => {
    const db = fixture();
    const { runner, jobs, runJob, stored } = fakeRunner(db);
    registerGapInsightJobs(
      db,
      runner,
      answering(
        { misconception: "Treats velocity as if it had no direction.", severity: "minor" },
        { misconception: "Confuses displacement with distance travelled.", severity: "minor" },
        { misconception: "Mixes up acceleration with speed.", severity: "severe" },
      ),
      embedding(),
    );
    enqueueGapInsights(db, runner, "att");
    await runJob(jobs()[0]!);
    addReview(db, "att2", NOW + 5000, [{ id: "a", stem: "A?" }, { id: "b", stem: "B?" }]);
    enqueueGapInsights(db, runner, "att2");
    await runJob(jobs()[1]!);
    const [first, second] = openGapsOf(db);
    expect(openGapsOf(db)).toHaveLength(2);
    expect(stored(jobs()[1]!)).toMatchObject({ outcome: "distinct", gapId: second!.id });
    expect(first).toMatchObject({ misconception: "Treats velocity as if it had no direction.", severity: "minor", origin: "answers" });
    expect(second).toMatchObject({ misconception: "Confuses displacement with distance travelled.", origin: "misconception", comparison: null });
    // Each gap keeps the answers behind its own misconception.
    expect(linked(db, first!.id)).toEqual(["att"]);
    expect(linked(db, second!.id)).toEqual(["att2"]);
    expect(gapEvidence(db, second!.id).map((wrong) => wrong.question)).toEqual(["A?", "B?"]);
    expect(gapEvidence(db, first!.id).map((wrong) => wrong.question)).toEqual(["Which quantity has a direction?", "Does speed include direction?"]);
    // A third, more severe reading is a third gap; the others are not displaced or hidden.
    addReview(db, "att3", NOW + 6000, [{ id: "c", stem: "C?" }, { id: "d", stem: "D?" }, { id: "e", stem: "E?" }]);
    enqueueGapInsights(db, runner, "att3");
    await runJob(jobs()[2]!);
    expect(openGapsOf(db).map((gap) => [gap.misconception, gap.severity])).toEqual([
      ["Treats velocity as if it had no direction.", "minor"],
      ["Confuses displacement with distance travelled.", "minor"],
      ["Mixes up acceleration with speed.", "severe"],
    ]);
    // Exactly one gap_opened event per gap, written when the gap was created.
    expect(db.prepare("SELECT count(*) AS n FROM learning_events WHERE kind = 'gap_opened'").get()).toEqual({ n: 3 });
    // Progress ranks by severity, then linked wrong answers, then age; one entry per gap id. Mastery is 0 here, so all are severe.
    const gaps = planSeries(db, "plan", NOW + 7000).gaps;
    expect(gaps.map((gap) => gap.misconception)).toEqual([
      "Mixes up acceleration with speed.",
      "Treats velocity as if it had no direction.",
      "Confuses displacement with distance travelled.",
    ]);
    expect(new Set(gaps.map((gap) => gap.gapId)).size).toBe(3);
    expect(gaps.map((gap) => gap.wrongAnswers)).toEqual([3, 2, 2]);
  });

  it.each([
    ["the local model is unavailable", async () => null],
    ["embedding fails", async () => Promise.reject(new Error("embed-dim"))],
  ])("keeps the reading apart and marked unchecked, without merging or failing, when %s", async (_name, embed) => {
    const db = fixture();
    const { runner, jobs, runJob, stored } = fakeRunner(db);
    registerGapInsightJobs(
      db,
      runner,
      answering(
        { misconception: "Treats velocity as if it had no direction.", severity: "minor" },
        { misconception: "Thinks velocity ignores direction.", severity: "minor" },
      ),
      embed as never,
    );
    enqueueGapInsights(db, runner, "att");
    await runJob(jobs()[0]!);
    addReview(db, "att2", NOW + 5000, [{ id: "a", stem: "A?" }, { id: "b", stem: "B?" }]);
    enqueueGapInsights(db, runner, "att2");
    await runJob(jobs()[1]!);
    expect(stored(jobs()[1]!)!.outcome).toBe("unchecked");
    const gaps = openGapsOf(db);
    expect(gaps.map((gap) => [gap.misconception, gap.comparison])).toEqual([
      ["Treats velocity as if it had no direction.", null],
      ["Thinks velocity ignores direction.", "unchecked"],
    ]);
    // The evidence is kept with the gap that holds it, and Progress says it is unmerged.
    expect(linked(db, gaps[1]!.id)).toEqual(["att2"]);
    expect(planSeries(db, "plan", NOW + 7000).gaps.map((gap) => gap.unmerged).sort()).toEqual([false, true]);
  });

  it("merges an unchecked gap into the older one once the local model can compare them", async () => {
    const db = fixture();
    const { runner, jobs, runJob } = fakeRunner(db);
    let available = false;
    registerGapInsightJobs(
      db,
      runner,
      answering(
        { misconception: "Treats velocity as if it had no direction.", severity: "minor" },
        { misconception: "Thinks velocity ignores direction.", severity: "severe" },
        { misconception: "Confuses displacement with distance travelled.", severity: "minor" },
      ),
      async (text) => (available ? embedding()(text) : null),
    );
    enqueueGapInsights(db, runner, "att");
    await runJob(jobs()[0]!);
    addReview(db, "att2", NOW + 5000, [{ id: "a", stem: "A?" }, { id: "b", stem: "B?" }]);
    enqueueGapInsights(db, runner, "att2");
    await runJob(jobs()[1]!);
    expect(openGapsOf(db)).toHaveLength(2);
    // Another analysis lands with the model back: the unchecked pair is compared and joined, a new different one stays apart.
    available = true;
    addReview(db, "att3", NOW + 6000, [{ id: "c", stem: "C?" }, { id: "d", stem: "D?" }]);
    enqueueGapInsights(db, runner, "att3");
    await runJob(jobs()[2]!);
    const all = allGaps(db);
    const [older, newer] = all;
    expect(all).toHaveLength(3);
    expect(newer).toMatchObject({ merged_into: older!.id });
    expect(newer!.closed_at).not.toBeNull();
    expect(openGapsOf(db).map((gap) => [gap.misconception, gap.severity, gap.comparison])).toEqual([
      ["Treats velocity as if it had no direction.", "severe", null],
      ["Confuses displacement with distance travelled.", "minor", null],
    ]);
    // The absorbed gap's answers moved to the survivor, and closing it as merged wrote its one gap_closed event.
    expect(linked(db, older!.id)).toEqual(["att", "att2"]);
    const closed = db.prepare("SELECT payload_json FROM learning_events WHERE kind = 'gap_closed'").all() as Array<{ payload_json: string }>;
    expect(closed.map((row) => JSON.parse(row.payload_json))).toEqual([{ gapId: newer!.id, reason: "merged", into: older!.id }]);
    // Merging is not a learning close: a repeated sync changes nothing.
    syncGaps(db, "plan", NOW + 9000);
    expect(db.prepare("SELECT count(*) AS n FROM learning_events WHERE kind = 'gap_closed'").get()).toEqual({ n: 1 });
  });

  it("marks a reading unchecked when new readings kept arriving past the comparison cap, and reconciles it later", async () => {
    const db = fixture();
    const { runner, jobs, runJob, stored } = fakeRunner(db);
    const reading = "Confuses displacement with distance travelled.";
    const vector: Record<string, [number, number]> = {
      [reading]: [0, 1],
      "Mixes up acceleration with speed.": [0.7, -0.7],
      "Seen 1": [1, 0],
      "Seen 2": [1, 0.1],
      "Seen 3": [0.02, 1],
    };
    const addOpen = (misconception: string, openedAt: number) =>
      insertGap(db, { planId: "plan", topicId: "topic", openedAt, origin: "misconception", misconception, severity: "minor" });
    // The gap the first attempt opened already has a reading, so the new reading cannot take its place.
    db.prepare("UPDATE gaps SET misconception = 'Mixes up acceleration with speed.', severity = 'minor'").run();
    let arrivals = 0;
    // Another analysis lands during each of the first three comparison rounds; the last one is close to this reading.
    const embed: Parameters<typeof registerGapInsightJobs>[3] = async (text) => {
      const key = text.replace(/^query: /, "");
      if (key === reading && ++arrivals <= 3) addOpen(`Seen ${arrivals}`, NOW + 4000 + arrivals);
      return Float32Array.from(vector[key] ?? [0, -1]);
    };
    registerGapInsightJobs(db, runner, answering({ misconception: reading, severity: "minor" }), embed);
    addReview(db, "att2", NOW + 5000, [{ id: "a", stem: "A?" }, { id: "b", stem: "B?" }]);
    enqueueGapInsights(db, runner, "att2");
    await runJob(jobs().at(-1)!);
    expect(stored(jobs().at(-1)!)).toMatchObject({ outcome: "unchecked" });
    const read = allGaps(db).filter((gap) => gap.misconception);
    const seen3 = read.find((gap) => gap.misconception === "Seen 3")!;
    const mine = read.find((gap) => gap.misconception === reading)!;
    // Without the cap rule it would sit beside "Seen 3" as a duplicate "distinct" gap.
    expect(mine).toMatchObject({ merged_into: seen3.id });
    expect(mine.closed_at).not.toBeNull();
    expect(openGapsOf(db).filter((gap) => gap.misconception).map((gap) => [gap.misconception, gap.comparison])).toEqual([
      ["Mixes up acceleration with speed.", null],
      ["Seen 1", null],
      ["Seen 2", null],
      ["Seen 3", null],
    ]);
    expect(linked(db, seen3.id)).toEqual(["att2"]);
  });

  it("writes nothing for a gap closed or archived before the call or while the model works", async () => {
    const db = fixture();
    let calls = 0;
    const run: GenerateInput["run"] = async () => {
      calls += 1;
      db.prepare("UPDATE gaps SET closed_at = ?").run(NOW + 9000);
      return { text: "", structured: { misconception: "Treats velocity as if it had no direction.", severity: "severe" } } as never;
    };
    const { runner, jobs, runJob } = fakeRunner(db);
    registerGapInsightJobs(db, runner, run, embedding());
    enqueueGapInsights(db, runner, "att");
    await runJob(jobs()[0]!);
    expect(calls).toBe(1);
    // Closed during the call: nothing is written, and no later gap picks it up.
    expect(allGaps(db)).toHaveLength(1);
    expect(allGaps(db)[0]!.misconception).toBeNull();
    // Archived before the job starts: no model call at all.
    db.prepare("UPDATE gaps SET closed_at = NULL").run();
    db.prepare("UPDATE topics SET archived_at = 1").run();
    await runJob(jobs()[0]!);
    expect(calls).toBe(1);
    expect(allGaps(db)[0]!.misconception).toBeNull();
  });

  it("stops without writing when cancelled during the call", async () => {
    const db = fixture();
    const controller = new AbortController();
    const run: GenerateInput["run"] = async () => {
      controller.abort();
      return { text: "", structured: { misconception: "Treats velocity as if it had no direction.", severity: "severe" } } as never;
    };
    const { runner, jobs, runJob } = fakeRunner(db);
    registerGapInsightJobs(db, runner, run, embedding());
    enqueueGapInsights(db, runner, "att");
    await expect(runJob(jobs()[0]!, controller)).rejects.toThrow();
    expect(gapRow(db).misconception).toBeNull();
  });

  it("shows the analysis in progress and keeps Pyxis's mastery rule on top of the model's severity", () => {
    const db = fixture();
    // Two wrong answers on the topic open the gap from the events themselves.
    db.prepare("DELETE FROM gaps").run();
    db.prepare(
      "INSERT INTO learning_events (id, kind, plan_id, topic_id, payload_json, created_at) VALUES ('e1', 'answer_given', 'plan', 'topic', ?, ?)",
    ).run(JSON.stringify({ score: 0.5, scores: [0, 0, 1, 1, 1, 1, 1, 1, 1, 1] }), NOW);
    const first = planSeries(db, "plan", NOW + 1000).gaps[0]!;
    expect(first.misconception).toBeNull();
    db.prepare("UPDATE gaps SET misconception = 'Mixes up speed and velocity.', severity = 'minor'").run();
    // Mastery is well above half of the 0.75 target, so the model's "minor" stands.
    const minor = planSeries(db, "plan", NOW + 1000).gaps[0]!;
    expect(minor).toMatchObject({ misconception: "Mixes up speed and velocity.", severity: "minor" });
    db.prepare("UPDATE gaps SET severity = 'severe'").run();
    expect(planSeries(db, "plan", NOW + 1000).gaps[0]!.severity).toBe("severe");
    expect(minor.misses.every((miss) => !("answer" in miss))).toBe(true);
  });

  it("starts after the grading that opens the gap and cannot fail that grading", async () => {
    const db = fixture();
    db.prepare("DELETE FROM gaps").run();
    const itemId = saveQuiz(db, "plan", [1, 2].map((n) => ({
      id: `t${n}`,
      stem: `Statement ${n}`,
      grade: { kind: "tf" as const, picked: true, correct: false },
    })));
    db.prepare("UPDATE items SET topic_id = 'topic' WHERE id = ?").run(itemId);
    const { attemptId } = startAttempt(db, "plan", itemId);
    const calls: string[] = [];
    const runner = createRunner(db, () => {});
    // Only grading is registered first: the unknown insight job must not fail the grade.
    registerQuizGradingJobs(db, runner);
    submitQuiz(db, runner, attemptId, { t1: "true", t2: "true" });
    const settled = async (kind: string) => {
      for (let i = 0; i < 200; i++) {
        const job = db.prepare("SELECT state FROM jobs WHERE kind = ?").get(kind) as { state: string } | undefined;
        if (job && ["succeeded", "failed"].includes(job.state)) return job.state;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      throw new Error(`${kind} never settled`);
    };
    expect(await settled("quiz-grade")).toBe("succeeded");
    expect(db.prepare("SELECT count(*) AS n FROM gaps WHERE misconception IS NULL AND closed_at IS NULL").get()).toEqual({ n: 1 });
    expect(db.prepare("SELECT count(*) AS n FROM jobs WHERE kind = 'gap-insight'").get()).toEqual({ n: 0 });

    // With the job registered, the next graded attempt on the open gap starts one analysis.
    registerGapInsightJobs(db, runner, async (input) => {
      calls.push(input.prompt);
      return { text: "", structured: { misconception: "Believes false statements are true.", severity: "minor" } } as never;
    });
    const again = startAttempt(db, "plan", itemId).attemptId;
    submitQuiz(db, runner, again, { t1: "true", t2: "true" });
    await settled("gap-insight");
    expect(db.prepare("SELECT misconception, severity FROM gaps").get()).toEqual({
      misconception: "Believes false statements are true.",
      severity: "minor",
    });
    expect(calls).toHaveLength(1);
    expect(JSON.parse(calls[0]!).mistakes).toHaveLength(2);
  });
});
