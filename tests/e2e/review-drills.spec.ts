import AxeBuilder from "@axe-core/playwright";
import { _electron as electron, expect, test, type Page } from "@playwright/test";
import { strToU8, zipSync } from "fflate";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { importPickedSource } from "./picked-source";

const MAIN = join(process.cwd(), process.env.PYXIS_OUT ?? "out", "main/index.js");
const dbPath = (userData: string) => join(userData, "workspace", "pyxis.db");

type Session = {
  next: "cards" | "questions" | "waiting" | "done";
  attemptId: string;
  questions: Array<{ id: string; topicId?: string }>;
  progress: { done: number; total: number; cardsTotal: number; questionsTotal: number; questionsPending: number };
  drills: Array<{ topicId: string; gapId?: string; title: string; jobId: string; state: string; want: number }>;
  explanations: Array<{ topicId: string; text: string }>;
};

/** Three chapters; only the first has exercises, so the other two topics have gaps that need a model-made drill. */
function smartbook() {
  return zipSync({
    "smartbook.json": strToU8(
      JSON.stringify({
        id: "drills",
        title: "Fisica",
        access: "public",
        chapters: [1, 2, 3].map((n) => ({ id: `c${n}`, number: n, title: `Tema ${n}`, file: `0${n}.md` })),
      }),
    ),
    ...Object.fromEntries(
      [1, 2, 3].map((n) => [`chapters/0${n}.md`, strToU8(`## p1 | Tema ${n}\nTesto del tema ${n}.\n`)]),
    ),
    "esercizi.md": strToU8(
      [1, 2, 3, 4]
        .map((k) => `:::exercise{id="a${k}" chapter="1"}\nDomanda ${k}?\n:::solution\nrisposta ${k}\n:::\n:::\n`)
        .join("\n"),
    ),
  });
}

/** LES-03: the gap drill is five questions (mcq, tf and completion in rotation) after one short explanation. */
const DRILL_KINDS = ["mcq", "tf", "completion", "mcq", "tf"];
const EXPLANATION = "Rileggi la definizione: la forza è massa per accelerazione.";
function drillReply() {
  return {
    questions: DRILL_KINDS.map((kind, i) => ({
      kind,
      stem: kind === "completion" ? `Completa {{1}} nel caso ${i}.` : `Affermazione ${i} {{question:${i}}}.`,
      ...(kind === "mcq" ? { options: ["Uno", "Due", "Tre", "Quattro"], correct: 0 } : {}),
      ...(kind === "tf" ? { correct: true } : {}),
      ...(kind === "completion" ? { accepted: ["risposta"] } : {}),
      passageIds: ["{{passage:0}}"],
      explanation: "Perché sì.",
    })),
  };
}

/** The two model calls of a drill: the short explanation, then the questions. */
const drillReplies = () => ({ explanation: { explanation: EXPLANATION }, quizQuestions: drillReply() });

const diagnostic = {
  questions: Array.from({ length: 10 }, (_, i) => ({
    stem: `Diagnosi ${i}`,
    options: ["a", "b", "c", "d"],
    correct: 0,
    topicIndex: i % 3,
    passageIds: [`{{passage:${i % 3}}}`],
    explanation: "La relazione fisica.",
  })),
};

function launch(userData: string, replies: object, delay = 0) {
  const env = {
    ...process.env,
    PYXIS_USER_DATA: userData,
    PYXIS_E2E: "1",
    PYXIS_E2E_PLAN_REPLIES: JSON.stringify({ markdown: { markdown: "## Ripasso\nUsa le formule [P1]." }, questions: diagnostic, ...replies }),
    PYXIS_E2E_PLAN_DELAY: String(delay),
  };
  delete env.ELECTRON_RUN_AS_NODE;
  return electron.launch({ args: [MAIN], env });
}

const invoke = <T>(page: Page, channel: string, input: object) =>
  page.evaluate(
    ([c, i]) =>
      window.pyxis.invoke(c as never, i as never).catch((error: unknown) => {
        throw new Error(JSON.stringify(error));
      }),
    [channel, input] as const,
  ) as Promise<T>;

/** A plan with three topics whose second and third have an open gap and no questions of their own. */
async function setupPlan(userData: string, page: Page, app: Awaited<ReturnType<typeof launch>>) {
  await page.getByRole("button", { name: "Salta" }).click();
  const file = join(userData, "fisica.ptsb");
  writeFileSync(file, smartbook());
  const { sourceId } = (await importPickedSource(page, app, file)) as { sourceId: string };
  await expect
    .poll(async () => (await invoke<Array<{ id: string; status: string }>>(page, "sources.list", {})).find((row) => row.id === sourceId)?.status)
    .toBe("ready");
  const { planId } = await invoke<{ planId: string }>(page, "plans.create", { title: "Fisica", sourceIds: [sourceId] });
  await expect
    .poll(async () => (await invoke<{ state: string }>(page, "plans.build", { planId })).state, { timeout: 90000 })
    .toBe("succeeded");
  const plan = await invoke<{ topics: Array<{ id: string }> }>(page, "plans.read", { planId });
  expect(plan.topics).toHaveLength(3);
  // Each gapped topic gets a saved quiz it answers wrongly, which is how a gap opens in the app.
  const db = new DatabaseSync(dbPath(userData));
  const now = Date.now();
  for (const [index, topic] of plan.topics.slice(1).entries()) {
    const body = {
      questions: [1, 2, 3].map((n) => ({
        id: `gap-${index}-${n}`,
        topicId: topic.id,
        stem: `Domanda ${n}`,
        options: ["a", "b", "c", "d"],
        explanation: "Spiegazione.",
        answer: { kind: "mcq", correct: 0, picked: -1 },
      })),
      config: { count: 3, feedback: false },
      complete: true,
    };
    db.prepare("INSERT INTO items(id,plan_id,topic_id,kind,body_json,engine_provider,grounding,created_at) VALUES(?,?,?,'quiz',?,'fixture','sources',?)").run(
      `gap-quiz-${index}`,
      planId,
      topic.id,
      JSON.stringify(body),
      now + index,
    );
    db.prepare("INSERT INTO attempts(id,plan_id,item_id,started_at) VALUES(?,?,?,?)").run(`gap-attempt-${index}`, planId, `gap-quiz-${index}`, now + index);
  }
  db.close();
  for (const index of [0, 1]) await invoke(page, "study.quizSubmit", { attemptId: `gap-attempt-${index}`, picks: {} });
  return { planId, topics: plan.topics.map((topic) => topic.id) };
}

const goto = (page: Page, hash: string) =>
  page.evaluate((hash) => {
    window.location.hash = hash;
  }, hash);

test("LES-13 a Review of only gap drills waits, offers retry, adopts the questions once, ends the wait on cancel and credits each topic", async () => {
  test.setTimeout(240000);
  const userData = mkdtempSync(join(tmpdir(), "pyxis-review-drills-"));
  let planId = "";
  // First run: the model's reply does not fit the quiz schema, so both drills fail.
  let app = await launch(userData, { quizQuestions: { questions: [] } });
  try {
    const page = await app.firstWindow();
    page.setDefaultTimeout(30000);
    ({ planId } = await setupPlan(userData, page, app));
    await goto(page, `/plans/${planId}/review`);
    await page.getByRole("button", { name: "Inizia il ripasso" }).click();
    await expect(page.getByText(/Non sono riuscito a preparare le domande su/)).toHaveCount(2, { timeout: 60000 });
  } finally {
    await app.close();
  }

  // Second run: valid replies, slow enough to cancel one drill while the other is building.
  app = await launch(userData, drillReplies(), 4000);
  try {
    const page = await app.firstWindow();
    page.setDefaultTimeout(15000);
    await goto(page, `/plans/${planId}/review`);
    // The saved review is still there: nothing but drills, so Continue cannot go anywhere yet.
    await expect(page.getByText("Hai un ripasso in corso")).toBeVisible();
    await expect(page.getByRole("button", { name: "Continua il ripasso" })).toBeDisabled();
    const failed = page.getByRole("button", { name: "Riprova", exact: true });
    await expect(failed).toHaveCount(2);
    await expect(page.locator(".px-review-progress .small")).toContainText("in preparazione");
    mkdirSync(".shots", { recursive: true });
    await page.screenshot({ path: ".shots/review-drills-failed-it.png", animations: "disabled" });
    expect((await new AxeBuilder({ page }).setLegacyMode(true).analyze()).violations).toEqual([]);

    const before = (await invoke<Session>(page, "study.reviewSession", { planId }))!;
    expect(before.next).toBe("waiting");
    expect(before.questions).toHaveLength(0);
    expect(before.drills.map((drill) => drill.state)).toEqual(["failed", "failed"]);
    const [first, second] = before.drills;
    const want = first!.want;
    // Submitting while a drill can still deliver is refused.
    await failed.first().click();
    await expect(page.getByRole("button", { name: "Annulla", exact: true })).toBeVisible();
    await expect(invoke(page, "study.quizSubmit", { attemptId: before.attemptId, picks: {} })).rejects.toThrow(/review-drills-pending/);
    // Cancel the second while the first is building: cancelling ends the wait for that one only.
    await page.getByRole("button", { name: "Riprova", exact: true }).click();
    await expect(page.getByRole("button", { name: "Annulla", exact: true })).toHaveCount(2);
    await page.getByRole("button", { name: "Annulla", exact: true }).last().click();
    await expect(page.getByRole("button", { name: "Annulla", exact: true })).toHaveCount(1);
    await expect(page.getByText(/Hai saltato le domande su/)).toBeVisible();

    // The first drill delivers: its questions join the one review attempt, and only those.
    await expect.poll(async () => (await invoke<Session>(page, "study.reviewSession", { planId }))!.questions.length, { timeout: 60000 }).toBe(want);
    const adopted = (await invoke<Session>(page, "study.reviewSession", { planId }))!;
    expect(adopted.attemptId).toBe(before.attemptId);
    expect(adopted.next).toBe("questions");
    expect(adopted.questions.every((question) => question.topicId === first!.topicId)).toBe(true);
    expect(adopted.drills.map((drill) => drill.jobId)).toEqual([second!.jobId]);
    expect(adopted.drills[0]!.state).toBe("cancelled");
    await page.reload();
    await expect(page.getByRole("button", { name: "Continua il ripasso" })).toBeEnabled();
    await page.screenshot({ path: ".shots/review-drills-adopted-it.png", animations: "disabled" });
    expect((await new AxeBuilder({ page }).setLegacyMode(true).analyze()).violations).toEqual([]);
    // Reloading and restarting never add the questions again or start another model call.
    const again = (await invoke<Session>(page, "study.review", { planId }))!;
    expect(again.questions.map((question) => question.id)).toEqual(adopted.questions.map((question) => question.id));
    await page.getByRole("button", { name: "Continua il ripasso" }).click();
    await expect(page).toHaveURL(/\/diagnostic\?attempt=/);
    // LES-03: the adopted drill brings its short explanation, shown above the first question.
    expect(adopted.explanations.map((note) => note.text)).toEqual([EXPLANATION]);
    await expect(page.getByRole("heading", { name: "Prima una breve spiegazione" })).toBeVisible();
    await expect(page.getByText(EXPLANATION)).toBeVisible();

    // The cancelled drill no longer blocks the finish; the adopted topic is credited with exactly its questions.
    const read = (sql: string, ...args: string[]) => {
      const db = new DatabaseSync(dbPath(userData), { readOnly: true });
      try {
        return db.prepare(sql).all(...args) as Array<{ topic_id: string; payload_json: string; n: number }>;
      } finally {
        db.close();
      }
    };
    const mark = read("SELECT COALESCE(MAX(rowid), 0) AS n FROM learning_events")[0]!.n;
    await invoke(page, "study.quizSubmit", { attemptId: before.attemptId, picks: {} });
    const events = read(
      "SELECT topic_id, payload_json FROM learning_events WHERE kind = 'answer_given' AND plan_id = ? AND rowid > ?",
      planId,
      String(mark),
    );
    // Only the adopted topic is credited, with exactly the questions it contributed; the cancelled one gets none.
    expect(events.map((row) => row.topic_id)).toEqual([first!.topicId]);
    expect((JSON.parse(events[0]!.payload_json) as { scores: number[] }).scores).toHaveLength(want);
    expect(await invoke(page, "study.reviewSession", { planId })).toBeNull();
  } finally {
    await app.close();
    rmSync(userData, { recursive: true, force: true });
  }
});

test("LES-13 discarding an unfinished Review frees a new one, keeps the cards and reuses the drill already building", async () => {
  test.setTimeout(180000);
  const userData = mkdtempSync(join(tmpdir(), "pyxis-review-discard-"));
  const app = await launch(userData, drillReplies(), 6000);
  try {
    const page = await app.firstWindow();
    page.setDefaultTimeout(15000);
    const { planId, topics } = await setupPlan(userData, page, app);
    await invoke(page, "study.save", { planId, topicId: topics[0]!, front: "Carta", back: "Retro" });
    await goto(page, `/plans/${planId}/review`);
    await page.getByRole("button", { name: "Inizia il ripasso" }).click();
    await expect(page).toHaveURL(/\/review\/cards/);
    const first = (await invoke<Session>(page, "study.reviewSession", { planId }))!;
    const building = first.drills.map((drill) => drill.jobId);
    expect(building.length).toBeGreaterThan(0);
    await goto(page, `/plans/${planId}/review`);
    await expect(page.getByText("Hai un ripasso in corso")).toBeVisible();
    await page.getByRole("button", { name: "Scarta questo ripasso" }).click();
    await expect(page.getByText("Hai un ripasso in corso")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Inizia il ripasso" })).toBeVisible();
    expect(await invoke(page, "study.reviewSession", { planId })).toBeNull();
    // A new review starts at once and takes over the drill that is still running instead of paying for another.
    await page.getByRole("button", { name: "Inizia il ripasso" }).click();
    await expect(page).toHaveURL(/\/review\/cards/);
    const second = (await invoke<Session>(page, "study.reviewSession", { planId }))!;
    expect(second.attemptId).not.toBe(first.attemptId);
    // The student's card is still in the new review.
    expect(second.progress.cardsTotal).toBe(1);
    expect(second.drills.map((drill) => drill.jobId).sort()).toEqual([...building].sort());
    const db = new DatabaseSync(dbPath(userData), { readOnly: true });
    const started = db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE kind = 'gap-drill'").get() as { n: number };
    db.close();
    expect(started.n).toBe(building.length);
  } finally {
    await app.close();
    rmSync(userData, { recursive: true, force: true });
  }
});

test("LES-13 a failed drill can be skipped for good, a closed gap stops being waited for, and the Review then counts as finished", async () => {
  test.setTimeout(180000);
  const userData = mkdtempSync(join(tmpdir(), "pyxis-review-skip-"));
  let planId = "";
  let topics: string[] = [];
  // Every drill fails: the model's reply does not fit the quiz schema.
  let app = await launch(userData, { quizQuestions: { questions: [] } });
  try {
    const page = await app.firstWindow();
    page.setDefaultTimeout(30000);
    ({ planId, topics } = await setupPlan(userData, page, app));
    await goto(page, `/plans/${planId}/review`);
    await page.getByRole("button", { name: "Inizia il ripasso" }).click();
    await expect(page.getByText(/Non sono riuscito a preparare le domande su/)).toHaveCount(2, { timeout: 60000 });
    const skip = page.getByRole("button", { name: "Salta", exact: true });
    await expect(skip).toHaveCount(2);
    await page.screenshot({ path: ".shots/review-drills-skip-offered-it.png", animations: "disabled" });
    // Skipping one drill ends the wait for that one only; the other still blocks the finish.
    const before = (await invoke<Session>(page, "study.reviewSession", { planId }))!;
    await skip.first().click();
    await expect(page.getByText(/Hai saltato le domande su/)).toHaveCount(1);
    await expect(skip).toHaveCount(1);
    await expect(page.getByRole("button", { name: "Continua il ripasso" })).toBeDisabled();
    await expect(invoke(page, "study.quizSubmit", { attemptId: before.attemptId, picks: {} })).rejects.toThrow(/review-drills-pending/);
    expect((await invoke<Session>(page, "study.reviewSession", { planId }))!.drills.map((drill) => drill.state).sort()).toEqual(["failed", "skipped"]);
  } finally {
    await app.close();
  }

  // The choice is stored in the review: it survives a restart, and the job stays failed underneath.
  app = await launch(userData, { quizQuestions: { questions: [] } });
  try {
    const page = await app.firstWindow();
    page.setDefaultTimeout(15000);
    await goto(page, `/plans/${planId}/review`);
    await expect(page.getByText(/Hai saltato le domande su/)).toHaveCount(1);
    await expect(page.getByRole("button", { name: "Salta", exact: true })).toHaveCount(1);
    // The other gap closes while its drill is failed: the drill is dropped instead of waited for.
    const db = new DatabaseSync(dbPath(userData));
    db.prepare("UPDATE gaps SET closed_at = ? WHERE plan_id = ? AND topic_id = ?").run(Date.now(), planId, topics[2]!);
    db.close();
    await page.reload();
    await expect(page.getByText(/Non sono riuscito a preparare le domande su/)).toHaveCount(0);
    // Nothing is left to ask, so the Review counts as finished: no stale waiting state, and a new one can start.
    expect(await invoke(page, "study.reviewSession", { planId })).toBeNull();
    await expect(page.getByText(/Hai saltato le domande su/)).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Inizia il ripasso" })).toBeVisible();
    await page.screenshot({ path: ".shots/review-drills-closed-gap-it.png", animations: "disabled" });
    expect((await new AxeBuilder({ page }).setLegacyMode(true).analyze()).violations).toEqual([]);
  } finally {
    await app.close();
    rmSync(userData, { recursive: true, force: true });
  }
});

test("LES-03 a single gap drill started from the progress page opens its quiz with the short explanation above the first question", async () => {
  test.setTimeout(180000);
  const userData = mkdtempSync(join(tmpdir(), "pyxis-progress-drill-"));
  const app = await launch(userData, drillReplies());
  try {
    const page = await app.firstWindow();
    page.setDefaultTimeout(30000);
    const { planId } = await setupPlan(userData, page, app);
    await goto(page, `/plans/${planId}/progress`);
    const fill = page.getByRole("button", { name: /^Colma la lacuna ·/ });
    await expect(fill.first()).toBeVisible();
    await fill.first().click();
    // The drill is built by its job; the page then opens the quiz of that one drill, not a Review.
    await expect(page).toHaveURL(/\/quiz\/[^?]+\?attempt=/, { timeout: 60000 });
    await expect(page.getByRole("heading", { name: "Prima una breve spiegazione" })).toBeVisible();
    await expect(page.getByText(EXPLANATION)).toBeVisible();
    await expect(page.locator(".px-quiz-question")).toBeVisible();
    mkdirSync(".shots", { recursive: true });
    await page.screenshot({ path: ".shots/progress-drill-explanation-it.png", animations: "disabled" });
    expect((await new AxeBuilder({ page }).setLegacyMode(true).analyze()).violations).toEqual([]);
  } finally {
    await app.close();
    rmSync(userData, { recursive: true, force: true });
  }
});
