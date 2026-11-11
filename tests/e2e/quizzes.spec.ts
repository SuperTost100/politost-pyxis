import { importPickedSource } from "./picked-source";
import {
  expect,
  test,
  type ElectronApplication,
  type Page,
} from "@playwright/test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchPyxis } from "./app-under-test";
import { makeBook } from "./book";
import { expectNoAxeViolations } from "./axe";
import { saveShot } from "./shots";
import { removeTestFolder } from "./cleanup";
import { fromChiediToExams } from "./doors";

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
  // Skipping saves the profile, then moves to Chiedi; wait so a reload or route change cannot land on setup.
  await fromChiediToExams(page);
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
    removeTestFolder(userData);
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

// The results summary: the line with the points, and the grade on the student's scale as the title.
const score = (page: Page) => page.locator(".px-res-headline");
const grade = (page: Page) => page.locator(".px-res-title");

// The question's own card: "Domanda 3 di 10" is its heading, and it takes focus when the question changes.
const card = (page: Page) => page.locator(".px-qz-sheet");
const sheet = (page: Page) => page.getByRole("complementary", { name: /^(Domande|Questions)$/ });

test("LES-11 LES-12 topic quiz: calm intro, ten questions answered then handed in, back, keys and results", async () => {
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
    await expect(page.getByText("Correzione alla consegna", { exact: true })).toBeVisible();
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
    // Number keys pick, and the pick can change freely until the quiz is handed in.
    await page.keyboard.press("2");
    await expect(falso).toHaveAttribute("aria-pressed", "true");
    // The question's card takes focus for screen readers but draws no focus box.
    expect(
      await card(page).evaluate(
        (element) => document.activeElement === element && getComputedStyle(element).outlineStyle,
      ),
    ).toBe("none");
    await page.keyboard.press("1");
    await expect(vero).toHaveAttribute("aria-pressed", "true");
    await expect(falso).toHaveAttribute("aria-pressed", "false");
    // On the first question there is nothing to go back to.
    await expect(page.getByRole("button", { name: "Indietro", exact: true })).toHaveCount(0);
    // Enter goes on: no correction until Consegna.
    await page.keyboard.press("Enter");
    await expect(page.getByText("Domanda 2 di 10", { exact: true })).toBeVisible();
    await expect(card(page)).toBeFocused();
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
    // Back and Avanti sit on one row under the card, Back on the left; the previous answer can still change.
    const back = page.getByRole("button", { name: "Indietro", exact: true });
    const next = page.getByRole("button", { name: "Avanti", exact: true });
    const [backBox, nextBox] = [await back.boundingBox(), await next.boundingBox()];
    expect(Math.abs(backBox!.y + backBox!.height / 2 - (nextBox!.y + nextBox!.height / 2))).toBeLessThan(2);
    expect(backBox!.x).toBeLessThan(nextBox!.x);
    await back.click();
    await expect(page.getByText("Domanda 1 di 10", { exact: true })).toBeVisible();
    await expect(vero).toHaveAttribute("aria-pressed", "true");
    await expect(vero).toBeEnabled();
    await next.click();
    await expect(page.getByText("Domanda 2 di 10", { exact: true })).toBeVisible();
    await expect(falso).toHaveAttribute("aria-pressed", "true");
    await next.click();
    for (let i = 2; i < 10; i++) {
      await expect(page.getByText(`Domanda ${i + 1} di 10`, { exact: true })).toBeVisible();
      await vero.click();
      // The last question's step forward is Consegna; with nothing blank or marked it hands in at once.
      await page.locator(".px-qz-nav .px-btn-primary").click();
    }
    await expect(score(page)).toContainText("9 punti su 10.");
    await expect(grade(page)).toHaveText("Hai preso 27/30");
    await page.reload();
    await expect(score(page)).toContainText("9 punti su 10.");
    // Every question in order: the nine right ones folded to a line, the one to review open.
    await expect(page.locator(".px-res-q")).toHaveCount(10);
    await expect(page.locator(".px-res-q.is-correct")).toHaveCount(9);
    const second = page.locator(".px-res-q").nth(1);
    await expect(second.locator(".px-res-n")).toHaveText("2");
    await expect(second).toHaveClass(/is-open/);
    await expect(second.locator(".px-res-answer.is-wrong")).toContainText("Falso");
    await expect(second.locator(".px-res-answer.is-expected")).toContainText("Vero");
    await axe(page);
    // "Wrong question?" takes it out of the score at once; the toast can undo it.
    await second.getByRole("button", { name: "Domanda sbagliata?" }).click();
    await expect(score(page)).toContainText("9 punti su 9.");
    await expect(grade(page)).toHaveText("Hai preso 30/30");
    await expect(second).toContainText("Esclusa dal punteggio");
    await page.locator(".px-quiz-toast").getByRole("button", { name: "Annulla" }).click();
    await expect(score(page)).toContainText("9 punti su 10.");
    await expect(second.getByRole("button", { name: "Domanda sbagliata?" })).toBeVisible();
    await second.getByRole("button", { name: "Chiedi", exact: true }).click();
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
    await expect(card(page)).toBeVisible();
    // The time left sits in the bar, and the line under the title says how long the quiz is.
    await expect(page.getByRole("timer", { name: "Tempo rimasto" })).toBeVisible();
    await expect(page.locator(".px-studybar-title p")).toHaveText("Fisica 1 · limite di 1 minuto");
    await expect.poll(async () => (await read()).deadlineAt).toBeGreaterThan(0);
    const deadline = (await read()).deadlineAt;
    await page.reload();
    expect((await read()).deadlineAt).toBe(deadline);
    // Move the deadline into the past while no quiz page is open, since an open page saves its draft on a timer and
    // keeps the session it loaded. Leave, reload so nothing of that page is left, then write.
    await go(page, "/exams");
    await expect(card(page)).toHaveCount(0);
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

test("Non lo so (key 0) and Segna per dopo (key S) are saved, counted at Consegna, and a blank answer scores 0", async () => {
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
        draft?: { index: number; picks: Record<string, string>; marked?: string[] };
        questions: Array<{ id: string; stem: string }>;
      }>(page, "study.quizRead", { attemptId: started.attemptId });
    await expect.poll(async () => (await read()).state).toBe("succeeded");
    const ids = (await read()).questions.map((question) => question.id);
    await go(page, `/plans/${planId}/quiz/${topics[0]!.id}?attempt=${started.attemptId}`);
    await expect(page.getByText("Domanda 1 di 10", { exact: true })).toBeVisible();
    await axe(page);
    await shoot("question", "it");

    // 0 on the first question: an empty answer, said under the actions. S marks it for later.
    await page.keyboard.press("0");
    await page.keyboard.press("s");
    const dontKnow = page.getByRole("button", { name: "Non lo so", exact: true });
    const mark = page.getByRole("button", { name: "Segna per dopo", exact: true });
    await expect(dontKnow).toHaveAttribute("aria-pressed", "true");
    await expect(mark).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByText("Conta come una risposta sbagliata, e quella giusta la vedi nei risultati.")).toBeVisible();
    await expect(sheet(page).getByRole("button", { name: "Domanda 1, non lo so, segnata per dopo" })).toBeVisible();
    await expect.poll(async () => (await read()).draft).toMatchObject({ picks: { [ids[0]!]: "" }, marked: [ids[0]] });
    await axe(page);
    await shoot("dont-know", "it");
    // Pressed again, each takes itself back.
    await page.keyboard.press("0");
    await expect(dontKnow).toHaveAttribute("aria-pressed", "false");
    await page.keyboard.press("0");

    // Every other question but the last is answered; the last stays blank.
    await page.keyboard.press("Enter");
    for (let i = 2; i <= 9; i++) {
      await expect(page.getByText(`Domanda ${i} di 10`, { exact: true })).toBeVisible();
      await page.keyboard.press("1");
      await page.keyboard.press("Enter");
    }
    await expect(page.getByText("Domanda 10 di 10", { exact: true })).toBeVisible();
    await expect(sheet(page).locator(".px-qz-count")).toHaveText("9 di 10 date");
    // Enter on the last question asks Consegna's question: one blank, one marked.
    await page.keyboard.press("Enter");
    const confirm = page.getByRole("group", { name: /^Consegni con/ });
    await expect(confirm).toHaveAccessibleName(
      "Consegni con 1 domanda vuota e 1 domanda segnata per dopo? Quella vuota conta come «non lo so».",
    );
    await shoot("handin", "it");
    await confirm.getByRole("button", { name: "Consegna", exact: true }).click();
    // Eight right answers; the "Non lo so" and the blank one are wrong answers with no pick.
    await expect(score(page)).toContainText("8 punti su 10.");
    // The two to review are open; the right ones fold to a line.
    await expect(page.locator(".px-res-q:not(.is-correct)")).toHaveCount(2);
    const rows = page.locator(".px-res-q");
    await expect(rows).toHaveCount(10);
    const first = rows.nth(0);
    await expect(first.locator(".px-res-n")).toHaveText("1");
    await expect(first.locator(".px-res-st")).toHaveText("Non lo so · 0/1");
    await expect(first.locator(".px-res-answer-empty")).toHaveText("Non lo so");
    await expect(first.locator(".px-res-answer.is-expected")).toContainText("Vero");
    await expect(rows.nth(9).locator(".px-res-n")).toHaveText("10");
    await expect(rows.nth(9).locator(".px-res-answer-empty")).toHaveText("Non lo so");

    // The same screens in English.
    await page.evaluate(() => localStorage.setItem("pyxis.lang", "en"));
    const english = await invoke<{ attemptId: string }>(page, "study.quizStart", {
      planId,
      topicId: topics[0]!.id,
      types: ["tf"],
    });
    await go(page, "/exams");
    await page.reload();
    await go(page, `/plans/${planId}/quiz/${topics[0]!.id}?attempt=${english.attemptId}`);
    await expect(page.getByRole("button", { name: "I don't know", exact: true })).toBeVisible();
    await shoot("question", "en");
    await page.setViewportSize({ width: 480, height: 800 });
    await shoot("question-narrow", "en");
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.keyboard.press("0");
    await page.keyboard.press("s");
    await expect(page.getByRole("button", { name: "Mark for later", exact: true })).toHaveAttribute("aria-pressed", "true");
    await shoot("dont-know", "en");
    await page.evaluate(() => localStorage.setItem("pyxis.lang", "it"));
    await go(page, "/exams");
    await page.reload();

    // On a timed quiz marking leaves the deadline alone and still saves.
    const timed = await invoke<{ attemptId: string }>(page, "study.quizStart", {
      planId,
      topicId: topics[0]!.id,
      types: ["tf"],
      timerMinutes: 5,
    });
    const timedRead = () =>
      invoke<{ state: string; deadlineAt?: number; draft?: { marked?: string[] } }>(
        page,
        "study.quizRead",
        { attemptId: timed.attemptId },
      );
    await expect.poll(async () => (await timedRead()).state).toBe("succeeded");
    // A new page, as from the path: the finished quiz's page state does not carry over.
    await go(page, "/exams");
    await expect(page.locator(".px-res")).toHaveCount(0);
    await go(page, `/plans/${planId}/quiz/${topics[0]!.id}?attempt=${timed.attemptId}`);
    await expect.poll(async () => (await timedRead()).deadlineAt).toBeGreaterThan(0);
    const deadline = (await timedRead()).deadlineAt;
    await expect(page.getByRole("timer")).toBeVisible();
    await page.keyboard.press("s");
    await expect.poll(async () => (await timedRead()).draft?.marked).toHaveLength(1);
    expect((await timedRead()).deadlineAt).toBe(deadline);
  } finally {
    await done();
  }
});

test("diagnostic: answered then handed in, where to start, source chips and a reported question replaced", async () => {
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
    await expect(page.getByRole("heading", { name: "Test diagnostico", level: 2 })).toBeVisible();
    await expect(page.getByText("10 domande", { exact: true })).toBeVisible();
    await expect(page.getByText(/alla fine/)).toHaveCount(0);
    // Back and Start sit side by side; the focus bar's X is the only exit, so the intro has no Close of its own.
    const back = page.locator(".px-intro-actions").getByRole("button", { name: "Indietro" });
    const begin = page.getByRole("button", { name: "Inizia", exact: true });
    expect(Math.abs((await back.boundingBox())!.y - (await begin.boundingBox())!.y)).toBeLessThan(2);
    await expect(page.locator(".px-intro-actions").getByRole("button", { name: "Chiudi" })).toHaveCount(0);
    await begin.click();
    await expect(page.getByText("Domanda 1 di 10", { exact: true })).toBeVisible();
    // The bar says what the page is, not "Quiz".
    await expect(page.locator(".px-studybar-title")).toContainText("Test diagnostico");
    // The options are shown in a shuffled order, so each answer is picked by its text.
    const option = (text: string) => page.getByRole("button", { name: new RegExp(`^[A-D] ${text}$`) });
    await expect(option("La velocità")).toBeEnabled();
    await option("La velocità").click();
    await page.keyboard.press("Enter");
    await option("La massa").click();
    await page.keyboard.press("Enter");
    // "Segnala la domanda" takes the third question out of the score at once and says so; pressed again it would undo.
    await option("La velocità").click();
    await page.getByRole("button", { name: "Segnala la domanda" }).click();
    await expect(page.getByRole("button", { name: "Domanda segnalata" })).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByText("Domanda tolta dal punteggio e dai prossimi quiz.")).toBeVisible();
    // Focus stays on the pressed button, where Enter would undo the report, so this step goes on with Avanti.
    await page.getByRole("button", { name: "Avanti", exact: true }).click();
    for (let i = 3; i < 10; i++) {
      await expect(page.getByText(`Domanda ${i + 1} di 10`, { exact: true })).toBeVisible();
      await option("La velocità").click();
      await page.locator(".px-qz-nav .px-btn-primary").click();
    }
    await expect(page.getByText("Test diagnostico completato", { exact: true })).toBeVisible();
    // Nine questions count; the reported one is left out.
    await expect(score(page)).toContainText("8 punti su 9.");
    const topics = page.locator(".px-res-topics li");
    await expect(topics).toHaveCount(2);
    await expect(topics.nth(0)).toContainText("Moti");
    await expect(topics.nth(0)).toContainText("Lo sai già");
    await expect(topics.nth(1)).toContainText("Energia");
    await axe(page);
    // The wrong answer is the one listed to review, open with its cited explanation.
    const second = page.locator(".px-res-q:not(.is-correct)").first();
    await expect(second.locator(".px-res-n")).toHaveText("2");
    await expect(second.locator(".px-cite")).toHaveCount(1);
    expect(await second.innerText()).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/);
    // A new question takes the reported one's place in the next diagnostic.
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

test("open answer: written with formulas, graded by the AI tool after Consegna with the work shown in place", async () => {
  test.setTimeout(120000);
  const { page, planId, topics, done } = await launch(openReplies(), 1500);
  try {
    const quiz = await invoke<{ attemptId: string }>(page, "study.quizStart", {
      planId,
      topicId: topics[0]!.id,
      types: ["open"],
    });
    // While the questions are written, the sheet shows the work in place: the working mark in the question's card, or
    // beside the numbers once some questions are ready, with the ones still to come drawn and Consegna waiting.
    await go(page, `/plans/${planId}/quiz/${topics[0]!.id}?attempt=${quiz.attemptId}`);
    await expect(page.locator(".px-qz-sheet .px-working-slot, .px-qz-busy").first()).toBeVisible();
    await expect(page.locator(".px-qz-num.is-waiting").first()).toBeVisible();
    await expect(sheet(page).getByRole("button", { name: "Consegna", exact: true })).toBeDisabled();
    await expect(sheet(page)).toContainText("Potrai consegnare quando tutte le domande saranno pronte.");
    await saveShot(page, "quiz-writing-it-light.png", { animations: "disabled" });
    // Ten questions are written in three calls, each with the recorded model's delay.
    await expect
      .poll(async () => (await invoke<{ state: string }>(page, "study.quizRead", { attemptId: quiz.attemptId })).state, {
        timeout: 20000,
      })
      .toBe("succeeded");
    await expect(page.locator(".px-qz-kicker")).toHaveText("Risposta aperta");
    const answer = page.getByRole("textbox", { name: "La tua risposta" });
    await answer.fill("È lo spostamento diviso il tempo.");
    await expect(sheet(page).getByRole("button", { name: "Domanda 1, risposta data" })).toBeVisible();
    // An answer erased to nothing is blank again, not "Non lo so".
    await answer.fill("");
    await expect(sheet(page).getByRole("button", { name: "Domanda 1", exact: true })).toBeVisible();
    await answer.fill("È lo spostamento diviso il tempo.");
    await sheet(page).getByRole("button", { name: "Consegna", exact: true }).click();
    await page.getByRole("group", { name: /^Consegni con 9 domande vuote/ }).getByRole("button", { name: "Consegna" }).click();
    // The written answer is graded by the model while the results wait with the working mark.
    // The title or the line under it, whichever says it.
    await expect(page.locator(".px-res")).toContainText("Correggo le tue risposte.");
    await expect(page.locator(".px-qz-sheet")).toHaveCount(0);
    await expect(score(page)).toContainText(/0,6 punt[io] su 10\./, { timeout: 15000 });
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
        marked: [ids[2]!],
      });
      await go(page, view);
      await expect(page.locator(".px-opt.is-selected")).toHaveCount(1);
      await expect(sheet(page).locator(".px-qz-flag")).toHaveCount(1);
      await shoot("question");
      await sheet(page).getByRole("button", { name: lang === "it" ? "Consegna" : "Hand in", exact: true }).click();
      await expect(page.locator(".px-qz-confirm")).toBeVisible();
      await shoot("handin");
      const picks: Record<string, string> = Object.fromEntries(
        ids.map((id, index) => [id, index === 1 || index === 4 ? wrong[index]! : right[index]!]),
      );
      await go(page, "/exams");
      await expect(page.locator(".px-opt")).toHaveCount(0);
      await page.reload();
      await invoke(page, "study.quizSubmit", { attemptId: started.attemptId, picks });
      await expect
        .poll(async () => (await invoke<{ result?: unknown }>(page, "study.quizRead", { attemptId: started.attemptId })).result)
        .toBeTruthy();
      await go(page, view);
      await expect(page.locator(".px-res")).toBeVisible();
      await shoot("results", true);
      // A right answer stays folded until it is opened.
      const rightRow = page.locator(".px-res-q.is-correct").first();
      await expect(rightRow.locator(".px-res-q-body")).toHaveCount(0);
      await rightRow.locator(".px-res-q-head").click();
      await expect(rightRow.locator(".px-res-q-body")).toBeVisible();
      await shoot("results-expanded", true);

      const quiz = await invoke<{ attemptId: string }>(page, "study.quizStart", {
        planId,
        topicId: topics[0]!.id,
        types: ["open"],
      });
      // Ten questions are written in three calls, each with the recorded model's delay.
      await expect
        .poll(async () => (await invoke<{ state: string }>(page, "study.quizRead", { attemptId: quiz.attemptId })).state, {
          timeout: 20000,
        })
        .toBe("succeeded");
      await go(page, `/plans/${planId}/quiz/${topics[0]!.id}?attempt=${quiz.attemptId}`);
      await page.locator(".px-quiz-open").getByRole("textbox").fill(
        lang === "it" ? "È lo spostamento diviso il tempo." : "Displacement over time.",
      );
      await shoot("open");
      await sheet(page).locator(".px-qz-handin > .px-btn").click();
      await page.locator(".px-qz-confirm .px-btn-primary").click();
      await expect(page.locator(".px-res")).toBeVisible();
      await shoot("open-grading");
      await expect(score(page)).toContainText(/0,6|0\.6/, { timeout: 15000 });
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
    // Skipping saves the profile, then moves to Chiedi; wait so a reload or route change cannot land on setup.
    await fromChiediToExams(page);
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
    removeTestFolder(userData);
  }
});
