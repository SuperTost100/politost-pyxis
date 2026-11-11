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

test("A file moved behind \"Mostra tutti\" shows where it went and keeps the keyboard's place", async () => {
  test.setTimeout(240000);
  const { app, page, userData } = await start({ PYXIS_E2E_PLAN_REPLIES: undefined });
  try {
    await page.setViewportSize({ width: 1280, height: 900 });
    const analysis = (await page.evaluate(() => window.pyxis.invoke("subjects.list", {}))).find(
      (subject) => subject.name === "Analisi 1",
    )!;
    // Fifteen covers that sort before "Zeta" and "Zulu": the shelf shows fourteen, so a moved file lands behind the button.
    for (let n = 1; n <= 15; n++) {
      const id = await pasteLoose(page, `Appunti ${String(n).padStart(2, "0")}`);
      await page.evaluate(({ id, subjectId }) => window.pyxis.invoke("sources.move", { sourceId: id, subjectId }), {
        id,
        subjectId: analysis.id,
      });
    }
    await pasteLoose(page, "Zeta");
    await pasteLoose(page, "Zulu");
    const group = page.getByRole("region", { name: "Da sistemare" });
    await expect(group.locator(".px-unsorted-row")).toHaveCount(2);
    await expect(shelf(page, "Analisi 1").locator(".px-cover")).toHaveCount(14);

    // Chosen in "Da sistemare": the shelf opens so the cover is there, and focus goes to the next row's choice.
    await group.getByRole("combobox", { name: "Materia di Zeta" }).selectOption({ label: "Analisi 1" });
    await expect(cover(page, "Analisi 1", "Zeta")).toBeVisible();
    await expect(shelf(page, "Analisi 1").locator(".px-cover")).toHaveCount(16);
    await expect(group.getByRole("combobox", { name: "Materia di Zulu" })).toBeFocused();

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

/** The menu that is open: the one with `item`, whatever the page scrolled or did while it opened. */
const openMenu = (page: Page, item: string) =>
  page.locator(".ant-dropdown:not(.ant-dropdown-hidden)").filter({ has: page.getByRole("menuitem", { name: item, exact: true }) });

test("At 960 px a file's and a subject's menu open at the dots or the pointer after the page scrolled, only their owner looks hovered, and a scroll or a resize ends them but a layout shift does not", async () => {
  test.setTimeout(240000);
  const { app, page, userData } = await start({ PYXIS_E2E_PLAN_REPLIES: undefined });
  try {
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
      await expect(menu).toBeVisible();
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
    const parent = (await fileMenu.boundingBox())!;
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
    const at = centre((await second.boundingBox())!);
    await page.mouse.click(at.x, at.y, { button: "right" });
    await expectMenuAt(fileMenu, at, await sourceId(second), "library-menu/960-file-right-click.png");
    await page.keyboard.press("Escape");
    await expect(fileMenu).toHaveCount(0);

    // By the keyboard: Shift+F10 on the cover that has focus.
    await rest();
    const third = cover(page, "Fisica 2", "Ottica");
    await third.scrollIntoViewIfNeeded();
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
    await subjectDots.click();
    await expectMenuAt(subjectMenu, centre((await subjectDots.boundingBox())!), null, "library-menu/960-subject-dots.png");
    await page.keyboard.press("Escape");
    await expect(subjectMenu).toHaveCount(0);
    const heading = shelf(page, "Analisi 1").getByRole("heading", { name: "Analisi 1" });
    await heading.scrollIntoViewIfNeeded();
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
      /** Opens the menu of "Serie" and says where it was asked from: the dots, or the pointer. */
      let from = { x: 0, y: 0 };
      const open = async () => {
        const file = cover(page, "Analisi 1", "Serie");
        await file.scrollIntoViewIfNeeded();
        if (way === "dots") {
          await file.hover();
          await page.getByRole("button", { name: "Azioni per Serie" }).click();
          from = centre((await page.getByRole("button", { name: "Azioni per Serie" }).boundingBox())!);
        } else {
          from = centre((await file.boundingBox())!);
          await page.mouse.click(from.x, from.y, { button: "right" });
        }
        await expect(fileMenu).toBeVisible();
        await animationsSettled(page);
      };
      /** Where the menu should be: at the dots, wherever they are now, or at the pointer's old place. */
      const asked = async () =>
        way === "dots" ? centre((await page.getByRole("button", { name: "Azioni per Serie" }).boundingBox())!) : from;

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
        expect(gap(after, await asked()), `menu ${JSON.stringify(after)} follows its dots`).toBeLessThan(40);
        expect(after.y).not.toBeCloseTo(before.y, 0);
      } else expect(after).toEqual(before);
      // The owner keeps its hover look while its menu is open, and nothing else has it.
      await expect.poll(hovered).toEqual([await sourceId(cover(page, "Analisi 1", "Serie"))]);
      await page.evaluate(() => document.getElementById("e2e-spacer")?.remove());
      await expect(fileMenu).toBeVisible();

      await page.setViewportSize({ width: 900, height: 900 });
      if (way === "right-click") await expect(fileMenu, "right-click menu after a resize").toHaveCount(0);
      else {
        await expect(fileMenu, "dots menu after a resize").toBeVisible();
        await animationsSettled(page);
        expect(gap((await fileMenu.boundingBox())!, await asked())).toBeLessThan(40);
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
      await expect(file).toHaveClass(/px-cover/);
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
