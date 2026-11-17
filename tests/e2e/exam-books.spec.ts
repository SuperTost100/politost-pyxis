import { expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchPyxis, setUp } from "./app-under-test";
import { expectNoAxeViolations } from "./axe";
import { booksSite } from "./books-site";
import { removeTestFolder } from "./cleanup";
import { fromChiediToExams, toLibrary } from "./doors";
import { animationsSettled, clickSettled } from "./settled";
import { saveShot } from "./shots";

/** Stand-in replies, so creating an exam does not need an AI tool: the build only has to start. */
const PLAN_REPLIES = JSON.stringify({
  topics: { topics: [{ title: "Moto", summary: "Velocità", subtopics: ["Velocità"], segmentIds: ["{{segment:0}}"] }] },
  markdown: { markdown: "## Il moto\n\nStudierai la velocità [P1]." },
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
});

type Started = { app: ElectronApplication; page: Page; userData: string; site: string };

async function start(env: Record<string, string | undefined> = {}, withSite = true): Promise<Started> {
  const userData = mkdtempSync(join(tmpdir(), "pyxis-exam-books-"));
  const site = booksSite();
  const app = await launchPyxis({ userData, env: { PYXIS_E2E_BOOKS: withSite ? site : undefined, PYXIS_E2E_PLAN_REPLIES: PLAN_REPLIES, ...env } });
  return setUp(app, userData, async () => {
    const page = await app.firstWindow();
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.getByRole("button", { name: "Salta" }).click();
    await fromChiediToExams(page);
    return { app, page, userData, site };
  });
}
async function finish({ app, userData, site }: Started) {
  await app.close();
  removeTestFolder(userData);
  rmSync(site, { recursive: true, force: true });
}

const db = <T>(userData: string, sql: string) => {
  const handle = new DatabaseSync(join(userData, "workspace", "pyxis.db"), { timeout: 10_000 });
  try {
    return handle.prepare(sql).all() as T[];
  } finally {
    handle.close();
  }
};
const smartbooks = (userData: string) => db<{ title: string }>(userData, "SELECT title FROM sources WHERE kind = 'smartbook' AND status != 'removed'");

/** The new exam's material step, for an exam with this name and no date. */
async function toMaterial(page: Page, name: string) {
  await page.evaluate(() => {
    location.hash = "/plans/new";
  });
  await page.getByLabel("Nome dell'esame", { exact: true }).fill(name);
  await page.getByRole("button", { name: "Non ho ancora la data" }).click();
  await page.getByRole("button", { name: "Continua" }).click();
  await expect(page.getByRole("heading", { name: "Da cosa studi?" })).toBeVisible();
}
const row = (page: Page) => page.locator("[data-book-choice]");
const reader = (page: Page, title: string) => page.getByRole("complementary", { name: title });

test("A new exam named like a PoliTost book offers it as a ticked source, readable first, and creates the exam with it", async () => {
  test.setTimeout(180_000);
  const run = await start();
  const { page, userData } = run;
  try {
    await toMaterial(page, "Fisica 1");
    await expect(row(page)).toBeVisible({ timeout: 30_000 });
    const tick = row(page).getByRole("checkbox", { name: /Fisica 1, libro PoliTost/ });
    await expect(tick).toBeChecked();
    // The offer counts as a source, and the step makes the exam instead of going on to the guided flow.
    await expect(page.getByText("1 fonte nell'esame")).toBeVisible();
    await expect(page.getByRole("button", { name: "Crea l'esame" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Libri PoliTost gratuiti" })).toHaveCount(0);
    // Nothing was downloaded to show it.
    expect(smartbooks(userData)).toEqual([]);
    await expectNoAxeViolations(page);
    await saveShot(page, "exam-books/offer-it-light-1280.png", { fullPage: true });

    // Reading it first: the reader says the book is among the sources and takes it out, and the page follows.
    await row(page).getByRole("button", { name: "Apri il libro Fisica 1" }).click();
    const panel = reader(page, "Fisica 1");
    await expect(panel.getByText("È tra le fonti di questo esame.")).toBeVisible();
    await expect(panel.getByText("La velocità media è lo spazio percorso")).toBeVisible({ timeout: 30_000 });
    await animationsSettled(page);
    await saveShot(page, "exam-books/reader-it-light-1280.png", { fullPage: true });
    await panel.getByRole("button", { name: "Togli dalle fonti" }).click();
    await expect(panel.getByText("Non è tra le fonti di questo esame.")).toBeVisible();
    await expect(tick).not.toBeChecked();
    await expect(page.getByRole("button", { name: "Continua" })).toBeVisible();
    await panel.getByRole("button", { name: "Aggiungi alle fonti" }).click();
    await expect(tick).toBeChecked();
    await expect(panel.getByText("È tra le fonti di questo esame.")).toBeVisible();
    // And ticking on the page changes the reader's row.
    await tick.uncheck();
    await expect(panel.getByText("Non è tra le fonti di questo esame.")).toBeVisible();
    await tick.check();
    await panel.getByRole("button", { name: "Chiudi" }).click();
    expect(smartbooks(userData)).toEqual([]);

    // Creating the exam downloads the book and makes it a source of the exam.
    await page.getByRole("button", { name: "Crea l'esame" }).click();
    await expect.poll(() => db<{ title: string }>(userData, "SELECT s.title FROM plan_sources ps JOIN sources s ON s.id = ps.source_id")).toEqual([{ title: "Fisica 1" }]);
    expect(smartbooks(userData)).toEqual([{ title: "Fisica 1" }]);
  } finally {
    await finish(run);
  }
});

test("Once the exam is being created the choice is locked in the reader too, and says why", async () => {
  test.setTimeout(180_000);
  const run = await start({ PYXIS_E2E_BOOKS_DELAY: "4000" });
  const { page, userData } = run;
  try {
    await toMaterial(page, "Fisica 1");
    await expect(row(page)).toBeVisible({ timeout: 30_000 });
    await page.getByRole("button", { name: "Crea l'esame" }).click();
    // The book is downloading: the tick is locked, and the reader opened now cannot take the book out either.
    await expect(row(page).getByRole("checkbox")).toBeDisabled();
    await row(page).getByRole("button", { name: "Apri il libro Fisica 1" }).click();
    // The reader is still downloading the book itself, so it has no name yet: it is found as the panel.
    const panel = page.locator("aside.source-panel");
    await expect(panel.getByText("L'esame si sta creando con questo libro.")).toBeVisible();
    await expect(panel.getByRole("button", { name: "Togli dalle fonti" })).toBeDisabled();
    await expect(row(page).getByRole("checkbox")).toBeChecked();
    // And the exam is made with the book, as the page said.
    await expect.poll(() => db<{ title: string }>(userData, "SELECT s.title FROM plan_sources ps JOIN sources s ON s.id = ps.source_id"), { timeout: 30_000 }).toEqual([{ title: "Fisica 1" }]);
  } finally {
    await finish(run);
  }
});

test("Leaving the book out downloads nothing and the exam goes on without it", async () => {
  test.setTimeout(120_000);
  const run = await start();
  const { page, userData } = run;
  try {
    await toMaterial(page, "Fisica 1");
    await row(page).getByRole("checkbox").uncheck();
    await expect(page.getByText("0 fonti nell'esame")).toBeVisible();
    // With no source the step goes on to the guided flow, as it always did.
    await expect(page.getByRole("button", { name: "Continua" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Crea l'esame" })).toHaveCount(0);
    expect(smartbooks(userData)).toEqual([]);
  } finally {
    await finish(run);
  }
});

test("A download that fails keeps the form, the tick and the exam not made, with the reason", async () => {
  test.setTimeout(120_000);
  const run = await start();
  const { page, userData, site } = run;
  try {
    await toMaterial(page, "Fisica 1");
    await expect(row(page)).toBeVisible({ timeout: 30_000 });
    rmSync(join(site, "books"), { recursive: true, force: true });
    await page.getByRole("button", { name: "Crea l'esame" }).click();
    await expect(page.getByRole("alert").filter({ hasText: "Non riesco a raggiungere books.politost.it" })).toBeVisible({ timeout: 30_000 });
    await expect(row(page).getByRole("checkbox")).toBeChecked();
    await expect(page.getByRole("button", { name: "Crea l'esame" })).toBeEnabled();
    expect(db(userData, "SELECT id FROM plans")).toEqual([]);
    expect(smartbooks(userData)).toEqual([]);
  } finally {
    await finish(run);
  }
});

test("An exam no book is named like, and an exam offline, show no offer", async () => {
  test.setTimeout(120_000);
  const run = await start();
  try {
    await toMaterial(run.page, "Analisi 2");
    await expect(run.page.getByText("0 fonti nell'esame")).toBeVisible();
    await expect(row(run.page)).toHaveCount(0);
  } finally {
    await finish(run);
  }
  const offline = await start({}, false);
  try {
    await toMaterial(offline.page, "Fisica 1");
    await expect(offline.page.getByText("0 fonti nell'esame")).toBeVisible();
    await expect(row(offline.page)).toHaveCount(0);
    await expect(offline.page.getByRole("alert")).toHaveCount(0);
  } finally {
    await finish(offline);
  }
});

test("The first file of a new subject can bring the book along, which is read first and ticked by default", async () => {
  test.setTimeout(180_000);
  const run = await start();
  const { page, userData } = run;
  try {
    const seed = new DatabaseSync(join(userData, "workspace", "pyxis.db"), { timeout: 10_000 });
    seed.exec(`
      INSERT INTO subjects (id, name, position, created_at) VALUES ('fis', 'Fisica 1', 0, 1);
      INSERT INTO sources (id, subject_id, kind, title, status, library, created_at, updated_at) VALUES ('fis-notes', 'fis', 'pdf', 'Appunti di fisica', 'ready', 1, 1, 1);
      INSERT INTO sources (id, kind, title, status, library, subject_sort, created_at, updated_at) VALUES ('loose', 'pdf', 'Slide di chimica', 'ready', 1, 'unsure', 2, 2);`);
    seed.close();
    await toLibrary(page);
    await page.reload();
    const loose = page.locator('[data-unsorted-id="loose"]');
    await loose.getByRole("combobox").selectOption({ label: "Nuova materia…" });
    const dialog = page.getByRole("dialog", { name: "Sposta in una materia nuova" });
    // A name that is a book's, for a subject with no file yet: the book is offered with the file, ticked.
    await dialog.getByRole("textbox").fill("Chimica");
    const offer = dialog.locator("[data-book-choice]");
    await expect(offer).toBeVisible();
    await expect(offer.getByRole("checkbox")).toBeChecked();
    await saveShot(page, "exam-books/first-file-it-light-1280.png", { fullPage: true });
    // A name the student already has files under offers nothing: it is not a first file.
    await dialog.getByRole("textbox").fill("Fisica 1");
    await expect(offer).toHaveCount(0);
    await dialog.getByRole("textbox").fill("Chimica");
    await offer.getByRole("button", { name: "Apri il libro Chimica di base" }).click();
    const panel = reader(page, "Chimica di base");
    await expect(panel.getByText("Va nella Libreria con questo file.")).toBeVisible();
    await expect(panel.getByText("L'atomo ha un nucleo.")).toBeVisible({ timeout: 30_000 });
    await panel.getByRole("button", { name: "Non aggiungerlo" }).click();
    await expect(offer.getByRole("checkbox")).not.toBeChecked();
    await panel.getByRole("button", { name: "Aggiungilo" }).click();
    await expect(offer.getByRole("checkbox")).toBeChecked();
    await panel.getByRole("button", { name: "Chiudi" }).click();
    expect(smartbooks(userData)).toEqual([]);
    await clickSettled(page, dialog.getByRole("button", { name: "Sposta" }));
    // The file moved to the new subject, and the book follows it onto that shelf.
    const shelf = page.getByRole("region", { name: /^Chimica (\d+ file|nessun file)/ });
    await expect(shelf.getByRole("button", { name: "Slide di chimica", exact: true })).toBeVisible();
    await expect(shelf.getByRole("button", { name: "Chimica di base", exact: true })).toBeVisible({ timeout: 30_000 });
    expect(smartbooks(userData)).toEqual([{ title: "Chimica di base" }]);
  } finally {
    await finish(run);
  }
});

test("Unticked, the book of a new subject is not added", async () => {
  test.setTimeout(120_000);
  const run = await start();
  const { page, userData } = run;
  try {
    const seed = new DatabaseSync(join(userData, "workspace", "pyxis.db"), { timeout: 10_000 });
    seed.exec(`INSERT INTO sources (id, kind, title, status, library, subject_sort, created_at, updated_at) VALUES ('loose', 'pdf', 'Slide di chimica', 'ready', 1, 'unsure', 2, 2);`);
    seed.close();
    await toLibrary(page);
    await page.reload();
    await page.locator('[data-unsorted-id="loose"]').getByRole("combobox").selectOption({ label: "Nuova materia…" });
    const dialog = page.getByRole("dialog", { name: "Sposta in una materia nuova" });
    await dialog.getByRole("textbox").fill("Chimica");
    await dialog.locator("[data-book-choice]").getByRole("checkbox").uncheck();
    await dialog.getByRole("button", { name: "Sposta" }).click();
    const shelf = page.getByRole("region", { name: /^Chimica (\d+ file|nessun file)/ });
    await expect(shelf.getByRole("button", { name: "Slide di chimica", exact: true })).toBeVisible();
    // The shelf's own quiet row still offers it, so leaving it out here cost nothing.
    await expect(shelf.getByRole("group", { name: "C'è un libro PoliTost per questa materia" })).toBeVisible({ timeout: 30_000 });
    expect(smartbooks(userData)).toEqual([]);
  } finally {
    await finish(run);
  }
});
