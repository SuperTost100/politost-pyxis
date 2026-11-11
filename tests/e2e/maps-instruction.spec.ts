import { expect, test } from "@playwright/test";
import { mkdtempSync, readFileSync } from "node:fs";
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
const first = "solo i teoremi, con le dimostrazioni";
const second = "con un esempio per ogni teorema";

test("a map asked for in the student's own words reaches the engine, and a second one for the same topic sits beside the first", async () => {
  test.setTimeout(180_000);
  const userData = mkdtempSync(join(tmpdir(), "pyxis-maps-instruction-"));
  const prompts = join(userData, "map-prompts.log");
  const mapReplies = {
    nodes: {
      nodes: labels.map((label, i) => ({ id: `n${i}`, label, parent: i ? "n0" : null, sources: "{{allPassages}}" })),
      edges: [],
    },
  };
  const app = await launchPyxis({
    userData,
    env: {
      PYXIS_E2E_MAP_REPLIES: JSON.stringify(mapReplies),
      PYXIS_E2E_MAP_DELAY: "1500",
      PYXIS_E2E_MAP_PROMPTS: prompts,
    },
  });
  try {
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

    const openDialog = async () => {
      await page.getByRole("link", { name: /^Mappe/ }).click();
      await page.getByRole("button", { name: "Nuova mappa" }).click();
      return page.getByRole("dialog", { name: "Nuova mappa" });
    };
    const choose = async (dialog: ReturnType<typeof page.getByRole>, field: string, option: string) => {
      await dialog.getByLabel(field).click();
      await page.locator(`.ant-select-dropdown:visible .ant-select-item-option[title="${option}"]`).click();
    };

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
