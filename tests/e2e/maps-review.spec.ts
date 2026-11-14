import { expect, test, type Page } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { launchPyxis } from "./app-under-test";
import { seedSubjects } from "./seed";
import { removeTestFolder } from "./cleanup";
import { fromChiediToExams } from "./doors";

/** A map of `root` with one branch and one concept. */
function graph(root: string) {
  const nodes = [
    { id: "n0", label: root, parent: null as string | null, x: 0, y: 0, pinned: false },
    { id: "b0", label: "Ramo", parent: "n0", x: 0, y: 0, pinned: false },
    { id: "b0l0", label: "Concetto", parent: "b0", x: 0, y: 0, pinned: false },
  ];
  const edges = [
    { from: "n0", to: "b0" },
    { from: "b0", to: "b0l0" },
  ];
  return { layout: "tree", undo: null, redo: null, nodes, edges };
}

/**
 * The app with Fisica 2, which has two maps of the whole subject and a build of it that failed, so the page of a map
 * offers Riprova and Chiudi under its title.
 */
async function startApp() {
  const userData = mkdtempSync(join(tmpdir(), "pyxis-maps-review-"));
  const app = await launchPyxis({ userData });
  const page = await app.firstWindow();
  await page.emulateMedia({ reducedMotion: "reduce" });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.getByRole("button", { name: "Salta" }).click();
  await fromChiediToExams(page);
  await page.evaluate(() => window.pyxis.invoke("plans.list", {}));
  const dbPath = join(userData, "workspace", "pyxis.db");
  const db = new DatabaseSync(dbPath, { timeout: 10000 });
  seedSubjects(db, [{ id: "fis", name: "Fisica 2" }]);
  const maps = [
    { id: "m-campo", title: "Campo elettrico", graph: graph("Campo elettrico") },
    { id: "m-rc", title: "Circuiti RC", graph: graph("Circuiti RC") },
  ].map((map) => ({ passageIds: [], grounding: "sources", ...map }));
  db.prepare("INSERT INTO maps(id,subject_id,graph_json,grounding,created_at) VALUES(?,?,?,'sources',1)").run(
    "row-fis",
    "fis",
    JSON.stringify({ version: 1, maps }),
  );
  db.prepare(
    "INSERT INTO jobs(id,kind,params_json,state,progress,error,created_at,updated_at) VALUES('build-fis','map-build',?,'failed',0,'offline',2,2)",
  ).run(JSON.stringify({ input: { subjectId: "fis" } }));
  db.close();
  await page.reload();
  return { app, page, userData, dbPath, errors };
}

async function openMaps(page: Page) {
  await page.getByRole("complementary", { name: "Barra laterale" }).getByRole("link", { name: /^Mappe/ }).click();
  await expect(page.getByRole("heading", { level: 2, name: "Fisica 2" })).toBeVisible();
}
const tile = (page: Page, title: string) =>
  page.locator(".px-maps-tilew").filter({ has: page.getByRole("heading", { level: 3, name: title, exact: true }) });

test("a tile's name field stays open with its word when it is left empty", async () => {
  test.setTimeout(120_000);
  const { app, page, userData, errors } = await startApp();
  try {
    await openMaps(page);
    const card = tile(page, "Circuiti RC");
    await card.hover();
    await card.getByRole("button", { name: "Altro su Circuiti RC" }).click();
    await page.getByRole("menuitem", { name: "Rinomina" }).click();
    const field = page.getByRole("textbox", { name: "Nome della mappa" });
    await expect(field).toBeFocused();
    await field.fill("   ");
    // Clicking away says the same as Enter does, and the field stays where the name was.
    await page.getByRole("heading", { level: 2, name: "Fisica 2" }).click();
    await expect(page.getByRole("alert")).toHaveText("Scrivi un nome per la mappa.");
    await expect(field).toBeVisible();
    await expect(field).toHaveAttribute("aria-invalid", "true");
    // Escape gives the name back as it was.
    await field.focus();
    await field.press("Escape");
    await expect(field).toHaveCount(0);
    await expect(tile(page, "Circuiti RC")).toHaveCount(1);
    expect(errors).toEqual([]);
  } finally {
    await app.close();
    removeTestFolder(userData);
  }
});

test("a map tile's dots show without hover, on a screen that has none", async () => {
  test.setTimeout(120_000);
  const { app, page, userData, errors } = await startApp();
  try {
    await openMaps(page);
    const dots = tile(page, "Circuiti RC").getByRole("button", { name: "Altro su Circuiti RC" });
    await page.mouse.move(0, 0);
    await expect(dots).toHaveCSS("opacity", "0");
    // The page is made to report a touch screen, as a Windows one does.
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 1 });
    await cdp.send("Emulation.setEmitTouchEventsForMouse", { enabled: true, configuration: "mobile" });
    await expect.poll(() => page.evaluate(() => matchMedia("(hover: none)").matches)).toBe(true);
    await expect(dots).toHaveCSS("opacity", "1");
    expect(errors).toEqual([]);
  } finally {
    await app.close();
    removeTestFolder(userData);
  }
});

test("a failed Chiudi on the build notice says so, and the notice keeps its buttons", async () => {
  test.setTimeout(120_000);
  const { app, page, userData, dbPath, errors } = await startApp();
  try {
    await openMaps(page);
    await tile(page, "Campo elettrico").getByRole("link").click();
    const notice = page.locator(".px-map-recover");
    await expect(notice).toContainText("L’ultima costruzione della mappa non è riuscita");
    // The database refuses to write the build, as a full disk would.
    const db = new DatabaseSync(dbPath, { timeout: 10000 });
    db.exec("CREATE TRIGGER refuse_dismiss BEFORE UPDATE OF dismissed ON jobs BEGIN SELECT RAISE(ABORT, 'disk full'); END");
    await notice.getByRole("button", { name: "Chiudi" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Non riesco a chiudere l’avviso. Riprova." })).toBeVisible();
    await expect(notice).toBeVisible();
    await expect(notice.getByRole("button", { name: "Chiudi" })).toBeEnabled();
    await expect(notice.getByRole("button", { name: "Riprova" })).toBeEnabled();
    // Once the write works, Chiudi takes the notice away, and the word with it.
    db.exec("DROP TRIGGER refuse_dismiss");
    db.close();
    await notice.getByRole("button", { name: "Chiudi" }).click();
    await expect(notice).toHaveCount(0);
    expect(errors).toEqual([]);
  } finally {
    await app.close();
    removeTestFolder(userData);
  }
});

test("a deleted map's note for Mappe never pulls back a page the student opens right after it, and the map is gone", async () => {
  test.setTimeout(120_000);
  const { app, page, userData, errors } = await startApp();
  try {
    // Mappe has been opened once, so the router already holds its code and its list.
    await openMaps(page);
    await tile(page, "Circuiti RC").getByRole("link").click();
    await expect(page.getByRole("heading", { level: 1, name: "Circuiti RC" })).toBeVisible();
    await page.locator(".px-map-actions").getByRole("button", { name: "Altro", exact: true }).click();
    await page.getByRole("menuitem", { name: "Elimina la mappa…" }).click();
    // The delete leaves through the map's way back, back to Mappe, which then reads a note once to shrink the tile. The
    // student moves on in the same instant, through the sidebar: that move has to win, whether it lands before the way
    // back, while it is under way, or after Mappe has opened.
    const confirm = page.getByRole("dialog").getByRole("button", { name: "Elimina la mappa" });
    await confirm.click();
    await page.getByRole("navigation", { name: "Sezioni" }).getByRole("link", { name: "Flashcard", exact: true }).click();
    await expect(page).toHaveURL(/#\/flashcards$/);
    // Give a late move time to land. It would take the student back to Mappe.
    await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 1000)));
    await expect(page).toHaveURL(/#\/flashcards$/);
    // The delete did not depend on Mappe being on screen: the map is gone when Mappe opens afresh, and nothing is left
    // to shrink or announce.
    await page.evaluate(() => {
      location.hash = "#/maps";
    });
    await expect(page.getByRole("heading", { level: 1, name: "Mappe" })).toBeVisible();
    await expect(tile(page, "Circuiti RC")).toHaveCount(0);
    await expect(tile(page, "Campo elettrico")).toHaveCount(1);
    expect(errors).toEqual([]);
  } finally {
    await app.close();
    removeTestFolder(userData);
  }
});
