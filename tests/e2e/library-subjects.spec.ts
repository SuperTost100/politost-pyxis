import { expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchPyxis } from "./app-under-test";
import { expectNoAxeViolations } from "./axe";
import { removeTestFolder } from "./cleanup";
import { fromChiediToExams, toLibrary } from "./doors";
import { animationsSettled } from "./settled";
import { saveShot } from "./shots";

/** Recorded answers of the AI tool that chooses subjects, by the `id` each file is sent with (its place in the call): file 1 fits a subject the student has, file 2 needs a new one. */
const replies = JSON.stringify({
  files: {
    files: [
      { id: "1", subject: "Analisi 1", newSubject: "" },
      { id: "2", subject: "", newSubject: "Probabilità e statistica" },
    ],
  },
});

/** The native picker answers with `paths`, as if the student had chosen them. */
async function answerPicker(app: ElectronApplication, paths: string[]) {
  await app.evaluate(({ dialog }, answer) => {
    delete process.env["PYXIS_E2E_FILE"];
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: answer })) as typeof dialog.showOpenDialog;
  }, paths);
}

/** Two study files, with enough text to read. */
function studyFiles(userData: string) {
  const folder = join(userData, "notes");
  mkdirSync(folder, { recursive: true });
  const limits = join(folder, "Esercizi sui limiti.txt");
  const notes = join(folder, "Calcolo delle probabilita, dispense.txt");
  writeFileSync(limits, "Calcola il limite per x che tende a zero di sin x su x.\n");
  writeFileSync(notes, "La probabilità condizionata di A dato B è il rapporto tra P(A e B) e P(B).\n");
  return { limits, notes };
}

async function start(env: Record<string, string | undefined>) {
  const userData = mkdtempSync(join(tmpdir(), "pyxis-library-subjects-"));
  const files = studyFiles(userData);
  const app = await launchPyxis({ userData, env: { PYXIS_E2E_FILE: undefined, ...env } });
  const page = await app.firstWindow();
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.getByRole("button", { name: "Salta" }).click();
  await fromChiediToExams(page);
  for (const name of ["Analisi 1", "Fisica 2"])
    await page.evaluate((name) => window.pyxis.invoke("subjects.add", { name }), name);
  await toLibrary(page);
  return { app, page, userData, files };
}

/** Adds files through the Library's file picker and closes the result. */
async function addFiles(app: ElectronApplication, page: Page, paths: string[]) {
  await answerPicker(app, paths);
  await page.getByRole("button", { name: "Aggiungi fonti", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Scegli i file", exact: true }).click();
  if (paths.length > 1) {
    await expect(dialog.getByText(`${paths.length} file importati.`)).toBeVisible();
    await dialog.getByRole("button", { name: "Fatto", exact: true }).click();
  }
  await expect(dialog).toBeHidden();
}

/** A row of the Library's list, below "Da sistemare". */
const row = (page: Page, title: string) =>
  page.getByRole("list", { name: "Fonti", exact: true }).locator(".px-source-row", { hasText: title });

test("Files added from the Library go into a subject the student has, or a new one Pyxis says it made", async () => {
  test.setTimeout(180000);
  const { app, page, userData, files } = await start({ PYXIS_E2E_PLAN_REPLIES: replies });
  try {
    await addFiles(app, page, [files.limits, files.notes]);
    const limits = row(page, "Esercizi sui limiti");
    const notes = row(page, "Calcolo delle probabilita, dispense");
    // One lands in Analisi 1; the other in a subject made for it, which the row says is new.
    await expect(limits.locator(".px-source-row-meta")).toContainText("Analisi 1", { timeout: 60000 });
    await expect(notes.locator(".px-source-row-meta")).toContainText("Probabilità e statistica");
    await expect(notes).toContainText(
      "Materia nuova. L'ho creata per questo file, perché non andava in nessuna delle altre.",
    );
    await expect(limits).not.toContainText("Materia nuova.");
    await animationsSettled(page);
    await expectNoAxeViolations(page);
    await saveShot(page, "library-subjects/1-sorted.png");

    // A chat in the new subject: the sidebar names the subject under its title.
    await page.evaluate(() =>
      window.pyxis.invoke("chats.seed", { kind: "answer", title: "Teorema di Bayes", body: "Bayes.", subject: "Probabilità e statistica" }),
    );
    await page.reload();
    const sidebarChat = page.getByRole("list", { name: "Chat" }).getByRole("link", { name: /^Teorema di Bayes/ });
    await expect(sidebarChat).toHaveText("Teorema di BayesProbabilità e statistica");

    // The new subject is renamed in place, and the note goes.
    await notes.getByRole("button", { name: "Rinomina la materia Probabilità e statistica" }).click();
    const field = notes.getByRole("textbox", { name: "Nome della materia Probabilità e statistica" });
    await expect(field).toBeFocused();
    await field.fill("Probabilità");
    await field.press("Enter");
    await expect(notes.locator(".px-source-row-meta")).toContainText("Probabilità");
    await expect(notes).not.toContainText("Materia nuova.");
    // Everything else that names the subject follows without a reload: the sidebar's chat says the new name.
    await expect(sidebarChat).toHaveText("Teorema di BayesProbabilità");
    const subjects = (await page.evaluate(() => window.pyxis.invoke("subjects.list", {}))).map((subject) => subject.name);
    expect(subjects.sort()).toEqual(["Analisi 1", "Fisica 2", "Probabilità"]);

    // A file is moved by hand from its row's menu.
    await page.getByRole("button", { name: "Azioni per Esercizi sui limiti" }).click();
    await page.getByRole("menuitem", { name: "Sposta in", exact: true }).hover();
    await page.getByRole("menuitem", { name: "Fisica 2" }).click();
    await expect(limits.locator(".px-source-row-meta")).toContainText("Fisica 2");
    // And into a subject it names there.
    await page.getByRole("button", { name: "Azioni per Esercizi sui limiti" }).click();
    await page.getByRole("menuitem", { name: "Sposta in", exact: true }).hover();
    await page.getByRole("menuitem", { name: "Nuova materia…" }).click();
    const named = page.getByRole("dialog", { name: "Sposta in una materia nuova" });
    await named.getByLabel("Nome della materia").fill("Analisi matematica");
    await named.getByRole("button", { name: "Sposta", exact: true }).click();
    await expect(named).toBeHidden();
    await expect(limits.locator(".px-source-row-meta")).toContainText("Analisi matematica");
    const listed = await page.evaluate(() => window.pyxis.invoke("sources.list", {}));
    expect(listed.map((source) => [source.title, source.subject, source.sort]).sort()).toEqual([
      ["Calcolo delle probabilita, dispense", "Probabilità", null],
      ["Esercizi sui limiti", "Analisi matematica", null],
    ]);
  } finally {
    await app.close();
    removeTestFolder(userData);
  }
});

test("Without an AI tool, files added from the Library wait in Da sistemare until the student chooses", async () => {
  test.setTimeout(180000);
  const { app, page, userData, files } = await start({ PYXIS_E2E_PLAN_REPLIES: undefined });
  try {
    await addFiles(app, page, [files.limits]);
    const group = page.getByRole("region", { name: "Da sistemare" });
    await expect(group).toBeVisible({ timeout: 60000 });
    await expect(group).toContainText(
      "Non hai collegato uno strumento AI, quindi la materia di questi file la scegli tu.",
    );
    await expect(group.getByRole("link", { name: "Collega uno strumento" })).toBeVisible();
    // Nothing was guessed: the file has no subject and waits in its own row there, not in the list below.
    await expect(group.locator(".px-source-row", { hasText: "Esercizi sui limiti" })).toBeVisible();
    await expect(row(page, "Esercizi sui limiti")).toHaveCount(0);
    await animationsSettled(page);
    await expectNoAxeViolations(page);
    await saveShot(page, "library-subjects/2-unsorted.png");
    await group.getByRole("combobox", { name: "Materia di Esercizi sui limiti" }).selectOption({ label: "Analisi 1" });
    await expect(group).toBeHidden();
    await expect(row(page, "Esercizi sui limiti").locator(".px-source-row-meta")).toContainText("Analisi 1");
  } finally {
    await app.close();
    removeTestFolder(userData);
  }
});
