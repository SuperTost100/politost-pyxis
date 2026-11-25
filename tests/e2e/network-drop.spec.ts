import { expect, test, type Page } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { launchPyxis } from "./app-under-test";
import { removeTestFolder } from "./cleanup";
import { seedPlan, seedSubjects } from "./seed";
import { animationsSettled } from "./settled";

// Every query and mutation of the app reads or writes local data over IPC. When the network drops, Chromium fires the
// window's "offline" event, and TanStack Query's default mode then pauses each of them for good; the app sets
// `networkMode: "always"` so none of them depends on the network. These specs fire that event the way the browser does.

/** The app open on the Exams home, with a workspace to seed. */
async function open(label: string) {
  const userData = mkdtempSync(join(tmpdir(), `pyxis-network-drop-${label}-`));
  const app = await launchPyxis({ userData });
  const page = await app.firstWindow();
  await page.getByRole("button", { name: "Salta" }).click();
  await expect(page).toHaveURL(/#\/exams$/);
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
    seedPlan(db, { id: "p-ana", subjectId: "ana", title: "Analisi 1", language: "it", topics: [{ id: "t-lim", title: "Limiti" }] });
    db.exec(`INSERT INTO cards(id,plan_id,topic_id,front,back,created_at) VALUES
      ('c1','p-ana','t-lim','Limite?','Il valore a cui tende.',1), ('c2','p-ana','t-lim','Derivata?','Il tasso di variazione.',2)`);
    await page.evaluate(() => {
      location.hash = "#/exams/cards";
    });
    await page.reload();
    await expect(page.getByText("Derivata?")).toBeVisible();
    await offline(page);
    // A new search is a new query: with the default network mode it waited for a network it did not need.
    const search = page.getByRole("textbox", { name: "Cerca nelle flashcard" });
    await search.fill("limite");
    await expect(page.getByText("Limite?")).toBeVisible();
    await expect(page.getByText("Derivata?")).toHaveCount(0);
    await online(page);
    await search.fill("derivata");
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
    // With no exams yet, the subjects are in the Exams home's More menu.
    await page.getByRole("button", { name: "Altro", exact: true }).click();
    await page.getByRole("menuitem", { name: "Gestisci materie" }).click();
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
