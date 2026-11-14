import { expect, test, type ElectronApplication, type Locator, type Page } from "@playwright/test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchPyxis } from "./app-under-test";
import { expectNoAxeViolations } from "./axe";
import { removeTestFolder } from "./cleanup";
import { fromChiediToExams, toLibrary } from "./doors";
import { openBox, trackEvents, withTrail } from "./event-trail";
import { animationsSettled, atRest } from "./settled";
import { saveShot } from "./shots";
import { seedSource, seedSubjects } from "./seed";

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
    await expect(page.getByText(/^Qui compariranno i tuoi file/)).toBeVisible();
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
    // The type filter keeps the files of that kind.
    await page.getByRole("combobox", { name: "Tipo" }).click();
    await page.locator(".ant-select-dropdown:visible .ant-select-item-option", { hasText: "Dispensa" }).click();
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

/** Pastes plain notes with no subject, so they wait in "Da sistemare" (no AI tool is connected in these specs). */
async function pasteLoose(page: Page, title: string): Promise<string> {
  const { sourceId } = await page.evaluate(
    (title) =>
      window.pyxis.invoke("sources.paste", {
        title,
        text: `${title}: la probabilità condizionata di A dato B è il rapporto tra P(A e B) e P(B).\n\n`.repeat(20),
      }),
    title,
  );
  return sourceId;
}

/**
 * Sixteen files on the way to Analisi 1's shelf: fifteen that sort before "Zeta" and "Zulu" (the shelf shows fourteen, so a
 * moved file lands behind the button), and "Zeta" and "Zulu" waiting in "Da sistemare". The files are written to the
 * database, so a spec decides whether "Zeta" is still being read when it moves, and when its read ends.
 */
async function seedFullShelf(page: Page, userData: string, zeta: "ready" | "extracting") {
  const analysis = (await page.evaluate(() => window.pyxis.invoke("subjects.list", {}))).find(
    (subject) => subject.name === "Analisi 1",
  )!;
  const db = new DatabaseSync(join(userData, "workspace", "pyxis.db"), { timeout: 10_000 });
  for (let n = 1; n <= 15; n++)
    seedSource(db, { id: `appunti-${n}`, title: `Appunti ${String(n).padStart(2, "0")}`, subjectId: analysis.id });
  seedSource(db, { id: "zeta", title: "Zeta", status: zeta });
  seedSource(db, { id: "zulu", title: "Zulu" });
  db.close();
  await page.reload();
}

/** Ends the read of "Zeta" in the database and has the page read its files again, as a finished job does. */
async function finishReading(page: Page, userData: string) {
  const db = new DatabaseSync(join(userData, "workspace", "pyxis.db"), { timeout: 10_000 });
  db.prepare("UPDATE sources SET status = 'ready' WHERE id = 'zeta'").run();
  db.close();
  // The import of another file ends with an update that makes the page read its files again.
  await pasteLoose(page, "Sonda");
}

for (const zeta of ["ready", "extracting"] as const) {
  test(
    zeta === "ready"
      ? 'A file moved behind "Mostra tutti" shows where it went and keeps the keyboard\'s place'
      : "A file moved while it is still being read shows where it went, and stays there when its read ends",
    async () => {
      test.setTimeout(240000);
      const { app, page, userData } = await start({ PYXIS_E2E_PLAN_REPLIES: undefined });
      try {
        await page.setViewportSize({ width: 1280, height: 900 });
        await seedFullShelf(page, userData, zeta);
        const group = page.getByRole("region", { name: "Da sistemare" });
        await expect(group.locator(".px-unsorted-row")).toHaveCount(2);
        await expect(shelf(page, "Analisi 1").locator(".px-cover")).toHaveCount(14);

        // Chosen in "Da sistemare": the shelf opens so the cover is there, and focus goes to the next row's choice.
        await group.getByRole("combobox", { name: "Materia di Zeta" }).selectOption({ label: "Analisi 1" });
        await expect(cover(page, "Analisi 1", "Zeta")).toBeVisible();
        await expect(shelf(page, "Analisi 1").locator(".px-cover")).toHaveCount(16);
        await expect(group.getByRole("combobox", { name: "Materia di Zulu" })).toBeFocused();

        if (zeta === "extracting") {
          // Its read ends: by title it now sorts behind the fourteen, and the shelf must not fold it away.
          await expect(cover(page, "Analisi 1", "Zeta")).toContainText("Lettura");
          await finishReading(page, userData);
          await expect(cover(page, "Analisi 1", "Zeta")).not.toContainText("Lettura");
          await expect(cover(page, "Analisi 1", "Zeta")).toBeVisible();
          await expect(shelf(page, "Analisi 1").locator(".px-cover")).toHaveCount(16);
          return;
        }

        // By the file's menu, with the shelf folded again: the cover is shown and takes focus.
        await shelf(page, "Analisi 1").getByRole("button", { name: "Mostra meno" }).click();
        await expect(shelf(page, "Analisi 1").locator(".px-cover")).toHaveCount(14);
        await page.getByRole("button", { name: "Azioni per Zulu" }).click();
        await moveTo(page, "Analisi 1");
        const zulu = cover(page, "Analisi 1", "Zulu");
        await expect(zulu).toBeVisible();
        await expect(zulu.getByRole("button", { name: "Zulu", exact: true })).toBeFocused();
        await expect(group).toBeHidden();
      } finally {
        await app.close();
        removeTestFolder(userData);
      }
    },
  );
}

test("A file moved from its menu while it is still being read shows where it went, and stays there when its read ends", async () => {
  test.setTimeout(240000);
  const { app, page, userData } = await start({ PYXIS_E2E_PLAN_REPLIES: undefined });
  try {
    await page.setViewportSize({ width: 1280, height: 900 });
    await seedFullShelf(page, userData, "extracting");
    await expect(shelf(page, "Analisi 1").locator(".px-cover")).toHaveCount(14);
    await page.getByRole("button", { name: "Azioni per Zeta" }).click();
    await moveTo(page, "Analisi 1");
    const zeta = cover(page, "Analisi 1", "Zeta");
    await expect(zeta).toBeVisible();
    await expect(shelf(page, "Analisi 1").locator(".px-cover")).toHaveCount(16);
    await finishReading(page, userData);
    await expect(zeta).not.toContainText("Lettura");
    await expect(zeta).toBeVisible();
    await expect(shelf(page, "Analisi 1").locator(".px-cover")).toHaveCount(16);
  } finally {
    await app.close();
    removeTestFolder(userData);
  }
});

test("A double-click on a subject's name renames it in place with the name selected, like Rinomina", async () => {
  test.setTimeout(120000);
  const { app, page, userData } = await start({ PYXIS_E2E_PLAN_REPLIES: undefined });
  try {
    const name = shelf(page, "Fisica 2").getByRole("heading", { level: 2, name: "Fisica 2" });
    await name.dblclick();
    const field = page.getByRole("textbox", { name: "Nome della materia Fisica 2" });
    await expect(field).toBeFocused();
    await expect(field).toHaveValue("Fisica 2");
    // The whole name is selected, so typing replaces it.
    expect(await field.evaluate((input: HTMLInputElement) => input.value.slice(input.selectionStart!, input.selectionEnd!))).toBe("Fisica 2");
    await field.fill("Fisica generale");
    await field.press("Enter");
    await expect(shelf(page, "Fisica generale").getByRole("heading", { level: 2, name: "Fisica generale" })).toBeVisible();
    expect(await subjectNames(page)).toEqual(["Analisi 1", "Fisica generale"]);
    // Escape leaves the name as it was, and a double-click on the field itself only selects a word in it.
    await shelf(page, "Fisica generale").getByRole("heading", { level: 2 }).dblclick();
    const again = page.getByRole("textbox", { name: "Nome della materia Fisica generale" });
    await again.dblclick();
    await expect(again).toBeFocused();
    await again.press("Escape");
    await expect(page.getByRole("textbox", { name: /^Nome della materia/ })).toHaveCount(0);
    await expect(shelf(page, "Fisica generale")).toBeVisible();
  } finally {
    await app.close();
    removeTestFolder(userData);
  }
});

test("A subject offers its delete as soon as its last file is removed", async () => {
  test.setTimeout(180000);
  const { app, page, userData } = await start({ PYXIS_E2E_PLAN_REPLIES: undefined });
  try {
    const physics = (await page.evaluate(() => window.pyxis.invoke("subjects.list", {}))).find(
      (subject) => subject.name === "Fisica 2",
    )!;
    const id = await pasteLoose(page, "Dinamica");
    await page.evaluate(({ id, subjectId }) => window.pyxis.invoke("sources.move", { sourceId: id, subjectId }), {
      id,
      subjectId: physics.id,
    });
    // Another file keeps the Library from showing its empty page once Dinamica is gone.
    const other = await pasteLoose(page, "Limiti");
    await page.evaluate(({ id, subjectId }) => window.pyxis.invoke("sources.move", { sourceId: id, subjectId }), {
      id: other,
      subjectId: (await page.evaluate(() => window.pyxis.invoke("subjects.list", {}))).find(
        (subject) => subject.name === "Analisi 1",
      )!.id,
    });
    // The page reads the subjects again, as when the student opens it with the file already there.
    await page.reload();
    await expect(cover(page, "Fisica 2", "Dinamica")).toBeVisible();
    // With a file the subject cannot be deleted.
    await page.getByRole("button", { name: "Azioni sulla materia Fisica 2" }).click();
    await expect(page.getByRole("menuitem", { name: "Rinomina", exact: true })).toBeVisible();
    await expect(page.getByRole("menuitem", { name: "Elimina la materia…" })).toHaveCount(0);
    await page.keyboard.press("Escape");
    // The file goes; the page is not reopened, and the delete is there.
    page.once("dialog", (dialog) => void dialog.accept());
    await page.getByRole("button", { name: "Azioni per Dinamica" }).click();
    await page.getByRole("menuitem", { name: "Rimuovi", exact: true }).click();
    await expect(shelf(page, "Fisica 2")).toContainText("nessun file");
    await page.getByRole("button", { name: "Azioni sulla materia Fisica 2" }).click();
    await expect(page.getByRole("menuitem", { name: "Elimina la materia…" })).toBeVisible();
  } finally {
    await app.close();
    removeTestFolder(userData);
  }
});

/** How far a point is from a box, in px: 0 inside it. */
const gap = (box: { x: number; y: number; width: number; height: number }, at: { x: number; y: number }) =>
  Math.hypot(Math.max(box.x - at.x, 0, at.x - (box.x + box.width)), Math.max(box.y - at.y, 0, at.y - (box.y + box.height)));

/**
 * How a menu opened by its dots sits against them: the distance between their right edges, and between the menu and the
 * dots' bottom (or top, when the menu opens above them). A menu that hangs from its dots has its right edge on theirs
 * and the dropdown's offset, 4 px, between them.
 */
const hangsFrom = async (menu: Locator, dots: Locator) => {
  const box = (await menu.boundingBox())!;
  const from = (await dots.boundingBox())!;
  const below = box.y >= from.y;
  return {
    edges: Math.round(box.x + box.width - (from.x + from.width)),
    offset: Math.round(below ? box.y - (from.y + from.height) : from.y - (box.y + box.height)),
  };
};
const HANGS = { edges: 0, offset: 4 };

/** The menu that is open: the one with `item`, whatever the page scrolled or did while it opened. */
const openMenu = (page: Page, item: string) =>
  page.locator(".ant-dropdown:not(.ant-dropdown-hidden)").filter({ has: page.getByRole("menuitem", { name: item, exact: true }) });

test("At 960 px a file's and a subject's menu open at the dots or the pointer after the page scrolled, only their owner looks hovered, and a scroll or a resize ends them but a layout shift does not", async () => {
  test.setTimeout(240000);
  const { app, page, userData } = await start({ PYXIS_E2E_PLAN_REPLIES: undefined });
  try {
    await trackEvents(page);
    await page.setViewportSize({ width: 960, height: 900 });
    for (const name of ["Chimica", "Geometria", "Algebra", "Statistica"])
      await page.evaluate((name) => window.pyxis.invoke("subjects.add", { name }), name);
    const subjects = await page.evaluate(() => window.pyxis.invoke("subjects.list", {}));
    const idOf = (name: string) => subjects.find((subject) => subject.name === name)!.id;
    // Six shelves and some files with no subject, so the page is taller than the window.
    for (const [subject, titles] of [
      ["Analisi 1", ["Limiti", "Derivate", "Integrali", "Serie", "Successioni", "Funzioni"]],
      ["Fisica 2", ["Dinamica", "Cinematica", "Circuiti", "Ottica", "Onde", "Termologia"]],
      ["Chimica", ["Legami", "Reazioni"]],
      ["Geometria", ["Vettori", "Matrici"]],
      ["Algebra", ["Gruppi", "Anelli"]],
      ["Statistica", ["Medie", "Varianza"]],
    ] as const)
      for (const title of titles) {
        const id = await pasteLoose(page, title);
        await page.evaluate(({ id, subjectId }) => window.pyxis.invoke("sources.move", { sourceId: id, subjectId }), {
          id,
          subjectId: idOf(subject),
        });
      }
    for (const title of ["Appunti sciolti", "Esercizi sciolti", "Lezione sciolta"]) await pasteLoose(page, title);
    await expect(cover(page, "Fisica 2", "Termologia")).toBeVisible();
    await animationsSettled(page);

    // Scrolls the page the way a student does, and says how far it went.
    const scrolled = async () => {
      await page.mouse.move(480, 450);
      await page.mouse.wheel(0, 260);
      await expect
        .poll(() =>
          page.evaluate(() => {
            for (let el: Element | null = document.querySelector(".px-shelves"); el; el = el.parentElement)
              if (el.scrollTop > 0) return el.scrollTop;
            return 0;
          }),
        )
        .toBeGreaterThan(100);
      await animationsSettled(page);
    };
    await scrolled();

    /** The files whose cover has the hover fill, and the dots, rows and cards that show their hover look. */
    const hovered = () =>
      page.evaluate(() =>
        [...document.querySelectorAll<HTMLElement>(".px-cover")]
          .filter((el) => getComputedStyle(el.querySelector(".px-cover-open")!).backgroundColor !== "rgba(0, 0, 0, 0)")
          .map((el) => el.dataset["sourceId"]),
      );
    /** Fails when the menu is off the window or far from where it was asked, or when a cover but the owner looks hovered. */
    const expectMenuAt = async (menu: Locator, at: { x: number; y: number }, owner: string | null, shot: string) => {
      await withTrail(page, () => expect(menu).toBeVisible());
      await animationsSettled(page);
      const box = (await menu.boundingBox())!;
      const view = page.viewportSize()!;
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.y).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(view.width);
      expect(box.y + box.height).toBeLessThanOrEqual(view.height);
      expect(gap(box, at), `menu ${JSON.stringify(box)} for ${JSON.stringify(at)}`).toBeLessThan(40);
      await expect.poll(hovered).toEqual(owner ? [owner] : []);
      await saveShot(page, shot);
    };
    const centre = (box: { x: number; y: number; width: number; height: number }) => ({
      x: box.x + box.width / 2,
      y: box.y + box.height / 2,
    });
    /** Where the pointer rests between steps: in the gutter, over no cover. */
    const rest = () => page.mouse.move(930, 450);
    const sourceId = async (item: Locator) => (await item.getAttribute("data-source-id"))!;
    const fileMenu = openMenu(page, "Dettagli della fonte");
    const subjectMenu = openMenu(page, "Nuova mappa di questa materia");

    // A file's menu by its dots.
    const target = cover(page, "Analisi 1", "Integrali");
    await target.scrollIntoViewIfNeeded();
    // The page's own scrolls, the wheel's and this one, have stopped: a menu closes on a scroll that moves its item, and
    // on an Intel Mac this menu opened and was gone.
    await atRest(target);
    await target.hover();
    const dots = page.getByRole("button", { name: "Azioni per Integrali" });
    await expect(dots).toBeVisible();
    await dots.click();
    await expectMenuAt(fileMenu, centre((await dots.boundingBox())!), await sourceId(target), "library-menu/960-file-dots.png");
    // Sposta in opens beside the menu, inside the window.
    await page.getByRole("menuitem", { name: "Sposta in", exact: true }).hover();
    const sub = page.locator(".ant-dropdown-menu-submenu-popup:not(.ant-dropdown-menu-submenu-hidden)").filter({
      has: page.getByRole("menuitem", { name: "Fisica 2", exact: true }),
    });
    await expect(sub).toBeVisible();
    await animationsSettled(page);
    const parent = await openBox(fileMenu, page, "The file's menu, with its submenu shown a moment ago,");
    const child = (await sub.boundingBox())!;
    expect(child.x).toBeGreaterThanOrEqual(0);
    expect(child.x + child.width).toBeLessThanOrEqual(960);
    expect(child.y + child.height).toBeLessThanOrEqual(900);
    expect(gap(parent, { x: child.x, y: child.y + 10 })).toBeLessThan(24);
    await saveShot(page, "library-menu/960-file-move.png");
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
    await expect(fileMenu).toHaveCount(0);

    // By a right-click, at the pointer.
    const second = cover(page, "Fisica 2", "Onde");
    await second.scrollIntoViewIfNeeded();
    await atRest(second);
    const at = centre((await second.boundingBox())!);
    await page.mouse.click(at.x, at.y, { button: "right" });
    await expectMenuAt(fileMenu, at, await sourceId(second), "library-menu/960-file-right-click.png");
    await page.keyboard.press("Escape");
    await expect(fileMenu).toHaveCount(0);

    // By the keyboard: Shift+F10 on the cover that has focus.
    await rest();
    const third = cover(page, "Fisica 2", "Ottica");
    await third.scrollIntoViewIfNeeded();
    await atRest(third);
    await third.getByRole("button", { name: "Ottica", exact: true }).focus();
    await page.keyboard.press("Shift+F10");
    const focusedBox = (await third.getByRole("button", { name: "Ottica", exact: true }).boundingBox())!;
    await expectMenuAt(fileMenu, { x: focusedBox.x + 8, y: focusedBox.y + focusedBox.height }, await sourceId(third), "library-menu/960-file-key.png");
    await page.keyboard.press("Escape");
    await expect(third.getByRole("button", { name: "Ottica", exact: true })).toBeFocused();

    // A subject's menu, by its dots, by a right-click on its name and by the keyboard.
    await rest();
    const subjectDots = page.getByRole("button", { name: "Azioni sulla materia Fisica 2" });
    await subjectDots.scrollIntoViewIfNeeded();
    await atRest(subjectDots);
    await subjectDots.click();
    await expectMenuAt(subjectMenu, centre((await subjectDots.boundingBox())!), null, "library-menu/960-subject-dots.png");
    await page.keyboard.press("Escape");
    await expect(subjectMenu).toHaveCount(0);
    const heading = shelf(page, "Analisi 1").getByRole("heading", { name: "Analisi 1" });
    await heading.scrollIntoViewIfNeeded();
    await atRest(heading);
    const headAt = centre((await heading.boundingBox())!);
    await page.mouse.click(headAt.x, headAt.y, { button: "right" });
    await expectMenuAt(subjectMenu, headAt, null, "library-menu/960-subject-right-click.png");
    await page.keyboard.press("Escape");
    await expect(subjectMenu).toHaveCount(0);
    await rest();
    const keyDots = page.getByRole("button", { name: "Azioni sulla materia Analisi 1" });
    await keyDots.focus();
    await page.keyboard.press("Shift+F10");
    const keyBox = (await keyDots.boundingBox())!;
    await expectMenuAt(subjectMenu, { x: keyBox.x + 8, y: keyBox.y + keyBox.height }, null, "library-menu/960-subject-key.png");
    await page.keyboard.press("Escape");
    await expect(subjectMenu).toHaveCount(0);

    // A menu ends the way a desktop menu does. Scrolling the page closes it, by the dots or by a right-click. A layout
    // shift (a group appearing above the shelves) does not: a right-click menu stays at the pointer, and the one opened
    // by the dots follows them. Resizing the window closes a right-click menu, and the dots' menu follows them.
    for (const way of ["dots", "right-click"] as const) {
      /** Opens the menu of "Serie" by its dots or by a right-click at its centre. */
      const open = async () => {
        const file = cover(page, "Analisi 1", "Serie");
        await file.scrollIntoViewIfNeeded();
        // After this scroll, the wheel's and the window's last resize, which closes a right-click menu.
        await atRest(file);
        if (way === "dots") {
          await file.hover();
          await page.getByRole("button", { name: "Azioni per Serie" }).click();
        } else {
          const from = centre((await file.boundingBox())!);
          await page.mouse.click(from.x, from.y, { button: "right" });
        }
        await expect(fileMenu).toBeVisible();
        await animationsSettled(page);
      };
      await open();
      await page.mouse.move(480, 450);
      await page.mouse.wheel(0, -200);
      await expect(fileMenu, `${way} menu after a scroll`).toHaveCount(0);
      await rest();

      await open();
      const before = (await fileMenu.boundingBox())!;
      await rest();
      await page.evaluate(() => {
        const spacer = document.createElement("div");
        spacer.id = "e2e-spacer";
        spacer.style.height = "180px";
        document.querySelector(".px-shelves")!.prepend(spacer);
      });
      // The cover moved down, and the menu is still open and still acts on it.
      await expect
        .poll(async () => (await page.getByRole("button", { name: "Azioni per Serie" }).boundingBox())?.y)
        .toBeGreaterThan(0);
      await animationsSettled(page);
      await expect(fileMenu, `${way} menu after a layout shift`).toBeVisible();
      const after = (await fileMenu.boundingBox())!;
      if (way === "dots") {
        // The menu follows its dots a frame after they move.
        await expect
          .poll(() => hangsFrom(fileMenu, page.getByRole("button", { name: "Azioni per Serie" })), "follows its dots")
          .toEqual(HANGS);
        expect((await fileMenu.boundingBox())!.y).not.toBeCloseTo(before.y, 0);
      } else expect(after).toEqual(before);
      // The owner keeps its hover look while its menu is open, and nothing else has it.
      await expect.poll(hovered).toEqual([await sourceId(cover(page, "Analisi 1", "Serie"))]);
      await page.evaluate(() => document.getElementById("e2e-spacer")?.remove());
      await expect(fileMenu).toBeVisible();

      await page.setViewportSize({ width: 900, height: 900 });
      if (way === "right-click") await expect(fileMenu, "right-click menu after a resize").toHaveCount(0);
      else {
        await expect(fileMenu, "dots menu after a resize").toBeVisible();
        await expect
          .poll(() => hangsFrom(fileMenu, page.getByRole("button", { name: "Azioni per Serie" })), "follows its dots")
          .toEqual(HANGS);
      }
      await page.setViewportSize({ width: 960, height: 900 });
      await page.keyboard.press("Escape");
      await expect(fileMenu).toHaveCount(0);
      await rest();
    }
  } finally {
    await app.close();
    removeTestFolder(userData);
  }
});

test("A menu stays open when the page gets shorter under a student who has scrolled to its end, which scrolls the page back without their hand", async () => {
  test.setTimeout(240000);
  const { app, page, userData } = await start({ PYXIS_E2E_PLAN_REPLIES: undefined });
  try {
    await trackEvents(page);
    await page.setViewportSize({ width: 960, height: 900 });
    for (const [subject, titles] of [
      ["Analisi 1", ["Limiti", "Derivate", "Integrali", "Serie", "Successioni", "Funzioni"]],
      ["Fisica 2", ["Dinamica", "Cinematica", "Circuiti", "Ottica", "Onde", "Termologia"]],
    ] as const)
      for (const title of titles) await fileUnder(page, title, subject);
    for (const title of ["Appunti sciolti", "Esercizi sciolti", "Lezione sciolta"]) await pasteLoose(page, title);
    await expect(cover(page, "Fisica 2", "Termologia")).toBeVisible();
    await animationsSettled(page);
    // Something taller than the window under the last shelf, as a row of files still being read is, so the page scrolls.
    await page.evaluate(() => {
      const below = document.createElement("div");
      below.id = "e2e-below";
      below.style.height = "400px";
      document.querySelector(".px-shelves")!.append(below);
    });
    /** How far the page that holds the shelves is scrolled, and how far it can go. */
    const place = () =>
      page.evaluate(() => {
        let scroller: Element = document.scrollingElement!;
        for (let el = document.querySelector(".px-shelves")?.parentElement; el; el = el.parentElement)
          if (el.scrollHeight > el.clientHeight && getComputedStyle(el).overflowY !== "visible") {
            scroller = el;
            break;
          }
        return { top: Math.round(scroller.scrollTop), end: Math.round(scroller.scrollHeight - scroller.clientHeight) };
      });
    const hovered = () =>
      page.evaluate(() =>
        [...document.querySelectorAll<HTMLElement>(".px-cover")]
          .filter((el) => getComputedStyle(el.querySelector(".px-cover-open")!).backgroundColor !== "rgba(0, 0, 0, 0)")
          .map((el) => el.dataset["sourceId"]),
      );
    const fileMenu = openMenu(page, "Dettagli della fonte");

    for (const way of ["dots", "right-click"] as const) {
      // The student scrolls to the end of the page with the wheel.
      await page.mouse.move(930, 450);
      await expect
        .poll(async () => {
          await page.mouse.wheel(0, 600);
          const { top, end } = await place();
          return end > 0 && top === end;
        })
        .toBe(true);
      const file = cover(page, "Fisica 2", "Termologia");
      await atRest(file);
      const owner = (await file.getAttribute("data-source-id"))!;
      if (way === "dots") {
        await file.hover();
        await page.getByRole("button", { name: "Azioni per Termologia" }).click();
      } else {
        const box = (await file.boundingBox())!;
        await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: "right" });
      }
      await expect(fileMenu, `${way} menu at the end of the page`).toBeVisible();
      await animationsSettled(page);
      await page.mouse.move(930, 450);
      const before = (await fileMenu.boundingBox())!;
      const scrollBefore = await place();

      // The page gets shorter below the file, so the browser scrolls it back by itself and the file moves down.
      await page.evaluate(() => document.getElementById("e2e-below")!.remove());
      await expect.poll(async () => (await place()).top, "the page scrolled back").toBeLessThan(scrollBefore.top);
      await animationsSettled(page);
      await withTrail(page, () => expect(fileMenu, `${way} menu after the page got shorter`).toBeVisible());
      if (way === "dots") {
        await expect
          .poll(() => hangsFrom(fileMenu, page.getByRole("button", { name: "Azioni per Termologia" })), "follows its dots")
          .toEqual(HANGS);
      } else expect(await fileMenu.boundingBox()).toEqual(before);
      await expect.poll(hovered).toEqual([owner]);

      // A scroll of the student's still ends it, from where the file is now.
      await page.mouse.wheel(0, -200);
      await expect(fileMenu, `${way} menu after a scroll`).toHaveCount(0);

      // The same page again for the other way.
      await page.evaluate(() => {
        const below = document.createElement("div");
        below.id = "e2e-below";
        below.style.height = "400px";
        document.querySelector(".px-shelves")!.append(below);
      });
    }
  } finally {
    await app.close();
    removeTestFolder(userData);
  }
});

/** Gives a file a subject by name, without the page's own menus. */
async function fileUnder(page: Page, title: string, subject: string): Promise<string> {
  const id = await pasteLoose(page, title);
  const subjectId = (await page.evaluate(() => window.pyxis.invoke("subjects.list", {}))).find((item) => item.name === subject)!.id;
  await page.evaluate(({ id, subjectId }) => window.pyxis.invoke("sources.move", { sourceId: id, subjectId }), { id, subjectId });
  return id;
}

test("A menu stays open and acts on its own file while the page changes under it", async () => {
  test.setTimeout(240000);
  const { app, page, userData } = await start({ PYXIS_E2E_PLAN_REPLIES: undefined });
  try {
    await page.setViewportSize({ width: 1280, height: 900 });
    for (const title of ["Limiti", "Derivate"]) await fileUnder(page, title, "Analisi 1");
    await page.reload();
    await expect(cover(page, "Analisi 1", "Derivate")).toBeVisible();
    await expect(page.getByRole("region", { name: "Da sistemare" })).toHaveCount(0);

    // A file arrives while the menu is open: the group "Da sistemare" appears above the shelves and pushes them down, and
    // Pyxis reads the new file. The menu stays, and its action still reaches the file it was opened on.
    for (const [way, title, arrives] of [
      ["right-click", "Limiti", "Appunti sciolti"],
      ["dots", "Derivate", "Esercizi sciolti"],
    ] as const) {
      const file = cover(page, "Analisi 1", title);
      const top = (await file.boundingBox())!.y;
      if (way === "dots") {
        await file.hover();
        await page.getByRole("button", { name: `Azioni per ${title}` }).click();
      } else {
        const box = (await file.boundingBox())!;
        await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: "right" });
      }
      const menu = openMenu(page, "Dettagli della fonte");
      await expect(menu).toBeVisible();
      await page.mouse.move(1200, 60);
      await pasteLoose(page, arrives);
      await expect(page.getByRole("region", { name: "Da sistemare" }).locator(".px-unsorted-row", { hasText: arrives })).toBeVisible();
      await expect.poll(async () => (await file.boundingBox())!.y, `the page shifted under the ${way} menu`).toBeGreaterThan(top + 20);
      await animationsSettled(page);
      await expect(menu, `${way} menu after a file arrived`).toBeVisible();
      await moveTo(page, "Fisica 2");
      await expect(cover(page, "Fisica 2", title)).toBeVisible();
      await expect(cover(page, "Analisi 1", title)).toHaveCount(0);
      await expect(page.getByRole("region", { name: "Da sistemare" }).locator(".px-unsorted-row")).not.toHaveCount(0);
    }
    const titles = (await page.evaluate(() => window.pyxis.invoke("sources.list", {}))).map((source) => `${source.title}:${source.subject}`).sort();
    expect(titles).toEqual(["Appunti sciolti:null", "Derivate:Fisica 2", "Esercizi sciolti:null", "Limiti:Fisica 2"]);
  } finally {
    await app.close();
    removeTestFolder(userData);
  }
});

test("A menu closes when its file, row or subject goes away, and nothing acts on what is gone", async () => {
  test.setTimeout(240000);
  const { app, page, userData } = await start({ PYXIS_E2E_PLAN_REPLIES: undefined });
  try {
    await page.setViewportSize({ width: 1280, height: 900 });
    const derivate = await fileUnder(page, "Derivate", "Analisi 1");
    await fileUnder(page, "Integrali", "Analisi 1");
    await fileUnder(page, "Limiti", "Analisi 1");
    const loose = await pasteLoose(page, "Appunti sciolti");
    await page.reload();
    const group = page.getByRole("region", { name: "Da sistemare" });
    await expect(group.locator(".px-unsorted-row", { hasText: "Appunti sciolti" })).toBeVisible();
    const analysis = shelf(page, "Analisi 1");
    // A file added later makes the page read the library again, as a finished import does.
    let arrivals = 0;
    const refreshed = async () => {
      const title = `Arrivo ${++arrivals}`;
      await pasteLoose(page, title);
      await expect(group.locator(".px-unsorted-row", { hasText: title })).toBeVisible();
    };
    const sources = () => page.evaluate(() => window.pyxis.invoke("sources.list", {}));

    // A cover removed under its right-click menu: the menu goes, and the menu's action cannot reach the file.
    const box = (await cover(page, "Analisi 1", "Derivate").boundingBox())!;
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: "right" });
    await expect(openMenu(page, "Dettagli della fonte")).toBeVisible();
    await page.evaluate((sourceId) => window.pyxis.invoke("sources.remove", { sourceId, confirmed: true }), derivate);
    await refreshed();
    await expect(cover(page, "Analisi 1", "Derivate")).toHaveCount(0);
    await expect(page.locator(".ant-dropdown:not(.ant-dropdown-hidden)")).toHaveCount(0);
    expect((await sources()).map((source) => source.title)).not.toContain("Derivate");

    // The same by the keyboard: focus goes to the next cover.
    await analysis.getByRole("button", { name: "Integrali", exact: true }).focus();
    await page.keyboard.press("Shift+F10");
    await expect(openMenu(page, "Dettagli della fonte")).toBeVisible();
    const integrali = (await sources()).find((source) => source.title === "Integrali")!.id;
    await page.evaluate((sourceId) => window.pyxis.invoke("sources.remove", { sourceId, confirmed: true }), integrali);
    await refreshed();
    await expect(cover(page, "Analisi 1", "Integrali")).toHaveCount(0);
    await expect(page.locator(".ant-dropdown:not(.ant-dropdown-hidden)")).toHaveCount(0);
    await expect(analysis.getByRole("button", { name: "Limiti", exact: true })).toBeFocused();

    // A row that leaves "Da sistemare" because the file was given a subject somewhere else.
    const row = group.locator(".px-unsorted-row", { hasText: "Appunti sciolti" });
    const at = (await row.boundingBox())!;
    await page.mouse.click(at.x + 80, at.y + at.height / 2, { button: "right" });
    await expect(openMenu(page, "Dettagli della fonte")).toBeVisible();
    const physics = (await page.evaluate(() => window.pyxis.invoke("subjects.list", {}))).find((item) => item.name === "Fisica 2")!;
    await page.evaluate(({ sourceId, subjectId }) => window.pyxis.invoke("sources.move", { sourceId, subjectId }), {
      sourceId: loose,
      subjectId: physics.id,
    });
    await refreshed();
    await expect(group.locator(".px-unsorted-row", { hasText: "Appunti sciolti" })).toHaveCount(0);
    await expect(page.locator(".ant-dropdown:not(.ant-dropdown-hidden)")).toHaveCount(0);
    await expect(cover(page, "Fisica 2", "Appunti sciolti")).toBeVisible();

    // A subject deleted under its menu, which was opened by the keyboard on its dots.
    await page.evaluate(() => window.pyxis.invoke("subjects.add", { name: "Chimica" }));
    await page.reload();
    const chemistry = (await page.evaluate(() => window.pyxis.invoke("subjects.list", {}))).find((item) => item.name === "Chimica")!;
    await expect(shelf(page, "Chimica")).toBeVisible();
    await shelf(page, "Chimica").getByRole("button", { name: "Azioni sulla materia Chimica" }).focus();
    await page.keyboard.press("Shift+F10");
    await expect(openMenu(page, "Nuova mappa di questa materia")).toBeVisible();
    await page.evaluate((id) => window.pyxis.invoke("subjects.remove", { id, onlyEmpty: true }), chemistry.id);
    await refreshed();
    await expect(shelf(page, "Chimica")).toHaveCount(0);
    await expect(page.locator(".ant-dropdown:not(.ant-dropdown-hidden)")).toHaveCount(0);
    // Focus did not fall to the page: it is on the subject before it.
    await expect(page.locator(".px-shelf-subject").filter({ has: page.locator(":focus") })).toHaveCount(1);
    expect(await subjectNames(page)).not.toContain("Chimica");
  } finally {
    await app.close();
    removeTestFolder(userData);
  }
});

/** How far the page has scrolled: the first scroller above the shelves that is not at the top. */
const pageScroll = (page: Page) =>
  page.evaluate(() => {
    for (let el: Element | null = document.querySelector(".px-shelves"); el; el = el.parentElement)
      if (el.scrollTop > 0) return el.scrollTop;
    return 0;
  });

/** Subjects with files, enough of them for the page to scroll in a window 420 px high. */
async function tallLibrary(page: Page) {
  await page.setViewportSize({ width: 1280, height: 420 });
  for (const name of ["Chimica", "Geometria", "Algebra", "Statistica", "Informatica", "Storia", "Inglese"])
    await page.evaluate((name) => window.pyxis.invoke("subjects.add", { name }), name);
  for (const [subject, titles] of [
    ["Analisi 1", ["Limiti", "Derivate"]],
    ["Fisica 2", ["Dinamica", "Cinematica"]],
    ["Geometria", ["Vettori"]],
  ] as const)
    for (const title of titles) await fileUnder(page, title, subject);
  await page.reload();
  await expect(cover(page, "Geometria", "Vettori")).toBeVisible();
  await animationsSettled(page);
}

test("A scroll that ends a keyboard-opened menu leaves the page where it went and the focus on the item, and the last cover's removal leaves the focus on the subject", async () => {
  test.setTimeout(240000);
  const { app, page, userData } = await start({ PYXIS_E2E_PLAN_REPLIES: undefined });
  try {
    await tallLibrary(page);
    const menu = page.locator(".ant-dropdown:not(.ant-dropdown-hidden)");
    /** Scrolls the page by wheel from a point clear of the cover and the menu hanging from it, and waits for it to stop. */
    const scrollDown = async () => {
      await page.mouse.move(1100, 300);
      await page.mouse.wheel(0, 450);
      await expect(menu).toHaveCount(0);
      await animationsSettled(page);
    };
    const scrollUp = async () => {
      await page.mouse.wheel(0, -900);
      await expect.poll(() => pageScroll(page)).toBe(0);
      // The next menu opens here, after this scroll's event.
      await atRest(page.locator(".px-shelves"));
    };
    // How far the wheel takes the page with no menu open, which is where a menu's scroll must leave it.
    await page.mouse.move(1100, 300);
    await page.mouse.wheel(0, 450);
    await expect.poll(() => pageScroll(page)).toBeGreaterThan(150);
    await animationsSettled(page);
    await page.waitForTimeout(500);
    const farthest = await pageScroll(page);
    await scrollUp();
    const stayed = () => expect.poll(() => pageScroll(page)).toBeGreaterThan(farthest - 3);

    // A cover's menu opened with the keyboard: the scroll closes it, and focus returns to the cover without scrolling back.
    const limiti = cover(page, "Analisi 1", "Limiti").getByRole("button", { name: "Limiti", exact: true });
    await limiti.focus();
    await page.keyboard.press("Shift+F10");
    await expect(menu.getByRole("menuitem", { name: "Dettagli della fonte" })).toBeVisible();
    await scrollDown();
    await expect(limiti).toBeFocused();
    await stayed();
    await scrollUp();

    // A cover's dots menu opened with the keyboard: the scroll closes it, and focus is not left on the page.
    const dots = cover(page, "Analisi 1", "Derivate").getByRole("button", { name: "Azioni per Derivate" });
    await dots.focus();
    await page.keyboard.press("Enter");
    await expect(menu.getByRole("menuitem", { name: "Dettagli della fonte" })).toBeVisible();
    await scrollDown();
    await expect(dots).toBeFocused();
    await stayed();
    await scrollUp();

    // The same for a subject's dots.
    const subjectDots = shelf(page, "Analisi 1").getByRole("button", { name: "Azioni sulla materia Analisi 1" });
    await subjectDots.focus();
    await page.keyboard.press("Enter");
    await expect(menu.getByRole("menuitem", { name: "Nuova mappa di questa materia" })).toBeVisible();
    await scrollDown();
    await expect(subjectDots).toBeFocused();
    await stayed();
    await scrollUp();

    // A menu opened with the pointer keeps focus where the click put it: a scroll does not move it.
    await cover(page, "Fisica 2", "Dinamica").hover();
    await page.getByRole("button", { name: "Azioni per Dinamica" }).click();
    await expect(menu.getByRole("menuitem", { name: "Dettagli della fonte" })).toBeVisible();
    await page.mouse.move(1100, 300);
    await page.mouse.wheel(0, 450);
    await expect(menu).toHaveCount(0);
    await scrollUp();

    // The last cover of a shelf removed while its menu is open: the shelf's list goes, and focus stays in the page, on
    // the subject's dots, not on the body.
    const vettori = await page.evaluate(
      async () => (await window.pyxis.invoke("sources.list", {})).find((source) => source.title === "Vettori")!.id,
    );
    await cover(page, "Geometria", "Vettori").getByRole("button", { name: "Vettori", exact: true }).focus();
    await page.keyboard.press("Shift+F10");
    await expect(menu.getByRole("menuitem", { name: "Dettagli della fonte" })).toBeVisible();
    await page.evaluate((sourceId) => window.pyxis.invoke("sources.remove", { sourceId, confirmed: true }), vettori);
    await pasteLoose(page, "Arrivo"); // the page reads the library again
    await expect(shelf(page, "Geometria")).toContainText("nessun file");
    await expect(menu).toHaveCount(0);
    await expect(shelf(page, "Geometria").getByRole("button", { name: "Azioni sulla materia Geometria" })).toBeFocused();
  } finally {
    await app.close();
    removeTestFolder(userData);
  }
});

test("A menu from the dots is drawn like the right-click menu of the same file, at large text", async () => {
  test.setTimeout(180000);
  const { app, page, userData } = await start({ PYXIS_E2E_PLAN_REPLIES: undefined });
  try {
    await page.setViewportSize({ width: 1280, height: 900 });
    await fileUnder(page, "Limiti", "Analisi 1");
    await page.evaluate(() => window.pyxis.invoke("profile.save", { dyslexia: false, textSize: "lg" }));
    await page.reload();
    const file = cover(page, "Analisi 1", "Limiti");
    await expect(file).toBeVisible();
    const menu = page.locator(".ant-dropdown:not(.ant-dropdown-hidden)");
    /** What the menu's rows look like: the class the stylesheet keys on, and the size, text and colour of two rows. */
    const look = async () => {
      await expect(menu.getByRole("menuitem", { name: "Dettagli della fonte" })).toBeVisible();
      await animationsSettled(page);
      return menu.evaluate((el) => {
        const row = (name: string) => {
          const item = [...el.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((node) => node.textContent?.trim() === name)!;
          const style = getComputedStyle(item);
          return { height: item.getBoundingClientRect().height, font: style.fontSize, colour: style.color };
        };
        return { shared: el.classList.contains("px-item-menu"), details: row("Dettagli della fonte"), remove: row("Rimuovi") };
      });
    };
    const box = (await file.boundingBox())!;
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: "right" });
    const rightClick = await look();
    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
    await file.hover();
    await page.getByRole("button", { name: "Azioni per Limiti" }).click();
    const dots = await look();
    // Large text is on, and both menus use the shared look.
    expect(parseFloat(rightClick.details.font)).toBeGreaterThan(14.5);
    expect(rightClick.shared).toBe(true);
    expect(dots).toEqual(rightClick);
    await page.keyboard.press("Escape");

    // A subject's menu too.
    await expect(menu).toHaveCount(0);
    const head = shelf(page, "Analisi 1").locator(".px-shelf-subject-head");
    const at = (await head.boundingBox())!;
    await page.mouse.click(at.x + at.width / 2, at.y + at.height / 2, { button: "right" });
    await expect(menu.getByRole("menuitem", { name: "Nuova mappa di questa materia" })).toBeVisible();
    const subjectRight = await menu.evaluate((el) => ({ shared: el.classList.contains("px-item-menu"), height: el.querySelector("[role=menuitem]")!.getBoundingClientRect().height }));
    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
    await shelf(page, "Analisi 1").getByRole("button", { name: "Azioni sulla materia Analisi 1" }).click();
    await expect(menu.getByRole("menuitem", { name: "Nuova mappa di questa materia" })).toBeVisible();
    await animationsSettled(page);
    const subjectDots = await menu.evaluate((el) => ({ shared: el.classList.contains("px-item-menu"), height: el.querySelector("[role=menuitem]")!.getBoundingClientRect().height }));
    expect(subjectDots).toEqual(subjectRight);
    expect(subjectDots.shared).toBe(true);
  } finally {
    await app.close();
    removeTestFolder(userData);
  }
});

test("A cover's full title shows on hover and on keyboard focus, and its state is still described", async () => {
  test.setTimeout(180000);
  const { app, page, userData } = await start({ PYXIS_E2E_PLAN_REPLIES: undefined });
  try {
    await page.setViewportSize({ width: 1280, height: 900 });
    const first = "Dispensa di analisi matematica uno: serie numeriche e criteri di convergenza";
    const second = "Dispensa di analisi matematica uno: serie di potenze e raggio di convergenza";
    for (const title of [first, second, "Limiti"]) await fileUnder(page, title, "Analisi 1");
    await page.reload();
    const tip = page.locator(".ant-tooltip:not(.ant-tooltip-hidden)");
    const open = (title: string) => cover(page, "Analisi 1", title).getByRole("button", { name: title, exact: true });
    // The whole title is the button's name, whatever the cover shows.
    await expect(open(first)).toBeVisible();
    await expect(open(second)).toBeVisible();
    // A title the cover cuts shows whole on hover...
    await open(first).hover();
    await expect(tip).toHaveText(first);
    await page.mouse.move(5, 5);
    await expect(tip).toHaveCount(0);
    // ...and on keyboard focus.
    await open(second).focus();
    await expect(tip).toHaveText(second);
    await open(first).focus();
    await expect(tip).toHaveText(first);
    await page.keyboard.press("Escape");
    await expect(tip).toHaveCount(0);
    // A title that fits says nothing more.
    await open("Limiti").hover();
    await page.waitForTimeout(400);
    await expect(tip).toHaveCount(0);
  } finally {
    await app.close();
    removeTestFolder(userData);
  }
});

test("With subjects and no files the Library shows the subjects with the add-a-file message, and with neither it keeps the empty page", async () => {
  test.setTimeout(180000);
  const { app, page, userData } = await start({ PYXIS_E2E_PLAN_REPLIES: undefined });
  try {
    await page.setViewportSize({ width: 1280, height: 900 });
    const empty = page.getByText(/^Qui compariranno i tuoi file/);
    await expect(empty).toBeVisible();
    // The student can see both subjects, and act on them.
    for (const name of ["Analisi 1", "Fisica 2"]) await expect(shelf(page, name)).toContainText("nessun file");
    // With no file anywhere there is none to move, so the cards say only that they are empty.
    for (const name of ["Analisi 1", "Fisica 2"]) {
      await expect(shelf(page, name).locator(".px-shelf-subject-none")).toHaveText("Ancora niente.");
    }
    await expect(page.getByRole("button", { name: "Aggiungi file", exact: true })).toBeVisible();
    await shelf(page, "Fisica 2").getByRole("button", { name: "Azioni sulla materia Fisica 2" }).click();
    await expect(page.getByRole("menuitem", { name: "Nuova mappa di questa materia" })).toBeVisible();
    await page.getByRole("menuitem", { name: "Elimina la materia…" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Elimina", exact: true }).click();
    await expect(shelf(page, "Fisica 2")).toHaveCount(0);
    await expect(shelf(page, "Analisi 1")).toBeVisible();
    await expect(empty).toBeVisible();
    // A subject renamed on a page that has no files.
    await shelf(page, "Analisi 1").getByRole("button", { name: "Azioni sulla materia Analisi 1" }).click();
    await page.getByRole("menuitem", { name: "Rinomina", exact: true }).click();
    await page.getByRole("textbox", { name: "Nome della materia Analisi 1" }).fill("Analisi uno");
    await page.keyboard.press("Enter");
    await expect(shelf(page, "Analisi uno")).toBeVisible();
    // With the last subject gone, no card is left: today's empty page.
    await shelf(page, "Analisi uno").getByRole("button", { name: "Azioni sulla materia Analisi uno" }).click();
    await page.getByRole("menuitem", { name: "Elimina la materia…" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Elimina", exact: true }).click();
    await expect(page.locator(".px-shelf-subject")).toHaveCount(0);
    await expect(empty).toBeVisible();
    await expect(page.locator(".px-shelves")).toHaveCount(0);
  } finally {
    await app.close();
    removeTestFolder(userData);
  }
});

test("When the subjects cannot be read, the files stay on the page and the student can try again", async () => {
  test.setTimeout(180000);
  const { app, page, userData } = await start({ PYXIS_E2E_PLAN_REPLIES: undefined });
  try {
    await page.setViewportSize({ width: 1280, height: 900 });
    await fileUnder(page, "Limiti", "Analisi 1");
    await fileUnder(page, "Dinamica", "Fisica 2");
    // The subjects request fails while the table it counts chats in is away; the files' own request does not use it.
    const db = new DatabaseSync(join(userData, "workspace", "pyxis.db"), { timeout: 10000 });
    db.exec("ALTER TABLE chats RENAME TO chats_away");
    await page.reload();
    const files = page.getByRole("region", { name: "File", exact: true });
    await expect(page.getByText("Non sono riuscito a leggere le materie.")).toBeVisible();
    await expect(files.getByRole("button", { name: "Limiti", exact: true })).toBeVisible();
    await expect(files.getByRole("button", { name: "Dinamica", exact: true })).toBeVisible();
    await expect(page.locator("[data-subject-id]")).toHaveCount(0);
    await animationsSettled(page);
    await expectNoAxeViolations(page);
    // The files have their menu.
    await files.getByRole("button", { name: "Azioni per Limiti" }).click();
    await expect(page.getByRole("menuitem", { name: "Dettagli della fonte" })).toBeVisible();
    await page.keyboard.press("Escape");
    // Try again: the subjects come back and the files go to their shelves.
    db.exec("ALTER TABLE chats_away RENAME TO chats");
    db.close();
    await page.getByRole("button", { name: "Riprova" }).click();
    await expect(cover(page, "Analisi 1", "Limiti")).toBeVisible();
    await expect(cover(page, "Fisica 2", "Dinamica")).toBeVisible();
    await expect(page.getByText("Non sono riuscito a leggere le materie.")).toHaveCount(0);
    await expect(files).toHaveCount(0);
  } finally {
    await app.close();
    removeTestFolder(userData);
  }
});

test("When the subjects cannot be read again, a file moved to a new subject stays on the page and the student can try again", async () => {
  test.setTimeout(180000);
  const { app, page, userData } = await start({ PYXIS_E2E_PLAN_REPLIES: undefined });
  try {
    await page.setViewportSize({ width: 1280, height: 900 });
    await fileUnder(page, "Limiti", "Analisi 1");
    await page.reload();
    await expect(cover(page, "Analisi 1", "Limiti")).toBeVisible();
    // The page has the subjects now. The request for them fails from here on, while the table it counts chats in is away.
    const db = new DatabaseSync(join(userData, "workspace", "pyxis.db"), { timeout: 10000 });
    db.exec("ALTER TABLE chats RENAME TO chats_away");
    try {
      await cover(page, "Analisi 1", "Limiti").click({ button: "right" });
      await page.getByRole("menuitem", { name: "Sposta in", exact: true }).hover();
      await page.getByRole("menuitem", { name: "Nuova materia…" }).click();
      const named = page.getByRole("dialog", { name: "Sposta in una materia nuova" });
      await named.getByLabel("Nome della materia").fill("Chimica");
      await named.getByRole("button", { name: "Sposta", exact: true }).click();
      await expect(named).toBeHidden();
      // The subject Chimica is not in the list the page kept, so the file is not on its shelf: it is said, and still shown.
      await expect(page.getByText("Non sono riuscito a leggere le materie.")).toBeVisible();
      await expect(page.getByRole("region", { name: "File", exact: true }).getByRole("button", { name: "Limiti", exact: true })).toBeVisible();
    } finally {
      db.exec("ALTER TABLE chats_away RENAME TO chats");
      db.close();
    }
    await page.getByRole("button", { name: "Riprova" }).click();
    await expect(cover(page, "Chimica", "Limiti")).toBeVisible();
    await expect(page.getByText("Non sono riuscito a leggere le materie.")).toHaveCount(0);
    await expect(page.getByRole("region", { name: "File", exact: true })).toHaveCount(0);
  } finally {
    await app.close();
    removeTestFolder(userData);
  }
});

test("A rename that answers late does not close another subject's rename field", async () => {
  test.setTimeout(180000);
  const { app, page, userData } = await start({ PYXIS_E2E_PLAN_REPLIES: undefined });
  let lock: DatabaseSync | undefined;
  try {
    await page.setViewportSize({ width: 1280, height: 900 });
    await fileUnder(page, "Limiti", "Analisi 1");
    // The test holds the database's write lock, as new-flashcard.spec.ts does, so that the core waits on it in the middle
    // of a request. That works on every platform, unlike stopping the core with a signal. A rename itself cannot be the
    // request that waits: it reads before it writes, and SQLite refuses that upgrade at once while another connection
    // holds the lock. A chat rename starts with a write, so it waits, and the core answers nothing until the lock is let
    // go, which leaves the renames sent after it waiting in its queue.
    lock = new DatabaseSync(join(userData, "workspace", "pyxis.db"), { timeout: 10_000 });
    lock.exec("BEGIN IMMEDIATE");
    const stuck = page.evaluate(() => window.pyxis.invoke("chats.rename", { chatId: "nothing", title: "Nothing" })).catch(() => undefined);
    // Analisi 1 is renamed: leaving its field sends the new name, whose answer waits until the student has gone on to Fisica 2.
    await shelf(page, "Analisi 1").getByRole("button", { name: "Azioni sulla materia Analisi 1" }).click();
    await page.getByRole("menuitem", { name: "Rinomina", exact: true }).click();
    await page.getByRole("textbox", { name: "Nome della materia Analisi 1" }).fill("Analisi uno");
    await shelf(page, "Fisica 2").getByRole("button", { name: "Azioni sulla materia Fisica 2" }).click();
    await page.getByRole("menuitem", { name: "Rinomina", exact: true }).click();
    const second = page.getByRole("textbox", { name: "Nome della materia Fisica 2" });
    await second.fill("Fisica due");
    await expect(second).toBeFocused();
    // Nothing is renamed while the lock is held.
    await expect(shelf(page, "Analisi 1")).toBeVisible();
    lock.exec("ROLLBACK");
    lock.close();
    lock = undefined;
    await stuck;
    // Analisi 1 is renamed; the field of Fisica 2 is still there, with its text and the focus.
    await expect.poll(() => subjectNames(page)).toContain("Analisi uno");
    await expect(shelf(page, "Analisi uno")).toBeVisible();
    await page.waitForTimeout(400);
    await expect(second).toBeVisible();
    await expect(second).toHaveValue("Fisica due");
    await expect(second).toBeFocused();
  } finally {
    // Still open only when the test failed before it let the write go.
    lock?.close();
    await app.close();
    removeTestFolder(userData);
  }
});

test("A subject's menu offers flashcards of the subject, which open the Flashcard page's dialog on Pyxis's side with the subject chosen", async () => {
  test.setTimeout(180000);
  const { app, page, userData } = await start({ PYXIS_E2E_PLAN_REPLIES: undefined });
  try {
    await page.setViewportSize({ width: 1280, height: 900 });
    await fileUnder(page, "Limiti", "Analisi 1");
    await page.reload();
    const physics = (await page.evaluate(() => window.pyxis.invoke("subjects.list", {}))).find((item) => item.name === "Fisica 2")!;
    const menu = page.locator(".ant-dropdown:not(.ant-dropdown-hidden)");
    const items = () => menu.getByRole("menuitem").allTextContents();
    // An empty subject: the three actions, a divider, and the delete.
    await shelf(page, "Fisica 2").getByRole("button", { name: "Azioni sulla materia Fisica 2" }).click();
    await expect(menu.getByRole("menuitem", { name: "Rinomina", exact: true })).toBeVisible();
    expect(await items()).toEqual(["Rinomina", "Nuova mappa di questa materia", "Crea flashcard di questa materia", "Elimina la materia…"]);
    await page.keyboard.press("Escape");
    // A subject with a file: the same, without the delete, by right-click on its heading.
    const head = shelf(page, "Analisi 1").locator(".px-shelf-subject-head");
    const at = (await head.boundingBox())!;
    await page.mouse.click(at.x + at.width / 2, at.y + at.height / 2, { button: "right" });
    await expect(menu.getByRole("menuitem", { name: "Rinomina", exact: true })).toBeVisible();
    expect(await items()).toEqual(["Rinomina", "Nuova mappa di questa materia", "Crea flashcard di questa materia"]);
    await page.keyboard.press("Escape");

    await shelf(page, "Fisica 2").getByRole("button", { name: "Azioni sulla materia Fisica 2" }).click();
    await menu.getByRole("menuitem", { name: "Crea flashcard di questa materia" }).click();
    const dialog = page.getByRole("dialog", { name: "Nuova flashcard" });
    await expect(dialog).toBeVisible();
    await expect(page).toHaveURL(/#\/flashcards$/);
    await expect(dialog.getByRole("radio", { name: "Falla fare a Pyxis" })).toHaveAttribute("aria-checked", "true");
    await expect(dialog.getByRole("combobox", { name: "Materia" })).toHaveValue(physics.id);
    // Back returns to the Library, and the dialog does not open again.
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await page.goBack();
    await expect(shelf(page, "Fisica 2")).toBeVisible();
    await expect(page.getByRole("dialog")).toHaveCount(0);
  } finally {
    await app.close();
    removeTestFolder(userData);
  }
});

test("A cover's dots and a subject's dots work from the keyboard alone: Sposta in moves the file and Rinomina renames the subject", async () => {
  test.setTimeout(180000);
  const { app, page, userData } = await start({ PYXIS_E2E_PLAN_REPLIES: undefined });
  try {
    await page.setViewportSize({ width: 1280, height: 900 });
    await fileUnder(page, "Limiti", "Analisi 1");
    await page.reload();
    const file = cover(page, "Analisi 1", "Limiti");
    await expect(file).toBeVisible();

    // Tab from the cover to its dots, Enter opens the menu, the arrows reach Sposta in, the right arrow opens the
    // subjects, and Enter on one moves the file there.
    await file.locator(".px-cover-open").focus();
    await page.keyboard.press("Tab");
    const dots = file.getByRole("button", { name: "Azioni per Limiti" });
    await expect(dots).toBeFocused();
    await page.keyboard.press("Enter");
    for (const item of ["Dettagli della fonte", "Rinomina", "Tipo", "Sposta in"]) {
      await page.keyboard.press("ArrowDown");
      await expect(page.getByRole("menuitem", { name: item, exact: true })).toBeFocused();
    }
    await page.keyboard.press("ArrowRight");
    const target = page.getByRole("menuitem", { name: "Fisica 2", exact: true });
    await expect(target).toBeVisible();
    // The subject the file is on is shown and cannot be chosen, so the keyboard lands on the next one.
    await expect(target).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(cover(page, "Fisica 2", "Limiti")).toBeVisible();
    await expect(shelf(page, "Analisi 1")).toHaveAccessibleName("Analisi 1 nessun file");

    // Shift+Tab from the subject's first cover reaches its dots; Enter, the down arrow and Enter start the rename.
    await cover(page, "Fisica 2", "Limiti").locator(".px-cover-open").focus();
    await page.keyboard.press("Shift+Tab");
    const subjectDots = shelf(page, "Fisica 2").getByRole("button", { name: "Azioni sulla materia Fisica 2" });
    await expect(subjectDots).toBeFocused();
    await page.keyboard.press("Enter");
    await page.keyboard.press("ArrowDown");
    await expect(page.getByRole("menuitem", { name: "Rinomina", exact: true })).toBeFocused();
    await page.keyboard.press("Enter");
    const field = page.getByRole("textbox", { name: "Nome della materia Fisica 2" });
    await expect(field).toBeFocused();
    await page.keyboard.type("Fisica tecnica");
    await page.keyboard.press("Enter");
    await expect(shelf(page, "Fisica tecnica").locator(".px-cover", { hasText: "Limiti" })).toBeVisible();
    expect(await subjectNames(page)).toEqual(["Analisi 1", "Fisica tecnica"]);
  } finally {
    await app.close();
    removeTestFolder(userData);
  }
});

test("Files that need the student come first on their shelf and in Da sistemare, so none hides behind Mostra tutti", async () => {
  test.setTimeout(120_000);
  const userData = mkdtempSync(join(tmpdir(), "pyxis-library-order-"));
  const app = await launchPyxis({ userData });
  try {
    const page = await app.firstWindow();
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.getByRole("button", { name: "Salta" }).click();
    await fromChiediToExams(page);
    const db = new DatabaseSync(join(userData, "workspace", "pyxis.db"), { timeout: 10_000 });
    seedSubjects(db, [{ id: "an", name: "Analisi 1" }]);
    // Sixteen files read, and two whose titles sort last: one whose read failed and one still being read.
    for (let index = 1; index <= 16; index++)
      seedSource(db, { id: `an-${index}`, title: `Dispensa ${String(index).padStart(2, "0")}`, subjectId: "an" });
    seedSource(db, { id: "an-failed", title: "Zeta, scansione illeggibile", subjectId: "an", status: "failed" });
    seedSource(db, { id: "an-reading", title: "Zeta, slide in lettura", subjectId: "an", status: "extracting" });
    // Nine files without a subject, the one that failed last by title.
    for (let index = 1; index <= 8; index++) seedSource(db, { id: `loose-${index}`, title: `Appunti ${index}` });
    seedSource(db, { id: "loose-failed", title: "Zeta, foto rovinata", status: "failed" });
    db.close();
    await toLibrary(page);

    const shelf = page.getByRole("region", { name: /^Analisi 1/ });
    const covers = shelf.locator(".px-cover-title");
    await expect(covers).toHaveCount(14);
    await expect(covers.nth(0)).toHaveText("Zeta, scansione illeggibile");
    await expect(covers.nth(1)).toHaveText("Zeta, slide in lettura");
    await expect(covers.nth(2)).toHaveText("Dispensa 01");
    // The count line says so while some covers are behind Mostra tutti, which is a button that looks like one.
    await expect(shelf.locator(".px-shelf-subject-head")).toContainText(/18 file\s*· i 2 da controllare sono i primi/);
    const all = shelf.getByRole("button", { name: "Mostra tutti i 18 file" });
    await expect(all).toHaveClass(/px-btn-secondary/);
    await all.click();
    await expect(covers).toHaveCount(18);
    await expect(shelf.locator(".px-shelf-subject-head")).not.toContainText("da controllare");
    await expect(shelf.getByRole("button", { name: "Mostra meno" })).toHaveClass(/px-btn-secondary/);

    const unsorted = page.getByRole("region", { name: "Da sistemare" });
    const rows = unsorted.locator(".px-unsorted-row");
    await expect(rows).toHaveCount(8);
    await expect(rows.first()).toContainText("Zeta, foto rovinata");
    await expect(unsorted.getByRole("button", { name: "Mostra tutti i 9 file" })).toHaveClass(/px-btn-secondary/);
    await expectNoAxeViolations(page);
  } finally {
    await app.close();
    removeTestFolder(userData);
  }
});

test("Subjects with no files keep one column width each, and the last row is not stretched", async () => {
  test.setTimeout(120_000);
  const userData = mkdtempSync(join(tmpdir(), "pyxis-library-empty-cards-"));
  const app = await launchPyxis({ userData });
  try {
    const page = await app.firstWindow();
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.getByRole("button", { name: "Salta" }).click();
    await fromChiediToExams(page);
    const db = new DatabaseSync(join(userData, "workspace", "pyxis.db"), { timeout: 10_000 });
    seedSubjects(db, [
      { id: "an", name: "Analisi 1" },
      { id: "fis", name: "Fisica 2" },
      { id: "chem", name: "Chimica generale" },
      { id: "lab", name: "Laboratorio di fisica" },
    ]);
    db.close();
    const cards = page.locator(".px-shelf-subject");
    for (const [width, textSize] of [
      [1280, "md"],
      [960, "lg"],
    ] as const) {
      await page.setViewportSize({ width, height: 800 });
      await page.evaluate((textSize) => window.pyxis.invoke("profile.save", { dyslexia: false, textSize }), textSize);
      await toLibrary(page);
      await page.reload();
      await expect(cards).toHaveCount(4);
      const widths = await cards.evaluateAll((nodes) => nodes.map((node) => Math.round(node.getBoundingClientRect().width)));
      const row = (await page.locator(".px-shelf-subjects").boundingBox())!;
      // Every card has the same width, the one of a column, never the whole row.
      expect(new Set(widths).size, `${width}: ${widths.join(", ")}`).toBe(1);
      expect(widths[0]!, `${width}: a card is ${widths[0]} of ${row.width}`).toBeLessThan(row.width * 0.6);
    }
  } finally {
    await app.close();
    removeTestFolder(userData);
  }
});
