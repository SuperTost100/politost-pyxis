import { importPickedSource } from "./picked-source";
import { expect, test } from "@playwright/test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { manyPagePdf } from "../../src/core/sources/test-pdf";
import { launchPyxis } from "./app-under-test";
import { expectNoAxeViolations } from "./axe";
import { saveShot } from "./shots";

test("Ask: a suggested follow-up with math draws the formula, and sends its own text", async () => {
  test.setTimeout(120000);
  const userData = mkdtempSync(join(tmpdir(), "pyxis-math-chip-"));
  const app = await launchPyxis({
    userData,
    env: {
      PYXIS_E2E_REPLY:
        "Ecco.\n<followups>\nCome si estende a $\\alpha \\geq 1$?\nPerché?\n</followups>",
    },
  });
  try {
    const page = await app.firstWindow();
    await page.getByRole("button", { name: "Salta" }).click();
    await expect(page).toHaveURL(/#\/exams$/);
    await page.evaluate(() => {
      location.hash = "/ask";
    });
    const box = page.getByRole("textbox", { name: "Messaggio" });
    await box.fill("Prima domanda");
    await box.press("Enter");
    const chips = page.locator(".px-msg-chips .px-chip");
    await expect(chips).toHaveCount(2);
    await expect(chips.first().locator(".katex")).toHaveCount(1);
    await expect(chips.first()).not.toContainText("$");
    await saveShot(page.locator(".px-msg-chips"), "chips-math.png");
    await expectNoAxeViolations(page);
    // The chip still sends the student's text, with its `$`, and the sent message draws it as math.
    await chips.first().click();
    await expect(page.locator(".px-mathtext-view .katex")).toHaveCount(1);
  } finally {
    await app.close();
    rmSync(userData, { recursive: true, force: true });
  }
});

test("Quiz: a matching question's menu draws math and picks with the keyboard", async () => {
  test.setTimeout(240000);
  const userData = mkdtempSync(join(tmpdir(), "pyxis-math-match-"));
  const file = join(userData, "physics.pdf");
  writeFileSync(file, manyPagePdf(1, "Velocity is displacement over time."));
  const replies = {
    topics: {
      topics: [{ title: "Moto", summary: "Velocità", subtopics: ["Tempo"], segmentIds: ["{{segment:0}}"] }],
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
        kind: "matching",
        stem: `Abbina ogni insieme alla sua descrizione. Domanda {{question:${i}}}.`,
        pairs: [
          ["$\\mathbb{N}$", "Numeri della forma $a+ib$ con $a,b \\in \\mathbb{R}$"],
          ["$\\mathbb{Z}$", "Rapporti $p/q$ con $q \\neq 0$"],
          ["$\\mathbb{Q}$", "Interi senza il segno"],
        ],
        passageIds: ["{{passage:0}}"],
        explanation: "Ogni insieme supera i limiti del precedente.",
      })),
    },
  };
  const app = await launchPyxis({
    userData,
    env: { PYXIS_E2E_PLAN_REPLIES: JSON.stringify(replies), PYXIS_E2E_PLAN_DELAY: "100" },
  });
  try {
    const page = await app.firstWindow();
    await page.getByRole("button", { name: "Salta" }).click();
    await expect(page).toHaveURL(/#\/exams$/);
    const source = (await importPickedSource(page, app, file)) as { sourceId: string };
    await expect
      .poll(async () => {
        const rows = (await page.evaluate(() => window.pyxis.invoke("sources.list", {}))) as Array<{
          id: string;
          status: string;
        }>;
        return rows.find((row) => row.id === source.sourceId)?.status;
      })
      .toBe("ready");
    const created = (await page.evaluate(
      (sourceId) => window.pyxis.invoke("plans.create", { title: "Fisica", sourceIds: [sourceId] }),
      source.sourceId,
    )) as { planId: string };
    await expect
      .poll(
        async () =>
          (
            (await page.evaluate((planId) => window.pyxis.invoke("plans.build", { planId }), created.planId)) as {
              state: string;
            }
          ).state,
      )
      .toBe("succeeded");
    const plan = (await page.evaluate((planId) => window.pyxis.invoke("plans.read", { planId }), created.planId)) as {
      topics: Array<{ id: string }>;
    };
    await page.evaluate(
      ({ planId, topicId }) => {
        window.location.hash = `/plans/${planId}/quiz/${topicId}`;
      },
      { planId: created.planId, topicId: plan.topics[0]!.id },
    );
    await page.getByRole("button", { name: "Personalizza" }).click();
    const types = page.getByRole("group", { name: "Tipi di domanda" });
    for (const name of ["Scelta multipla", "Vero o falso", "Completamento", "Risposta aperta"])
      await types.getByRole("button", { name, exact: true }).click();
    await page.getByRole("button", { name: "Inizia", exact: true }).click();
    await expect(page.getByText(/^Domanda 1 di \d+$/)).toBeVisible();

    // The left column and the selects draw math; nothing shows a raw `$`.
    const rows = page.locator(".px-quiz-matching label");
    await expect(rows).toHaveCount(3);
    await expect(rows.first().locator(".katex")).not.toHaveCount(0);
    const first = page.getByRole("combobox", { name: "Abbinamento per \\mathbb{N}" });
    await first.focus();
    await page.keyboard.press("ArrowDown");
    const menu = page.locator(".ant-select-dropdown:visible");
    await expect(menu.locator(".ant-select-item-option .katex").first()).toBeVisible();
    expect((await menu.locator(".ant-select-item-option").allInnerTexts()).join(" ")).not.toContain("$");
    // No hover tooltip with raw TeX either.
    await expect(menu.locator(".ant-select-item-option[title]:not([title=''])")).toHaveCount(0);
    await saveShot(page, "quiz-match-math-open.png");
    // Arrow keys walk the options; take the first one that holds math.
    for (let tries = 0; tries < 3; tries += 1) {
      if ((await menu.locator(".ant-select-item-option-active .katex").count()) > 0) break;
      await page.keyboard.press("ArrowDown");
    }
    await expect(menu.locator(".ant-select-item-option-active .katex").first()).toBeVisible();
    await page.keyboard.press("Enter");
    await expect(menu).toBeHidden();
    await expect(rows.first().locator(".ant-select-content .katex").first()).toBeVisible();
    await expect(rows.first()).not.toContainText("$");
    await saveShot(page.locator(".px-quiz-matching"), "quiz-match-math-picked.png");
    await expectNoAxeViolations(page);
  } finally {
    await app.close();
    rmSync(userData, { recursive: true, force: true });
  }
});
