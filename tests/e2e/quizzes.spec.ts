import { importPickedSource } from "./picked-source";
import {
  expect,
  test,
  type ElectronApplication,
  type Page,
} from "@playwright/test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchPyxis } from "./app-under-test";
import { makeBook } from "./book";
import { expectNoAxeViolations } from "./axe";
import { saveShot } from "./shots";

/** Ten diagnostic questions over the book's two chapters; each explanation cites a passage by ID. */
const diagnosticReply = {
  questions: Array.from({ length: 10 }, (_, i) => ({
    stem: `Diagnosi ${i}: quale grandezza descrive ${i % 2 ? "il lavoro" : "il moto"}?`,
    options: ["La velocità", "La massa", "La carica", "La temperatura"],
    correct: 0,
    topicIndex: i % 2,
    passageIds: [`{{passage:${i % 2}}}`],
    explanation: `La velocità è lo spostamento nell’unità di tempo [{{passage:${i % 2}}}].`,
  })),
};

async function invoke<T = unknown>(page: Page, channel: string, input: unknown): Promise<T> {
  return (await page.evaluate(
    ({ channel, input }) => window.pyxis.invoke(channel as never, input as never),
    { channel, input },
  )) as T;
}

/** Launches a fresh app on a two-chapter smartbook and builds a plan with recorded model replies. */
async function launch(replies: Record<string, unknown>, delay = 0) {
  const userData = mkdtempSync(join(tmpdir(), "pyxis-quiz-"));
  const file = join(userData, "book.ptsb");
  writeFileSync(
    file,
    makeBook({
      id: "fisica",
      chapters: [
        { title: "Moti", text: "## p1 | Velocità\nLa velocità descrive lo spostamento nel tempo.\n" },
        { title: "Energia", text: "## p1 | Lavoro\nIl lavoro è forza per spostamento.\n" },
      ],
    }),
  );
  const env = {
    PYXIS_E2E_PLAN_REPLIES: JSON.stringify(replies),
    PYXIS_E2E_PLAN_DELAY: String(delay),
  };
  const app: ElectronApplication = await launchPyxis({ userData, env });
  const page = await app.firstWindow();
  await page.getByRole("button", { name: "Salta" }).click();
  // Skipping saves the profile, then moves to Exams; wait so a reload or route change cannot land on setup.
  await expect(page).toHaveURL(/#\/exams$/);
  const source = (await importPickedSource(page, app, file)) as { sourceId: string };
  await expect
    .poll(async () =>
      (await invoke<Array<{ id: string; status: string }>>(page, "sources.list", {})).find(
        (row) => row.id === source.sourceId,
      )?.status,
    )
    .toBe("ready");
  const { planId } = await invoke<{ planId: string }>(page, "plans.create", {
    title: "Fisica 1",
    sourceIds: [source.sourceId],
  });
  await expect
    .poll(async () => (await invoke<{ state: string }>(page, "plans.build", { planId })).state, {
      timeout: 60000,
    })
    .toBe("succeeded");
  const plan = await invoke<{ topics: Array<{ id: string; title: string }> }>(page, "plans.read", {
    planId,
  });
  const done = async () => {
    await app.close();
    rmSync(userData, { recursive: true, force: true });
  };
  return { app, page, userData, planId, topics: plan.topics, done };
}

async function go(page: Page, hash: string) {
  await page.evaluate((value) => {
    window.location.hash = value;
  }, hash);
}

async function axe(page: Page) {
  await expectNoAxeViolations(page);
}

const score = (page: Page) => page.locator(".px-quiz-score");

test("LES-11 LES-12 topic quiz: calm intro, ten questions, feedback after each answer, back, keys and results", async () => {
  test.setTimeout(120000);
  const { page, planId, topics, userData, done } = await launch({
    markdown: { markdown: "## Il moto\nLa velocità descrive il moto [P1]." },
    questions: diagnosticReply,
    quizQuestions: {
      questions: Array.from({ length: 10 }, (_, i) => ({
        kind: "tf",
        stem: `La velocità descrive lo spostamento nel tempo. Affermazione {{question:${i}}}.`,
        correct: true,
        passageIds: ["{{passage:0}}"],
        explanation: "La velocità è lo spostamento per unità di tempo.",
      })),
    },
  });
  try {
    await go(page, `/plans/${planId}/quiz/${topics[0]!.id}`);
    await expect(page.getByRole("heading", { name: "Moti", level: 2 })).toBeVisible();
    await expect(page.getByText("10 domande", { exact: true })).toBeVisible();
    await expect(page.getByText("Correzione dopo ogni risposta", { exact: true })).toBeVisible();
    await axe(page);
    await page.getByRole("button", { name: "Personalizza" }).click();
    await page.getByRole("button", { name: "Solo vero o falso", exact: true }).click();
    await page.getByRole("button", { name: "Inizia", exact: true }).click();
    await expect(page.getByText("Domanda 1 di 10", { exact: true })).toBeVisible();
    await page.clock.install();
    await page.clock.fastForward(11000);
    await expect(
      page.getByRole("progressbar", { name: "Dieci secondi per riflettere" }),
    ).toHaveAttribute("aria-valuenow", "0");
    const vero = page.getByRole("button", { name: "A Vero", exact: true });
    const falso = page.getByRole("button", { name: "B Falso", exact: true });
    // Number keys pick, and the pick can change freely until Check.
    await page.keyboard.press("2");
    await expect(falso).toHaveAttribute("aria-pressed", "true");
    // Picking by key draws no focus box around the question.
    expect(
      await page.locator(".px-quiz-stem").evaluate(
        (stem) => document.activeElement === stem && getComputedStyle(stem).outlineStyle,
      ),
    ).toBe("none");
    await page.keyboard.press("1");
    await expect(vero).toHaveAttribute("aria-pressed", "true");
    await expect(falso).toHaveAttribute("aria-pressed", "false");
    // On the first question there is nothing to go back to.
    await expect(page.getByRole("button", { name: "Indietro", exact: true })).toHaveCount(0);
    await page.keyboard.press("Enter");
    await expect(page.locator(".px-quiz-feedback")).toContainText("Corretto");
    await expect(page.getByRole("button", { name: "Avanti", exact: true })).toBeFocused();
    await expect(page.getByRole("button", { name: /^A Vero Corretta$/ })).toBeDisabled();
    await axe(page);
    await page.keyboard.press("Enter");
    await expect(page.getByText("Domanda 2 di 10", { exact: true })).toBeVisible();
    await page.clock.runFor(600);
    await expect
      .poll(async () => {
        const attemptId = new URLSearchParams(
          (await page.evaluate(() => window.location.hash)).split("?")[1],
        ).get("attempt")!;
        return (await invoke<{ draft?: { index: number } }>(page, "study.quizRead", { attemptId }))
          .draft?.index;
      })
      .toBe(1);
    await page.reload();
    await expect(page.getByText("Domanda 2 di 10", { exact: true })).toBeVisible();
    await page.clock.resume();
    await falso.click();
    await page.getByRole("button", { name: "Verifica", exact: true }).click();
    await expect(page.locator(".px-quiz-feedback")).toContainText("Sbagliato");
    await expect(page.getByRole("button", { name: /^A Vero Risposta giusta$/ })).toBeVisible();
    await expect(page.getByRole("button", { name: /^B Falso Sbagliata$/ })).toBeVisible();
    // Back shows the previous question as answered, read-only, on the left of the same row.
    const back = page.getByRole("button", { name: "Indietro", exact: true });
    const next = page.getByRole("button", { name: "Avanti", exact: true });
    const [backBox, nextBox] = [await back.boundingBox(), await next.boundingBox()];
    expect(Math.abs(backBox!.y - nextBox!.y)).toBeLessThan(2);
    expect(backBox!.x).toBeLessThan(nextBox!.x);
    await back.click();
    await expect(page.getByText("Domanda 1 di 10", { exact: true })).toBeVisible();
    await expect(page.locator(".px-quiz-feedback")).toContainText("Corretto");
    await expect(page.getByRole("button", { name: /^A Vero Corretta$/ })).toBeDisabled();
    await next.click();
    await expect(page.getByText("Domanda 2 di 10", { exact: true })).toBeVisible();
    await expect(page.locator(".px-quiz-feedback")).toContainText("Sbagliato");
    await next.click();
    for (let i = 2; i < 10; i++) {
      await expect(page.getByText(`Domanda ${i + 1} di 10`, { exact: true })).toBeVisible();
      await vero.click();
      await page.getByRole("button", { name: "Verifica", exact: true }).click();
      await page
        .getByRole("button", { name: i === 9 ? "Vedi risultato" : "Avanti", exact: true })
        .click();
    }
    await expect(score(page)).toHaveText(/^9\s*su 10$/);
    await expect(page.getByText("90%", { exact: true })).toBeVisible();
    await page.reload();
    await expect(score(page)).toHaveText(/^9\s*su 10$/);
    const second = page.locator(".px-quiz-row").nth(1);
    await second.locator(".px-quiz-row-head").click();
    await expect(second.locator(".px-quiz-answer.is-wrong")).toContainText("Falso");
    await expect(second.locator(".px-quiz-answer.is-expected")).toContainText("Vero");
    await axe(page);
    // "Wrong question?" takes it out of the score at once; the toast can undo it.
    await second.getByRole("button", { name: "Domanda sbagliata?" }).click();
    await expect(score(page)).toHaveText(/^9\s*su 9$/);
    await expect(page.getByText("100%", { exact: true })).toBeVisible();
    await page.locator(".px-quiz-toast").getByRole("button", { name: "Annulla" }).click();
    await expect(score(page)).toHaveText(/^9\s*su 10$/);
    await expect(second.getByRole("button", { name: "Domanda sbagliata?" })).toBeVisible();
    await second.getByRole("button", { name: "Chiedi al tutor", exact: true }).click();
    await expect(page.getByText(/La tua risposta: Falso/)).toContainText("Risposta corretta: Vero");

    // Core asks at most ten questions, whatever count a caller sends.
    const big = await invoke<{ attemptId: string }>(page, "study.quizStart", {
      planId,
      topicId: topics[0]!.id,
      count: 40,
      types: ["tf"],
    });
    await expect
      .poll(async () => (await invoke<{ state: string }>(page, "study.quizRead", { attemptId: big.attemptId })).state)
      .toBe("succeeded");
    expect(
      await invoke<{ questions: unknown[]; requestedCount: number }>(page, "study.quizRead", {
        attemptId: big.attemptId,
      }),
    ).toMatchObject({ requestedCount: 10, questions: expect.any(Array) });
    expect(
      (await invoke<{ questions: unknown[] }>(page, "study.quizRead", { attemptId: big.attemptId }))
        .questions,
    ).toHaveLength(10);

    // A whole-plan timed quiz keeps its deadline through reload and submits unanswered work on expiry.
    const timed = await invoke<{ attemptId: string }>(page, "study.quizStart", {
      planId,
      scope: "plan",
      types: ["tf"],
      timerMinutes: 1,
    });
    const read = () =>
      invoke<{ state: string; deadlineAt?: number; submittedAt?: number; result?: { score: number } }>(
        page,
        "study.quizRead",
        { attemptId: timed.attemptId },
      );
    await expect.poll(async () => (await read()).state).toBe("succeeded");
    await go(page, `/plans/${planId}/quiz/${topics[0]!.id}?attempt=${timed.attemptId}`);
    await expect(page.locator(".px-quiz-question")).toBeVisible();
    await expect.poll(async () => (await read()).deadlineAt).toBeGreaterThan(0);
    const deadline = (await read()).deadlineAt;
    await page.reload();
    expect((await read()).deadlineAt).toBe(deadline);
    // Move the deadline into the past while no quiz page is open, since an open page saves its draft on a timer and
    // keeps the session it loaded. Leave, reload so nothing of that page is left, then write.
    await go(page, "/exams");
    await expect(page.locator(".px-quiz-question")).toHaveCount(0);
    await page.reload();
    const past = Date.now() - 1000;
    const db = new DatabaseSync(join(userData, "workspace", "pyxis.db"), { timeout: 10000 });
    const moved = db
      .prepare(
        "UPDATE attempt_answers SET payload_json = json_set(payload_json, '$.deadlineAt', ?) WHERE attempt_id = ? AND json_type(payload_json, '$.draft') = 'object'",
      )
      .run(past, timed.attemptId);
    db.close();
    expect(moved.changes).toBe(1);
    // Core answers with the moved deadline before the quiz opens on it.
    await expect.poll(async () => (await read()).deadlineAt).toBe(past);
    await go(page, `/plans/${planId}/quiz/${topics[0]!.id}?attempt=${timed.attemptId}`);
    await expect.poll(async () => (await read()).submittedAt).toBeGreaterThan(0);
    expect((await read()).result?.score).toBe(0);
  } finally {
    await done();
  }
});

test("I don't know (key 0) scores a question 0 and shows the answer; Skip (key S) moves it to the end, once", async () => {
  test.setTimeout(120000);
  const { page, planId, topics, done } = await launch({
    markdown: { markdown: "## Il moto\nLa velocità descrive il moto [P1]." },
    questions: diagnosticReply,
    quizQuestions: {
      questions: Array.from({ length: 10 }, (_, i) => ({
        kind: "tf",
        stem: `La velocità descrive lo spostamento nel tempo. Affermazione {{question:${i}}}.`,
        correct: true,
        passageIds: ["{{passage:0}}"],
        explanation: "La velocità è lo spostamento per unità di tempo.",
      })),
    },
  });
  const shoot = async (name: string, lang: string) => {
    for (const theme of ["light", "dark"] as const) {
      await page.evaluate((value) => window.pyxis.setAppearance(value), theme);
      await page.evaluate(() => document.fonts.ready);
      await saveShot(page, `quiz-mastery-${name}-${lang}-${theme}.png`, { animations: "disabled" });
    }
  };
  try {
    const started = await invoke<{ attemptId: string }>(page, "study.quizStart", {
      planId,
      topicId: topics[0]!.id,
      types: ["tf"],
    });
    const read = () =>
      invoke<{
        state: string;
        draft?: { index: number; skipped?: string[] };
        questions: Array<{ id: string; stem: string }>;
      }>(page, "study.quizRead", { attemptId: started.attemptId });
    await expect.poll(async () => (await read()).state).toBe("succeeded");
    await go(page, `/plans/${planId}/quiz/${topics[0]!.id}?attempt=${started.attemptId}`);
    const stem = page.locator(".px-quiz-stem");
    await expect(page.getByText("Domanda 1 di 10", { exact: true })).toBeVisible();
    const skippedStem = await stem.innerText();
    await axe(page);
    await shoot("question", "it");

    // S moves the first question to the end: the next one takes its place in the count.
    await page.keyboard.press("s");
    await expect(stem).not.toHaveText(skippedStem);
    await expect(page.getByText("Domanda 1 di 10", { exact: true })).toBeVisible();
    // 0 on the second question: scored wrong, no pick, the right option is shown.
    await page.keyboard.press("0");
    const feedback = page.locator(".px-quiz-feedback.is-wrong");
    await expect(feedback).toContainText("Ancora da imparare");
    await expect(feedback).toContainText("Vale 0, come una risposta sbagliata.");
    await expect(page.getByRole("button", { name: /^A Vero Risposta giusta$/ })).toBeVisible();
    await expect(page.getByRole("button", { name: "Non lo so" })).toHaveCount(0);
    await axe(page);
    await shoot("dont-know", "it");
    await page.keyboard.press("Enter");
    await expect(page.getByText("Domanda 2 di 10", { exact: true })).toBeVisible();
    await expect.poll(async () => (await read()).draft?.skipped).toHaveLength(1);

    for (let i = 2; i <= 9; i++) {
      await expect(page.getByText(`Domanda ${i} di 10`, { exact: true })).toBeVisible();
      await page.keyboard.press("1");
      await page.keyboard.press("Enter");
      await expect(page.locator(".px-quiz-feedback.is-correct")).toBeVisible();
      await page.keyboard.press("Enter");
    }
    // The skipped question comes back last, says so, and cannot be skipped again.
    await expect(page.getByText("Domanda 10 di 10", { exact: true })).toBeVisible();
    await expect(stem).toHaveText(skippedStem);
    await expect(page.getByText(/Già saltata/)).toBeVisible();
    await expect(page.getByRole("button", { name: /^Salta/ })).toHaveCount(0);
    await page.keyboard.press("s");
    await expect(stem).toHaveText(skippedStem);
    await expect(page.getByRole("button", { name: /^Non lo so/ })).toBeVisible();
    await shoot("skipped-back", "it");
    // The order survives a reload.
    await expect.poll(async () => (await read()).draft?.index).toBe(9);
    await page.reload();
    await expect(page.getByText("Domanda 10 di 10", { exact: true })).toBeVisible();
    await expect(stem).toHaveText(skippedStem);
    await page.keyboard.press("1");
    await page.keyboard.press("Enter");
    await expect(page.locator(".px-quiz-feedback.is-correct")).toBeVisible();
    await page.getByRole("button", { name: "Vedi risultato", exact: true }).click();
    // Nine right answers; the one "I don't know" is a wrong answer with no pick.
    await expect(score(page)).toHaveText(/^9\s*su 10$/);
    const second = page.locator(".px-quiz-row").nth(1);
    await second.locator(".px-quiz-row-head").click();
    await expect(second.locator(".px-quiz-answer-empty")).toHaveText("Nessuna risposta");
    await expect(second.locator(".px-quiz-answer.is-expected")).toContainText("Vero");

    // The same three screens in English.
    await page.evaluate(() => localStorage.setItem("pyxis.lang", "en"));
    const english = await invoke<{ attemptId: string }>(page, "study.quizStart", {
      planId,
      topicId: topics[0]!.id,
      types: ["tf"],
    });
    await go(page, "/exams");
    await page.reload();
    await go(page, `/plans/${planId}/quiz/${topics[0]!.id}?attempt=${english.attemptId}`);
    await expect(page.getByRole("button", { name: /^I don't know/ })).toBeVisible();
    await shoot("question", "en");
    await page.setViewportSize({ width: 480, height: 800 });
    await shoot("question-narrow", "en");
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.keyboard.press("0");
    await expect(page.locator(".px-quiz-feedback.is-wrong")).toContainText("Not known yet");
    await shoot("dont-know", "en");
    await page.keyboard.press("Enter");
    await page.keyboard.press("s");
    await expect(page.getByRole("button", { name: /^Skip/ })).toBeVisible();
    await page.evaluate(() => localStorage.setItem("pyxis.lang", "it"));
    await go(page, "/exams");
    await page.reload();

    // On a timed quiz Skip leaves the deadline alone and still saves the order.
    const timed = await invoke<{ attemptId: string }>(page, "study.quizStart", {
      planId,
      topicId: topics[0]!.id,
      types: ["tf"],
      timerMinutes: 5,
    });
    const timedRead = () =>
      invoke<{ state: string; deadlineAt?: number; draft?: { skipped?: string[] } }>(
        page,
        "study.quizRead",
        { attemptId: timed.attemptId },
      );
    await expect.poll(async () => (await timedRead()).state).toBe("succeeded");
    // A new page, as from the path: the finished quiz's page state does not carry over.
    await go(page, "/exams");
    await expect(page.locator(".px-quiz-results")).toHaveCount(0);
    await go(page, `/plans/${planId}/quiz/${topics[0]!.id}?attempt=${timed.attemptId}`);
    await expect.poll(async () => (await timedRead()).deadlineAt).toBeGreaterThan(0);
    const deadline = (await timedRead()).deadlineAt;
    await expect(page.getByRole("timer")).toBeVisible();
    await page.keyboard.press("s");
    await expect.poll(async () => (await timedRead()).draft?.skipped).toHaveLength(1);
    expect((await timedRead()).deadlineAt).toBe(deadline);
  } finally {
    await done();
  }
});

test("diagnostic: feedback after each answer, where to start, source chips and a wrong question replaced", async () => {
  test.setTimeout(120000);
  const { page, planId, userData, done } = await launch({
    markdown: { markdown: "## Fisica\nIl moto e il lavoro [P1]." },
    questions: diagnosticReply,
    quizQuestions: {
      questions: [
        {
          kind: "mcq",
          stem: "Domanda di ricambio sul moto",
          options: ["La velocità", "Il colore", "Il suono", "La luce"],
          correct: 0,
          passageIds: ["{{passage:0}}"],
          explanation: "La velocità descrive il moto.",
        },
      ],
    },
  });
  try {
    await go(page, `/plans/${planId}/diagnostic`);
    await expect(page.getByRole("heading", { name: "Diagnosi", level: 2 })).toBeVisible();
    await expect(page.getByText("10 domande", { exact: true })).toBeVisible();
    await expect(page.getByText(/alla fine/)).toHaveCount(0);
    // Back and Start sit side by side; the focus bar's X is the only exit, so the intro has no Close of its own.
    const back = page.locator(".px-intro-actions").getByRole("button", { name: "Indietro" });
    const begin = page.getByRole("button", { name: "Inizia", exact: true });
    expect(Math.abs((await back.boundingBox())!.y - (await begin.boundingBox())!.y)).toBeLessThan(2);
    await expect(page.locator(".px-intro-actions").getByRole("button", { name: "Chiudi" })).toHaveCount(0);
    await begin.click();
    await expect(page.getByText("Domanda 1 di 10", { exact: true })).toBeVisible();
    // The page header says what the page is, not "Quiz".
    await expect(page.getByRole("heading", { level: 1, name: "Test diagnostico" })).toBeVisible();
    // The options are shown in a shuffled order, so each answer is picked by its text.
    const option = (text: string) => page.getByRole("button", { name: new RegExp(`^[A-D] ${text}$`) });
    await expect(option("La velocità")).toBeEnabled();
    await option("La velocità").click();
    await page.keyboard.press("Enter");
    const feedback = page.locator(".px-quiz-feedback");
    await expect(feedback).toContainText("Corretto");
    // The passage the model cited is a source chip, never a raw ID.
    await expect(feedback.locator(".px-cite")).toHaveCount(1);
    expect(await feedback.innerText()).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/);
    await page.keyboard.press("Enter");
    await option("La massa").click();
    await page.keyboard.press("Enter");
    await expect(feedback).toContainText("Sbagliato");
    await page.keyboard.press("Enter");
    for (let i = 2; i < 10; i++) {
      await expect(page.getByText(`Domanda ${i + 1} di 10`, { exact: true })).toBeVisible();
      await option("La velocità").click();
      await page.keyboard.press("Enter");
      await expect(feedback).toContainText("Corretto");
      await page.keyboard.press("Enter");
    }
    await expect(page.getByText("Diagnosi completata", { exact: true })).toBeVisible();
    await expect(score(page)).toHaveText(/^9\s*su 10$/);
    const topics = page.locator(".px-quiz-topics li");
    await expect(topics).toHaveCount(2);
    await expect(topics.nth(0)).toContainText("Moti");
    await expect(topics.nth(0)).toContainText("Lo sai già");
    await expect(topics.nth(1)).toContainText("Energia");
    await axe(page);
    const second = page.locator(".px-quiz-row").nth(1);
    await second.locator(".px-quiz-row-head").click();
    await expect(second.locator(".px-cite")).toHaveCount(1);
    await second.getByRole("button", { name: "Domanda sbagliata?" }).click();
    await expect(score(page)).toHaveText(/^9\s*su 9$/);
    await expect(second).toContainText("Domanda tolta dal punteggio");
    // A new question takes its place in the next diagnostic.
    await expect
      .poll(
        () => {
          const db = new DatabaseSync(join(userData, "workspace", "pyxis.db"), { readOnly: true, timeout: 10000 });
          const row = db
            .prepare(
              "SELECT body_json FROM items WHERE plan_id = ? AND kind = 'diagnostic' ORDER BY created_at DESC LIMIT 1",
            )
            .get(planId) as { body_json: string };
          db.close();
          return (JSON.parse(row.body_json) as { questions: Array<{ stem: string }> }).questions.map(
            (question) => question.stem,
          );
        },
        { timeout: 20000 },
      )
      .toContain("Domanda di ricambio sul moto");
    await page.getByRole("button", { name: "Continua", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`#/plans/${planId}$`));
  } finally {
    await done();
  }
});

/** Open questions graded by the recorded model after `delay` ms. */
function openReplies() {
  return {
    markdown: { markdown: "## Il moto\nLa velocità descrive il moto [P1]." },
    questions: diagnosticReply,
    quizQuestions: {
      questions: Array.from({ length: 10 }, (_, i) => ({
        kind: "open",
        stem: `Spiega che cosa misura la velocità (${"{{question:" + i + "}}"}).`,
        reference: "La velocità è lo spostamento diviso il tempo impiegato.",
        rubric: ["Nomina lo spostamento", "Nomina il tempo"],
        passageIds: ["{{passage:0}}"],
        explanation: "Spostamento nel tempo.",
      })),
    },
    score: { score: 0.6, explanation: "Hai nominato lo spostamento ma non il tempo." },
  };
}

test("open answer: checked right away, the check can be cancelled and the answer edited", async () => {
  test.setTimeout(120000);
  const { page, planId, topics, done } = await launch(openReplies(), 1500);
  try {
    const quiz = await invoke<{ attemptId: string }>(page, "study.quizStart", {
      planId,
      topicId: topics[0]!.id,
      types: ["open"],
    });
    await expect
      .poll(async () => (await invoke<{ state: string }>(page, "study.quizRead", { attemptId: quiz.attemptId })).state)
      .toBe("succeeded");
    await go(page, `/plans/${planId}/quiz/${topics[0]!.id}?attempt=${quiz.attemptId}`);
    const answer = page.getByRole("textbox", { name: "La tua risposta" });
    await answer.fill("È lo spostamento.");
    await page.getByRole("button", { name: "Verifica", exact: true }).click();
    await expect(page.getByText("Correggo…", { exact: true })).toBeVisible();
    await expect(answer).toBeDisabled();
    await page.locator(".px-quiz-checking").getByRole("button", { name: "Annulla" }).click();
    await expect(page.getByText("Correggo…", { exact: true })).toHaveCount(0);
    await expect(answer).toBeEnabled();
    await expect(page.getByRole("alert")).toHaveCount(0);
    await answer.fill("È lo spostamento diviso il tempo.");
    await page.getByRole("button", { name: "Verifica", exact: true }).click();
    const feedback = page.locator(".px-quiz-feedback");
    await expect(feedback).toContainText("Parzialmente corretto", { timeout: 15000 });
    await expect(feedback).toContainText("60%");
    await expect(feedback).toContainText("Risposta modello");
    await expect(answer).toBeDisabled();
    await axe(page);
  } finally {
    await done();
  }
});

test("quiz screens in both languages and themes", async () => {
  test.setTimeout(240000);
  const { page, planId, topics, done } = await launch(openReplies(), 2500);
  await page.setViewportSize({ width: 1280, height: 800 });
  try {
    for (const lang of ["it", "en"] as const) {
      await page.evaluate((value) => localStorage.setItem("pyxis.lang", value), lang);
      await page.reload();
      const shoot = async (name: string, fullPage = false) => {
        for (const theme of ["light", "dark"] as const) {
          await page.evaluate((value) => window.pyxis.setAppearance(value), theme);
          await page.evaluate(() => document.fonts.ready);
          await saveShot(page, `v021-quiz-${name}-${lang}-${theme}.png`, { animations: "disabled", fullPage });
        }
      };
      await go(page, `/plans/${planId}/diagnostic`);
      await expect(page.locator(".px-intro")).toBeVisible();
      // Questions, time, topics and when it corrects.
      await expect(page.locator(".px-intro-facts li")).toHaveCount(4);
      await shoot("start");
      const started = await invoke<{
        attemptId: string;
        questions: Array<{ id: string; options: string[] }>;
      }>(page, "study.diagnosticStart", { planId });
      const ids = started.questions.map((question) => question.id);
      // The options are shown in a shuffled order: the right one is the text "La velocità", and any other is wrong.
      const right = started.questions.map((question) => String(question.options.indexOf("La velocità")));
      const wrong = started.questions.map((question) =>
        String(question.options.findIndex((text) => text !== "La velocità")),
      );
      const view = `/plans/${planId}/diagnostic?attempt=${started.attemptId}`;
      await invoke(page, "study.quizDraft", {
        attemptId: started.attemptId,
        planId,
        picks: { [ids[0]!]: "1" },
        index: 0,
      });
      await go(page, view);
      await expect(page.locator(".px-opt.is-selected")).toHaveCount(1);
      await shoot("question");
      await invoke(page, "study.quizCheck", { attemptId: started.attemptId, questionId: ids[0], pick: right[0] });
      await page.reload();
      await expect(page.locator(".px-quiz-feedback.is-correct")).toBeVisible();
      await shoot("correct");
      await invoke(page, "study.quizCheck", { attemptId: started.attemptId, questionId: ids[1], pick: wrong[1] });
      // An open quiz page saves its own draft shortly after loading and again when it closes, so a draft set while it
      // is open can be overwritten on a slow runner. Set it with no quiz page open: leave, wait until the page is gone,
      // and reload. The reload also drops the session the page cached: opened again from that cache, the quiz page
      // would save the old draft half a second later, over ours.
      await go(page, "/exams");
      await expect(page.locator(".px-opt")).toHaveCount(0);
      await page.reload();
      // A closing save sent just before the reload can still land after ours, so save until the stored draft holds.
      const wanted = { [ids[0]!]: right[0]!, [ids[1]!]: wrong[1]! };
      await expect(async () => {
        await invoke(page, "study.quizDraft", {
          attemptId: started.attemptId,
          planId,
          picks: wanted,
          index: 1,
        });
        const stored = (await invoke(page, "study.quizRead", { attemptId: started.attemptId, planId })) as {
          draft?: { picks: Record<string, string>; index: number };
        };
        expect(stored.draft).toEqual({ picks: wanted, index: 1 });
      }).toPass({ timeout: 15000 });
      await go(page, view);
      await expect(page.locator(".px-quiz-feedback.is-wrong")).toBeVisible();
      await shoot("wrong");
      const picks: Record<string, string> = { [ids[0]!]: right[0]!, [ids[1]!]: wrong[1]! };
      for (const [offset, id] of ids.slice(2).entries()) {
        picks[id] = id === ids[4] ? wrong[offset + 2]! : right[offset + 2]!;
        await invoke(page, "study.quizCheck", { attemptId: started.attemptId, questionId: id, pick: picks[id] });
      }
      await invoke(page, "study.quizSubmit", { attemptId: started.attemptId, picks });
      await expect
        .poll(async () => (await invoke<{ result?: unknown }>(page, "study.quizRead", { attemptId: started.attemptId })).result)
        .toBeTruthy();
      await page.reload();
      await expect(page.locator(".px-quiz-results")).toBeVisible();
      await shoot("results", true);
      await page.locator(".px-quiz-row").nth(1).locator(".px-quiz-row-head").click();
      await expect(page.locator(".px-quiz-row-body")).toBeVisible();
      await shoot("results-expanded", true);

      const quiz = await invoke<{ attemptId: string }>(page, "study.quizStart", {
        planId,
        topicId: topics[0]!.id,
        types: ["open"],
      });
      await expect
        .poll(async () => (await invoke<{ state: string }>(page, "study.quizRead", { attemptId: quiz.attemptId })).state)
        .toBe("succeeded");
      await go(page, `/plans/${planId}/quiz/${topics[0]!.id}?attempt=${quiz.attemptId}`);
      await page.locator(".px-quiz-open").getByRole("textbox").fill(
        lang === "it" ? "È lo spostamento diviso il tempo." : "Displacement over time.",
      );
      await page.locator(".px-quiz-nav .ant-btn-primary").click();
      await expect(page.locator(".px-quiz-checking")).toBeVisible();
      await shoot("open-checking");
      await expect(page.locator(".px-quiz-feedback.is-partial")).toBeVisible({ timeout: 15000 });
      await shoot("open-graded");
    }
  } finally {
    await done();
  }
});

test("LES-01 LES-11 FC-01 live smartbook study loop", async () => {
  test.skip(
    process.env.PYXIS_LIVE_STUDY !== "1",
    "Set PYXIS_LIVE_STUDY=1 for signed-in model validation.",
  );
  test.setTimeout(480000);
  const userData = mkdtempSync(join(tmpdir(), "pyxis-live-study-"));
  const app = await launchPyxis({ userData, env: { PYXIS_E2E_PLAN_REPLIES: undefined } });
  const startedAt = Date.now();
  try {
    const page = await app.firstWindow();
    await page.getByRole("button", { name: "Salta" }).click();
    // Skipping saves the profile, then moves to Exams; wait so a reload or route change cannot land on setup.
    await expect(page).toHaveURL(/#\/exams$/);
    const models = (await page.evaluate(() =>
      window.pyxis.invoke("engines.models", { provider: "claude" }),
    )) as Array<{ id: string; name: string }>;
    const model = models.find((entry) => /sonnet/i.test(entry.name))!.id;
    await page.evaluate(
      (model) =>
        window.pyxis.invoke("engines.setFeature", {
          feature: "default",
          provider: "claude",
          model,
        }),
      model,
    );
    const imported = (await importPickedSource(
      page,
      app,
      "/Users/tost1/Documents/Personal/Vibecode/PoliTost/books/ptt-fisica1.ptsb",
    )) as { sourceId: string };
    await expect
      .poll(async () => {
        const rows = (await page.evaluate(() =>
          window.pyxis.invoke("sources.list", {}),
        )) as Array<{ id: string; status: string }>;
        return rows.find((row) => row.id === imported.sourceId)?.status;
      })
      .toBe("ready");
    const created = (await page.evaluate(
      (sourceId) =>
        window.pyxis.invoke("plans.create", {
          title: "Fisica 1",
          sourceIds: [sourceId],
          language: "it",
        }),
      imported.sourceId,
    )) as { planId: string };
    let build = null as { state: string; error?: string } | null;
    await expect
      .poll(
        async () => {
          build = (await page.evaluate(
            (planId) => window.pyxis.invoke("plans.build", { planId }),
            created.planId,
          )) as typeof build;
          return build?.state === "failed" || build?.state === "succeeded"
            ? build.state
            : "waiting";
        },
        { timeout: 240000 },
      )
      .toMatch(/^(failed|succeeded)$/);
    expect(build?.state, build?.error).toBe("succeeded");
    const plan = (await page.evaluate(
      (planId) => window.pyxis.invoke("plans.read", { planId }),
      created.planId,
    )) as { topics: Array<{ id: string }> };
    const scope = { planId: created.planId, topicId: plan.topics[0]!.id };
    const lesson = (await page.evaluate(
      (scope) => window.pyxis.invoke("study.lesson", scope),
      scope,
    )) as { markdown: string; passageIds: string[] };
    expect(lesson.markdown).toMatch(/\[P\d+\]/);
    expect(lesson.passageIds.length).toBeGreaterThan(0);
    const cards = (await page.evaluate(
      (scope) => window.pyxis.invoke("study.cards", scope),
      scope,
    )) as Array<{ id: string }>;
    expect(cards).toHaveLength(20);
    for (const card of cards) {
      const before = Date.now();
      const state = (await page.evaluate(
        (cardId) =>
          window.pyxis.invoke("study.rate", { cardId, rating: "good" }),
        card.id,
      )) as { intervalDays: number; dueAt: number };
      expect(state.intervalDays).toBe(0);
      expect(state.dueAt - before).toBeGreaterThanOrEqual(600000);
      expect(state.dueAt - before).toBeLessThan(602000);
    }
    const quiz = (await page.evaluate(
      (scope) =>
        window.pyxis.invoke("study.quizStart", {
          ...scope,
          count: 20,
        }),
      scope,
    )) as { attemptId: string };
    let session = null as {
      state: string;
      error?: string;
      questions: Array<{ id: string; grade: { kind: string } }>;
    } | null;
    await expect
      .poll(
        async () => {
          session = (await page.evaluate(
            (attemptId) => window.pyxis.invoke("study.quizRead", { attemptId }),
            quiz.attemptId,
          )) as typeof session;
          return session?.state === "succeeded" || session?.state === "failed"
            ? session.state
            : "waiting";
        },
        { timeout: 180000 },
      )
      .toMatch(/^(failed|succeeded)$/);
    expect(session?.state, session?.error).toBe("succeeded");
    expect(session!.questions).toHaveLength(20);
    for (const kind of ["mcq", "tf", "completion", "matching", "open"])
      expect(
        session!.questions.filter((question) => question.grade.kind === kind),
      ).toHaveLength(4);
    const open = session!.questions.find(
      (question) => question.grade.kind === "open",
    )!;
    const check = (await page.evaluate(
      ({ attemptId, questionId }) =>
        window.pyxis.invoke("study.quizCheck", {
          attemptId,
          questionId,
          pick: "La velocità è la variazione della posizione nel tempo e include direzione e verso.",
        }),
      { attemptId: quiz.attemptId, questionId: open.id },
    )) as { score: number; model?: string };
    expect(check.model).toBeTruthy();
    mkdirSync(".shots", { recursive: true });
    writeFileSync(
      ".shots/m8-live-check.json",
      JSON.stringify(
        {
          latencyMs: Date.now() - startedAt,
          topics: plan.topics.length,
          lessonCitations: lesson.passageIds.length,
          ratedCards: cards.length,
          questions: session!.questions.length,
          gradingModel: check.model,
          selection: model,
        },
        null,
        2,
      ),
    );
  } finally {
    await app.close();
    rmSync(userData, { recursive: true, force: true });
  }
});
