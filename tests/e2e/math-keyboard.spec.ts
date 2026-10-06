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

test("Composer: the formula keyboard builds a fraction and inserts it at the caret", async () => {
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
    await box.evaluate((el: HTMLTextAreaElement) => el.setSelectionRange(8, 8));

    const toggle = page.getByRole("button", { name: "Inserisci formula" });
    await expect(toggle).toHaveAttribute("aria-pressed", "false");
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-pressed", "true");
    const keys = page.getByRole("group", { name: "Tastiera per formule" });
    await expect(keys).toBeVisible();
    await expect(page.locator("math-field")).toBeVisible();
    // The keyboard is part of the composer, so it does not cover the textarea or the send button.
    const boxes = await page.evaluate(() => {
      const rect = (selector: string) => document.querySelector(selector)!.getBoundingClientRect();
      return {
        panelTop: rect(".px-formula").top,
        textareaBottom: rect(".px-composer textarea").bottom,
        barTop: rect(".px-composer-bar").top,
        panelBottom: rect(".px-formula").bottom,
        viewport: window.innerHeight,
        composerBottom: rect(".px-composer").bottom,
      };
    });
    expect(boxes.panelTop).toBeGreaterThanOrEqual(boxes.textareaBottom);
    expect(boxes.panelBottom).toBeLessThanOrEqual(boxes.barTop);
    expect(boxes.composerBottom).toBeLessThanOrEqual(boxes.viewport);

    // Four tabs, reachable by keyboard.
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
    await keys.getByRole("button", { name: "Inserisci", exact: true }).click();

    await expect(keys).toHaveCount(0);
    await expect(box).toBeFocused();
    await expect(box).toHaveValue("Calcola $\\frac{1}{2}$ e poi semplifica");
    const caret = await box.evaluate((el: HTMLTextAreaElement) => el.selectionStart);
    expect(caret).toBe("Calcola $\\frac{1}{2}$".length);
    // The preview renders the formula under the textarea.
    const preview = page.getByRole("group", { name: "Anteprima" });
    await expect(preview.locator(".katex .mfrac")).toBeVisible();

    // Esc closes without inserting; the toggle button opens it again.
    await toggle.click();
    await expect(keys).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(keys).toHaveCount(0);
    await expect(box).toBeFocused();
    await expect(box).toHaveValue("Calcola $\\frac{1}{2}$ e poi semplifica");

    // Typing in the field with the physical keyboard and pressing Enter inserts too.
    await box.fill("");
    await toggle.click();
    await expect(page.locator("math-field")).toBeFocused();
    await page.keyboard.type("x^2");
    await page.keyboard.press("Enter");
    await expect(box).toHaveValue(/^\$x\^\{?2\}?\$$/);
    await expect(box).toBeFocused();

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
    await expect(keys.getByRole("button", { name: "Insert", exact: true })).toBeDisabled();
    await expect(keys.getByRole("tab", { name: "Calculus" })).toBeVisible();
  } finally {
    await app.close();
    rmSync(userData, { recursive: true, force: true });
  }
});

test("Quiz: an open answer takes a formula from the keyboard and previews it", async () => {
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
    await keys.getByRole("button", { name: "Inserisci", exact: true }).click();
    await expect(answer).toHaveValue("La velocità vale $\\frac{1}{2}$");
    await expect(answer).toBeFocused();
    await expect(page.getByRole("group", { name: "Anteprima" }).locator(".katex .mfrac")).toBeVisible();
  } finally {
    await app.close();
    rmSync(userData, { recursive: true, force: true });
  }
});
