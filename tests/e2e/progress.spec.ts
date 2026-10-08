import { importPickedSource } from "./picked-source";
import AxeBuilder from "@axe-core/playwright";
import { _electron as electron, expect, test } from "@playwright/test";
import { strToU8, zipSync } from "fflate";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

test("PRO-01 through PRO-06 preparation layout, flagged content, activity and progress tabs", async () => {
  test.setTimeout(90000);
  const userData = mkdtempSync(join(tmpdir(), "pyxis-progress-check-"));
  const file = join(userData, "book.ptsb");
  writeFileSync(
    file,
    zipSync({
      "smartbook.json": strToU8(
        JSON.stringify({
          id: "study",
          title: "Fisica",
          access: "public",
          chapters: [
            { id: "c1", number: 1, title: "Moti", file: "01.md" },
            { id: "c2", number: 2, title: "Energia", file: "02.md" },
          ],
        }),
      ),
      "chapters/01.md": strToU8(
        "## p1 | Velocità\nLa velocità descrive il moto.\n",
      ),
      "chapters/02.md": strToU8(
        "## p1 | Energia\nL’energia misura il lavoro disponibile.\n",
      ),
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
    ...process.env,
    PYXIS_USER_DATA: userData,
    PYXIS_E2E: "1",
    PYXIS_E2E_PLAN_REPLIES: JSON.stringify(fixture),
  };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({
    args: [join(process.cwd(), "out/main/index.js")],
    env,
  });
  try {
    const page = await app.firstWindow();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
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
    mkdirSync(".shots", { recursive: true });
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
      await page.screenshot({
        path: `.shots/m12-preparation-${language}-${theme}-${width}.png`,
        fullPage: true,
      });
      expect(
        (await new AxeBuilder({ page }).setLegacyMode(true).analyze())
          .violations,
      ).toEqual([]);
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
      await page.screenshot({
        path: `.shots/m12-pace-${language}-${theme}-${width}.png`,
        fullPage: true,
      });
      expect(
        (await new AxeBuilder({ page }).setLegacyMode(true).analyze())
          .violations,
      ).toEqual([]);
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
    rmSync(userData, { recursive: true, force: true });
  }
});
