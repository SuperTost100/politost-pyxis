import { expect, test, type Page } from "@playwright/test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { launchPyxis } from "./app-under-test";
import { expectNoAxeViolations } from "./axe";
import { animationsSettled } from "./settled";
import { saveShot } from "./shots";


const paper = {
  title: "Analisi 1, appello di giugno",
  minutes: 150,
  totalPoints: 30,
  questions: [
    ["open", "easy", "Enuncia il teorema di Weierstrass e dai un esempio in cui non vale."],
    ["choice", "easy", "Quanto vale $\\lim_{x\\to 0} \\frac{\\sin x}{x}$?\nA) 0\nB) 1\nC) $\\infty$\nD) non esiste"],
    ["numeric", "medium", "Calcola $\\int_0^1 x e^{x}\\,dx$."],
    ["numeric", "hard", "Trova il valore di $a$ per cui $f(x)=ax^2-4x+1$ ha minimo $-3$."],
    ["proof", "hard", "Dimostra che ogni successione convergente è limitata."],
    ["open", "medium", "Studia la convergenza della serie $\\sum_{n\\ge 1} \\frac{1}{n(n+1)}$."],
  ].map(([type, difficulty, text]) => ({
    text,
    type,
    points: 5,
    minutes: null,
    difficulty,
    reference: "Soluzione di riferimento dell'appello.",
  })),
};

async function look(page: Page, language: "it" | "en", theme: "light" | "dark") {
  await page.evaluate(
    async ({ language, theme }) => {
      localStorage.setItem("pyxis.lang", language);
      await window.pyxis.setAppearance(theme);
    },
    { language, theme },
  );
  await page.reload();
  // The window draws nothing until it has its theme, then fades the page in: wait for both, and for the fade to end,
  // before a caller takes a screenshot or measures.
  await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
  await expect(page.locator("h1:visible").first()).toBeVisible();
  await animationsSettled(page);
}

async function shoot(page: Page, name: string) {
  await page.evaluate(() => window.scrollTo(0, 0));
  await saveShot(page, `past-papers/${name}.png`, { fullPage: true });
}

test("past exams: add one, see what was read, practise it and follow it in a simulation", async () => {
  test.setTimeout(240000);
  const userData = mkdtempSync(join(tmpdir(), "pyxis-past-papers-"));
  const file = join(userData, "appello-giugno.md");
  writeFileSync(
    file,
    "# Analisi 1, appello di giugno\n\nTempo: 150 minuti.\n\n" +
      paper.questions.map((q, i) => `${i + 1}. ${q.text}`).join("\n\n"),
  );
  const env = {
    PYXIS_E2E_PLAN_REPLIES: JSON.stringify({
      paper,
      markdown: { markdown: "## Ripasso\nUn riepilogo del piano." },
      questions: {
        questions: Array.from({ length: 10 }, (_, i) => ({
          stem: `Diagnosi ${i}`,
          options: ["a", "b", "c", "d"],
          correct: 0,
          topicIndex: i % 3,
          passageIds: [],
          explanation: "La relazione.",
        })),
      },
      score: { score: 0.8, explanation: "Corretto, manca un passaggio." },
    }),
  };
  const app = await launchPyxis({ userData, env });
  try {
    const page = await app.firstWindow();
    await page.getByRole("button", { name: "Salta" }).click();
    await expect(page).toHaveURL(/#\/exams$/);
    const plan = (await page.evaluate(() =>
      window.pyxis.invoke("plans.create", {
        title: "Analisi 1",
        sourceIds: [],
        draftTopics: [{ title: "Limiti" }, { title: "Integrali" }, { title: "Serie" }],
      }),
    )) as { planId: string };
    await expect
      .poll(async () =>
        (
          (await page.evaluate(
            (planId) => window.pyxis.invoke("plans.build", { planId }),
            plan.planId,
          )) as { state: string }
        ).state,
      )
      .toBe("succeeded");
    await page.evaluate((planId) => {
      window.location.hash = `/plans/${planId}/sources`;
    }, plan.planId);

    // Empty state: nothing read yet.
    await look(page, "en", "light");
    await expect(page.getByRole("heading", { name: "Past exams" })).toBeVisible();
    await expect(page.getByText("No past exams yet")).toBeVisible();
    await expect(page.getByRole("button", { name: "Practise past questions" })).toHaveCount(0);
    await shoot(page, "sources-empty-en-light");
    await look(page, "it", "dark");
    await expect(page.getByRole("heading", { name: "Appelli passati" })).toBeVisible();
    await shoot(page, "sources-empty-it-dark");

    // The file goes through the usual source import dialog, then becomes a past paper of this plan.
    await app.evaluate(({ dialog }, selected) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] });
    }, file);
    await look(page, "en", "light");
    await page.getByRole("button", { name: "Add a past exam" }).click();
    // A click on a dialog still zooming in is lost on a slow runner, and the import never starts.
    await animationsSettled(page, page.getByRole("dialog"));
    await page.getByRole("button", { name: "Choose files" }).click();
    await expect(page.getByText("Analisi 1, appello di giugno")).toBeVisible();
    await expect(page.getByRole("button", { name: "Add a past exam" })).toBeVisible();
    await look(page, "it", "dark");
    await expect(page.getByText("Analisi 1, appello di giugno")).toBeVisible();
    await expect(page.getByText(/6 domande · 150 min · aperte 2, numeriche 2/)).toBeVisible();
    await expect(page.getByText(/Le simulazioni copiano questi appelli: circa 6 domande, 150 min/)).toBeVisible();
    // The paper is not study material: the plan still lists no source of its own.
    const read = (await page.evaluate(
      (planId) => window.pyxis.invoke("plans.read", { planId }),
      plan.planId,
    )) as { sources: unknown[] };
    expect(read.sources).toEqual([]);
    await shoot(page, "sources-paper-it-dark");
    // A reload into a new theme fades the page in; axe must not measure a colour halfway.
    await animationsSettled(page);
    await expectNoAxeViolations(page);

    await look(page, "en", "dark");
    await expect(page.getByText(/6 questions · 150 min · open 2, numeric 2, multiple choice 1, proof 1/)).toBeVisible();
    await shoot(page, "sources-paper-en-dark");
    await page.setViewportSize({ width: 420, height: 900 });
    await shoot(page, "sources-paper-en-dark-420");
    await look(page, "it", "light");
    await expect(page.getByText(/6 domande · 150 min · aperte 2, numeriche 2/)).toBeVisible();
    await shoot(page, "sources-paper-it-light-420");
    await page.setViewportSize({ width: 1280, height: 900 });
    await look(page, "en", "light");
    await expect(page.getByText(/6 questions · 150 min/)).toBeVisible();
    await shoot(page, "sources-paper-en-light");
    await animationsSettled(page);
    await expectNoAxeViolations(page);

    // Practise one paper: intro, first question, a graded answer.
    await page.getByRole("button", { name: "Practise", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Past questions" })).toBeVisible();
    await expect(page.getByText("6 questions")).toBeVisible();
    await shoot(page, "practise-intro-en-light");
    await page.getByRole("button", { name: "Start", exact: true }).click();
    await expect(page.getByText(/Weierstrass/)).toBeVisible();
    await page.getByRole("textbox").first().fill("Una funzione continua su un compatto ha massimo e minimo.");
    await shoot(page, "practise-question-en-light");
    await look(page, "it", "dark");
    await expect(page.getByText(/Weierstrass/)).toBeVisible();
    await shoot(page, "practise-question-it-dark");

    // The simulation setup offers the papers' format and their length.
    await page.evaluate((planId) => {
      window.location.hash = `/plans/${planId}/simulation`;
    }, plan.planId);
    await expect(page.getByText("Formato", { exact: true })).toBeVisible();
    await expect(page.getByText("Come i tuoi appelli passati")).toBeVisible();
    await expect(page.getByText("6 domande nello stile del tuo appello passato.")).toBeVisible();
    await expect(page.getByRole("button", { name: "150 minuti", pressed: true })).toBeVisible();
    await animationsSettled(page);
    await shoot(page, "simulation-setup-it-dark");
    await look(page, "en", "light");
    await expect(page.getByText("Like your past exams")).toBeVisible();
    await animationsSettled(page);
    await shoot(page, "simulation-setup-en-light");
    await expectNoAxeViolations(page);
    await page.getByText("Standard", { exact: true }).click();
    await expect(page.getByText(/in the style of your past exam/)).toHaveCount(0);

    // A scan that was never read leaves a failed paper with its way out. The row is written the way a failed read leaves it.
    const db = new DatabaseSync(join(userData, "workspace", "pyxis.db"), { timeout: 10000 });
    db.prepare(
      "INSERT INTO sources (id, kind, title, status, created_at, updated_at) VALUES ('scan', 'pdf', 'Appello di settembre (scansione)', 'needs-ocr', 5, 5)",
    ).run();
    db.prepare("INSERT INTO plan_sources (plan_id, source_id, role) VALUES (?, 'scan', 'past_paper')").run(plan.planId);
    db.prepare(
      "INSERT INTO jobs (id, kind, params_json, state, error, created_at, updated_at) VALUES ('job-scan', 'paper-read', ?, 'failed', 'paper-needs-ocr', 5, 5)",
    ).run(JSON.stringify({ planId: plan.planId, sourceId: "scan" }));
    db.close();
    await page.evaluate((planId) => {
      window.location.hash = `/plans/${planId}/sources`;
    }, plan.planId);
    await look(page, "en", "light");
    await expect(page.getByText("This file has no text yet. Read it in your Library, then try again.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();
    await shoot(page, "sources-failed-en-light");
    await look(page, "it", "dark");
    await shoot(page, "sources-failed-it-dark");
    await expectNoAxeViolations(page);
    await look(page, "en", "light");

    // Removing the papers brings the plain setup back.
    await page.evaluate((planId) => {
      window.location.hash = `/plans/${planId}/sources`;
    }, plan.planId);
    for (const title of ["Appello di settembre (scansione)", "Analisi 1, appello di giugno"]) {
      await page.locator(".px-paper", { hasText: title }).getByRole("button", { name: "Remove" }).click();
      await page.getByRole("dialog").getByRole("button", { name: "Remove" }).click();
      await expect(page.getByText(title)).toHaveCount(0);
    }
    await expect(page.getByText("No past exams yet")).toBeVisible();
  } finally {
    await app.close();
    rmSync(userData, { recursive: true, force: true });
  }
});
