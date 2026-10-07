import { importPickedSource } from "./picked-source";
import { _electron as electron, expect, test, type Page } from "@playwright/test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { manyPagePdf } from "../../src/core/sources/documents";

const MAIN = join(process.cwd(), process.env.PYXIS_OUT ?? "out", "main/index.js");

async function launch(extra: Record<string, string> = {}) {
  const userData = mkdtempSync(join(tmpdir(), "pyxis-math-keyboard-"));
  const env = { ...process.env, PYXIS_USER_DATA: userData, PYXIS_E2E: "1", ...extra };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ args: [MAIN], env });
  const page = await app.firstWindow();
  const violations: string[] = [];
  page.on("console", (message) => {
    if (/content security policy|refused to (load|connect|apply)/i.test(message.text()))
      violations.push(message.text());
  });
  page.on("request", (request) => {
    if (!/^(file|data|blob|devtools|chrome-extension):/.test(request.url()))
      violations.push(`request ${request.url()}`);
  });
  await page.getByRole("button", { name: "Salta" }).click();
  await expect(page).toHaveURL(/#\/exams$/);
  return { app, page, userData, violations };
}

/** Builds one half in the open field: fraction key, 1, move right, 2. */
async function typeHalf(page: Page) {
  const keys = page.getByRole("group", { name: "Tastiera per formule" });
  await keys.getByRole("button", { name: "Frazione" }).click();
  await keys.getByRole("button", { name: "1", exact: true }).click();
  await keys.getByRole("button", { name: "Sposta a destra" }).click();
  await keys.getByRole("button", { name: "2", exact: true }).click();
  return keys;
}

/** The message as it will be sent, and what of it lies before the caret. */
function composerState(page: Page) {
  return page.evaluate(() => {
    const box = document.querySelector<HTMLElement>(".px-composer-field")!;
    const range = getSelection()!.getRangeAt(0);
    const before = document.createRange();
    before.setStart(box, 0);
    before.setEnd(range.startContainer, range.startOffset);
    return {
      draft: sessionStorage.getItem("pyxis-draft"),
      formulasBeforeCaret: before.cloneContents().querySelectorAll(".px-mathchip").length,
      textBeforeCaret: before.toString().replace(/[^\x20-\x7e]/g, ""),
    };
  });
}

test("Composer: the formula keyboard types into a formula opened at the caret", async () => {
  test.setTimeout(120000);
  const { app, page, userData, violations } = await launch();
  try {
    await page.evaluate(() => {
      location.hash = "/ask";
    });
    await page.reload();
    const box = page.getByRole("textbox", { name: "Messaggio" });
    await box.fill("Calcola  e poi semplifica");
    // The caret sits after "Calcola ".
    await box.evaluate((el) => {
      const range = document.createRange();
      range.setStart(el.firstChild!, 8);
      getSelection()!.removeAllRanges();
      getSelection()!.addRange(range);
    });

    const toggle = page.getByRole("button", { name: "Inserisci formula" });
    await expect(toggle).toHaveAttribute("aria-pressed", "false");
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-pressed", "true");
    const keys = page.getByRole("group", { name: "Tastiera per formule" });
    await expect(keys).toBeVisible();
    // The formula opens inside the message, not in a box of its own.
    const field = box.locator(".px-mathchip math-field");
    await expect(field).toBeFocused();
    // The keyboard is part of the composer, so it does not cover the field or the send button.
    const boxes = await page.evaluate(() => {
      const rect = (selector: string) => document.querySelector(selector)!.getBoundingClientRect();
      return {
        panelTop: rect(".px-formula").top,
        fieldBottom: rect(".px-composer-field").bottom,
        barTop: rect(".px-composer-bar").top,
        panelBottom: rect(".px-formula").bottom,
        viewport: window.innerHeight,
        composerBottom: rect(".px-composer").bottom,
      };
    });
    expect(boxes.panelTop).toBeGreaterThanOrEqual(boxes.fieldBottom);
    expect(boxes.panelBottom).toBeLessThanOrEqual(boxes.barTop);
    expect(boxes.composerBottom).toBeLessThanOrEqual(boxes.viewport);

    // Four tabs, reachable by keyboard. Focus on the tabs keeps the formula open.
    const tabs = keys.getByRole("tab");
    await expect(tabs).toHaveCount(4);
    await expect(tabs.nth(0)).toHaveAttribute("aria-selected", "true");
    await tabs.nth(0).focus();
    await page.keyboard.press("ArrowRight");
    await expect(tabs.nth(1)).toBeFocused();
    await expect(tabs.nth(1)).toHaveAttribute("aria-selected", "true");
    await expect(keys.getByRole("button", { name: "Logaritmo naturale" })).toBeVisible();
    await tabs.nth(0).click();

    await typeHalf(page);
    await expect(field).toBeFocused();
    await keys.getByRole("button", { name: "Fatto", exact: true }).click();

    await expect(keys).toHaveCount(0);
    await expect(box).toBeFocused();
    await expect(box.locator(".px-mathchip .katex .mfrac")).toBeVisible();
    expect(await composerState(page)).toEqual({
      draft: "Calcola $\\frac{1}{2}$ e poi semplifica",
      formulasBeforeCaret: 1,
      textBeforeCaret: expect.stringMatching(/^Calcola /),
    });
    await expect(page.getByText("Anteprima")).toHaveCount(0);

    // Esc closes the keyboard; a formula left empty goes away.
    await toggle.click();
    await expect(keys).toBeVisible();
    await expect(field).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(keys).toHaveCount(0);
    await expect(box).toBeFocused();
    await expect(box.locator(".px-mathchip")).toHaveCount(1);
    expect((await composerState(page)).draft).toBe("Calcola $\\frac{1}{2}$ e poi semplifica");

    // Typing in the formula with the physical keyboard; Enter returns to the text without sending.
    await box.fill("");
    await toggle.click();
    await expect(field).toBeFocused();
    await page.keyboard.type("x^2");
    await page.keyboard.press("Enter");
    await expect(box).toBeFocused();
    expect((await composerState(page)).draft).toMatch(/^\$x\^\{?2\}?\$$/);
    await expect(page).toHaveURL(/#\/ask$/);

    expect(violations).toEqual([]);
  } finally {
    await app.close();
    rmSync(userData, { recursive: true, force: true });
  }
});

test("Composer: the keyboard follows the interface language", async () => {
  test.setTimeout(120000);
  const { app, page, userData } = await launch();
  try {
    await page.evaluate(() => localStorage.setItem("pyxis.lang", "en"));
    await page.evaluate(() => {
      location.hash = "/ask";
    });
    await page.reload();
    await page.getByRole("button", { name: "Insert formula" }).click();
    const keys = page.getByRole("group", { name: "Formula keyboard" });
    await expect(keys.getByRole("button", { name: "Square root" })).toBeVisible();
    await expect(keys.getByRole("button", { name: "Done", exact: true })).toBeEnabled();
    await expect(keys.getByRole("tab", { name: "Calculus" })).toBeVisible();
  } finally {
    await app.close();
    rmSync(userData, { recursive: true, force: true });
  }
});

test("Quiz: an open answer takes a formula from the keyboard inline", async () => {
  test.setTimeout(240000);
  const userData = mkdtempSync(join(tmpdir(), "pyxis-math-quiz-"));
  const file = join(userData, "physics.pdf");
  writeFileSync(file, manyPagePdf(1, "Velocity is displacement over time."));
  const replies = {
    topics: {
      topics: [
        { title: "Moto", summary: "Velocità", subtopics: ["Tempo"], segmentIds: ["{{segment:0}}"] },
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
        kind: "open",
        stem: `Scrivi la velocità media come rapporto. Domanda {{question:${i}}}.`,
        reference: "$v = \\frac{\\Delta x}{\\Delta t}$",
        rubric: ["Spostamento", "Tempo"],
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
  const app = await electron.launch({ args: [MAIN], env });
  try {
    const page = await app.firstWindow();
    await page.getByRole("button", { name: "Salta" }).click();
    await expect(page).toHaveURL(/#\/exams$/);
    const source = (await importPickedSource(page, app, file)) as { sourceId: string };
    await expect
      .poll(async () => {
        const rows = (await page.evaluate(() =>
          window.pyxis.invoke("sources.list", {}),
        )) as Array<{ id: string; status: string }>;
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
    await page.getByRole("slider", { name: "Numero di domande" }).waitFor();
    // Only open questions: switch the other four kinds off.
    const types = page.getByRole("group", { name: "Tipi di domanda" });
    for (const name of ["Scelta multipla", "Vero o falso", "Completamento", "Abbinamento"])
      await types.getByRole("button", { name }).click();
    await page.getByRole("button", { name: "Inizia", exact: true }).click();
    await expect(page.getByText(/^Domanda 1 di \d+$/)).toBeVisible();

    const answer = page.getByRole("textbox", { name: "La tua risposta" });
    await answer.fill("La velocità vale ");
    await page.getByRole("button", { name: "Inserisci formula" }).click();
    const keys = page.getByRole("group", { name: "Tastiera per formule" });
    await typeHalf(page);
    await keys.getByRole("button", { name: "Fatto", exact: true }).click();
    await expect(answer).toBeFocused();
    await expect(answer).toHaveText(/^La velocità vale /);
    await expect(answer.locator(".px-mathchip .katex .mfrac")).toBeVisible();
    expect(await answer.innerText()).not.toContain("frac");
    await page.locator(".px-mathinput").screenshot({ path: ".shots/math-input-quiz.png" });
  } finally {
    await app.close();
    rmSync(userData, { recursive: true, force: true });
  }
});
