import { expect, test, type Page } from "@playwright/test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { launchPyxis } from "./app-under-test";
import { seedPlan, seedSource, seedSubjects } from "./seed";
import { removeTestFolder } from "./cleanup";
import { fromChiediToExams } from "./doors";
import { saveShot } from "./shots";
import { expectNoAxeViolations } from "./axe";

const labels = ["Limiti", "Definizione", "Teoremi", "Dimostrazioni", "Esempi", "Successioni", "Continuità", "Derivate"];
/** What the recorded engine answers a request with an instruction: a map of these concepts, the first being the root. */
function focused(concepts: string[]) {
  return {
    result: {
      kind: "map",
      nodes: concepts.map((label, i) => ({ id: `n${i}`, label, parent: i ? "n0" : null, sources: "{{allPassages}}" })),
      edges: [],
    },
  };
}
const nothing = { result: { kind: "nothing" } };
const first = "solo i teoremi, con le dimostrazioni";
const second = "con un esempio per ogni teorema";

/** The app with the recorded engine answering map requests with `replies`, and Analisi 1 with its topic Limiti seeded. */
async function startApp(replies: unknown[], env: Record<string, string> = {}) {
  const userData = mkdtempSync(join(tmpdir(), "pyxis-maps-instruction-"));
  const prompts = join(userData, "map-prompts.log");
  const app = await launchPyxis({
    userData,
    env: {
      PYXIS_E2E_MAP_REPLIES: JSON.stringify({ result: replies }),
      PYXIS_E2E_MAP_DELAY: "300",
      PYXIS_E2E_MAP_PROMPTS: prompts,
      ...env,
    },
  });
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
    { id: "geo", name: "Geometria" },
  ]);
  seedSource(db, {
    id: "bramanti",
    title: "Bramanti",
    subjectId: "an",
    document: { id: "bramanti-doc" },
    passages: [
      { id: "pa-1", text: "Il limite di una successione è il valore a cui tende.", section: "Limiti" },
      { id: "pa-2", text: "Una successione convergente è limitata.", section: "Limiti" },
    ],
  });
  seedPlan(db, { id: "p-an", subjectId: "an", title: "Analisi 1", topics: [{ id: "t-limits", title: "Limiti" }] });
  db.exec(
    "INSERT INTO topic_passages(topic_id,passage_id) SELECT 't-limits', id FROM passages WHERE source_id = 'bramanti'",
  );
  db.close();
  await page.reload();
  return { app, page, userData, prompts, errors };
}

/** The Nuova mappa dialog of the Mappe section, and a way to ask for a map of Limiti in it. */
function dialogs(page: Page) {
  const openDialog = async () => {
    await page.getByRole("link", { name: /^Mappe/ }).click();
    await page.getByRole("button", { name: "Nuova mappa" }).click();
    return page.getByRole("dialog", { name: "Nuova mappa" });
  };
  const choose = async (dialog: ReturnType<typeof page.getByRole>, field: string, option: string) => {
    await dialog.getByLabel(field).click();
    await page.locator(`.ant-select-dropdown:visible .ant-select-item-option[title="${option}"]`).click();
  };
  /** Asks for a map of Limiti in these words; `topic` is the option as the select shows it ("Limiti · 1 mappa"). */
  const ask = async (words: string, topic = "Limiti") => {
    const dialog = await openDialog();
    await choose(dialog, "Materia", "Analisi 1");
    await choose(dialog, "Argomento", topic);
    await dialog.getByLabel("Come la vuoi?").fill(words);
    await dialog.getByRole("button", { name: "Crea la mappa" }).click();
  };
  return { openDialog, choose, ask };
}

test("a map asked for in the student's own words reaches the engine, and a second one for the same topic sits beside the first", async () => {
  test.setTimeout(180_000);
  const { app, page, userData, prompts, errors } = await startApp([focused(labels)], { PYXIS_E2E_MAP_DELAY: "1500" });
  try {
    const { openDialog, choose } = dialogs(page);

    // A subject whose exams have no topics has no topic select, no disabled one and no note about it.
    let dialog = await openDialog();
    await choose(dialog, "Materia", "Geometria");
    await expect(dialog.getByLabel("Argomento")).toBeHidden();
    await expect(dialog.getByText("non hanno ancora argomenti")).toHaveCount(0);
    await expect(dialog.getByLabel("Come la vuoi?")).toBeVisible();
    await expectNoAxeViolations(page);
    // A subject with topics shows the select, which starts on the whole subject and lists the topics by exam.
    await choose(dialog, "Materia", "Analisi 1");
    await expect(dialog.getByLabel("Argomento")).toBeVisible();
    await expect(
      dialog.locator("#new-map-topic").locator("xpath=ancestor::div[contains(@class,'ant-select')][1]"),
    ).toContainText("Tutta la materia");
    await dialog.getByLabel("Argomento").click();
    await expect(page.locator(".ant-select-dropdown:visible .ant-select-item-group")).toHaveText(["Analisi 1"]);
    await page.locator('.ant-select-dropdown:visible .ant-select-item-option[title="Limiti"]').click();
    await dialog.getByLabel("Come la vuoi?").fill(`  ${first}  `);
    await expectNoAxeViolations(page);
    await dialog.getByRole("button", { name: "Crea la mappa" }).click();

    // The page names what it builds and shows the request in one quiet line.
    await expect(page).toHaveURL(/#\/maps\/an\/t-limits\?from=maps$/);
    const working = page.locator(".px-map-working");
    await expect(working.getByRole("status")).toHaveText(`Creo la mappa «Limiti»…«${first}»`);
    await expect(page.locator(".px-map-asked")).toHaveAttribute("title", first);
    await saveShot(page, "maps-instruction/working-asked.png");
    await expect(page.locator(".react-flow__node").first()).toBeVisible({ timeout: 60_000 });

    // What the engine received carries the request, trimmed, next to the topic's title and its passages.
    const sent = readFileSync(prompts, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(JSON.parse(line) as string) as { title: string; instruction?: string; passages: unknown[] });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ title: "Limiti", instruction: first });
    expect(sent[0]!.passages).toHaveLength(2);

    // A second request for the same topic with other words is a new map, and the first stays.
    dialog = await openDialog();
    await choose(dialog, "Materia", "Analisi 1");
    await choose(dialog, "Argomento", "Limiti · 1 mappa");
    await dialog.getByLabel("Come la vuoi?").fill(second);
    await dialog.getByRole("button", { name: "Crea la mappa" }).click();
    await expect(page).toHaveURL(/#\/maps\/an\/t-limits\?from=maps$/);
    // The map that exists is not shown meanwhile: the page shows the new one's working state.
    await expect(working.getByRole("status")).toHaveText(`Creo la mappa «Limiti»…«${second}»`);
    await expect(page.locator(".react-flow__node")).toHaveCount(0);
    // The new map opens when it is ready, and is the second of the topic.
    await expect(page.locator(".react-flow__node").first()).toBeVisible({ timeout: 60_000 });
    const maps = (await page.evaluate(() => window.pyxis.invoke("maps.list", { topicId: "t-limits" }))) as Array<{
      id: string;
      instruction?: string;
    }>;
    expect(maps.map((map) => map.instruction)).toEqual([first, second]);
    await expect(page).toHaveURL(new RegExp(`map=${maps[1]!.id}$`));
    expect(readFileSync(prompts, "utf8").trim().split("\n")).toHaveLength(2);
    // The map's own menu tells the two apart.
    await page.getByRole("button", { name: "Altro" }).click();
    await expect(page.getByRole("group", { name: "Scegli una mappa" }).getByRole("menuitemradio")).toHaveText([
      `Limiti«${first}»`,
      `Limiti«${second}»`,
    ]);
    await saveShot(page, "maps-instruction/picker.png");
    await page.keyboard.press("Escape");

    // Mappe lists both, told apart by what each was asked for, with the whole text on hover.
    await page.getByRole("link", { name: /^Mappe/ }).click();
    const tiles = page.locator(".px-maps-tile");
    await expect(tiles).toHaveCount(2);
    await expect(tiles.locator(".px-maps-card-title")).toHaveText(["Limiti", "Limiti"]);
    await expect(tiles.locator(".px-maps-card-ask")).toHaveText([`«${first}»`, `«${second}»`]);
    await expect(tiles.locator(".px-maps-card-ask").first()).toHaveAttribute("title", first);
    await expectNoAxeViolations(page);
    await saveShot(page, "maps-instruction/two-maps.png");

    // Without words the topic's map opens and nothing is built again.
    dialog = await openDialog();
    await choose(dialog, "Materia", "Analisi 1");
    await choose(dialog, "Argomento", "Limiti · 2 mappe");
    await dialog.getByRole("button", { name: "Crea la mappa" }).click();
    await expect(page).toHaveURL(/#\/maps\/an\/t-limits\?from=maps$/);
    await expect(page.locator(".react-flow__node").first()).toBeVisible();
    await expect(page.locator(".px-map-working")).toHaveCount(0);
    expect(readFileSync(prompts, "utf8").trim().split("\n")).toHaveLength(2);
    expect(await page.evaluate(() => window.pyxis.invoke("maps.list", { topicId: "t-limits" }))).toHaveLength(2);
    expect(errors).toEqual([]);
  } finally {
    await app.close();
    removeTestFolder(userData);
  }
});

const listOf = (page: Page) =>
  page.evaluate(() => window.pyxis.invoke("maps.list", { topicId: "t-limits" })) as Promise<
    Array<{ id: string; instruction?: string }>
  >;
/** A map's concepts told apart by their first child; a single part's root always takes the topic's title. */
const conceptsOf = (tag: string) => ["Limiti", `Definizione ${tag}`, ...labels.slice(2)];
const conceptOf = (page: Page, tag: string) =>
  page.locator(".react-flow__node").filter({ hasText: `Definizione ${tag}` });

test("a request that matches nothing builds no map, says so next to the request, and lets the student change it", async () => {
  test.setTimeout(180_000);
  const { app, page, userData, errors } = await startApp([nothing, focused(labels)]);
  try {
    const { ask } = dialogs(page);
    const words = "solo i teoremi sulle onde gravitazionali";
    await ask(words);
    await expect(page).toHaveURL(/#\/maps\/an\/t-limits\?from=maps$/);
    // The page says nothing matched, where a failed build shows, with the request still there to change.
    const empty = page.locator(".px-map-empty");
    await expect(
      empty.getByRole("heading", { name: "Nel materiale non c’è niente per la tua richiesta" }),
    ).toBeVisible({ timeout: 60_000 });
    await expect(empty).toContainText(`«${words}»`);
    await expect(page.getByLabel("Come la vuoi?")).toHaveValue(words);
    await expect(page.locator(".react-flow__node")).toHaveCount(0);
    await expect(page.getByText("Non riesco a creare la mappa")).toHaveCount(0);
    // No empty map is stored, and the build says why it ended.
    expect(await listOf(page)).toEqual([]);
    expect(await page.evaluate(() => window.pyxis.invoke("maps.build", { topicId: "t-limits" }))).toMatchObject({
      state: "failed",
      error: "map-nothing-matched",
      instruction: words,
    });
    await expectNoAxeViolations(page);
    await saveShot(page, "maps-instruction/nothing-matched.png");

    // Attività lists it as finished, with its own line and no retry, and shows no problem. Its button opens this page.
    const activity = page.locator(".px-corner-tools").getByRole("button", { name: /^Attività/ });
    await expect(activity).not.toHaveAccessibleName(/da sistemare/);
    await expect(page.locator(".px-corner-tools .px-jobs-part.is-problem")).toHaveCount(0);
    await activity.click();
    const list = page.getByRole("region", { name: "Attività" });
    const row = list.locator(".px-jobs-row", { hasText: "Nel materiale non c’è niente per la tua richiesta" });
    await expect(row).toBeVisible();
    await expect(list.getByRole("button", { name: /^Riprova/ })).toHaveCount(0);
    await expect(list.getByText("Dettagli tecnici")).toHaveCount(0);
    await saveShot(page, "maps-instruction/nothing-matched-activity.png");
    await page.keyboard.press("Escape");
    await expect(list).toBeHidden();
    await page.evaluate(() => {
      location.hash = "/maps";
    });
    await activity.click();
    await row.getByRole("button", { name: "Cambia la richiesta" }).click();
    await expect(page).toHaveURL(/#\/plans\/[^/]+\/map\/t-limits$/);
    await expect(page.getByLabel("Come la vuoi?")).toHaveValue(words);

    // Other words are another request, and its map is the topic's first.
    await page.getByLabel("Come la vuoi?").fill("le definizioni sui limiti");
    await page.getByRole("button", { name: "Crea la mappa" }).click();
    await expect(page.locator(".react-flow__node").first()).toBeVisible({ timeout: 60_000 });
    expect((await listOf(page)).map((map) => map.instruction)).toEqual(["le definizioni sui limiti"]);
    expect(errors).toEqual([]);
  } finally {
    await app.close();
    removeTestFolder(userData);
  }
});

test("asking again for a request that failed follows that build, while a newer request of the topic has finished", async () => {
  test.setTimeout(240_000);
  const a = "con le dimostrazioni";
  const b = "solo le definizioni";
  // Request A fails at its first call, B succeeds, and A asked again succeeds.
  const { app, page, userData, prompts, errors } = await startApp([
    { fail: "offline" },
    focused(conceptsOf("B")),
    focused(conceptsOf("A")),
  ]);
  try {
    const { ask } = dialogs(page);
    await ask(a);
    await expect(page.getByText("Non riesco a creare la mappa. Riprova.")).toBeVisible({ timeout: 60_000 });
    await ask(b);
    await expect(conceptOf(page, "B")).toBeVisible({ timeout: 60_000 });
    expect((await listOf(page)).map((map) => map.instruction)).toEqual([b]);

    // The newest build of the topic is B's, which finished. A asked again is a retry of A's build, and the page follows it.
    await ask(a, "Limiti · 1 mappa");
    await expect(page.locator(".px-map-working")).toBeVisible();
    await expect(conceptOf(page, "A")).toBeVisible({ timeout: 60_000 });
    const maps = await listOf(page);
    expect(maps.map((map) => map.instruction)).toEqual([b, a]);
    await expect(page).toHaveURL(new RegExp(`map=${maps[1]!.id}$`));
    // The map's own controls are there, and the working state is gone.
    await expect(page.getByRole("button", { name: "Altro" })).toBeVisible();
    await expect(page.locator(".px-map-working")).toHaveCount(0);
    expect(readFileSync(prompts, "utf8").trim().split("\n")).toHaveLength(3);
    expect(errors).toEqual([]);
  } finally {
    await app.close();
    removeTestFolder(userData);
  }
});

test("opens the map the build it follows made when an older request finishes right after it", async () => {
  test.setTimeout(240_000);
  const a = "con le dimostrazioni";
  const b = "solo le definizioni";
  const holdFolder = mkdtempSync(join(tmpdir(), "pyxis-maps-hold-"));
  const release = join(holdFolder, "release-a");
  // A is asked first and waits until the test lets it go; B is asked next and finishes first.
  const { app, page, userData, errors } = await startApp(
    [{ hold: release, ...focused(conceptsOf("A")) }, focused(conceptsOf("B"))],
    { PYXIS_E2E_MAP_DELAY: "100" },
  );
  try {
    const { ask } = dialogs(page);
    await ask(a);
    await expect(page.locator(".px-map-working")).toBeVisible();
    await ask(b);
    await expect(conceptOf(page, "B")).toBeVisible({ timeout: 60_000 });
    // B's map is the only one so far; A finishes after it, so the last map of the topic is A's.
    expect((await listOf(page)).map((map) => map.instruction)).toEqual([b]);
    writeFileSync(release, "go");
    await expect.poll(async () => (await listOf(page)).length, { timeout: 60_000 }).toBe(2);
    const maps = await listOf(page);
    expect(maps.map((map) => map.instruction)).toEqual([b, a]);
    // The page stays on the map of the build it followed.
    await expect(page).toHaveURL(new RegExp(`map=${maps[0]!.id}$`));
    await expect(conceptOf(page, "B")).toBeVisible();
    expect(errors).toEqual([]);
  } finally {
    await app.close();
    removeTestFolder(userData);
    removeTestFolder(holdFolder);
  }
});
