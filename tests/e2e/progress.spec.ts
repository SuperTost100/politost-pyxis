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

test("PRO-01 through PRO-06 preparation layout, flagged content, activity and progress tabs", async () => {
  test.setTimeout(90000);
  const userData = mkdtempSync(join(tmpdir(), "pyxis-progress-check-"));
  const file = join(userData, "book.ptsb");
  writeFileSync(
    file,
    makeBook({
      id: "study",
      chapters: [
        { title: "Moti", text: "## p1 | Velocità\nLa velocità descrive il moto.\n" },
        { title: "Energia", text: "## p1 | Energia\nL’energia misura il lavoro disponibile.\n" },
      ],
    }),
  );
  const fixture = {
    markdown: { markdown: "## Studio\nIl moto e l’energia [P1]." },
    explanation: { explanation: "Rileggi la definizione di energia e lavoro." },
    quizQuestions: {
      questions: Array.from({ length: 5 }, (_, i) => ({
        kind: ["mcq", "tf", "completion"][i % 3],
        stem: `Drill ${i}${i % 3 === 2 ? " {{1}}" : ""}`,
        passageIds: ["{{passage:0}}"],
        explanation: "La grandezza fisica.",
        ...(i % 3 === 0
          ? { options: ["a", "b", "c", "d"], correct: 0 }
          : i % 3 === 1
            ? { correct: true }
            : { accepted: ["energia"] }),
      })),
    },
    questions: {
      questions: Array.from({ length: 10 }, (_, i) => ({
        stem: `Diagnosi ${i}`,
        options: ["a", "b", "c", "d"],
        correct: 0,
        topicIndex: i % 2,
        passageIds: [`{{passage:${i % 2}}}`],
        explanation: "La grandezza fisica.",
      })),
    },
  };
  const env = {
    PYXIS_E2E_PLAN_REPLIES: JSON.stringify(fixture),
  };
  const app = await launchPyxis({ userData, env });
  try {
    const page = await app.firstWindow();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
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
    const created = (await page.evaluate(
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
              created.planId,
            )) as { state: string }
          ).state,
      )
      .toBe("succeeded");
    const plan = (await page.evaluate(
      (planId) => window.pyxis.invoke("plans.read", { planId }),
      created.planId,
    )) as { topics: Array<{ id: string }> };
    const db = new DatabaseSync(join(userData, "workspace", "pyxis.db"), {
      timeout: 10000,
    });
    const insert = db.prepare(
      "INSERT INTO learning_events (id,kind,plan_id,topic_id,payload_json,created_at) VALUES (?,?,?,?,?,?)",
    );
    for (let day = 0; day < 14; day++) {
      const at = new Date();
      at.setDate(at.getDate() - day);
      at.setHours(12, 0, 0, 0);
      const instant = Math.min(Date.now() - 5000, at.getTime());
      insert.run(
        `answer-${day}`,
        "answer_given",
        created.planId,
        plan.topics[0]!.id,
        JSON.stringify({ score: 1, scores: [1, 1, 1] }),
        instant,
      );
      insert.run(
        `lesson-${day}`,
        "lesson_completed",
        created.planId,
        plan.topics[0]!.id,
        "{}",
        instant + 1,
      );
      insert.run(
        `time-${day}`,
        "active_time",
        created.planId,
        plan.topics[0]!.id,
        JSON.stringify({ seconds: 1200 }),
        instant + 2,
      );
    }
    const old = Date.now() - 28 * 86400000;
    for (let i = 0; i < 3; i++)
      insert.run(
        `old-${i}`,
        "answer_given",
        created.planId,
        plan.topics[1]!.id,
        JSON.stringify({ score: 0, scores: [0, 0] }),
        old + i,
      );
    const passage = db
      .prepare("SELECT passage_id FROM topic_passages WHERE topic_id=? LIMIT 1")
      .get(plan.topics[1]!.id) as { passage_id: string };
    db.close();
    await page.evaluate(
      (targetId) =>
        window.pyxis.invoke("study.flag", {
          targetKind: "passage",
          targetId,
          reason: "La definizione richiede una revisione.",
        }),
      passage.passage_id,
    );
    await page.evaluate((planId) => {
      window.location.hash = `/plans/${planId}/progress`;
    }, created.planId);
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
        page.getByText(/Previsione per l’esame|Exam forecast/, { exact: true }),
      ).toBeVisible();
      await expect(page.locator(".px-progress-weekly thead th")).toHaveCount(6);
      await expect(page.locator(".px-progress-skills li")).toHaveCount(2);
      await expect(
        page.getByRole("button", {
          name: /Colma la lacuna più grave|Work on the most serious gap/,
        }),
      ).toBeVisible();
      await expect(
        page.getByRole("heading", {
          name: /Contenuti che hai segnalato|Content you reported/,
        }),
      ).toBeVisible();
      await expect(page.locator(".ant-segmented-thumb")).toHaveCount(0);
      await saveShot(page, `m12-preparation-${language}-${theme}-${width}.png`, { fullPage: true });
      await expectNoAxeViolations(page);
      await expect(page.locator(".px-plan-progress .ant-segmented")).toHaveCount(0);
      await expect(
        page.getByRole("heading", {
          name: /Preparazione|Preparation/,
          level: 2,
        }),
      ).toBeVisible();
      await expect(
        page.getByRole("heading", { name: /Simulazioni|Simulations/, level: 2 }),
      ).toBeVisible();
      await expect(
        page.getByRole("button", {
          name: /Inizia una simulazione|Start a simulation/,
        }),
      ).toBeVisible();
      await expect(
        page.getByRole("heading", { name: /Ritmo|Pace/, level: 2 }),
      ).toBeVisible();
      await expect(
        page.locator(".px-progress-pace-facts dd").first(),
      ).toContainText(/min/);
      await expect(page.locator(".ant-segmented-thumb")).toHaveCount(0);
      await saveShot(page, `m12-pace-${language}-${theme}-${width}.png`, { fullPage: true });
      await expectNoAxeViolations(page);
      // A topic row opens to the evidence behind its bar, and the parts add up to the bar's number.
      const breakdown = (await page.evaluate(
        (planId) => window.pyxis.invoke("plans.masteryBreakdown", { planId }),
        created.planId,
      )) as Array<{
        id: string;
        priorWeight: number;
        parts: Record<string, { count: number; weight: number; points: number }>;
      }>;
      const row = page.locator(".px-progress-skills li").first();
      const toggle = row.getByRole("button", {
        name: /Mostra da cosa è fatto|Show what/,
      });
      await expect(toggle).toHaveAttribute("aria-expanded", "false");
      await toggle.click();
      await expect(toggle).toHaveAttribute("aria-expanded", "true");
      const panel = row.locator(".px-evidence");
      await expect(panel).toContainText(
        language === "it" ? "Risposte ai quiz" : "Quiz answers",
      );
      const first = breakdown.find((topic) => topic.id === plan.topics[0]!.id)!;
      await expect(panel).toContainText(String(first.parts.quiz!.count));
      await expect(panel).toContainText(/per il tempo passato|from age/);
      const parts = Object.values(first.parts);
      const total = parts.reduce((sum, part) => sum + part.points, 0);
      const weight = parts.reduce((sum, part) => sum + part.weight, 0);
      expect(
        Number(await row.getByRole("meter").getAttribute("aria-valuenow")),
      ).toBe(Math.round((100 * total) / (first.priorWeight + weight)));
      await saveShot(page, `quiz-mastery-evidence-${language}-${theme}-${width}.png`, { fullPage: true });
      await expectNoAxeViolations(page);
      await toggle.click();
      await expect(panel).toHaveCount(0);
    }
    await page.locator(".px-progress-chart .recharts-surface").first().focus();
    await page.keyboard.press("ArrowRight");
    await expect(
      page.locator(".recharts-tooltip-wrapper").first(),
    ).toBeVisible();
    await page
      .locator(".px-progress-flags")
      .getByRole("button", { name: "Open" })
      .click();
    await expect(page.getByRole("dialog")).toContainText("L’energia misura");
    await page.keyboard.press("Escape");
    await page
      .getByRole("button", { name: "Work on the most serious gap" })
      .click();
    await expect
      .poll(() => page.evaluate(() => window.location.hash))
      .toContain(`/quiz/${plan.topics[1]!.id}`);
    expect(errors).toEqual([]);
  } finally {
    await app.close();
    removeTestFolder(userData);
  }
});
