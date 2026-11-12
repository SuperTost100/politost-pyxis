import { expect, test, type Locator, type Page } from "@playwright/test";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { launchPyxis } from "./app-under-test";
import { seedPlan, seedSource, seedSubjects } from "./seed";
import { removeTestFolder } from "./cleanup";
import { fromChiediToExams } from "./doors";
import { expectNoAxeViolations } from "./axe";
import { atRest } from "./settled";
import { saveShot } from "./shots";

/** A map of `root` with these branches, each with its concepts. */
function graph(root: string, branches: Array<[string, string[]]>) {
  const nodes = [{ id: "n0", label: root, parent: null as string | null, x: 0, y: 0, pinned: false }];
  const edges: Array<{ from: string; to: string }> = [];
  branches.forEach(([branch, leaves], b) => {
    nodes.push({ id: `b${b}`, label: branch, parent: "n0", x: 0, y: 0, pinned: false });
    edges.push({ from: "n0", to: `b${b}` });
    leaves.forEach((leaf, l) => {
      nodes.push({ id: `b${b}l${l}`, label: leaf, parent: `b${b}`, x: 0, y: 0, pinned: false });
      edges.push({ from: `b${b}`, to: `b${b}l${l}` });
    });
  });
  return { layout: "tree", undo: null, redo: null, nodes, edges };
}
const limits = graph("Limiti", [
  ["Definizioni", ["Limite finito", "Limite infinito"]],
  ["Teoremi", ["Unicità del limite", "Permanenza del segno"]],
  ["Limiti notevoli", ["sin x / x"]],
]);
const theorems = graph("Teoremi sui limiti", [
  ["Unicità del limite", ["Dimostrazione per assurdo"]],
  ["Confronto (carabinieri)", ["Dimostrazione con le disuguaglianze"]],
]);
const theoremsAsked = "solo i teoremi, con le dimostrazioni";

/**
 * The app with Analisi 1 (an exam whose topic Limiti has two maps, one asked for in words, Successioni one and Numeri
 * reali none yet, with material to build one from), Fisica 2 (two maps of the whole subject) and Chimica (one map, its
 * only one). `env` sets the recorded engine for a build.
 */
async function startApp(env: Record<string, string> = {}) {
  const userData = mkdtempSync(join(tmpdir(), "pyxis-maps-menu-"));
  const app = await launchPyxis({ userData, env });
  const page = await app.firstWindow();
  await page.emulateMedia({ reducedMotion: "reduce" });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.getByRole("button", { name: "Salta" }).click();
  await fromChiediToExams(page);
  await page.evaluate(() => window.pyxis.invoke("plans.list", {}));
  const db = new DatabaseSync(join(userData, "workspace", "pyxis.db"), { timeout: 10000 });
  seedSubjects(db, [
    { id: "an", name: "Analisi 1" },
    { id: "fis", name: "Fisica 2" },
    { id: "chem", name: "Chimica" },
  ]);
  seedPlan(db, {
    id: "p-an",
    subjectId: "an",
    title: "Appello del 14 gennaio",
    topics: [
      { id: "t-lim", title: "Limiti" },
      { id: "t-succ", title: "Successioni" },
      { id: "t-real", title: "Numeri reali" },
    ],
  });
  seedSource(db, {
    id: "bramanti",
    title: "Bramanti",
    subjectId: "an",
    document: { id: "bramanti-doc" },
    passages: [
      { id: "pa-1", text: "Un insieme limitato superiormente ha un estremo superiore.", section: "Numeri reali" },
      { id: "pa-2", text: "I numeri reali sono un campo ordinato completo.", section: "Numeri reali" },
    ],
  });
  db.exec("INSERT INTO topic_passages(topic_id,passage_id) SELECT 't-real', id FROM passages WHERE source_id = 'bramanti'");
  const collection = (maps: Array<{ id: string; title: string; graph: unknown; instruction?: string }>) =>
    JSON.stringify({ version: 1, maps: maps.map((map) => ({ passageIds: [], grounding: "sources", ...map })) });
  const topicRow = db.prepare(
    "INSERT INTO maps(id,plan_id,topic_id,graph_json,grounding,created_at) VALUES(?,?,?,?,'sources',1)",
  );
  const subjectRow = db.prepare(
    "INSERT INTO maps(id,subject_id,graph_json,grounding,created_at) VALUES(?,?,?,'sources',1)",
  );
  topicRow.run(
    "row-lim",
    "p-an",
    "t-lim",
    collection([
      { id: "m-lim", title: "Limiti", graph: limits },
      { id: "m-teo", title: "Teoremi sui limiti", graph: theorems, instruction: theoremsAsked },
    ]),
  );
  topicRow.run(
    "row-succ",
    "p-an",
    "t-succ",
    collection([{ id: "m-succ", title: "Successioni", graph: graph("Successioni", [["Convergenza", ["Limitatezza"]]]) }]),
  );
  subjectRow.run(
    "row-fis",
    "fis",
    collection([
      { id: "m-campo", title: "Campo elettrico", graph: graph("Campo elettrico", [["Legge di Gauss", ["Flusso"]]]) },
      {
        id: "m-rc",
        title: "Circuiti RC",
        graph: graph("Circuiti RC", [["Carica", ["Costante di tempo"]]]),
        instruction: "solo la carica e la scarica, con i grafici",
      },
    ]),
  );
  subjectRow.run(
    "row-chem",
    "chem",
    collection([{ id: "m-atom", title: "Struttura dell’atomo", graph: graph("Atomo", [["Protoni", ["Carica positiva"]]]) }]),
  );
  db.close();
  await page.reload();
  return { app, page, userData, errors };
}

async function openMaps(page: Page) {
  await page.getByRole("complementary", { name: "Barra laterale" }).getByRole("link", { name: /^Mappe/ }).click();
  await expect(page.getByRole("heading", { level: 2, name: "Analisi 1" })).toBeVisible();
}
const tile = (page: Page, title: string) => page.locator(".px-maps-tilew").filter({ has: page.getByRole("heading", { level: 3, name: title, exact: true }) });
async function menuItems(page: Page) {
  const menu = page.locator(".px-item-menu:not(.ant-dropdown-hidden) .ant-dropdown-menu-root").last();
  await expect(menu).toBeVisible();
  return menu.locator(":scope > li").evaluateAll((items) =>
    items.map((item) => (item.getAttribute("role") === "separator" || item.classList.contains("ant-dropdown-menu-item-divider") ? "-" : (item.textContent ?? "").trim())),
  );
}
/** A spot on the canvas with no concept under it. */
async function emptyCanvasSpot(page: Page) {
  const box = (await page.locator(".px-map-canvas").boundingBox())!;
  return { x: box.x + 24, y: box.y + 24 };
}

test("the map page keeps its tools on the canvas, its maps beside the title and three actions in its menu", async () => {
  test.setTimeout(180_000);
  const { app, page, userData, errors } = await startApp();
  try {
    await openMaps(page);
    await tile(page, "Limiti").getByRole("link").click();
    await expect(page.locator(".react-flow__node")).toHaveCount(9);
    await expect(page.getByRole("heading", { level: 1, name: "Limiti" })).toBeVisible();

    // The strip on the canvas: the layout, undo and redo, and fit. Undo takes the layout back, redo brings it again.
    const strip = page.getByRole("toolbar", { name: "Strumenti della mappa" });
    const tree = strip.getByRole("radio", { name: "Albero" });
    const radial = strip.getByRole("radio", { name: "Radiale" });
    await expect(tree).toHaveAttribute("aria-checked", "true");
    await expect(strip.getByRole("button", { name: "Annulla" })).toBeDisabled();
    await expect(strip.getByRole("button", { name: "Ripeti" })).toBeDisabled();
    await radial.click();
    await expect(radial).toHaveAttribute("aria-checked", "true");
    await strip.getByRole("button", { name: "Annulla" }).click();
    await expect(tree).toHaveAttribute("aria-checked", "true");
    await strip.getByRole("button", { name: "Ripeti" }).click();
    await expect(radial).toHaveAttribute("aria-checked", "true");
    await expect(strip.getByRole("button", { name: "Adatta la mappa" })).toBeEnabled();
    await tree.click();
    await expect(tree).toHaveAttribute("aria-checked", "true");

    // The dots hold three actions and no shortcuts.
    const dots = page.locator(".px-map-actions").getByRole("button", { name: "Altro", exact: true });
    await dots.click();
    expect(await menuItems(page)).toEqual(["Rinomina", "Esporta", "-", "Elimina la mappa…"]);
    await expect(page.getByText("Scorciatoie")).toHaveCount(0);
    await expectNoAxeViolations(page);
    // Esporta opens its formats with the right arrow, the left arrow closes them, Escape closes the menu.
    await page.keyboard.press("ArrowDown");
    await expect(page.getByRole("menuitem", { name: "Rinomina" })).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(page.getByRole("menuitem", { name: "Esporta" })).toBeFocused();
    await page.keyboard.press("ArrowRight");
    await expect(page.getByRole("menuitem", { name: /^Schema in testo/ })).toBeVisible();
    await expect(page.getByRole("menuitem", { name: /^Solo quello che vedi/ })).toBeVisible();
    await expectNoAxeViolations(page);
    await page.keyboard.press("ArrowLeft");
    await expect(page.getByRole("menuitem", { name: /^Schema in testo/ })).toBeHidden();
    await expect(page.getByRole("menuitem", { name: "Esporta" })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("menuitem", { name: "Esporta" })).toBeHidden();
    await expect(dots).toBeFocused();

    // A right-click on the empty canvas opens the same menu at the pointer; one on a concept does not.
    const spot = await emptyCanvasSpot(page);
    await page.mouse.click(spot.x, spot.y, { button: "right" });
    expect(await menuItems(page)).toEqual(["Rinomina", "Esporta", "-", "Elimina la mappa…"]);
    const opened = (await page.locator(".px-item-menu:not(.ant-dropdown-hidden)").last().boundingBox())!;
    expect(Math.abs(opened.x - spot.x)).toBeLessThan(40);
    await page.keyboard.press("Escape");
    await expect(page.getByRole("menuitem", { name: "Rinomina" })).toBeHidden();
    await page.locator(".react-flow__node", { hasText: "Definizioni" }).click({ button: "right" });
    await expect(page.getByRole("menuitem", { name: "Rinomina" })).toHaveCount(0);

    // The topic has two maps, so the switcher beside the title names this one by its request and lists both.
    const switcher = page.locator(".px-map-title-row").getByRole("button", { name: /^Mappe di Limiti, ora: Mappa completa$/ });
    await expect(switcher).toHaveText("Mappa completa");
    await switcher.click();
    const choices = page.getByRole("menuitemradio");
    await expect(choices).toHaveCount(2);
    await expect(choices.first()).toHaveAttribute("aria-checked", "true");
    await expect(choices.nth(1)).toContainText(`«${theoremsAsked}»`);
    await expect(choices.nth(1)).toContainText("Teoremi sui limiti");
    await expectNoAxeViolations(page);
    await choices.nth(1).click();
    await expect(page).toHaveURL(/map=m-teo/);
    await expect(page.getByRole("heading", { level: 1, name: "Teoremi sui limiti" })).toBeVisible();
    await expect(page.locator(".px-map-title-row").getByRole("button", { name: /ora: «solo i teoremi/ })).toBeFocused();

    // A topic with one map has no switcher.
    await page.locator(".px-map-page").getByRole("link", { name: "Mappe", exact: true }).click();
    await tile(page, "Successioni").getByRole("link").click();
    await expect(page.getByRole("heading", { level: 1, name: "Successioni" })).toBeVisible();
    await expect(page.locator(".px-map-switch")).toHaveCount(0);
    expect(errors).toEqual([]);
  } finally {
    await app.close();
    removeTestFolder(userData);
  }
});

test("a map is renamed in place on its page and on its tile, and an empty name is refused", async () => {
  test.setTimeout(180_000);
  const { app, page, userData, errors } = await startApp();
  try {
    await openMaps(page);
    await tile(page, "Limiti").getByRole("link").click();
    const title = page.getByRole("heading", { level: 1, name: "Limiti" });
    await expect(title).toBeVisible();
    const dots = page.locator(".px-map-actions").getByRole("button", { name: "Altro", exact: true });
    const rename = async () => {
      await dots.click();
      await page.getByRole("menuitem", { name: "Rinomina" }).click();
      return page.getByRole("textbox", { name: "Nome della mappa" });
    };
    let field = await rename();
    await expect(field).toBeFocused();
    await expect(field).toHaveValue("Limiti");
    // An empty name is refused and said so; Escape leaves the name as it was.
    await field.fill("   ");
    await field.press("Enter");
    await expect(page.getByRole("alert")).toHaveText("Scrivi un nome per la mappa.");
    await expect(field).toHaveAttribute("aria-invalid", "true");
    await field.press("Escape");
    await expect(title).toBeVisible();
    await expect(title).toBeFocused();
    // Another map's name is allowed, and Enter saves.
    field = await rename();
    await field.fill("Teoremi sui limiti");
    await field.press("Enter");
    const renamed = page.getByRole("heading", { level: 1, name: "Teoremi sui limiti" });
    await expect(renamed).toBeVisible();
    await expect(renamed).toBeFocused();
    await expect(page.locator("[aria-live]").filter({ hasText: "Ora la mappa si chiama «Teoremi sui limiti»." })).toHaveCount(1);
    // A long name is cut in the header and whole on hover.
    field = await rename();
    const long = "Limiti, continuità e teoremi fondamentali con tutte le dimostrazioni e gli esempi svolti in aula";
    await field.fill(long);
    await field.press("Enter");
    const longTitle = page.getByRole("heading", { level: 1, name: long });
    await expect(longTitle).toHaveAttribute("title", long);
    const cut = await longTitle.evaluate((el) => el.scrollWidth > el.clientWidth);
    expect(cut).toBe(true);
    await expect(page.locator(".px-map-actions").getByRole("button", { name: "Crea flashcard da questa mappa" })).toBeInViewport();
    await saveShot(page, "maps-menu/long-title.png");

    // On Mappe the tile renames in place too, from its dots.
    await page.locator(".px-map-page").getByRole("link", { name: "Mappe", exact: true }).click();
    const card = tile(page, "Successioni");
    await card.hover();
    await card.getByRole("button", { name: "Altro su Successioni" }).click();
    expect(await menuItems(page)).toEqual(["Apri", "Rinomina", "Esporta", "-", "Elimina la mappa…"]);
    await page.getByRole("menuitem", { name: "Rinomina" }).click();
    const tileField = page.getByRole("textbox", { name: "Nome della mappa" });
    await expect(tileField).toBeFocused();
    await tileField.fill("Successioni e serie");
    await tileField.press("Enter");
    await expect(page.getByRole("heading", { level: 3, name: "Successioni e serie" })).toBeVisible();
    await expect(tile(page, "Successioni e serie").getByRole("link")).toBeFocused();
    // The search finds it by its new name.
    await page.getByRole("textbox", { name: "Cerca nelle mappe" }).fill("serie");
    await expect(page.getByRole("status")).toHaveText("1 mappa");
    expect(errors).toEqual([]);
  } finally {
    await app.close();
    removeTestFolder(userData);
  }
});

test("a double-click on a map's title renames it in place, and a double-click on a tile opens the map instead", async () => {
  test.setTimeout(180_000);
  const { app, page, userData, errors } = await startApp();
  try {
    await openMaps(page);
    // A tile opens its map on a click, so a double-click on its title opens it and renames nothing.
    await tile(page, "Limiti").getByRole("heading", { level: 3 }).dblclick();
    const title = page.getByRole("heading", { level: 1, name: "Limiti" });
    await expect(title).toBeVisible();
    await expect(page.getByRole("textbox", { name: "Nome della mappa" })).toHaveCount(0);
    // On its page the title is the map's name: a double-click edits it, with the name selected.
    await title.dblclick();
    const field = page.getByRole("textbox", { name: "Nome della mappa" });
    await expect(field).toBeFocused();
    await expect(field).toHaveValue("Limiti");
    expect(await field.evaluate((input: HTMLInputElement) => input.value.slice(input.selectionStart!, input.selectionEnd!))).toBe("Limiti");
    await field.fill("Limiti e continuità");
    await field.press("Enter");
    const renamed = page.getByRole("heading", { level: 1, name: "Limiti e continuità" });
    await expect(renamed).toBeVisible();
    await expect(renamed).toBeFocused();
    expect(errors).toEqual([]);
  } finally {
    await app.close();
    removeTestFolder(userData);
  }
});

test("a map is deleted after one confirmation, from its page or its tile, and its links land on Mappe", async () => {
  test.setTimeout(180_000);
  const { app, page, userData, errors } = await startApp();
  try {
    await openMaps(page);
    // From the page: Annulla has the focus and keeps the map.
    await tile(page, "Teoremi sui limiti").getByRole("link").click();
    await expect(page.getByRole("heading", { level: 1, name: "Teoremi sui limiti" })).toBeVisible();
    const dots = page.locator(".px-map-actions").getByRole("button", { name: "Altro", exact: true });
    const askDelete = async () => {
      await dots.click();
      await page.getByRole("menuitem", { name: "Elimina la mappa…" }).click();
      const dialog = page.getByRole("dialog", { name: "Eliminare la mappa «Teoremi sui limiti»?" });
      await expect(dialog).toBeVisible();
      return dialog;
    };
    let dialog = await askDelete();
    await expect(dialog).toContainText("Le flashcard che hai creato da questa mappa restano tra le tue flashcard.");
    await expect(dialog.getByRole("button", { name: "Annulla" })).toBeFocused();
    await expectNoAxeViolations(page);
    await saveShot(page, "maps-menu/confirm.png");
    await dialog.getByRole("button", { name: "Annulla" }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByRole("heading", { level: 1, name: "Teoremi sui limiti" })).toBeVisible();
    // Confirming leads back to Mappe, where the tile goes and the other map of the topic stays.
    dialog = await askDelete();
    await dialog.getByRole("button", { name: "Elimina la mappa" }).click();
    await expect(page).toHaveURL(/#\/maps\?subject=an$/);
    await expect(tile(page, "Teoremi sui limiti")).toHaveCount(0);
    await expect(tile(page, "Limiti")).toHaveCount(1);
    await expect(page.locator("[aria-live]").filter({ hasText: "Ho eliminato la mappa «Teoremi sui limiti»." })).toHaveCount(1);
    // Focus goes to the tile that took its place.
    await expect(tile(page, "Successioni").getByRole("link")).toBeFocused();
    // The topic has one map now, so its page has no switcher.
    await tile(page, "Limiti").getByRole("link").click();
    await expect(page.locator(".px-map-switch")).toHaveCount(0);
    // A link to the deleted map lands on Mappe, which says so.
    await page.evaluate(() => {
      location.hash = "#/maps/an/t-lim?from=maps&map=m-teo";
    });
    await expect(page).toHaveURL(/#\/maps\?subject=an$/);
    await expect(page.getByText("Quella mappa non c’è più: è stata eliminata.")).toBeVisible();

    // From a tile, by right-click: the tile keeps its hover look while the menu is open.
    const campo = tile(page, "Campo elettrico");
    await campo.locator(".px-maps-thumb").click({ button: "right" });
    await expect(campo).toHaveClass(/is-ctx/);
    expect(await menuItems(page)).toEqual(["Apri", "Rinomina", "Esporta", "-", "Elimina la mappa…"]);
    await page.getByRole("menuitem", { name: "Elimina la mappa…" }).click();
    dialog = page.getByRole("dialog", { name: "Eliminare la mappa «Campo elettrico»?" });
    await dialog.getByRole("button", { name: "Annulla" }).click();
    await expect(campo).toHaveCount(1);
    await campo.locator(".px-maps-thumb").click({ button: "right" });
    await page.getByRole("menuitem", { name: "Elimina la mappa…" }).click();
    await dialog.getByRole("button", { name: "Elimina la mappa" }).click();
    await expect(campo).toHaveCount(0);
    await expect(tile(page, "Circuiti RC").getByRole("link")).toBeFocused();
    await expect(page.locator(".px-maps-subject", { hasText: "Fisica 2" }).locator("header .small")).toHaveText("1 mappa");

    // The last map of a subject, deleted from its page: the subject leaves Mappe with it.
    await tile(page, "Struttura dell’atomo").getByRole("link").click();
    await dots.click();
    await page.getByRole("menuitem", { name: "Elimina la mappa…" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Elimina la mappa" }).click();
    await expect(page).toHaveURL(/#\/maps\?subject=chem$/);
    await expect(page.getByRole("heading", { level: 2, name: "Chimica" })).toHaveCount(0);
    await expect(page.getByRole("heading", { level: 2, name: "Fisica 2" })).toBeVisible();
    expect(errors).toEqual([]);
  } finally {
    await app.close();
    removeTestFolder(userData);
  }
});

test("a delete that fails says so on the tile, which stays", async () => {
  test.setTimeout(120_000);
  const { app, page, userData, errors } = await startApp();
  const db = () => new DatabaseSync(join(userData, "workspace", "pyxis.db"), { timeout: 10000 });
  try {
    await openMaps(page);
    const card: Locator = tile(page, "Successioni");
    await expect(card).toHaveCount(1);
    // The maps' table is away while the delete is asked for, and back after.
    const away = db();
    away.exec("ALTER TABLE maps RENAME TO maps_away");
    away.close();
    await card.hover();
    await card.getByRole("button", { name: "Altro su Successioni" }).click();
    await page.getByRole("menuitem", { name: "Elimina la mappa…" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Elimina la mappa" }).click();
    await expect(card.getByRole("alert")).toHaveText("Non riesco a eliminare la mappa. Riprova.");
    await expect(card).toHaveCount(1);
    const back = db();
    back.exec("ALTER TABLE maps_away RENAME TO maps");
    back.close();
    expect(errors).toEqual([]);
  } finally {
    await app.close();
    removeTestFolder(userData);
  }
});

test("deleting a map still being written stops its build, and the build never brings it back", async () => {
  test.setTimeout(120_000);
  const asked = "solo le definizioni";
  const reply = {
    result: {
      kind: "map",
      nodes: ["Numeri reali", "Campo ordinato", "Estremo superiore"].map((label, i) => ({
        id: `n${i}`,
        label,
        parent: i ? "n0" : null,
        sources: "{{allPassages}}",
      })),
      edges: [],
    },
  };
  const { app, page, userData, errors } = await startApp({
    PYXIS_E2E_MAP_REPLIES: JSON.stringify({ result: [reply] }),
    PYXIS_E2E_MAP_DELAY: "3000",
  });
  try {
    await page.evaluate(
      (instruction) => window.pyxis.invoke("maps.generate", { planId: "p-an", topicId: "t-real", instruction }),
      asked,
    );
    await page.evaluate(() => {
      location.hash = "#/maps/an/t-real";
    });
    await expect(page.locator(".px-map-working")).toBeVisible();
    // While it is written there is nothing to rename or export, and no tools on a canvas; deleting stops it.
    await expect(page.locator(".px-map-strip")).toHaveCount(0);
    await page.locator(".px-map-actions").getByRole("button", { name: "Altro", exact: true }).click();
    await expect(page.getByRole("menuitem", { name: "Rinomina" })).toHaveAttribute("aria-disabled", "true");
    await expect(page.getByRole("menuitem", { name: "Esporta" })).toHaveAttribute("aria-disabled", "true");
    await page.getByRole("menuitem", { name: "Elimina la mappa…" }).click();
    const dialog = page.getByRole("dialog", { name: `Eliminare la mappa «${asked}»?` });
    await expect(dialog).toContainText("Pyxis smette di scriverla");
    await dialog.getByRole("button", { name: "Elimina la mappa" }).click();
    await expect(page).toHaveURL(/#\/maps\?subject=an$/);
    // The recorded reply comes after the delete; no map appears, and Attività has nothing to resume.
    await page.waitForTimeout(4000);
    expect(await page.evaluate(() => window.pyxis.invoke("maps.list", { planId: "p-an", topicId: "t-real" }))).toEqual([]);
    const jobs = await page.evaluate(() => window.pyxis.invoke("jobs.list", {}));
    expect(jobs.filter((job) => job.kind === "map-build")).toEqual([]);
    await expect(page.getByRole("heading", { level: 3, name: "Numeri reali" })).toHaveCount(0);
    expect(errors).toEqual([]);
  } finally {
    await app.close();
    removeTestFolder(userData);
  }
});

/** A recorded model reply that builds a map of these concepts. */
function reply(concepts: string[]) {
  return {
    result: {
      kind: "map",
      nodes: concepts.map((label, i) => ({ id: `n${i}`, label, parent: i ? "n0" : null, sources: "{{allPassages}}" })),
      edges: [],
    },
  };
}
/**
 * The recorded replies: a map of the whole topic is looked up by its nodes, and the maps asked for in words take the
 * entries of `asked` by the number of the model call, which also counts the whole-topic map's (so the first request in
 * words after it is `asked[1]`).
 */
const recorded = (asked: unknown[]) =>
  JSON.stringify({
    nodes: {
      nodes: ["Numeri reali", "Campo ordinato", "Estremo superiore", "Estremo inferiore", "Densità", "Completezza", "Intervalli", "Valore assoluto"].map(
        (label, i) => ({ id: `n${i}`, label, parent: i ? "n0" : null, sources: "{{allPassages}}" }),
      ),
      edges: [],
    },
    result: asked,
  });

/** The scope's newest build, with the app's own words for its state. */
const buildOf = (page: Page) =>
  page.evaluate(() => window.pyxis.invoke("maps.build", { planId: "p-an", topicId: "t-real" }));
/** Asks for a map of Numeri reali, with `instruction` or without, and waits for its build to end. */
async function askAndWait(page: Page, instruction: string | undefined, state: "succeeded" | "failed") {
  await page.evaluate(
    (words) => window.pyxis.invoke("maps.generate", { planId: "p-an", topicId: "t-real", ...(words ? { instruction: words } : {}) }),
    instruction,
  );
  await expect.poll(async () => (await buildOf(page))?.state, { timeout: 60_000 }).toBe(state);
}
const recovery = (page: Page) => page.locator(".px-map-notice").filter({ has: page.getByRole("button", { name: /^(Riprova|Riprendi)$/ }) });

test("a build that failed next to a map is offered again whenever the page opens, until the student starts it or clears it", async () => {
  test.setTimeout(180_000);
  const { app, page, userData, errors } = await startApp({
    PYXIS_E2E_MAP_REPLIES: recorded([reply(["Teoremi", "Unicità del limite", "Confronto", "Permanenza del segno"]), { fail: "offline" }, reply(["Teoremi", "Unicità del limite", "Confronto", "Permanenza del segno"])]),
  });
  try {
    await askAndWait(page, undefined, "succeeded");
    await askAndWait(page, "solo i teoremi", "failed");

    // The page opens on a build that ended long before: its map is there and the way to ask again is next to it.
    await page.evaluate(() => {
      location.hash = "#/maps/an/t-real";
    });
    await expect(page.locator(".react-flow__node").first()).toBeVisible();
    await expect(recovery(page)).toContainText("L’ultima costruzione della mappa non è riuscita");
    await expect(recovery(page).getByRole("button", { name: "Riprova" })).toBeEnabled();

    // Leaving and coming back finds it again, as does a reload.
    await openMaps(page);
    await tile(page, "Numeri reali").getByRole("link").click();
    await expect(page.locator(".react-flow__node").first()).toBeVisible();
    await expect(recovery(page).getByRole("button", { name: "Riprova" })).toBeVisible();
    await page.reload();
    await expect(recovery(page).getByRole("button", { name: "Riprova" })).toBeVisible();
    await expectNoAxeViolations(page);
    await saveShot(page, "maps-menu/build-failed.png");

    // Riprova asks again with the same words, and the line goes while it builds and after it.
    await recovery(page).getByRole("button", { name: "Riprova" }).click();
    await expect(recovery(page)).toHaveCount(0);
    await expect.poll(async () => (await buildOf(page))?.state, { timeout: 60_000 }).toBe("succeeded");
    await expect(recovery(page)).toHaveCount(0);
    expect(await page.evaluate(() => window.pyxis.invoke("maps.list", { planId: "p-an", topicId: "t-real" }))).toHaveLength(2);
    expect(errors).toEqual([]);
  } finally {
    await app.close();
    removeTestFolder(userData);
  }
});

test("a build the student stopped is offered again, and Chiudi gives it up for good", async () => {
  test.setTimeout(180_000);
  const { app, page, userData, errors } = await startApp({
    PYXIS_E2E_MAP_REPLIES: recorded([reply(["Teoremi", "Unicità del limite", "Confronto", "Permanenza del segno"])]),
    PYXIS_E2E_MAP_DELAY: "3000",
  });
  try {
    await askAndWait(page, undefined, "succeeded");
    // The second request is held up, so it can be stopped while it runs.
    await page.evaluate(() => window.pyxis.invoke("maps.generate", { planId: "p-an", topicId: "t-real", instruction: "solo i teoremi" }));
    await page.evaluate(async () => {
      const build = (await window.pyxis.invoke("maps.build", { planId: "p-an", topicId: "t-real" }))!;
      await window.pyxis.invoke("jobs.cancel", { jobId: build.jobId });
    });
    await expect.poll(async () => (await buildOf(page))?.state).toBe("cancelled");
    await page.evaluate(() => {
      location.hash = "#/maps/an/t-real";
    });
    await expect(page.locator(".react-flow__node").first()).toBeVisible();
    await expect(recovery(page)).toContainText("Hai fermato la creazione della mappa");
    await expect(recovery(page).getByRole("button", { name: "Riprendi" })).toBeEnabled();
    await saveShot(page, "maps-menu/build-stopped.png");

    // Chiudi is Attività's own: the stopped build leaves both places and nothing offers it again.
    await recovery(page).getByRole("button", { name: "Chiudi" }).click();
    await expect(recovery(page)).toHaveCount(0);
    await page.reload();
    await expect(page.locator(".react-flow__node").first()).toBeVisible();
    await expect(recovery(page)).toHaveCount(0);
    const jobs = await page.evaluate(() => window.pyxis.invoke("jobs.list", {}));
    expect(jobs.filter((job) => job.kind === "map-build" && job.state !== "succeeded")).toEqual([]);
    expect(errors).toEqual([]);
  } finally {
    await app.close();
    removeTestFolder(userData);
  }
});

test("a build cut off by closing the app is offered again when the app opens", async () => {
  test.setTimeout(180_000);
  const first = await startApp({
    PYXIS_E2E_MAP_REPLIES: recorded([reply(["Teoremi", "Unicità del limite", "Confronto", "Permanenza del segno"])]),
    PYXIS_E2E_MAP_DELAY: "3000",
  });
  const { userData } = first;
  let app = first.app;
  try {
    await askAndWait(first.page, undefined, "succeeded");
    await first.page.evaluate(() =>
      window.pyxis.invoke("maps.generate", { planId: "p-an", topicId: "t-real", instruction: "solo i teoremi" }),
    );
    await app.close();
    app = await launchPyxis({
      userData,
      env: { PYXIS_E2E_MAP_REPLIES: recorded([reply(["Teoremi", "Unicità del limite", "Confronto", "Permanenza del segno"])]), PYXIS_E2E_MAP_DELAY: "100" },
    });
    const page = await app.firstWindow();
    await page.emulateMedia({ reducedMotion: "reduce" });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await expect.poll(async () => (await buildOf(page))?.state).toMatch(/^(interrupted|cancelled|failed)$/);
    await page.evaluate(() => {
      location.hash = "#/maps/an/t-real";
    });
    await expect(page.locator(".react-flow__node").first()).toBeVisible();
    await expect(recovery(page)).toBeVisible();
    await recovery(page).getByRole("button", { name: /^(Riprova|Riprendi)$/ }).click();
    await expect.poll(async () => (await buildOf(page))?.state, { timeout: 60_000 }).toBe("succeeded");
    await expect(recovery(page)).toHaveCount(0);
    expect(await page.evaluate(() => window.pyxis.invoke("maps.list", { planId: "p-an", topicId: "t-real" }))).toHaveLength(2);
    expect(errors).toEqual([]);
  } finally {
    await app.close();
    removeTestFolder(userData);
  }
});

test("renaming a tile on a fresh launch shows the name field in the design's own look, before any map page was opened", async () => {
  test.setTimeout(120_000);
  const { app, page, userData, errors } = await startApp();
  try {
    // Straight to Mappe: the map page, and the styles that ship with it, has not been opened in this launch.
    await openMaps(page);
    const card = tile(page, "Successioni");
    await card.hover();
    await card.getByRole("button", { name: "Altro su Successioni" }).click();
    await page.getByRole("menuitem", { name: "Rinomina" }).click();
    const field = page.getByRole("textbox", { name: "Nome della mappa" });
    await expect(field).toBeFocused();
    // The field wears the tokens' own border (the focus one, as it has the focus), surface, ink and corners, not the browser's.
    const look = await field.evaluate((input) => {
      const probe = document.createElement("div");
      probe.style.cssText = "border: 1px solid var(--primary-text); border-radius: var(--radius-field); background: var(--surface); color: var(--ink)";
      document.body.append(probe);
      const want = getComputedStyle(probe);
      const have = getComputedStyle(input);
      const result = {
        border: [have.borderTopColor, want.borderTopColor],
        borderWidth: [have.borderTopWidth, want.borderTopWidth],
        background: [have.backgroundColor, want.backgroundColor],
        color: [have.color, want.color],
        radius: [have.borderTopLeftRadius, want.borderTopLeftRadius],
      };
      probe.remove();
      return result;
    });
    expect(look.border[0]).toBe(look.border[1]);
    expect(look.borderWidth[0]).toBe(look.borderWidth[1]);
    expect(look.background[0]).toBe(look.background[1]);
    expect(look.color[0]).toBe(look.color[1]);
    expect(look.radius[0]).toBe(look.radius[1]);
    await saveShot(page, "maps-menu/tile-rename-fresh.png");
    expect(errors).toEqual([]);
  } finally {
    await app.close();
    removeTestFolder(userData);
  }
});

test("a tile's menu closes when the page scrolls, follows its dots when the window resizes or the page shifts, and a right-click menu closes on a resize", async () => {
  test.setTimeout(180_000);
  const { app, page, userData, errors } = await startApp();
  try {
    await page.setViewportSize({ width: 1280, height: 420 });
    await openMaps(page);
    const menu = page.locator(".px-item-menu:not(.ant-dropdown-hidden)");
    const dots = tile(page, "Successioni").getByRole("button", { name: "Altro su Successioni" });
    const near = async () => {
      const box = (await menu.boundingBox())!;
      const at = (await dots.boundingBox())!;
      const x = at.x + at.width / 2;
      const y = at.y + at.height / 2;
      return Math.hypot(Math.max(box.x - x, 0, x - (box.x + box.width)), Math.max(box.y - y, 0, y - (box.y + box.height)));
    };
    const open = async () => {
      await tile(page, "Successioni").hover();
      await dots.click();
      await expect(menu).toBeVisible();
    };

    // A layout shift (a block above the tiles) does not close it: the menu follows the dots.
    await open();
    await page.mouse.move(5, 5);
    const before = (await dots.boundingBox())!.y;
    await page.evaluate(() => {
      document.querySelector<HTMLElement>(".px-maps-subject")!.style.paddingTop = "60px";
    });
    await expect.poll(async () => (await dots.boundingBox())!.y).toBeGreaterThan(before + 20);
    await expect(menu).toBeVisible();
    await expect.poll(near).toBeLessThan(40);
    // So does a resize.
    await page.setViewportSize({ width: 900, height: 420 });
    await expect(menu).toBeVisible();
    await expect.poll(near).toBeLessThan(40);
    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);

    // A scroll closes it. The window is short, so the page scrolls.
    await open();
    await page.mouse.move(640, 250);
    await page.mouse.wheel(0, 150);
    await expect(menu).toHaveCount(0);
    await page.mouse.wheel(0, -400);

    // A right-click menu stays at the pointer when the page shifts, and closes on a resize.
    const thumb = tile(page, "Successioni").locator(".px-maps-thumb");
    await thumb.scrollIntoViewIfNeeded();
    // The wheel above returns before its scroll lands, and a scroll that moves the tile would close this menu.
    await atRest(thumb);
    await thumb.click({ button: "right" });
    await expect(menu).toBeVisible();
    await page.setViewportSize({ width: 1280, height: 420 });
    await expect(menu).toHaveCount(0);
    expect(errors).toEqual([]);
  } finally {
    await app.close();
    removeTestFolder(userData);
  }
});

test("a tile's menu opened with the keyboard gives focus back to its dots when a scroll closes it, without scrolling the page back", async () => {
  test.setTimeout(180_000);
  const { app, page, userData, errors } = await startApp();
  try {
    await page.setViewportSize({ width: 1280, height: 420 });
    await openMaps(page);
    const menu = page.locator(".px-item-menu:not(.ant-dropdown-hidden)");
    const dots = tile(page, "Successioni").getByRole("button", { name: "Altro su Successioni" });
    const scrolled = () =>
      page.evaluate(() => {
        for (let el: Element | null = document.querySelector(".px-maps-subject"); el; el = el.parentElement)
          if (el.scrollTop > 0) return el.scrollTop;
        return 0;
      });
    // How far the wheel takes the page with no menu open.
    await page.mouse.move(640, 250);
    await page.mouse.wheel(0, 450);
    await expect.poll(scrolled).toBeGreaterThan(150);
    await page.waitForTimeout(500);
    const farthest = await scrolled();
    await page.mouse.wheel(0, -900);
    await expect.poll(scrolled).toBe(0);
    await atRest(dots);
    await dots.focus();
    await page.keyboard.press("Enter");
    await expect(menu).toBeVisible();
    await page.mouse.wheel(0, 450);
    await expect(menu).toHaveCount(0);
    // Focus is on the dots, not on the page, and the page stays where the student scrolled it.
    await expect(dots).toBeFocused();
    await expect.poll(scrolled, "the page was scrolled back to the dots").toBeGreaterThan(farthest - 3);
    expect(errors).toEqual([]);
  } finally {
    await app.close();
    removeTestFolder(userData);
  }
});

test("Riprova on a failed build shows Pyxis at work in place at once, and a retry that fails brings the line back", async () => {
  test.setTimeout(180_000);
  const theorems = reply(["Teoremi", "Unicità del limite", "Confronto", "Permanenza del segno"]);
  const { app, page, userData, errors } = await startApp({
    PYXIS_E2E_MAP_REPLIES: recorded([theorems, { fail: "offline" }, { fail: "offline" }, theorems]),
    PYXIS_E2E_MAP_DELAY: "1500",
  });
  try {
    await askAndWait(page, undefined, "succeeded");
    await askAndWait(page, "solo i teoremi", "failed");
    await page.evaluate(() => {
      location.hash = "#/maps/an/t-real";
    });
    await expect(page.locator(".react-flow__node").first()).toBeVisible();

    // The line is a notice: its icon, Riprova as its action and Chiudi beside it.
    const line = recovery(page);
    await expect(line.locator(".px-notice")).toContainText("L’ultima costruzione della mappa non è riuscita");
    await expect(line.locator(".px-notice svg").first()).toBeVisible();
    await expect(line.getByRole("button")).toHaveText(["Riprova", "Chiudi"]);
    await expectNoAxeViolations(page);

    // Riprova: Pyxis at work where the map will be, at once, as for a new map, with the words asked for.
    await line.getByRole("button", { name: "Riprova" }).click();
    const working = page.locator(".px-map-card .px-map-working");
    await expect(working).toBeVisible({ timeout: 1000 });
    await expect(working).toContainText("solo i teoremi");
    await expect(line).toHaveCount(0);
    // It fails again: the line comes back and says so, and the map is there again.
    await expect(line).toContainText("L’ultima costruzione della mappa non è riuscita", { timeout: 30_000 });
    await expect(working).toHaveCount(0);
    await expect(page.locator(".react-flow__node").first()).toBeVisible();
    // The canvas drawn again opens on the whole map, not at the corner of an empty view: every concept is inside it.
    await expect
      .poll(async () => {
        const area = (await page.locator(".px-map-canvas").boundingBox())!;
        const boxes = await page.locator(".react-flow__node").evaluateAll((nodes) =>
          nodes.map((node) => {
            const box = node.getBoundingClientRect();
            return [box.top, box.left, box.bottom, box.right];
          }),
        );
        return boxes.every(
          ([top, left, bottom, right]) =>
            top! >= area.y && left! >= area.x && bottom! <= area.y + area.height && right! <= area.x + area.width,
        );
      })
      .toBe(true);

    // Again, and this time it is built: the new map opens.
    await line.getByRole("button", { name: "Riprova" }).click();
    await expect(working).toBeVisible({ timeout: 1000 });
    await expect(page.locator(".react-flow__node", { hasText: "Permanenza del segno" })).toBeVisible({ timeout: 30_000 });
    await expect(line).toHaveCount(0);
    expect(errors).toEqual([]);
  } finally {
    await app.close();
    removeTestFolder(userData);
  }
});

test("Riprendi on a stopped build shows Pyxis at work in place at once", async () => {
  test.setTimeout(180_000);
  const { app, page, userData, errors } = await startApp({
    PYXIS_E2E_MAP_REPLIES: recorded([reply(["Teoremi", "Unicità del limite", "Confronto", "Permanenza del segno"])]),
    PYXIS_E2E_MAP_DELAY: "3000",
  });
  try {
    await askAndWait(page, undefined, "succeeded");
    await page.evaluate(() => window.pyxis.invoke("maps.generate", { planId: "p-an", topicId: "t-real", instruction: "solo i teoremi" }));
    await page.evaluate(async () => {
      const build = (await window.pyxis.invoke("maps.build", { planId: "p-an", topicId: "t-real" }))!;
      await window.pyxis.invoke("jobs.cancel", { jobId: build.jobId });
    });
    await expect.poll(async () => (await buildOf(page))?.state).toBe("cancelled");
    await page.evaluate(() => {
      location.hash = "#/maps/an/t-real";
    });
    await expect(page.locator(".react-flow__node").first()).toBeVisible();
    const line = recovery(page);
    await expect(line.locator(".px-notice")).toContainText("Hai fermato la creazione della mappa");
    await expect(line.getByRole("button")).toHaveText(["Riprendi", "Chiudi"]);
    await line.getByRole("button", { name: "Riprendi" }).click();
    const working = page.locator(".px-map-card .px-map-working");
    await expect(working).toBeVisible({ timeout: 1000 });
    await expect(line).toHaveCount(0);
    await expect(page.locator(".react-flow__node", { hasText: "Permanenza del segno" })).toBeVisible({ timeout: 30_000 });
    await expect(working).toHaveCount(0);
    expect(errors).toEqual([]);
  } finally {
    await app.close();
    removeTestFolder(userData);
  }
});

/** A model reply that waits until the test creates `hold`, so a build can be left running for as long as the test needs. */
const held = (concepts: string[], hold: string) => ({ ...reply(concepts), hold });

test("Riprendi keeps following the resumed build when the read right after it fails", async () => {
  test.setTimeout(180_000);
  const concepts = ["Teoremi", "Unicità del limite", "Confronto", "Permanenza del segno"];
  const holdFolder = mkdtempSync(join(tmpdir(), "pyxis-maps-hold-"));
  const hold = join(holdFolder, "go");
  const lose = join(holdFolder, "lose");
  const { app, page, userData, errors } = await startApp({
    PYXIS_E2E_MAP_REPLIES: recorded([null, held(concepts, hold), held(concepts, hold)]),
    PYXIS_E2E_READ_FAIL: `maps.build=${lose}`,
  });
  try {
    await askAndWait(page, undefined, "succeeded");
    await page.evaluate(() =>
      window.pyxis.invoke("maps.generate", { planId: "p-an", topicId: "t-real", instruction: "solo i teoremi" }),
    );
    await expect.poll(async () => (await buildOf(page))?.state).toBe("running");
    await page.evaluate(async () => {
      const build = (await window.pyxis.invoke("maps.build", { planId: "p-an", topicId: "t-real" }))!;
      await window.pyxis.invoke("jobs.cancel", { jobId: build.jobId });
    });
    await expect.poll(async () => (await buildOf(page))?.state).toBe("cancelled");
    await page.evaluate(() => {
      location.hash = "#/maps/an/t-real";
    });
    await expect(page.locator(".react-flow__node").first()).toBeVisible();
    const line = recovery(page);
    // The resume is accepted, but the first read of the build after it is lost: the seam fails the next `maps.build` once.
    writeFileSync(lose, "");
    await line.getByRole("button", { name: "Riprendi" }).click();
    const working = page.locator(".px-map-card .px-map-working");
    await expect(working).toBeVisible({ timeout: 1000 });
    await expect.poll(() => existsSync(lose)).toBe(false);
    // Not a failed resume: no notice, no old map, and the build that runs is still followed a few seconds on.
    await page.waitForTimeout(3000);
    expect((await buildOf(page))?.state).toBe("running");
    await expect(working).toBeVisible();
    await expect(page.locator(".react-flow__node")).toHaveCount(0);
    await expect(page.getByText("Non riesco a creare la mappa")).toHaveCount(0);
    writeFileSync(hold, "");
    await expect(page.locator(".react-flow__node", { hasText: "Permanenza del segno" })).toBeVisible({ timeout: 30_000 });
    await expect(working).toHaveCount(0);
    expect(errors).toEqual([]);
  } finally {
    await app.close();
    removeTestFolder(userData);
    removeTestFolder(dirname(hold));
  }
});

for (const way of ["Riprendi", "Riprova"] as const) {
  test(`${way} keeps Pyxis at work in place for as long as the build runs, and the new map shows when it ends`, async () => {
    test.setTimeout(180_000);
    const concepts = ["Teoremi", "Unicità del limite", "Confronto", "Permanenza del segno"];
    const holdFolder = mkdtempSync(join(tmpdir(), "pyxis-maps-hold-"));
    const hold = join(holdFolder, "go");
    // Model call 0 is the whole topic's map; the request in words is call 1. A stopped one waits in its call, and the
    // resumed one is call 2. A failed one fails at call 1, and its retry is call 2. Call 2 waits for the test.
    const calls = way === "Riprendi" ? [null, held(concepts, hold), held(concepts, hold)] : [null, { fail: "offline" }, held(concepts, hold)];
    const { app, page, userData, errors } = await startApp({ PYXIS_E2E_MAP_REPLIES: recorded(calls) });
    try {
      await askAndWait(page, undefined, "succeeded");
      if (way === "Riprendi") {
        await page.evaluate(() =>
          window.pyxis.invoke("maps.generate", { planId: "p-an", topicId: "t-real", instruction: "solo i teoremi" }),
        );
        await expect.poll(async () => (await buildOf(page))?.state).toBe("running");
        await page.evaluate(async () => {
          const build = (await window.pyxis.invoke("maps.build", { planId: "p-an", topicId: "t-real" }))!;
          await window.pyxis.invoke("jobs.cancel", { jobId: build.jobId });
        });
        await expect.poll(async () => (await buildOf(page))?.state).toBe("cancelled");
      } else await askAndWait(page, "solo i teoremi", "failed");
      await page.evaluate(() => {
        location.hash = "#/maps/an/t-real";
      });
      await expect(page.locator(".react-flow__node").first()).toBeVisible();
      const line = recovery(page);
      await line.getByRole("button", { name: way }).click();
      const working = page.locator(".px-map-card .px-map-working");
      await expect(working).toBeVisible({ timeout: 1000 });
      // The build is still running a few seconds on: the page still shows Pyxis at work, not the old map or its line.
      await page.waitForTimeout(3000);
      expect((await buildOf(page))?.state).toBe("running");
      await expect(working).toBeVisible();
      await expect(page.locator(".react-flow__node")).toHaveCount(0);
      await expect(line).toHaveCount(0);
      // It ends: the new map shows.
      writeFileSync(hold, "");
      await expect(page.locator(".react-flow__node", { hasText: "Permanenza del segno" })).toBeVisible({ timeout: 30_000 });
      await expect(working).toHaveCount(0);
      await expect(line).toHaveCount(0);
      expect(errors).toEqual([]);
    } finally {
      await app.close();
      removeTestFolder(userData);
      removeTestFolder(dirname(hold));
    }
  });
}
