import { importPickedSource } from "./picked-source";
import AxeBuilder from "@axe-core/playwright";
import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
} from "@playwright/test";
import { strToU8, zipSync } from "fflate";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";

const MAIN = join(process.cwd(), process.env.PYXIS_OUT_DIR ?? "out", "main/index.js");

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
    zipSync({
      "smartbook.json": strToU8(
        JSON.stringify({
          id: "fisica",
          title: "Fisica",
          access: "public",
          chapters: [
            { id: "c1", number: 1, title: "Moti", file: "01.md" },
            { id: "c2", number: 2, title: "Energia", file: "02.md" },
          ],
        }),
      ),
      "chapters/01.md": strToU8("## p1 | Velocità\nLa velocità descrive lo spostamento nel tempo.\n"),
      "chapters/02.md": strToU8("## p1 | Lavoro\nIl lavoro è forza per spostamento.\n"),
    }),
  );
  const env = {
    ...process.env,
    PYXIS_USER_DATA: userData,
    PYXIS_E2E: "1",
    PYXIS_E2E_PLAN_REPLIES: JSON.stringify(replies),
    PYXIS_E2E_PLAN_DELAY: String(delay),
  };
  delete env.ELECTRON_RUN_AS_NODE;
  const app: ElectronApplication = await electron.launch({ args: [MAIN], env });
  const page = await app.firstWindow();
  await page.getByRole("button", { name: "Salta" }).click();
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
  expect((await new AxeBuilder({ page }).setLegacyMode(true).analyze()).violations).toEqual([]);
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
    const vero = page.getByRole("button", { name: "A. Vero", exact: true });
    const falso = page.getByRole("button", { name: "B. Falso", exact: true });
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
    await expect(page.getByRole("button", { name: /^A\. Vero, Corretta$/ })).toBeDisabled();
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
    await expect(page.getByRole("button", { name: /^A\. Vero, Risposta giusta$/ })).toBeVisible();
    await expect(page.getByRole("button", { name: /^B\. Falso, Sbagliata$/ })).toBeVisible();
    // Back shows the previous question as answered, read-only, on the left of the same row.
    const back = page.getByRole("button", { name: "Indietro", exact: true });
    const next = page.getByRole("button", { name: "Avanti", exact: true });
    const [backBox, nextBox] = [await back.boundingBox(), await next.boundingBox()];
    expect(Math.abs(backBox!.y - nextBox!.y)).toBeLessThan(2);
    expect(backBox!.x).toBeLessThan(nextBox!.x);
    await back.click();
    await expect(page.getByText("Domanda 1 di 10", { exact: true })).toBeVisible();
    await expect(page.locator(".px-quiz-feedback")).toContainText("Corretto");
    await expect(page.getByRole("button", { name: /^A\. Vero, Corretta$/ })).toBeDisabled();
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
    const db = new DatabaseSync(join(userData, "workspace", "pyxis.db"), { timeout: 10000 });
    db.prepare(
      "UPDATE attempt_answers SET payload_json = json_set(payload_json, '$.deadlineAt', ?) WHERE attempt_id = ? AND json_type(payload_json, '$.draft') = 'object'",
    ).run(Date.now() - 1000, timed.attemptId);
    db.close();
    await page.reload();
    await expect.poll(async () => (await read()).submittedAt).toBeGreaterThan(0);
    expect((await read()).result?.score).toBe(0);
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
    const close = page.locator(".px-quiz-intro-actions").getByRole("button", { name: "Chiudi" });
    const begin = page.getByRole("button", { name: "Inizia", exact: true });
    expect(Math.abs((await close.boundingBox())!.y - (await begin.boundingBox())!.y)).toBeLessThan(2);
    await begin.click();
    await expect(page.getByText("Domanda 1 di 10", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "A. La velocità" })).toBeEnabled();
    await page.keyboard.press("1");
    await page.keyboard.press("Enter");
    const feedback = page.locator(".px-quiz-feedback");
    await expect(feedback).toContainText("Corretto");
    // The passage the model cited is a source chip, never a raw ID.
    await expect(feedback.locator(".px-cite")).toHaveCount(1);
    expect(await feedback.innerText()).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/);
    await page.keyboard.press("Enter");
    await page.keyboard.press("2");
    await page.keyboard.press("Enter");
    await expect(feedback).toContainText("Sbagliato");
    await page.keyboard.press("Enter");
    for (let i = 2; i < 10; i++) {
      await expect(page.getByText(`Domanda ${i + 1} di 10`, { exact: true })).toBeVisible();
      await page.keyboard.press("1");
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
          const db = new DatabaseSync(join(userData, "workspace", "pyxis.db"), { readOnly: true });
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
  mkdirSync(".shots", { recursive: true });
  await page.setViewportSize({ width: 1280, height: 800 });
  try {
    for (const lang of ["it", "en"] as const) {
      await page.evaluate((value) => localStorage.setItem("pyxis.lang", value), lang);
      await page.reload();
      const shoot = async (name: string, fullPage = false) => {
        for (const theme of ["light", "dark"] as const) {
          await page.evaluate((value) => window.pyxis.setAppearance(value), theme);
          await page.evaluate(() => document.fonts.ready);
          await page.screenshot({
            path: `.shots/v021-quiz-${name}-${lang}-${theme}.png`,
            animations: "disabled",
            fullPage,
          });
        }
      };
      await go(page, `/plans/${planId}/diagnostic`);
      await expect(page.locator(".px-quiz-intro")).toBeVisible();
      await expect(page.locator(".px-quiz-facts li")).toHaveCount(3);
      await shoot("start");
      const started = await invoke<{ attemptId: string; questions: Array<{ id: string }> }>(
        page,
        "study.diagnosticStart",
        { planId },
      );
      const ids = started.questions.map((question) => question.id);
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
      await invoke(page, "study.quizCheck", { attemptId: started.attemptId, questionId: ids[0], pick: "0" });
      await page.reload();
      await expect(page.locator(".px-quiz-feedback.is-correct")).toBeVisible();
      await shoot("correct");
      await invoke(page, "study.quizCheck", { attemptId: started.attemptId, questionId: ids[1], pick: "2" });
      await invoke(page, "study.quizDraft", {
        attemptId: started.attemptId,
        planId,
        picks: { [ids[0]!]: "0", [ids[1]!]: "2" },
        index: 1,
      });
      await page.reload();
      await expect(page.locator(".px-quiz-feedback.is-wrong")).toBeVisible();
      await shoot("wrong");
      const picks: Record<string, string> = { [ids[0]!]: "0", [ids[1]!]: "2" };
      for (const id of ids.slice(2)) {
        picks[id] = id === ids[4] ? "3" : "0";
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
  const env = { ...process.env, PYXIS_USER_DATA: userData, PYXIS_E2E: "1" };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.PYXIS_E2E_PLAN_REPLIES;
  const app = await electron.launch({
    args: [join(process.cwd(), process.env.PYXIS_OUT_DIR ?? "out", "main/index.js")],
    env,
  });
  const startedAt = Date.now();
  try {
    const page = await app.firstWindow();
    await page.getByRole("button", { name: "Salta" }).click();
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
    let build: { state: string; error?: string } | null = null;
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
          feedback: true,
        }),
      scope,
    )) as { attemptId: string };
    let session: {
      state: string;
      error?: string;
      questions: Array<{ id: string; grade: { kind: string } }>;
    } | null = null;
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
