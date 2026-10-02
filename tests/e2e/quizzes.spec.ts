import AxeBuilder from "@axe-core/playwright";
import { _electron as electron, expect, test } from "@playwright/test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { manyPagePdf } from "../../src/core/sources/documents";

test("LES-11 LES-12 quiz setup, soft timer, checked-answer recovery and results", async () => {
  const userData = mkdtempSync(join(tmpdir(), "pyxis-quiz-check-"));
  const file = join(userData, "physics.pdf");
  writeFileSync(file, manyPagePdf(1, "Velocity is displacement over time."));
  const replies = {
    topics: {
      topics: [
        {
          title: "Moto",
          summary: "Velocità",
          subtopics: ["Tempo"],
          sourceSections: [
            { sourceId: "{{source:0}}", section: "{{section:0}}" },
          ],
        },
      ],
    },
    markdown: { markdown: "## Il moto\nLa velocità descrive il moto [P1]." },
    questions: {
      questions: Array.from({ length: 10 }, (_, i) => ({
        stem: `Diagnosi ${i}`,
        options: ["a", "b", "c", "d"],
        correct: 0,
        topicIndex: 0,
        passageIds: ["{{passage:0}}"],
        explanation: "Il moto.",
      })),
    },
    quizQuestions: {
      questions: Array.from({ length: 10 }, (_, i) => ({
        kind: "tf",
        stem: `La velocità descrive lo spostamento nel tempo. Affermazione {{question:${i}}}.`,
        correct: true,
        passageIds: ["{{passage:0}}"],
        explanation: "La velocità è lo spostamento per unità di tempo.",
      })),
    },
  };
  const env = {
    ...process.env,
    PYXIS_USER_DATA: userData,
    PYXIS_E2E: "1",
    PYXIS_E2E_PLAN_REPLIES: JSON.stringify(replies),
    PYXIS_E2E_PLAN_DELAY: "100",
  };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({
    args: [join(process.cwd(), "out/main/index.js")],
    env,
  });
  try {
    const page = await app.firstWindow();
    await page.getByRole("button", { name: "Salta" }).click();
    const source = (await page.evaluate(
      (path) => window.pyxis.invoke("sources.import", { path }),
      file,
    )) as { sourceId: string };
    await expect
      .poll(async () => {
        const rows = (await page.evaluate(() =>
          window.pyxis.invoke("sources.list", {}),
        )) as Array<{ id: string; status: string }>;
        return rows.find((row) => row.id === source.sourceId)?.status;
      })
      .toBe("ready");
    const created = (await page.evaluate(
      (sourceId) =>
        window.pyxis.invoke("plans.create", {
          title: "Fisica",
          sourceIds: [sourceId],
        }),
      source.sourceId,
    )) as { planId: string };
    await expect
      .poll(
        async () =>
          (
            (await page.evaluate(
              (planId) => window.pyxis.invoke("plans.build", { planId }),
              created.planId,
            )) as { state: string }
          ).state,
      )
      .toBe("succeeded");
    const plan = (await page.evaluate(
      (planId) => window.pyxis.invoke("plans.read", { planId }),
      created.planId,
    )) as { topics: Array<{ id: string }> };
    await page.evaluate(
      ({ planId, topicId }) => {
        window.location.hash = `/plans/${planId}/quiz/${topicId}`;
      },
      { planId: created.planId, topicId: plan.topics[0]!.id },
    );
    await expect(
      page.getByRole("slider", { name: "Numero di domande" }),
    ).toBeVisible();
    mkdirSync(".shots", { recursive: true });
    for (const theme of ["dark", "light"] as const) {
      await page.evaluate((value) => window.pyxis.setAppearance(value), theme);
      for (const width of [1280, 960]) {
        await page.setViewportSize({
          width,
          height: width === 960 ? 640 : 800,
        });
        await page.screenshot({
          path: `.shots/m8-setup-it-${theme}-${width}.png`,
          animations: "disabled",
        });
        expect(
          (await new AxeBuilder({ page }).setLegacyMode(true).analyze())
            .violations,
        ).toEqual([]);
      }
    }
    await page.getByRole("slider", { name: "Numero di domande" }).focus();
    await page.keyboard.press("End");
    await expect(page.locator("output")).toHaveText("100");
    await page.keyboard.press("Home");
    await expect(page.locator("output")).toHaveText("10");
    await page.getByRole("button", { name: "Solo vero o falso" }).click();
    await page.getByRole("button", { name: "Inizia", exact: true }).click();
    await expect(
      page.getByText("Domanda 1 di 10", { exact: true }),
    ).toBeVisible();
    await page.clock.install();
    await page.clock.fastForward(11000);
    await expect(
      page.getByRole("progressbar", { name: "Dieci secondi per riflettere" }),
    ).toHaveAttribute("aria-valuenow", "0");
    await expect(
      page.getByText("Domanda 1 di 10", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Vero", exact: true }),
    ).toBeEnabled();
    await page.getByRole("button", { name: "Vero", exact: true }).click();
    await page.getByRole("button", { name: "Correggi", exact: true }).click();
    await expect(page.getByText("Corretto", { exact: true })).toBeVisible();
    await page.screenshot({
      path: ".shots/m8-tf-feedback-it-light-960.png",
      animations: "disabled",
    });
    expect(
      (await new AxeBuilder({ page }).setLegacyMode(true).analyze()).violations,
    ).toEqual([]);
    await page.getByRole("button", { name: "Avanti", exact: true }).click();
    await page.clock.runFor(600);
    await expect
      .poll(async () => {
        const attemptId = new URLSearchParams(
          (await page.evaluate(() => window.location.hash)).split("?")[1],
        ).get("attempt")!;
        const session = (await page.evaluate(
          (attemptId) => window.pyxis.invoke("study.quizRead", { attemptId }),
          attemptId,
        )) as { draft?: { index: number } };
        return session.draft?.index;
      })
      .toBe(1);
    await page.reload();
    await expect(
      page.getByText("Domanda 2 di 10", { exact: true }),
    ).toBeVisible();
    for (let i = 1; i < 10; i++) {
      await page
        .getByRole("button", { name: i === 1 ? "Falso" : "Vero", exact: true })
        .click();
      await page.getByRole("button", { name: "Correggi", exact: true }).click();
      await expect(
        page.getByRole("button", {
          name: i === 9 ? "Termina il quiz" : "Avanti",
          exact: true,
        }),
      ).toBeEnabled();
      await page
        .getByRole("button", {
          name: i === 9 ? "Termina il quiz" : "Avanti",
          exact: true,
        })
        .click();
    }
    await expect(page.getByText("90 su 100", { exact: true })).toBeVisible();
    await page.reload();
    await expect(page.getByText("90 su 100", { exact: true })).toBeVisible();
    await page.evaluate(() => window.pyxis.setAppearance("dark"));
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.getByText(/Rivedi questa risposta/).click();
    await page.screenshot({
      path: ".shots/m8-results-it-dark-1280.png",
      animations: "disabled",
    });
    expect(
      (await new AxeBuilder({ page }).setLegacyMode(true).analyze()).violations,
    ).toEqual([]);
    await page
      .getByRole("button", { name: "Chiedi al tutor", exact: true })
      .click();
    await expect(page.getByText(/La tua risposta: Falso/)).toContainText(
      "Risposta corretta: Vero",
    );
  } finally {
    await app.close();
    rmSync(userData, { recursive: true, force: true });
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
    args: [join(process.cwd(), "out/main/index.js")],
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
    const imported = (await page.evaluate(
      (path) => window.pyxis.invoke("sources.import", { path }),
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
