import { expect, test, type ElectronApplication, type Locator, type Page } from "@playwright/test";
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
  await page.getByRole("button", { name: "Aggiungi file", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Scegli i file", exact: true }).click();
  if (paths.length > 1) {
    await expect(dialog.getByText(`${paths.length} file importati.`)).toBeVisible();
    await dialog.getByRole("button", { name: "Fatto", exact: true }).click();
  }
  await expect(dialog).toBeHidden();
}

const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** A subject's card on the Library page: a region named by the subject and its count. */
const shelf = (page: Page, subject: string) =>
  page.getByRole("region", { name: new RegExp(`^${escaped(subject)} (\\d+ file|nessun file)$`) });
/** A file's cover on a subject's shelf. */
const cover = (page: Page, subject: string, title: string) => shelf(page, subject).locator(".px-cover", { hasText: title });
/** The menu items Sposta in opens, from a menu that is open. */
async function moveTo(page: Page, subject: string) {
  await page.getByRole("menuitem", { name: "Sposta in", exact: true }).hover();
  await page.getByRole("menuitem", { name: subject, exact: true }).click();
}
const subjectNames = async (page: Page) =>
  (await page.evaluate(() => window.pyxis.invoke("subjects.list", {}))).map((subject) => subject.name).sort();

test("Files added from the Library go on the shelf of a subject the student has, or of a new one Pyxis says it made", async () => {
  test.setTimeout(240000);
  const { app, page, userData, files } = await start({ PYXIS_E2E_PLAN_REPLIES: replies });
  try {
    // The sidebar lists recent chats only while it is open, from 1100 CSS px; a smaller window folds it. The check on the
    // chat's subject below needs the open sidebar, so the page gets that width whatever the window is.
    await page.setViewportSize({ width: 1280, height: 800 });
    // Before any file, the Library says what goes in it.
    await expect(page.getByRole("heading", { name: "Nessuna fonte ancora" })).toBeVisible();
    await addFiles(app, page, [files.limits, files.notes]);
    // One lands in Analisi 1; the other in a subject made for it, whose card says it is new.
    await expect(cover(page, "Analisi 1", "Esercizi sui limiti")).toBeVisible({ timeout: 60000 });
    await expect(cover(page, "Probabilità e statistica", "Calcolo delle probabilita, dispense")).toBeVisible();
    await expect(shelf(page, "Probabilità e statistica")).toContainText(
      "Materia nuova. L'ho creata per questo file, perché non andava in nessuna delle altre.",
    );
    await expect(shelf(page, "Analisi 1")).not.toContainText("Materia nuova.");
    await expect(shelf(page, "Analisi 1")).toContainText("1 file");
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

    // The new subject is renamed in place, the note goes, and focus is back on the subject's dots.
    await shelf(page, "Probabilità e statistica").getByRole("button", { name: "Rinomina la materia Probabilità e statistica" }).click();
    const field = page.getByRole("textbox", { name: "Nome della materia Probabilità e statistica" });
    await expect(field).toBeFocused();
    await field.fill("Probabilità");
    await field.press("Enter");
    await expect(shelf(page, "Probabilità")).not.toContainText("Materia nuova.");
    await expect(page.getByRole("button", { name: "Azioni sulla materia Probabilità", exact: true })).toBeFocused();
    // Everything else that names the subject follows without a reload: the sidebar's chat says the new name.
    await expect(sidebarChat).toHaveText("Teorema di BayesProbabilità");
    expect(await subjectNames(page)).toEqual(["Analisi 1", "Fisica 2", "Probabilità"]);

    // A file is moved by its dots: its cover lands on the other shelf with focus, and a screen reader hears where.
    await page.getByRole("button", { name: "Azioni per Esercizi sui limiti" }).click();
    await moveTo(page, "Fisica 2");
    const limits = cover(page, "Fisica 2", "Esercizi sui limiti");
    await expect(limits).toBeVisible();
    await expect(limits.getByRole("button", { name: "Esercizi sui limiti", exact: true })).toBeFocused();
    await expect(page.getByRole("status").filter({ hasText: "Spostato in Fisica 2." })).toHaveCount(1);
    // The subject it left is an empty card that says how to fill it.
    await expect(shelf(page, "Analisi 1")).toContainText("nessun file");
    await expect(shelf(page, "Analisi 1")).toContainText("Ancora niente. Sposta qui un file dai suoi tre puntini.");
    // And by a right-click, into a subject it names there.
    await limits.click({ button: "right" });
    await page.getByRole("menuitem", { name: "Sposta in", exact: true }).hover();
    await page.getByRole("menuitem", { name: "Nuova materia…" }).click();
    const named = page.getByRole("dialog", { name: "Sposta in una materia nuova" });
    await named.getByLabel("Nome della materia").fill("Analisi matematica");
    await named.getByRole("button", { name: "Sposta", exact: true }).click();
    await expect(named).toBeHidden();
    await expect(cover(page, "Analisi matematica", "Esercizi sui limiti")).toBeVisible();
    const listed = await page.evaluate(() => window.pyxis.invoke("sources.list", {}));
    expect(listed.map((source) => [source.title, source.subject, source.sort]).sort()).toEqual([
      ["Calcolo delle probabilita, dispense", "Probabilità", null],
      ["Esercizi sui limiti", "Analisi matematica", null],
    ]);

    // Two subjects cannot share a name: the refusal sits next to the field, and Escape keeps the old name.
    await page.getByRole("button", { name: "Azioni sulla materia Fisica 2" }).click();
    await page.getByRole("menuitem", { name: "Rinomina", exact: true }).click();
    const rename = page.getByRole("textbox", { name: "Nome della materia Fisica 2" });
    await rename.fill("probabilità");
    await rename.press("Enter");
    await expect(shelf(page, "Fisica 2").getByRole("alert")).toHaveText("Esiste già una materia con questo nome.");
    await expect(rename).toHaveAttribute("aria-invalid", "true");
    await rename.press("Escape");
    await expect(page.getByRole("button", { name: "Azioni sulla materia Fisica 2" })).toBeFocused();
    expect(await subjectNames(page)).toEqual(["Analisi 1", "Analisi matematica", "Fisica 2", "Probabilità"]);

    // A subject with a file, or a chat, offers no delete.
    await page.getByRole("button", { name: "Azioni sulla materia Probabilità", exact: true }).click();
    await expect(page.getByRole("menuitem", { name: "Nuova mappa di questa materia" })).toBeVisible();
    await expect(page.getByRole("menuitem", { name: "Elimina la materia…" })).toHaveCount(0);
    await page.keyboard.press("Escape");
    // An empty one does, from a right-click on its name, and asks once with Annulla focused.
    await shelf(page, "Fisica 2").getByRole("heading", { name: "Fisica 2" }).click({ button: "right" });
    await page.getByRole("menuitem", { name: "Elimina la materia…" }).click();
    const confirm = page.getByRole("dialog", { name: "Eliminare la materia Fisica 2?" });
    await expect(confirm.getByRole("button", { name: "Annulla" })).toBeFocused();
    await animationsSettled(page);
    await expectNoAxeViolations(page);
    await saveShot(page, "library-subjects/2-delete.png");
    await confirm.getByRole("button", { name: "Elimina", exact: true }).click();
    await expect(shelf(page, "Fisica 2")).toHaveCount(0);
    expect(await subjectNames(page)).toEqual(["Analisi 1", "Analisi matematica", "Probabilità"]);

    // Search narrows the shelves to the files that match, and says when nothing does.
    const search = page.getByRole("textbox", { name: "Cerca una fonte per titolo" });
    await search.fill("limiti");
    await expect(cover(page, "Analisi matematica", "Esercizi sui limiti")).toBeVisible();
    await expect(shelf(page, "Probabilità")).toHaveCount(0);
    await expect(shelf(page, "Analisi 1")).toHaveCount(0);
    await search.fill("termodinamica");
    await expect(page.getByText("Nessuna fonte con questo filtro.")).toBeVisible();
    await search.fill("");
    await expect(shelf(page, "Analisi 1")).toBeVisible();
    // The type filter keeps the files of that type.
    await page.getByRole("combobox", { name: "Tipo" }).click();
    await page.locator(".ant-select-dropdown:visible .ant-select-item-option", { hasText: "Testo" }).click();
    await expect(cover(page, "Probabilità", "Calcolo delle probabilita, dispense")).toBeVisible();
    await expect(shelf(page, "Analisi 1")).toHaveCount(0);

    // A new map of a subject opens the new-map dialog with that subject chosen.
    await page.getByRole("combobox", { name: "Tipo" }).click();
    await page.locator(".ant-select-dropdown:visible .ant-select-item-option", { hasText: "Tutti i tipi" }).click();
    await page.getByRole("button", { name: "Azioni sulla materia Probabilità", exact: true }).click();
    await page.getByRole("menuitem", { name: "Nuova mappa di questa materia" }).click();
    await expect(page).toHaveURL(/#\/maps\?subject=/);
    const newMap = page.getByRole("dialog", { name: "Nuova mappa" });
    await expect(newMap).toBeVisible();
    await expect(newMap.getByText("Probabilità", { exact: true }).first()).toBeVisible();
    await expect(newMap.getByText("Scegli una materia", { exact: true })).toHaveCount(0);
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
    // Nothing was guessed: the file has no subject and waits in its own row there, on no shelf.
    await expect(group.locator(".px-unsorted-row", { hasText: "Esercizi sui limiti" })).toBeVisible();
    await expect(page.locator(".px-cover", { hasText: "Esercizi sui limiti" })).toHaveCount(0);
    await animationsSettled(page);
    await expectNoAxeViolations(page);
    await saveShot(page, "library-subjects/3-unsorted.png");
    // Its menu, by a right-click on the row, offers Sposta in like a cover's.
    await group.locator(".px-unsorted-row", { hasText: "Esercizi sui limiti" }).click({ button: "right", position: { x: 30, y: 30 } });
    await expect(page.getByRole("menuitem", { name: "Sposta in", exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    await group.getByRole("combobox", { name: "Materia di Esercizi sui limiti" }).selectOption({ label: "Analisi 1" });
    await expect(group).toBeHidden();
    // The row leaves, the file lands on its shelf, and focus goes with it.
    await expect(
      cover(page, "Analisi 1", "Esercizi sui limiti").getByRole("button", { name: "Esercizi sui limiti", exact: true }),
    ).toBeFocused();
  } finally {
    await app.close();
    removeTestFolder(userData);
  }
});

/**
 * Runs a spec with the request to choose subjects failing (`PYXIS_E2E_SORT_FAILS`). An add must end as if nothing had
 * gone wrong: the dialog closes as for any clean import and the new source is listed, waiting in "Da sistemare".
 */
async function withFailingSort(
  run: (context: {
    app: ElectronApplication;
    page: Page;
    files: ReturnType<typeof studyFiles>;
    open: (tab?: string) => Promise<Locator>;
    waiting: (title: string | RegExp) => Locator;
  }) => Promise<void>,
) {
  test.setTimeout(180000);
  const { app, page, userData, files } = await start({ PYXIS_E2E_PLAN_REPLIES: undefined, PYXIS_E2E_SORT_FAILS: "1" });
  try {
    const open = async (tab?: string) => {
      await page.getByRole("button", { name: "Aggiungi file", exact: true }).click();
      const dialog = page.getByRole("dialog");
      await expect(dialog).toBeVisible();
      await animationsSettled(page);
      if (tab) await dialog.getByRole("radio", { name: tab }).locator("..").click();
      return dialog;
    };
    const waiting = (title: string | RegExp) =>
      page.getByRole("region", { name: "Da sistemare" }).locator(".px-unsorted-row", { hasText: title });
    await run({ app, page, files, open, waiting });
  } finally {
    await app.close();
    removeTestFolder(userData);
  }
}

test("A failed request to choose subjects leaves a file from the picker imported and listed", async () => {
  await withFailingSort(async ({ app, files, open, waiting }) => {
    await answerPicker(app, [files.limits]);
    const dialog = await open();
    await dialog.getByRole("button", { name: "Scegli i file", exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(waiting("Esercizi sui limiti")).toBeVisible();
  });
});

test("A failed request to choose subjects leaves pasted text imported and listed", async () => {
  await withFailingSort(async ({ open, waiting }) => {
    const dialog = await open("Testo");
    await dialog.getByRole("textbox", { name: "Titolo" }).fill("Probabilità");
    await dialog
      .getByRole("textbox", { name: "Incolla gli appunti" })
      .fill("La probabilità condizionata di A dato B è il rapporto tra P(A e B) e P(B). ".repeat(25));
    await dialog.getByRole("button", { name: "Incolla gli appunti" }).click();
    await expect(dialog).toBeHidden();
    await expect(waiting("Probabilità")).toBeVisible();
  });
});
