import { importPickedSource } from "./picked-source";
import { expect, test } from "@playwright/test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { launchPyxis } from "./app-under-test";
import { makeBook } from "./book";
import { expectNoAxeViolations } from "./axe";
import { saveShot } from "./shots";
import { removeTestFolder } from "./cleanup";

test("LES-20 through LES-23 exam timer restart, auto-submit and named grading model", async () => {
  test.setTimeout(240000);
  const userData = mkdtempSync(join(tmpdir(), "pyxis-simulation-check-"));
  const file = join(userData, "exam.ptsb");
  writeFileSync(
    file,
    makeBook({
      id: "physics",
      chapters: [
        { title: "Forze", text: "## p1 | Forza\nLa forza vale massa per accelerazione.\n" },
        {
          title: "Energia",
          text: "## p1 | Energia\nL’energia cinetica vale metà della massa per la velocità al quadrato.\n",
        },
      ],
      files: {
        "esercizi.md": ':::exercise{id="practice" chapter="1"}\nDOMANDA DI PRATICA\n:::solution\n1\n:::\n:::\n',
        "esami.md":
          ':::exercise{id="force" chapter="1"}\nUna massa di 2 kg accelera a 3 m/s². Quanto vale la forza?\n:::solution\nF = ma = 6 N.\n:::\n:::\n\n:::exercise{id="energy" chapter="2"}\nUna massa di 2 kg si muove a 2 m/s. Quanto vale l’energia cinetica?\n:::solution\nE = mv²/2 = 4 J.\n:::\n:::\n',
      },
    }),
  );
  const planReplies = {
    markdown: {
      markdown: "## Ripasso\nUsa le formule di forza ed energia [P1].",
    },
    questions: {
      questions: Array.from({ length: 10 }, (_, i) => ({
        stem: `Diagnosi ${i}`,
        options: ["a", "b", "c", "d"],
        correct: 0,
        topicIndex: i % 2,
        passageIds: [`{{passage:${i % 2}}}`],
        explanation: "La relazione fisica.",
      })),
    },
  };
  const env = {
    PYXIS_E2E_PLAN_REPLIES: JSON.stringify(planReplies),
    PYXIS_E2E_SIMULATION_REPLIES: process.env.PYXIS_LIVE_SIMULATION
      ? undefined
      : JSON.stringify({
          score: {
            score: 1,
            feedback: "La formula e il risultato sono corretti.",
            missed: [],
          },
        }),
    PYXIS_E2E_SIMULATION_DELAY: "1500",
  };
  const launch = () =>
    launchPyxis({ userData, env });
  let app = await launch();
  try {
    let page = await app.firstWindow();
    await page.getByRole("button", { name: "Salta" }).click();
    // Skipping saves the profile, then moves to Exams; wait so a reload or route change cannot land on setup.
    await expect(page).toHaveURL(/#\/exams$/);
    const source = (await importPickedSource(page, app, file)) as {
      sourceId: string;
    };
    await expect
      .poll(
        async () =>
          (
            (await page.evaluate(() =>
              window.pyxis.invoke("sources.list", {}),
            )) as Array<{ id: string; status: string }>
          ).find((s) => s.id === source.sourceId)?.status,
      )
      .toBe("ready");
    const plan = (await page.evaluate(
      (sourceId) =>
        window.pyxis.invoke("plans.create", {
          title: "Fisica 1",
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
              plan.planId,
            )) as { state: string }
          ).state,
      )
      .toBe("succeeded");
    await page.evaluate((planId) => {
      window.location.hash = `/plans/${planId}/simulation`;
    }, plan.planId);
    await expect(
      page.getByRole("button", { name: "Inizia", exact: true }),
    ).toBeEnabled();
    await saveShot(page, "m11-setup-it-dark.png");
    await expectNoAxeViolations(page);
    await page.getByRole("button", { name: "Inizia", exact: true }).click();
    await expect(
      page.getByRole("textbox", { name: "La tua risposta" }),
    ).toBeVisible();
    expect(
      await page.getByRole("button", { name: "Chiedi", exact: true }).count(),
    ).toBe(0);
    expect(await page.getByText("DOMANDA DI PRATICA").count()).toBe(0);
    const openedAt = Date.now();
    let run = (await page.evaluate(
      (planId) => window.pyxis.invoke("study.simulationOpen", { planId }),
      plan.planId,
    )) as {
      attemptId: string;
      leftMs: number;
      questions: Array<{ id: string; stem: string }>;
    };
    expect(run.questions).toHaveLength(2);
    const picks = Object.fromEntries(
      run.questions.map((q) => [
        q.id,
        q.stem.includes("forza")
          ? "F = m a = 2 × 3 = 6 N."
          : "E = m v² / 2 = 2 × 4 / 2 = 4 J.",
      ]),
    );
    await page
      .getByRole("textbox", { name: "La tua risposta" })
      .fill(picks[run.questions[0]!.id]!);
    await page.getByRole("button", { name: /Domanda 2,/ }).click();
    await page
      .getByRole("textbox", { name: "La tua risposta" })
      .fill(picks[run.questions[1]!.id]!);
    await expect
      .poll(
        async () =>
          (
            (await page.evaluate(
              (attemptId) =>
                window.pyxis.invoke("study.simulationRead", { attemptId }),
              run.attemptId,
            )) as { picks: Record<string, string> }
          ).picks,
      )
      .toEqual(picks);
    const before = run.leftMs;
    await app.close();
    app = await launch();
    page = await app.firstWindow();
    await page.evaluate((planId) => {
      window.location.hash = `/plans/${planId}/simulation`;
    }, plan.planId);
    await expect(
      page.getByRole("textbox", { name: "La tua risposta" }),
    ).toHaveText(picks[run.questions[0]!.id]!);
    const reopenedAt = Date.now();
    run = (await page.evaluate(
      (planId) => window.pyxis.invoke("study.simulationOpen", { planId }),
      plan.planId,
    )) as typeof run;
    // The timer kept running while Pyxis was closed, by the time that passed and no more. A slow runner can take well
    // over 20 s for the restart, so compare with the clock rather than a fixed allowance.
    expect(run.leftMs).toBeLessThan(before);
    const elapsed = Date.now() - openedAt;
    expect(run.leftMs).toBeGreaterThanOrEqual(before - elapsed - 2000);
    expect(run.leftMs).toBeLessThanOrEqual(before - (reopenedAt - openedAt) + 2000);
    for (const [language, theme, width] of [
      ["it", "dark", 1280],
      ["it", "light", 960],
      ["en", "dark", 1280],
      ["en", "light", 960],
    ] as const) {
      await page.evaluate(
        async ({ language, theme }) => {
          localStorage.setItem("pyxis.lang", language);
          await window.pyxis.setAppearance(theme);
        },
        { language, theme },
      );
      await page.reload();
      await page.setViewportSize({ width, height: 800 });
      await expect(
        page.getByRole("textbox", { name: /La tua risposta|Your answer/ }),
      ).toBeVisible();
      await saveShot(page, `m11-run-${language}-${theme}-${width}.png`);
      await expectNoAxeViolations(page);
    }
    // Advance only this temporary exam's stored start; exercise core's real expiry path.
    const db = new DatabaseSync(join(userData, "workspace", "pyxis.db"), { timeout: 10000 });
    db.prepare("UPDATE attempts SET started_at = ? WHERE id = ?").run(
      Date.now() - 30 * 60000 - 1000,
      run.attemptId,
    );
    db.close();
    await page.evaluate(
      (attemptId) => window.pyxis.invoke("study.simulationRead", { attemptId }),
      run.attemptId,
    );
    // Time is up: the results screen waits for the grade and says which exercises are graded.
    await expect(page.locator(".px-res-headline")).toContainText("Grading your answers.");
    await expect(page.getByRole("heading", { name: "Exercises" })).toBeVisible();
    await expect
      .poll(
        async () => {
          const next = (await page.evaluate(
            (attemptId) =>
              window.pyxis.invoke("study.simulationRead", { attemptId }),
            run.attemptId,
          )) as {
            grading?: { progress: number; state: string; error: string | null };
          };
          return (
            (next.grading?.progress ?? 0) >= 0.5 ||
            next.grading?.state === "failed"
          );
        },
        { timeout: 90000 },
      )
      .toBe(true);
    const grading = (await page.evaluate(
      (attemptId) => window.pyxis.invoke("study.simulationRead", { attemptId }),
      run.attemptId,
    )) as { grading?: { state: string; error: string | null } };
    expect(
      grading.grading?.state,
      grading.grading?.error ?? "grading did not start",
    ).not.toBe("failed");
    await app.close();
    app = await launch();
    page = await app.firstWindow();
    await page.evaluate((planId) => {
      window.location.hash = `/plans/${planId}/simulation`;
    }, plan.planId);
    const retry = page.getByRole("button", { name: "Retry grading" });
    await expect
      .poll(async () => {
        const next = (await page.evaluate(
          (planId) => window.pyxis.invoke("study.simulationOpen", { planId }),
          plan.planId,
        )) as { grading?: { state: string } } | null;
        return next?.grading?.state ?? "done";
      })
      .not.toBe("running");
    const reopened = await page.evaluate((attemptId) => window.pyxis.invoke("study.simulationRead", { attemptId }), run.attemptId);
    if (reopened.grading && ["interrupted", "failed", "cancelled"].includes(reopened.grading.state))
      await retry.click();
    await expect
      .poll(
        async () =>
          (
            (await page.evaluate(
              (attemptId) =>
                window.pyxis.invoke("study.simulationRead", { attemptId }),
              run.attemptId,
            )) as { submitted: boolean }
          ).submitted,
        { timeout: 90000 },
      )
      .toBe(true);
    await expect(page.getByText(/Estimated grade by/)).toBeVisible();
    // One meter for the grade against the goal; the topic list reads its bars as text.
    await expect(page.getByRole("meter")).toHaveCount(1);
    await expect(page.locator(".px-res-topics li")).toHaveCount(2);
    const result = (await page.evaluate(
      (attemptId) => window.pyxis.invoke("study.simulationRead", { attemptId }),
      run.attemptId,
    )) as {
      results: Array<{ model: string; score: number }>;
      picks: Record<string, string>;
    };
    expect(result.picks).toEqual(picks);
    expect(result.results.every((r) => r.score >= 0.8)).toBe(true);
    expect(
      result.results.every(
        (r) =>
          r.model ===
          (process.env.PYXIS_LIVE_SIMULATION
            ? "claude-sonnet-5"
            : "recorded-plan"),
      ),
    ).toBe(true);
    // Every exercise reads its answer and the grader's feedback; one with full marks opens from its row.
    await page.locator(".px-res-filter .ant-segmented-item", { hasText: /^All/ }).click();
    const first = page.locator(".px-res-q").first();
    if ((await first.locator(".px-res-q-head").getAttribute("aria-expanded")) !== "true")
      await first.locator(".px-res-q-head").click();
    await expect(first.locator(".px-res-answer.is-yours")).toContainText("Your answer");
    await expect(first.locator(".px-res-grader")).toContainText("Graded by");
    await saveShot(page, "m11-results-en-light.png");
    await expectNoAxeViolations(page);
    if (process.env.PYXIS_LIVE_SIMULATION)
      console.log(
        "Live simulation graders",
        result.results.map((r) => r.model),
      );
  } finally {
    await app.close();
    removeTestFolder(userData);
  }
});
