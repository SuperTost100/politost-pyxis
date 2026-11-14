import { expect, test, type Page } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { launchPyxis } from "./app-under-test";
import { removeTestFolder } from "./cleanup";
import { fromChiediToExams, toLibrary } from "./doors";
import { expectEmptyPage, headBox } from "./empty-page";
import { saveShot } from "./shots";
import { seedPlan, seedSource, seedSubjects } from "./seed";

/** The two looks every empty page is checked in: Italian, dark, narrow and with large text, and English, light and wide. */
const looks = [
  { key: "it-dark-960-large", language: "it", theme: "dark", textSize: "lg", width: 960 },
  { key: "en-light-1280", language: "en", theme: "light", textSize: "md", width: 1280 },
] as const;
type Look = (typeof looks)[number];

/** Starts Pyxis with nothing in it, past setup, on Esami, with the database already created. */
async function start(prefix: string) {
  const userData = mkdtempSync(join(tmpdir(), `pyxis-empty-${prefix}-`));
  const app = await launchPyxis({ userData });
  const page = await app.firstWindow();
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.getByRole("button", { name: "Salta" }).click();
  await fromChiediToExams(page);
  await page.evaluate(() => window.pyxis.invoke("plans.list", {}));
  const open = () => new DatabaseSync(join(userData, "workspace", "pyxis.db"), { timeout: 10_000 });
  const finish = async () => {
    await app.close();
    removeTestFolder(userData);
  };
  return { page, open, finish };
}

/** Shows a page at its address in a look, so each test checks the same page in both. */
async function show(page: Page, look: Look, hash: string) {
  await page.setViewportSize({ width: look.width, height: 800 });
  await page.evaluate(
    async ([look, hash]) => {
      localStorage.setItem("pyxis.lang", look.language);
      await window.pyxis.setAppearance(look.theme);
      await window.pyxis.invoke("profile.save", { dyslexia: false, textSize: look.textSize });
      location.hash = hash;
    },
    [look, hash] as const,
  );
  await page.reload();
}

/** The names of the buttons in a page's head, in order: the dots and the main action are the only ones it can have. */
const headButtons = (page: Page, head: string) =>
  expect.poll(() =>
    page
      .locator(head)
      .getByRole("button")
      .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("aria-label") ?? node.textContent?.trim() ?? "")),
  );

test("Esami with no exam says what will appear, keeps the dots in its head and has one New exam, under the line", async () => {
  const { page, open, finish } = await start("exams");
  try {
    const lines = {
      it: /^Qui compariranno i tuoi esami, ognuno con un percorso di lezioni e quiz fino alla data\. Ti basta il nome e il materiale del corso\.$/,
      en: /^Your exams will appear here, each with a path of lessons and quizzes up to its date\. All you need is the name and the course material\.$/,
    };
    const names = { it: ["Altro su Esami", "Nuovo esame"], en: ["More for Exams", "New exam"] };
    for (const look of looks) {
      const language = look.language;
      await show(page, look, "/exams");
      await expectEmptyPage(page, { line: lines[language], action: names[language][1] });
      await saveShot(page, `empty-pages/exams-${look.key}.png`);
      // The head holds the dots and nothing else.
      await headButtons(page, ".px-exams-head").toEqual([names[language][0]]);
    }
    const empty = await headBox(page.locator(".px-exams-head"));

    // The first exam takes the page's place, the head keeps its size and its place, and its button comes back.
    const db = open();
    seedPlan(db, { id: "p-1", title: "Fisica 1", language: "it", target: 0.75, examAt: null, topics: [{ id: "t-1", title: "Dinamica" }] });
    db.close();
    await page.reload();
    await expect(page.getByRole("list", { name: "Your exams" })).toBeVisible();
    await expect(page.locator(".px-empty")).toHaveCount(0);
    await expect(page.locator(".px-exams-head").getByRole("button", { name: "New exam" })).toBeVisible();
    expect(await headBox(page.locator(".px-exams-head"))).toEqual(empty);
  } finally {
    await finish();
  }
});

test("Esami with every exam archived says where they are, and its one button opens them", async () => {
  const { page, open, finish } = await start("archived");
  try {
    const db = open();
    seedPlan(db, { id: "p-old", title: "Informatica", language: "it", target: 0.75, examAt: Date.now() - 60 * 86_400_000, topics: [{ id: "t-old", title: "Classi" }] });
    db.prepare("UPDATE plans SET archived_at = ? WHERE id = 'p-old'").run(Date.now() - 30 * 86_400_000);
    db.close();
    const lines = {
      it: /^Li trovi sotto Archiviati\. Per prepararne uno nuovo, scegli Nuovo esame\.$/,
      en: /^You'll find them under Archived\. To prepare a new one, choose New exam\.$/,
    };
    const names = { it: ["Altro su Esami", "Nuovo esame", "Archiviati"], en: ["More for Exams", "New exam", "Archived"] };
    for (const look of looks) {
      const language = look.language;
      await show(page, look, "/exams");
      await expectEmptyPage(page, { line: lines[language], action: names[language][2] });
      await saveShot(page, `empty-pages/exams-archived-${look.key}.png`);
      // Not an empty page for the head: the exam can still be made from it.
      await headButtons(page, ".px-exams-head").toEqual([names[language][0], names[language][1]]);
    }
    await page.getByRole("main").getByRole("button", { name: "Archived", exact: true }).click();
    await expect(page.getByRole("link", { name: /Informatica/ })).toBeVisible();
  } finally {
    await finish();
  }
});

test("Mappe with subjects and no map says what will appear, and its one button makes a map", async () => {
  const { page, open, finish } = await start("maps");
  try {
    const db = open();
    seedSubjects(db, [{ id: "phys", name: "Fisica I" }]);
    db.close();
    const lines = {
      it: /^Qui compariranno le mappe che crei, divise per materia\. Ne fai una da un argomento\.$/,
      en: /^The maps you make will appear here, by subject\. You make one from a topic\.$/,
    };
    const actions = { it: "Nuova mappa", en: "New map" };
    const searches = { it: "Cerca nelle mappe", en: "Search maps" };
    for (const look of looks) {
      const language = look.language;
      await show(page, look, "/maps");
      await expectEmptyPage(page, { line: lines[language], action: actions[language] });
      await saveShot(page, `empty-pages/maps-${look.key}.png`);
      // The search and the head's button wait for the first map.
      await expect(page.getByRole("textbox", { name: searches[language] })).toHaveCount(0);
    }
    await page.getByRole("main").getByRole("button", { name: "New map", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "New map" })).toBeVisible();
  } finally {
    await finish();
  }
});

test("Mappe with no subject says what will appear, and its one button links the folder with the material", async () => {
  const { page, finish } = await start("maps-none");
  try {
    const lines = {
      it: /^Qui compariranno le mappe che crei, divise per materia\. Prima serve il materiale: collega la cartella dove lo tieni\.$/,
      en: /^The maps you make will appear here, by subject\. First you need material: link the folder where you keep it\.$/,
    };
    const actions = { it: "Collega una cartella", en: "Link a folder" };
    for (const look of looks) {
      const language = look.language;
      await show(page, look, "/maps");
      await expectEmptyPage(page, { line: lines[language], action: actions[language] });
      await saveShot(page, `empty-pages/maps-none-${look.key}.png`);
    }
    await page.getByRole("main").getByRole("button", { name: "Link a folder", exact: true }).click();
    await expect(page).toHaveURL(/#\/onboarding\?again=1&step=material&from=maps$/);
  } finally {
    await finish();
  }
});

test("Flashcard with no flashcard says what will appear, keeps the dots in its head and has one New flashcard, under the line", async () => {
  const { page, open, finish } = await start("flashcards");
  try {
    const lines = {
      it: /^Qui compariranno le tue flashcard, divise per materia\. Le scrivi tu, oppure le fa Pyxis dal tuo materiale\.$/,
      en: /^Your flashcards will appear here, by subject\. You write them, or Pyxis makes them from your material\.$/,
    };
    const names = { it: ["Altro sulle flashcard", "Nuova flashcard"], en: ["More for flashcards", "New flashcard"] };
    for (const look of looks) {
      const language = look.language;
      await show(page, look, "/flashcards");
      await expectEmptyPage(page, { line: lines[language], action: names[language][1] });
      await saveShot(page, `empty-pages/flashcards-${look.key}.png`);
      await headButtons(page, ".px-fc-head").toEqual([names[language][0]]);
    }
    const empty = await headBox(page.locator(".px-fc-head"));
    await page.getByRole("main").getByRole("button", { name: "New flashcard", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "New flashcard" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);

    // The first flashcard takes the page's place, and the head's buttons come back where the head was.
    const db = open();
    seedSubjects(db, [{ id: "phys", name: "Fisica I" }]);
    db.exec("INSERT INTO cards(id,subject_id,front,back,created_at) VALUES('c-1','phys','Che cos’è il campo?','Una grandezza in ogni punto.',1)");
    db.close();
    await page.reload();
    await expect(page.locator(".px-empty")).toHaveCount(0);
    await expect(page.locator(".px-fc-head").getByRole("button", { name: "New flashcard" })).toBeVisible();
    await expect(page.locator(".px-fc-head").getByRole("button", { name: "Browse all" })).toBeVisible();
    expect((await headBox(page.locator(".px-fc-head"))).y).toBe(empty.y);
  } finally {
    await finish();
  }
});

test("All flashcards with no flashcard says what will appear, keeps Import from Anki in the dots and has one New flashcard", async () => {
  const { page, finish } = await start("cards");
  try {
    const lines = {
      it: /^Qui compariranno tutte le tue flashcard, da cercare e modificare\. Le scrivi tu, oppure le fa Pyxis dal tuo materiale\.$/,
      en: /^All your flashcards will appear here, to search and edit\. You write them, or Pyxis makes them from your material\.$/,
    };
    const names = {
      it: ["Altro sulle flashcard", "Nuova flashcard", "Importa da Anki"] as const,
      en: ["More for flashcards", "New flashcard", "Import from Anki"] as const,
    };
    for (const look of looks) {
      const language = look.language;
      await show(page, look, "/flashcards/all");
      await expectEmptyPage(page, { line: lines[language], action: names[language][1] });
      await saveShot(page, `empty-pages/cards-${look.key}.png`);
      // The head has the way back and the dots; its menu offers the import and, with nothing to export, no export.
      await expect(page.getByRole("textbox", { name: /^(Cerca nelle flashcard|Search flashcards)$/ })).toHaveCount(0);
      const dots = page.getByRole("button", { name: names[language][0] });
      await expect(dots).toHaveCount(1);
      await dots.click();
      await expect(page.getByRole("menuitem")).toHaveText([names[language][2]]);
      await page.keyboard.press("Escape");
    }
    // A right-click on the head opens the same menu.
    await page.getByRole("heading", { level: 1, name: "All flashcards" }).click({ button: "right" });
    await expect(page.getByRole("menuitem", { name: "Import from Anki" })).toBeVisible();
    await page.keyboard.press("Escape");
    await page.getByRole("main").getByRole("button", { name: "New flashcard", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "New flashcard" })).toBeVisible();
  } finally {
    await finish();
  }
});

for (const [hash, name] of [
  ["/flashcards", "Flashcard"],
  ["/flashcards/all", "All flashcards"],
] as const)
  test(`${name} with no flashcard: its button opens the dialog, which asks before closing with text, keeps it on Resta qui and saves the card`, async () => {
    const { page, finish } = await start(`dialog-${name.toLowerCase().replace(/\W+/g, "-")}`);
    try {
      await show(page, looks[0], hash);
      await page.getByRole("main").getByRole("button", { name: "Nuova flashcard", exact: true }).click();
      const dialog = page.getByRole("dialog", { name: "Nuova flashcard" });
      await expect(dialog).toBeVisible();
      // With no subject the dialog starts on a new one, its name field focused.
      const subject = dialog.getByRole("textbox", { name: "Nome della nuova materia" });
      await expect(subject).toBeFocused();
      await subject.fill("Chimica organica");
      await dialog.getByRole("textbox", { name: "Fronte" }).fill("Formula del metano?");
      await dialog.getByRole("textbox", { name: "Retro" }).fill("CH4");

      // Escape with text typed asks first; "Resta qui" keeps the dialog and the text.
      await page.keyboard.press("Escape");
      const question = page.getByRole("dialog", { name: "Uscire senza salvare?" });
      await expect(question.getByRole("button", { name: "Resta qui" })).toBeFocused();
      await question.getByRole("button", { name: "Resta qui" }).click();
      await expect(question).toHaveCount(0);
      await expect(dialog).toBeVisible();
      await expect(dialog.getByRole("textbox", { name: "Fronte" })).toHaveValue("Formula del metano?");

      // Saving closes the dialog, and the empty page gives way to the card.
      await dialog.getByRole("button", { name: "Salva", exact: true }).click();
      await expect(dialog).toBeHidden();
      await expect(page.locator(".px-empty")).toHaveCount(0);
      // The button the dialog grew out of is gone with the empty page: the focus does not fall to the body.
      await expect.poll(() => page.evaluate(() => document.activeElement?.tagName)).not.toBe("BODY");
      await expect(page.getByRole("main").getByText(/Formula del metano\?|Chimica organica/).first()).toBeVisible();
    } finally {
      await finish();
    }
  });

test("The Library with no file says what will appear, keeps the free books in its dots and has one Link a folder, which opens Add sources on Folder", async () => {
  const { page, open, finish } = await start("library");
  try {
    await toLibrary(page);
    const lines = {
      it: /^Qui compariranno i tuoi file, divisi per materia\. Collega la cartella dove tieni il materiale e Pyxis li legge da lì\.$/,
      en: /^Your files will appear here, by subject\. Link the folder where you keep your material and Pyxis reads them from there\.$/,
    };
    const names = {
      it: ["Altro sulla Libreria", "Collega una cartella", "Aggiungi file"],
      en: ["More for the Library", "Link a folder", "Add files"],
    };
    for (const look of looks) {
      const language = look.language;
      await show(page, look, "/exams/library");
      await expectEmptyPage(page, { line: lines[language], action: names[language][1] });
      await saveShot(page, `empty-pages/library-${look.key}.png`);
      // The head holds the dots alone: neither "Aggiungi file" nor the folders control, and the books are offered once.
      await headButtons(page, ".px-library-head").toEqual([names[language][0]]);
      await expect(page.getByRole("button", { name: /Libri PoliTost gratuiti|Free PoliTost books/ })).toHaveCount(0);
    }
    const empty = await headBox(page.locator(".px-library-head"));
    await page.getByRole("button", { name: "More for the Library" }).click();
    await expect(page.getByRole("menuitem")).toHaveText(["Free PoliTost books"]);
    await page.keyboard.press("Escape");

    await page.getByRole("main").getByRole("button", { name: "Link a folder", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Add sources" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("radio", { name: "Folder" })).toBeChecked();
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);

    // The first file takes the page's place, and the head's "Aggiungi file" comes back where the head was.
    const db = open();
    seedSubjects(db, [{ id: "phys", name: "Fisica I" }]);
    seedSource(db, { id: "src", title: "Mazzoldi", subjectId: "phys", document: { id: "doc" }, passages: [{ id: "pa", text: "La velocità media.", section: "Cinematica" }] });
    db.close();
    await page.reload();
    await expect(page.getByRole("button", { name: "Add files", exact: true })).toBeVisible();
    await expect(page.locator(".px-empty")).toHaveCount(0);
    expect(await headBox(page.locator(".px-library-head"))).toEqual(empty);
  } finally {
    await finish();
  }
});

test("The mistakes notebook with no mistake says what will collect there, with no button", async () => {
  const { page, finish } = await start("mistakes");
  try {
    const lines = {
      it: /^Qui si raccolgono le domande che sbagli nei quiz, nelle simulazioni, nel test diagnostico e nelle verifiche rapide delle lezioni\. Ognuna esce quando rispondi giusto\.$/,
      en: /^Questions you miss in quizzes, simulations, the diagnostic test and lesson quick checks collect here\. Each one leaves once you answer it right\.$/,
    };
    for (const look of looks) {
      const language = look.language;
      await show(page, look, "/exams/mistakes");
      await expectEmptyPage(page, { line: lines[language] });
      await saveShot(page, `empty-pages/mistakes-${look.key}.png`);
    }
  } finally {
    await finish();
  }
});
