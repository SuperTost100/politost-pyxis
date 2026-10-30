import { importPickedSource } from "./picked-source";
import { expect, test } from "@playwright/test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { manyPagePdf } from "../../src/core/sources/test-pdf";
import { launchPyxis } from "./app-under-test";
import { expectNoAxeViolations } from "./axe";
import { saveShot } from "./shots";
import { removeTestFolder } from "./cleanup";

test("PLAN-21 document tree and build resume after cancel and restart", async () => {
  const userData = mkdtempSync(join(tmpdir(), "pyxis-plan-check-"));
  const file = join(userData, "physics.pdf");
  writeFileSync(
    file,
    manyPagePdf(
      1,
      "Velocity changes position over time and acceleration changes velocity",
    ),
  );
  const replies = {
    topics: {
      topics: [
        {
          title: "Moto",
          summary: "Velocità e accelerazione",
          subtopics: ["Velocità", "Accelerazione"],
          segmentIds: ["{{segment:0}}"],
        },
      ],
    },
    markdown: {
      markdown: "## Il moto\n\nStudierai velocità e accelerazione [P1].",
    },
    questions: {
      questions: Array.from({ length: 10 }, (_, i) => ({
        stem: `Quale grandezza descrive il moto ${i + 1}?`,
        options: ["Velocità", "Calore", "Massa", "Volume"],
        correct: 0,
        topicIndex: 0,
        passageIds: ["{{passage:0}}"],
        explanation: "La velocità descrive il moto.",
      })),
    },
  };
  const env = {
    PYXIS_E2E_PLAN_REPLIES: JSON.stringify(replies),
    PYXIS_E2E_PLAN_DELAY: "2000",
  };
  let app = await launchPyxis({ userData, env });
  try {
    let page = await app.firstWindow();
    await page.getByRole("button", { name: "Salta" }).click();
    // Skipping saves the profile, then moves to Exams; wait so a reload or route change cannot land on setup.
    await expect(page).toHaveURL(/#\/exams$/);
    await expect(
      page.getByRole("heading", { name: "Esami", exact: true }),
    ).toBeVisible();
    const source = (await importPickedSource(page, app, file)) as {
      sourceId: string;
    };
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
          title: "Fisica 1",
          sourceIds: [sourceId],
        }),
      source.sourceId,
    )) as { planId: string; jobId: string };
    await page.evaluate((id) => {
      window.location.hash = `/plans/new?build=${id}`;
    }, created.planId);
    await expect(
      page.getByRole("button", { name: "Annulla", exact: true }),
    ).toBeVisible();
    await expect(page.getByRole("heading", { name: "Preparo Fisica 1" })).toBeVisible();
    for (const theme of ["dark", "light"] as const) {
      await page.evaluate((value) => window.pyxis.setAppearance(value), theme);
      for (const width of [1280, 960]) {
        await page.setViewportSize({
          width,
          height: width === 960 ? 640 : 800,
        });
        await page.emulateMedia({ reducedMotion: "reduce" });
        await saveShot(page, `m7-building-it-${theme}-${width}.png`, { animations: "disabled" });
      }
    }
    await page.getByRole("button", { name: "Annulla", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "Riprova", exact: true }),
    ).toBeVisible();
    await app.close();
    app = await launchPyxis({ userData, env });
    page = await app.firstWindow();
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.evaluate((id) => {
      window.location.hash = `/plans/new?build=${id}`;
    }, created.planId);
    await page.getByRole("button", { name: "Riprova", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "Apri l'esame", exact: true }),
    ).toBeVisible({ timeout: 20000 });
    // A built plan says so, and Enter opens it.
    await expect(page.getByRole("heading", { name: "Fisica 1 è pronto" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Apri l'esame", exact: true })).toBeFocused();
    await page
      .getByRole("button", { name: "Apri l'esame", exact: true })
      .click();
    // The plan page loads on its first visit and the build page stays until it has; the URL moves once it is there.
    await expect(page).toHaveURL(new RegExp(`#/plans/${created.planId}$`));
    // The topics are the path: a topic's row opens to show its steps and what it covers.
    await page.getByRole("button", { name: /^Moto/ }).click();
    await expect(page.locator(".px-path-about")).toContainText("Accelerazione");
    const result = (await page.evaluate(
      (id) => window.pyxis.invoke("plans.read", { planId: id }),
      created.planId,
    )) as { topics: Array<{ title: string }> };
    expect(result.topics).toHaveLength(1);
    // A new plan suggests the introduction first.
    await page
      .locator(".px-path-next")
      .getByRole("button", { name: "Inizia", exact: true })
      .click();
    // The introduction is its own page, without the passage references the model was given.
    await expect(page).toHaveURL(new RegExp(`#/plans/${created.planId}/intro$`));
    await expect(
      page.getByText("Studierai velocità e accelerazione", { exact: false }),
    ).toBeVisible();
    await expect(page.getByText("[P1]", { exact: false })).toHaveCount(0);
    await expectNoAxeViolations(page);
    await page.getByRole("button", { name: "Fatto", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`#/plans/${created.planId}$`));
    const diagnostic = (await page.evaluate(
      (planId) => window.pyxis.invoke("study.diagnosticStart", { planId }),
      created.planId,
    )) as { questions: unknown[] };
    expect(diagnostic.questions).toHaveLength(10);
  } finally {
    await app.close();
    removeTestFolder(userData);
  }
});

test("PLAN-21 live Claude builds the owner's smartbook plan", async () => {
  test.skip(
    process.env.PYXIS_LIVE_PLAN !== "1",
    "Set PYXIS_LIVE_PLAN=1 for the signed-in engine check.",
  );
  test.setTimeout(240000);
  const userData = mkdtempSync(join(tmpdir(), "pyxis-live-plan-"));
  const app = await launchPyxis({ userData, env: { PYXIS_E2E_PLAN_REPLIES: undefined } });
  try {
    const page = await app.firstWindow();
    await page.getByRole("button", { name: "Salta" }).click();
    // Skipping saves the profile, then moves to Exams; wait so a reload or route change cannot land on setup.
    await expect(page).toHaveURL(/#\/exams$/);
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
    const models = (await page.evaluate(() =>
      window.pyxis.invoke("engines.models", { provider: "claude" }),
    )) as Array<{ id: string; name: string }>;
    const model = models.find((entry) => /sonnet/i.test(entry.name))?.id;
    expect(model, "Claude must advertise a Sonnet model").toBeTruthy();
    await page.evaluate(
      (model) =>
        window.pyxis.invoke("engines.setFeature", {
          feature: "plan",
          provider: "claude",
          model,
        }),
      model!,
    );
    const started = Date.now();
    const built = (await page.evaluate(
      (sourceId) =>
        window.pyxis.invoke("plans.create", {
          title: "Fisica 1",
          sourceIds: [sourceId],
          language: "it",
        }),
      imported.sourceId,
    )) as { planId: string };
    let last = null as { state: string; error?: string } | null;
    await expect
      .poll(
        async () => {
          last = (await page.evaluate(
            (planId) => window.pyxis.invoke("plans.build", { planId }),
            built.planId,
          )) as typeof last;
          return last?.state === "succeeded" || last?.state === "failed"
            ? last.state
            : "waiting";
        },
        { timeout: 210000 },
      )
      .toMatch(/^(succeeded|failed)$/);
    mkdirSync(".shots", { recursive: true });
    writeFileSync(
      ".shots/m7-live-check.json",
      JSON.stringify({ latencyMs: Date.now() - started, state: last }, null, 2),
    );
    expect(last?.state, last?.error).toBe("succeeded");
    const plan = (await page.evaluate(
      (planId) => window.pyxis.invoke("plans.read", { planId }),
      built.planId,
    )) as { topics: unknown[] };
    expect(plan.topics).toHaveLength(9);
    const quiz = (await page.evaluate(
      (planId) => window.pyxis.invoke("study.diagnosticStart", { planId }),
      built.planId,
    )) as { questions: unknown[] };
    expect(quiz.questions.length).toBeGreaterThanOrEqual(10);
    mkdirSync(".shots", { recursive: true });
    writeFileSync(
      ".shots/m7-live-check.json",
      JSON.stringify(
        {
          latencyMs: Date.now() - started,
          topics: plan.topics.length,
          questions: quiz.questions.length,
          engine: "claude",
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
