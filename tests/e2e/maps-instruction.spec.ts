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
    await page.getByRole("complementary", { name: "Barra laterale" }).getByRole("link", { name: /^Mappe/ }).click();
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

test("the Nuova mappa dialog says when the topics of a subject did not load, and offers to try again", async () => {
  test.setTimeout(180_000);
  const { app, page, userData, errors } = await startApp([focused(labels)]);
  // The exam's read fails while the table it joins is away, and works again when it is back.
  const breakRead = (on: boolean) => {
    const db = new DatabaseSync(join(userData, "workspace", "pyxis.db"), { timeout: 10000 });
    try {
      db.exec(on ? "ALTER TABLE plan_sources RENAME TO plan_sources_away" : "ALTER TABLE plan_sources_away RENAME TO plan_sources");
    } finally {
      db.close();
    }
  };
  try {
    breakRead(true);
    const { openDialog, choose } = dialogs(page);
    const dialog = await openDialog();
    await choose(dialog, "Materia", "Analisi 1");
    // It says the topics are missing, with a way to try again, and does not take the subject for one without topics.
    const failed = dialog.getByRole("alert");
    await expect(failed).toContainText("Non riesco a caricare gli argomenti di Analisi 1");
    await expect(dialog.getByRole("button", { name: "Crea la mappa" })).toBeDisabled();
    await expectNoAxeViolations(page);
    await saveShot(page, "maps-instruction/new-map-topics-failed.png");
    await failed.getByRole("button", { name: "Riprova" }).click();
    await expect(failed).toBeVisible();
    // Once the read works, the topics are there to choose and the dialog goes on as usual.
    breakRead(false);
    await failed.getByRole("button", { name: "Riprova" }).click();
    await expect(failed).toHaveCount(0);
    await expect(dialog.getByRole("button", { name: "Crea la mappa" })).toBeEnabled();
    await choose(dialog, "Argomento", "Limiti");
    expect(errors).toEqual([]);
  } finally {
    await app.close();
    removeTestFolder(userData);
  }
});

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
    await page.getByRole("complementary", { name: "Barra laterale" }).getByRole("link", { name: /^Mappe/ }).click();
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
    // A screen reader that waited for the build hears the result: focus moves to its heading.
    await expect(empty.getByRole("heading", { name: "Nel materiale non c’è niente per la tua richiesta" })).toBeFocused();
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

    // Attività waits for the student under "C'è bisogno di te", with its own line and no retry, and counts it as one item
    // that needs them. Its button opens this page.
    const activity = page.locator(".px-corner-tools").getByRole("button", { name: /^Attività/ });
    await expect(activity).toHaveAccessibleName(/1 da sistemare/);
    await expect(page.locator(".px-corner-tools .px-jobs-part.is-problem .meta")).toHaveText("1");
    await activity.click();
    const list = page.getByRole("region", { name: "Attività" });
    const row = list.getByRole("region", { name: "C'è bisogno di te" }).locator(".px-jobs-problem", { hasText: "Nel materiale non c’è niente per la tua richiesta" });
    await expect(row).toBeVisible();
    await expect(list.getByRole("region", { name: "Finite oggi" })).toHaveCount(0);
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

/** Removes the map build that was asked for in these words, as clearing old jobs would. */
async function removeJob(userData: string, words: string) {
  const db = new DatabaseSync(join(userData, "workspace", "pyxis.db"), { timeout: 10000 });
  try {
    const removed = db
      .prepare("DELETE FROM jobs WHERE kind = 'map-build' AND json_extract(params_json, '$.instruction') = ?")
      .run(words);
    expect(removed.changes).toBe(1);
  } finally {
    db.close();
  }
}

/** Attività's list, opened from the corner button, and the items of requests that found nothing, under C'è bisogno di te. */
async function openActivity(page: Page) {
  await page.locator(".px-corner-tools").getByRole("button", { name: /^Attività/ }).click();
  const list = page.getByRole("region", { name: "Attività" });
  return list
    .getByRole("region", { name: "C'è bisogno di te" })
    .locator(".px-jobs-problem", { hasText: "Nel materiale non c’è niente per la tua richiesta" });
}

test("Cambia la richiesta opens the page on the request of its own row, not on the topic's newest one", async () => {
  test.setTimeout(180_000);
  const { app, page, userData, errors } = await startApp([nothing, nothing]);
  try {
    const { ask } = dialogs(page);
    const older = "solo i teoremi sulle onde gravitazionali";
    const newer = "solo le dimostrazioni sulla relatività";
    const field = page.getByLabel("Come la vuoi?");
    await ask(older);
    await expect(field).toHaveValue(older, { timeout: 60_000 });
    await ask(newer);
    await expect(field).toHaveValue(newer, { timeout: 60_000 });
    await page.evaluate(() => {
      location.hash = "/maps";
    });

    // Both requests are listed, the newest first. The older row opens the page with the older words.
    let rows = await openActivity(page);
    await expect(rows).toHaveCount(2);
    await rows.nth(1).getByRole("button", { name: "Cambia la richiesta" }).click();
    await expect(page).toHaveURL(/#\/plans\/[^/]+\/map\/t-limits$/);
    await expect(field).toHaveValue(older);
    await expect(page.getByRole("button", { name: "Crea la mappa" })).toBeVisible();

    // From the page itself, the newer row opens it on the newer words.
    rows = await openActivity(page);
    await rows.nth(0).getByRole("button", { name: "Cambia la richiesta" }).click();
    await expect(field).toHaveValue(newer);
    rows = await openActivity(page);
    await rows.nth(1).getByRole("button", { name: "Cambia la richiesta" }).click();
    await expect(field).toHaveValue(older);

    // A reload comes back to the same request, since the page was opened on it. Once that request's job is gone the page
    // shows the topic's newest one instead of waiting for it.
    await page.reload();
    await expect(field).toHaveValue(older);
    await removeJob(userData, older);
    await page.reload();
    await expect(field).toHaveValue(newer);
    expect(errors).toEqual([]);
  } finally {
    await app.close();
    removeTestFolder(userData);
  }
});

test("a request that found nothing leaves C'è bisogno di te and the count when it is dismissed", async () => {
  test.setTimeout(180_000);
  const { app, page, userData, errors } = await startApp([nothing]);
  try {
    const { ask } = dialogs(page);
    const words = "solo i teoremi sulle onde gravitazionali";
    await ask(words);
    await expect(page.getByLabel("Come la vuoi?")).toHaveValue(words, { timeout: 60_000 });
    await page.evaluate(() => {
      location.hash = "/maps";
    });
    const counted = page.locator(".px-corner-tools .px-jobs-part.is-problem .meta");
    await expect(counted).toHaveText("1");
    const rows = await openActivity(page);
    await expect(rows).toHaveCount(1);
    await rows.getByRole("button", { name: /^Chiudi/ }).click();
    await expect(rows).toHaveCount(0);
    await expect(counted).toHaveCount(0);
    expect(errors).toEqual([]);
  } finally {
    await app.close();
    removeTestFolder(userData);
  }
});

test("Cambia la richiesta on a topic that already has a map shows the request, and the map stays one choice away", async () => {
  test.setTimeout(180_000);
  const { app, page, userData, errors } = await startApp([focused(labels), nothing]);
  try {
    const { ask } = dialogs(page);
    const words = "solo i teoremi sulle onde gravitazionali";
    await ask(first);
    await expect(page.locator(".react-flow__node").first()).toBeVisible({ timeout: 60_000 });
    await ask(words, "Limiti · 1 mappa");
    await expect
      .poll(
        async () =>
          (
            (await page.evaluate(() => window.pyxis.invoke("maps.build", { topicId: "t-limits" }))) as {
              state: string;
            } | null
          )?.state,
        { timeout: 60_000 },
      )
      .toBe("failed");
    expect(await listOf(page)).toHaveLength(1);
    await page.evaluate(() => {
      location.hash = "/maps";
    });

    const rows = await openActivity(page);
    await expect(rows).toHaveCount(1);
    await rows.getByRole("button", { name: "Cambia la richiesta" }).click();
    // The page shows that request in its field, with the way to ask again, and not the map that exists.
    const field = page.getByLabel("Come la vuoi?");
    await expect(field).toHaveValue(words);
    await expect(page.getByRole("button", { name: "Crea la mappa" })).toBeVisible();
    await expect(page.locator(".react-flow__node")).toHaveCount(0);
    await expectNoAxeViolations(page);
    await saveShot(page, "maps-instruction/change-request-with-map.png");

    // The map is still there: the page's own menu opens it, and the request is gone from the page.
    await page.getByRole("button", { name: "Altro" }).click();
    await page.getByRole("group", { name: "Scegli una mappa" }).getByRole("menuitemradio").first().click();
    await expect(page.locator(".react-flow__node").first()).toBeVisible();
    await expect(field).toHaveCount(0);

    // The request belongs to its history entry: Back leaves it for the map, Forward and a reload come back to it.
    const again = await openActivity(page);
    await again.getByRole("button", { name: "Cambia la richiesta" }).click();
    await expect(field).toHaveValue(words);
    await page.goBack();
    await expect(page.locator(".react-flow__node").first()).toBeVisible();
    await expect(field).toHaveCount(0);
    await page.goForward();
    await expect(field).toHaveValue(words);
    await page.reload();
    await expect(field).toHaveValue(words);
    // When its job is gone, a reload shows the map and not an empty request.
    await removeJob(userData, words);
    await page.reload();
    await expect(page.locator(".react-flow__node").first()).toBeVisible();
    await expect(field).toHaveCount(0);
    expect(errors).toEqual([]);
  } finally {
    await app.close();
    removeTestFolder(userData);
  }
});

test("a request that finds nothing on a topic that has a map stays on the page to be changed", async () => {
  test.setTimeout(180_000);
  const { app, page, userData, errors } = await startApp([focused(labels), nothing, focused(conceptsOf("B"))]);
  try {
    const { ask } = dialogs(page);
    const words = "solo i teoremi sulle onde gravitazionali";
    await ask(first);
    await expect(page.locator(".react-flow__node").first()).toBeVisible({ timeout: 60_000 });
    await ask(words, "Limiti · 1 mappa");
    // The page stays where the build ended: the request in its field, as when Attività opens it, not the map and not a
    // notice alone.
    const field = page.getByLabel("Come la vuoi?");
    await expect(field).toHaveValue(words, { timeout: 60_000 });
    await expect(page.getByRole("heading", { name: "Nel materiale non c’è niente per la tua richiesta" })).toBeFocused();
    await expect(page.getByRole("button", { name: "Crea la mappa" })).toBeVisible();
    await expect(page.locator(".react-flow__node")).toHaveCount(0);
    await expectNoAxeViolations(page);
    await saveShot(page, "maps-instruction/nothing-matched-with-map.png");
    // Other words are another request, built next to the first map.
    await field.fill(second);
    await page.getByRole("button", { name: "Crea la mappa" }).click();
    await expect(conceptOf(page, "B")).toBeVisible({ timeout: 60_000 });
    expect((await listOf(page)).map((map) => map.instruction)).toEqual([first, second]);
    await expect(field).toHaveCount(0);
    expect(errors).toEqual([]);
  } finally {
    await app.close();
    removeTestFolder(userData);
  }
});

test("asking again from a request opened in Attività builds the new map next to the one that exists", async () => {
  test.setTimeout(180_000);
  const { app, page, userData, errors } = await startApp([focused(labels), nothing, focused(conceptsOf("B"))]);
  try {
    const { ask } = dialogs(page);
    await ask(first);
    await expect(page.locator(".react-flow__node").first()).toBeVisible({ timeout: 60_000 });
    await ask("solo i teoremi sulle onde gravitazionali", "Limiti · 1 mappa");
    await expect(page.getByText("non ha trovato niente su")).toBeVisible({ timeout: 60_000 });
    await page.evaluate(() => {
      location.hash = "/maps";
    });
    const rows = await openActivity(page);
    await rows.getByRole("button", { name: "Cambia la richiesta" }).click();
    await page.getByLabel("Come la vuoi?").fill(second);
    await page.getByRole("button", { name: "Crea la mappa" }).click();
    // The map that exists gives way to the working state, and the new map opens when it is ready, beside the first.
    await expect(page.locator(".px-map-working")).toBeVisible();
    await expect(conceptOf(page, "B")).toBeVisible({ timeout: 60_000 });
    const maps = await listOf(page);
    expect(maps.map((map) => map.instruction)).toEqual([first, second]);
    await expect(page).toHaveURL(new RegExp(`map=${maps[1]!.id}$`));
    await expect(page.getByLabel("Come la vuoi?")).toHaveCount(0);
    expect(errors).toEqual([]);
  } finally {
    await app.close();
    removeTestFolder(userData);
  }
});

test("a request that cannot be sent again keeps the student's edited words, and the form to send them again", async () => {
  test.setTimeout(180_000);
  const { app, page, userData, errors } = await startApp([focused(labels), nothing, focused(conceptsOf("B"))]);
  // Asking for a map reads the topic's passages; while their table is away that read fails, and works when it is back.
  const breakRead = (on: boolean) => {
    const db = new DatabaseSync(join(userData, "workspace", "pyxis.db"), { timeout: 10000 });
    try {
      db.exec(
        on
          ? "ALTER TABLE topic_passages RENAME TO topic_passages_away"
          : "ALTER TABLE topic_passages_away RENAME TO topic_passages",
      );
    } finally {
      db.close();
    }
  };
  try {
    const { ask } = dialogs(page);
    await ask(first);
    await expect(page.locator(".react-flow__node").first()).toBeVisible({ timeout: 60_000 });
    await ask("solo i teoremi sulle onde gravitazionali", "Limiti · 1 mappa");
    const field = page.getByLabel("Come la vuoi?");
    await expect(field).toHaveValue("solo i teoremi sulle onde gravitazionali", { timeout: 60_000 });

    // The student edits the words and sends them while the request cannot start: the page says so and keeps the words.
    breakRead(true);
    await field.fill(second);
    await page.getByRole("button", { name: "Crea la mappa" }).click();
    await expect(page.getByText("Non riesco a creare la mappa. Riprova.")).toBeVisible();
    await expect(field).toHaveValue(second);
    await expect(page.getByRole("button", { name: "Crea la mappa" })).toBeEnabled();

    // Once it works again, the same words are sent from the same form.
    breakRead(false);
    await page.getByRole("button", { name: "Crea la mappa" }).click();
    await expect(conceptOf(page, "B")).toBeVisible({ timeout: 60_000 });
    expect((await listOf(page)).map((map) => map.instruction)).toEqual([first, second]);
    await expect(field).toHaveCount(0);
    expect(errors).toEqual([]);
  } finally {
    await app.close();
    removeTestFolder(userData);
  }
});

test("a request opened from Attività replaces the one this page kept after it found nothing", async () => {
  test.setTimeout(180_000);
  const { app, page, userData, errors } = await startApp([nothing, nothing, nothing]);
  try {
    const { ask } = dialogs(page);
    const older = "solo i teoremi sulle onde gravitazionali";
    const newer = "solo le dimostrazioni sulla relatività";
    const latest = "solo gli esempi sulla meccanica quantistica";
    const field = page.getByLabel("Come la vuoi?");
    await ask(older);
    await expect(field).toHaveValue(older, { timeout: 60_000 });
    await ask(newer);
    await expect(field).toHaveValue(newer, { timeout: 60_000 });
    await page.evaluate(() => {
      location.hash = "/maps";
    });

    // The page opens on the older request, and a request made from it finds nothing too: the page keeps that one.
    let rows = await openActivity(page);
    await rows.nth(1).getByRole("button", { name: "Cambia la richiesta" }).click();
    await expect(field).toHaveValue(older);
    await field.fill(latest);
    await page.getByRole("button", { name: "Crea la mappa" }).click();
    await expect(page.locator(".px-map-working")).toHaveCount(0, { timeout: 60_000 });
    await expect(field).toHaveValue(latest);

    // The older request was changed, so it left Attività; the two that wait for the student are the newer and the latest.
    rows = await openActivity(page);
    await expect(rows).toHaveCount(2);
    await expect(page.locator(".px-corner-tools .px-jobs-part.is-problem .meta")).toHaveText("2");

    // The row of another request opens this same page on that request, and the kept one gives way.
    await rows.nth(1).getByRole("button", { name: "Cambia la richiesta" }).click();
    await expect(field).toHaveValue(newer);
    expect(errors).toEqual([]);
  } finally {
    await app.close();
    removeTestFolder(userData);
  }
});

test("a late answer to a request does not take the request of the entry opened at the same address out of it", async () => {
  test.setTimeout(180_000);
  // Asking for a map waits four seconds for its answer, which is time enough to open another request's row meanwhile.
  const { app, page, userData, errors } = await startApp([nothing, nothing, nothing], {
    PYXIS_E2E_READ_DELAY: "maps.generate=4000",
  });
  try {
    const { ask } = dialogs(page);
    const older = "solo i teoremi sulle onde gravitazionali";
    const newer = "solo le dimostrazioni sulla relatività";
    const latest = "solo gli esempi sulla meccanica quantistica";
    const field = page.getByLabel("Come la vuoi?");
    await ask(older);
    await expect(field).toHaveValue(older, { timeout: 60_000 });
    await ask(newer);
    await expect(field).toHaveValue(newer, { timeout: 60_000 });
    await page.evaluate(() => {
      location.hash = "/maps";
    });

    // The page opens on the older request, and the student asks again from it. Before the answer comes, the row of the
    // newer request opens the same page, at the same address, on the newer request: another history entry.
    let rows = await openActivity(page);
    await rows.nth(1).getByRole("button", { name: "Cambia la richiesta" }).click();
    await expect(field).toHaveValue(older);
    await field.fill(latest);
    await page.getByRole("button", { name: "Crea la mappa" }).click();
    rows = await openActivity(page);
    await rows.nth(0).getByRole("button", { name: "Cambia la richiesta" }).click();
    const db = new DatabaseSync(join(userData, "workspace", "pyxis.db"), { timeout: 10000, readOnly: true });
    try {
      const jobs = () => (db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE kind = 'map-build'").get() as { n: number }).n;
      const newerJob = (
        db
          .prepare("SELECT id FROM jobs WHERE kind = 'map-build' AND json_extract(params_json, '$.instruction') = ?")
          .get(newer) as { id: string }
      ).id;
      const entryJob = () =>
        page.evaluate(() => (history.state as { usr?: { job?: string } } | null)?.usr?.job);
      await expect.poll(entryJob).toBe(newerJob);
      // The answer to the first request arrives once its job exists. It belongs to the entry the student left, so the
      // newer request stays in the entry it was opened in.
      await expect.poll(jobs, { timeout: 30_000 }).toBe(3);
      await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 1000)));
      expect(await entryJob()).toBe(newerJob);
    } finally {
      db.close();
    }
    expect(errors).toEqual([]);
  } finally {
    await app.close();
    removeTestFolder(userData);
  }
});

test("the only map of a topic is one choice away from a request that found nothing", async () => {
  test.setTimeout(180_000);
  const { app, page, userData, errors } = await startApp([focused(labels), nothing]);
  try {
    const { ask } = dialogs(page);
    await ask(first);
    await expect(page.locator(".react-flow__node").first()).toBeVisible({ timeout: 60_000 });
    await ask("solo i teoremi sulle onde gravitazionali", "Limiti · 1 mappa");
    const field = page.getByLabel("Come la vuoi?");
    await expect(field).toBeVisible({ timeout: 60_000 });
    // The page's menu offers the one map, and choosing it shows the map and takes the request away.
    await page.getByRole("button", { name: "Altro" }).click();
    await page.getByRole("group", { name: "Scegli una mappa" }).getByRole("menuitemradio").first().click();
    await expect(page.locator(".react-flow__node").first()).toBeVisible();
    await expect(field).toHaveCount(0);
    expect(errors).toEqual([]);
  } finally {
    await app.close();
    removeTestFolder(userData);
  }
});

test("a build that ends while the page still shows its working state moves focus to the result once it appears", async () => {
  test.setTimeout(180_000);
  const { app, page, userData, errors } = await startApp([nothing], { PYXIS_E2E_MAP_DELAY: "0" });
  try {
    const { ask } = dialogs(page);
    await ask("solo i teoremi sulle onde gravitazionali");
    const heading = page.getByRole("heading", { name: "Nel materiale non c’è niente per la tua richiesta" });
    await expect(heading).toBeVisible({ timeout: 60_000 });
    await expect(heading).toBeFocused();
    expect(errors).toEqual([]);
  } finally {
    await app.close();
    removeTestFolder(userData);
  }
});
