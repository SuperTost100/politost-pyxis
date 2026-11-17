import { expect, test, type Page } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { launchPyxis } from "./app-under-test";
import { removeTestFolder } from "./cleanup";
import { fromChiediToExams } from "./doors";
import { seedSubjects } from "./seed";
import { animationsSettled, clickSettled } from "./settled";

// Every query and mutation of the app reads or writes local data over IPC. When the network drops, Chromium fires the
// window's "offline" event, and TanStack Query's default mode then pauses each of them for good; the app sets
// `networkMode: "always"` so none of them depends on the network. These specs fire that event the way the browser does.

/** The app open on its first page, with a workspace to seed. */
async function open(label: string) {
  const userData = mkdtempSync(join(tmpdir(), `pyxis-network-drop-${label}-`));
  const app = await launchPyxis({ userData });
  const page = await app.firstWindow();
  await page.getByRole("button", { name: "Salta" }).click();
  await fromChiediToExams(page);
  const db = new DatabaseSync(join(userData, "workspace", "pyxis.db"), { timeout: 10_000 });
  return {
    page,
    db,
    close: async () => {
      if (db.isOpen) db.close();
      await app.close();
      removeTestFolder(userData);
    },
  };
}

const subjectNames = (db: DatabaseSync) =>
  (db.prepare("SELECT name FROM subjects ORDER BY name").all() as Array<{ name: string }>).map((row) => row.name);
const offline = (page: Page) => page.evaluate(() => window.dispatchEvent(new Event("offline")));
const online = (page: Page) => page.evaluate(() => window.dispatchEvent(new Event("online")));

test("a query made after the network dropped answers, and the page still works when it is back", async () => {
  test.setTimeout(90_000);
  const { page, db, close } = await open("query");
  try {
    seedSubjects(db, [{ id: "ana", name: "Analisi 1" }]);
    db.exec(`INSERT INTO cards(id,subject_id,front,back,created_at) VALUES
      ('c1','ana','Limite?','Il valore a cui tende.',1), ('c2','ana','Derivata?','Il tasso di variazione.',2)`);
    await page.evaluate(() => {
      location.hash = "#/flashcards/all";
    });
    await page.reload();
    await expect(page.getByText("Derivata?")).toBeVisible();
    await offline(page);
    // A new search is a new query: with the network mode of the default it waited for a network that was not needed.
    await page.getByRole("textbox", { name: "Cerca nelle flashcard" }).fill("limite");
    await expect(page.getByText("Limite?")).toBeVisible();
    await expect(page.getByText("Derivata?")).toHaveCount(0);
    await online(page);
    await page.getByRole("textbox", { name: "Cerca nelle flashcard" }).fill("derivata");
    await expect(page.getByText("Derivata?")).toBeVisible();
    await expect(page.getByText("Limite?")).toHaveCount(0);
  } finally {
    await close();
  }
});

test("a mutation made after the network dropped is written, and the page still works when it is back", async () => {
  test.setTimeout(90_000);
  const { page, db, close } = await open("mutation");
  try {
    await page.getByRole("button", { name: "Altro su Esami", exact: true }).click();
    await clickSettled(page, page.getByRole("menuitem", { name: "Gestisci materie" }));
    await animationsSettled(page);
    await offline(page);
    const field = page.getByRole("textbox", { name: "Nuova materia" });
    // Adding a subject is a mutation: it stayed paused, with its field full, until the network came back.
    await field.fill("Chimica");
    await page.getByRole("button", { name: "Aggiungi", exact: true }).click();
    await expect(field).toHaveValue("");
    await expect(page.getByRole("button", { name: "Riordina Chimica" })).toBeVisible();
    expect(subjectNames(db)).toEqual(["Chimica"]);
    await online(page);
    await field.fill("Fisica");
    await page.getByRole("button", { name: "Aggiungi", exact: true }).click();
    await expect(page.getByRole("button", { name: "Riordina Fisica" })).toBeVisible();
    expect(subjectNames(db)).toEqual(["Chimica", "Fisica"]);
  } finally {
    await close();
  }
});

test("a flashcard is filed under the subject made after the network dropped, not under the first one", async () => {
  test.setTimeout(90_000);
  const { page, db, close } = await open("subject");
  try {
    await page.evaluate(() => window.pyxis.invoke("plans.list", {}));
    seedSubjects(db, [{ id: "ana", name: "Analisi 1" }]);
    await page.evaluate(() => {
      location.hash = "#/flashcards";
    });
    await expect(page).toHaveURL(/#\/flashcards$/);
    // The page has read its subjects: Analisi 1 only. Then the network drops, and the student makes Chimica.
    await expect(page.getByRole("button", { name: "Nuova flashcard", exact: true })).toBeVisible();
    await offline(page);
    await page.evaluate(() => {
      location.hash = "#/exams";
    });
    await page.getByRole("button", { name: "Altro su Esami", exact: true }).click();
    await clickSettled(page, page.getByRole("menuitem", { name: "Gestisci materie" }));
    await animationsSettled(page);
    await page.getByRole("textbox", { name: "Nuova materia" }).fill("Chimica");
    await page.getByRole("button", { name: "Aggiungi", exact: true }).click();
    await expect(page.getByRole("button", { name: "Riordina Chimica" })).toBeVisible();
    await clickSettled(page, page.getByRole("dialog", { name: "Gestisci materie" }).getByRole("button", { name: "Chiudi" }));
    const chem = db.prepare("SELECT id FROM subjects WHERE name = 'Chimica'").get() as { id: string };
    // As the Library's "Crea flashcard di questa materia" asks. The subjects are read again, and with that read paused
    // the dialog took the list it had, found no Chimica, and chose Analisi 1.
    await page.evaluate((id) => {
      location.hash = `#/flashcards?new=hand&subject=${id}`;
    }, chem.id);
    const dialog = page.getByRole("dialog", { name: "Nuova flashcard" });
    await expect(dialog).toBeVisible();
    const subject = dialog.getByRole("combobox", { name: "Materia" });
    await expect(subject).toBeEnabled();
    await expect(subject).toHaveValue(chem.id);
    await dialog.getByRole("textbox", { name: "Fronte" }).fill("Numero atomico?");
    await dialog.getByRole("textbox", { name: "Retro" }).fill("Protoni nel nucleo.");
    await dialog.getByRole("button", { name: "Salva", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    expect(
      db.prepare("SELECT c.front, s.name AS subject FROM cards c JOIN subjects s ON s.id = c.subject_id").all(),
    ).toEqual([expect.objectContaining({ front: "Numero atomico?", subject: "Chimica" })]);
    await online(page);
    await page.evaluate(() => {
      location.hash = "#/flashcards/all";
    });
    await expect(page.getByText("Numero atomico?")).toBeVisible();
  } finally {
    await close();
  }
});
