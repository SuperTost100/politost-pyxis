import { importPickedSource } from "./picked-source";
import AxeBuilder from "@axe-core/playwright";
import { _electron as electron, expect, test } from "@playwright/test";
import { strToU8, zipSync } from "fflate";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

test("LES-20 through LES-23 exam timer restart, auto-submit and named grading model", async () => {
  test.setTimeout(240000);
  const userData = mkdtempSync(join(tmpdir(), "pyxis-simulation-check-"));
  const file = join(userData, "exam.ptsb");
  writeFileSync(
    file,
    zipSync({
      "smartbook.json": strToU8(
        JSON.stringify({
          id: "physics",
          title: "Fisica",
          access: "public",
          chapters: [
            { id: "c1", number: 1, title: "Forze", file: "01.md" },
            { id: "c2", number: 2, title: "Energia", file: "02.md" },
          ],
        }),
      ),
      "chapters/01.md": strToU8(
        "## p1 | Forza\\nLa forza vale massa per accelerazione.\\n".replaceAll(
          "\\n",
          "\n",
        ),
      ),
      "chapters/02.md": strToU8(
        "## p1 | Energia\\nL’energia cinetica vale metà della massa per la velocità al quadrato.\\n".replaceAll(
          "\\n",
          "\n",
        ),
      ),
      "esercizi.md": strToU8(
        ':::exercise{id="practice" chapter="1"}\nDOMANDA DI PRATICA\n:::solution\n1\n:::\n:::\n',
      ),
      "esami.md": strToU8(
        ':::exercise{id="force" chapter="1"}\nUna massa di 2 kg accelera a 3 m/s². Quanto vale la forza?\n:::solution\nF = ma = 6 N.\n:::\n:::\n\n:::exercise{id="energy" chapter="2"}\nUna massa di 2 kg si muove a 2 m/s. Quanto vale l’energia cinetica?\n:::solution\nE = mv²/2 = 4 J.\n:::\n:::\n',
      ),
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
    ...process.env,
    PYXIS_USER_DATA: userData,
    PYXIS_E2E: "1",
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
  delete env.ELECTRON_RUN_AS_NODE;
  const launch = () =>
    electron.launch({ args: [join(process.cwd(), "out/main/index.js")], env });
  let app = await launch();
  try {
    let page = await app.firstWindow();
    await page.getByRole("button", { name: "Salta" }).click();
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
    mkdirSync(".shots", { recursive: true });
    await expect(
      page.getByRole("button", { name: "Inizia", exact: true }),
    ).toBeEnabled();
    await page.screenshot({ path: ".shots/m11-setup-it-dark.png" });
    expect(
      (await new AxeBuilder({ page }).setLegacyMode(true).analyze()).violations,
    ).toEqual([]);
    await page.getByRole("button", { name: "Inizia", exact: true }).click();
    await expect(
      page.getByRole("textbox", { name: "La tua risposta" }),
    ).toBeVisible();
    expect(
      await page.getByRole("button", { name: "Chiedi", exact: true }).count(),
    ).toBe(0);
    expect(await page.getByText("DOMANDA DI PRATICA").count()).toBe(0);
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
    ).toHaveValue(picks[run.questions[0]!.id]!);
    run = (await page.evaluate(
      (planId) => window.pyxis.invoke("study.simulationOpen", { planId }),
      plan.planId,
    )) as typeof run;
    expect(run.leftMs).toBeLessThan(before);
    expect(run.leftMs).toBeGreaterThan(before - 20000);
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
      await page.screenshot({
        path: `.shots/m11-run-${language}-${theme}-${width}.png`,
      });
      expect(
        (await new AxeBuilder({ page }).setLegacyMode(true).analyze())
          .violations,
      ).toEqual([]);
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
    await expect(
      page.getByRole("heading", { name: "Grading your exam" }),
    ).toBeVisible();
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
          writeFileSync(".tmp/m15-simulation-grading-poll.json", JSON.stringify(next, null, 2));
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
    await expect(page.getByRole("meter")).toHaveCount(2);
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
    await page.locator(".px-sim-feedback summary").first().click();
    await expect(
      page.getByRole("heading", { name: "Reference solution" }),
    ).toBeVisible();
    await page.screenshot({ path: ".shots/m11-results-en-light.png" });
    expect(
      (await new AxeBuilder({ page }).setLegacyMode(true).analyze()).violations,
    ).toEqual([]);
    if (process.env.PYXIS_LIVE_SIMULATION)
      console.log(
        "Live simulation graders",
        result.results.map((r) => r.model),
      );
  } finally {
    await app.close();
    rmSync(userData, { recursive: true, force: true });
  }
});
