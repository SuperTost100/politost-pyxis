import { expect, test } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { launchPyxis } from "./app-under-test";
import { seedPlan, seedSource, seedSubjects } from "./seed";
import { removeTestFolder } from "./cleanup";
import { fromChiediToExams } from "./doors";
import { saveShot } from "./shots";

function collection(id: string, title: string, labels: string[]) {
  return JSON.stringify({
    version: 1,
    maps: [
      {
        id,
        title,
        passageIds: [],
        graph: {
          layout: "tree",
          undo: null,
          nodes: labels.map((label, i) => ({ id: `n${i}`, label, parent: i ? "n0" : null, x: 0, y: 0, pinned: false })),
          edges: labels.slice(1).map((_, i) => ({ from: "n0", to: `n${i + 1}` })),
        },
      },
    ],
  });
}

test("a map belongs to a subject: built without an exam, listed by subject, with its source beside it", async () => {
  test.setTimeout(180_000);
  const userData = mkdtempSync(join(tmpdir(), "pyxis-maps-subject-"));
  const labels = ["Cinematica", "Velocità", "Accelerazione", "Moto rettilineo", "Moto circolare", "Vettori", "Traiettoria", "Spostamento"];
  // The reply is looked up by the first property of the map's schema.
  const mapReplies = {
    nodes: {
      nodes: labels.map((label, i) => ({ id: `n${i}`, label, parent: i ? "n0" : null, sources: "{{allPassages}}" })),
      edges: [],
    },
  };
  const app = await launchPyxis({ userData, env: { PYXIS_E2E_MAP_REPLIES: JSON.stringify(mapReplies), PYXIS_E2E_MAP_DELAY: "1500" } });
  try {
    const page = await app.firstWindow();
    await page.emulateMedia({ reducedMotion: "reduce" });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.getByRole("button", { name: "Salta" }).click();
    await fromChiediToExams(page);
    await page.evaluate(() => window.pyxis.invoke("plans.list", {}));

    // With no subject at all, Mappe offers the ways to add material, and an exam.
    await page.getByText("Mappe", { exact: true }).click();
    await expect(page).toHaveURL(/#\/maps$/);
    await expect(page.getByRole("heading", { name: "Ancora nessuna mappa" })).toBeVisible();
    await expect(page.getByText(/Collega la cartella dove studi/)).toBeVisible();
    for (const action of ["Collega una cartella", "Apri la Libreria", "Nuovo esame"])
      await expect(page.getByRole("button", { name: action })).toBeVisible();
    await saveShot(page, "maps-subject/empty-no-subjects.png");
    // The folder step of setup opens from here, and leaving it comes back to Mappe.
    await page.getByRole("button", { name: "Collega una cartella" }).click();
    await expect(page).toHaveURL(/#\/onboarding\?again=1&step=material&from=maps$/);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Come tieni il materiale per studiare?");
    await page.getByRole("button", { name: "Lo faccio dopo" }).click();
    await expect(page).toHaveURL(/#\/maps$/);

    // A subject with material and no exam.
    const db = new DatabaseSync(join(userData, "workspace", "pyxis.db"), { timeout: 10000 });
    seedSubjects(db, [{ id: "phys", name: "Fisica I" }, { id: "chem", name: "Chimica" }]);
    seedSource(db, {
      id: "mazzoldi",
      title: "Mazzoldi",
      subjectId: "phys",
      document: { id: "mazzoldi-doc" },
      passages: [
        { id: "pa-1", text: "La velocità media è lo spostamento diviso il tempo impiegato.", section: "Cinematica" },
        { id: "pa-2", text: "L'accelerazione misura quanto cambia la velocità in un istante.", section: "Cinematica" },
        { id: "pa-3", text: "Nel moto circolare uniforme l'accelerazione punta verso il centro.", section: "Moto circolare" },
      ],
    });
    db.close();
    await page.reload();

    // With subjects and no maps, the empty state offers a new map and no longer asks for an exam first.
    await expect(page.getByRole("heading", { name: "Ancora nessuna mappa" })).toBeVisible();
    await expect(page.getByText(/Crea prima un esame/)).toHaveCount(0);
    await page.getByRole("button", { name: "Nuova mappa" }).click();
    const dialog = page.getByRole("dialog", { name: "Nuova mappa" });
    await dialog.getByLabel("Materia").click();
    await page.locator('.ant-select-dropdown:visible .ant-select-item-option[title="Fisica I"]').click();
    // No exam means no topics: the map covers the whole subject.
    await expect(dialog.getByText("Gli esami di questa materia non hanno ancora argomenti")).toBeVisible();
    await expect(dialog.getByLabel("Argomento")).toBeDisabled();
    await saveShot(page, "maps-subject/new-map-subject.png");
    await dialog.getByRole("button", { name: "Continua" }).click();
    await expect(page).toHaveURL(/#\/maps\/phys\?from=maps$/);
    // One click builds the map: the page shows the working mark where the map will appear, and no second button.
    await expect(page.locator(".px-map-working")).toBeVisible();
    await expect(page.getByRole("button", { name: "Crea la mappa", exact: true })).toHaveCount(0);
    await expect(page.locator(".px-map-title p")).toHaveText("Fisica I");
    await saveShot(page, "maps-subject/building-after-confirm.png");
    await expect(page.locator(".react-flow__node")).toHaveCount(labels.length, { timeout: 60_000 });
    // The map is named after the subject, and so is its root.
    await expect(page.getByRole("heading", { level: 1, name: "Fisica I" })).toBeVisible();
    await expect(page.locator('.react-flow__node[data-id="n0"]')).toContainText("Fisica I");
    expect(
      await page.evaluate(() => window.pyxis.invoke("maps.list", { subjectId: "phys" })),
    ).toHaveLength(1);
    // Mappe stays the section the map belongs to.
    await expect(page.getByRole("link", { name: /^Mappe/ })).toHaveAttribute("aria-current", "page");

    // The concept's source opens beside the map at the cited passage, and the map stays usable next to it.
    const canvas = page.locator(".px-map-canvas");
    const wide = (await canvas.boundingBox())!.width;
    await page.locator('.react-flow__node[data-id="n2"]').click();
    const foot = page.locator(".px-map-foot");
    const sourceButton = foot.getByRole("button", { name: "Mazzoldi", exact: true });
    await sourceButton.click();
    const panel = page.getByRole("complementary", { name: /Mazzoldi/ });
    await expect(panel.locator(".source-viewer-paragraph.is-current")).toContainText("La velocità media");
    await expect(panel).toBeFocused();
    await expect(page).toHaveURL(/#\/maps\/phys\?from=maps/);
    await expect.poll(async () => (await canvas.boundingBox())!.width).toBeLessThan(wide - 200);
    const box = (await panel.boundingBox())!;
    expect(box.x).toBeGreaterThan((await canvas.boundingBox())!.x + (await canvas.boundingBox())!.width);
    await saveShot(page, "maps-subject/source-panel.png");
    // Another concept can be picked with the panel open.
    await page.locator('.react-flow__node[data-id="n3"]').click();
    await expect(foot.locator(".px-map-node-label")).toHaveText("Moto rettilineo");
    await expect(panel).toBeVisible();
    await foot.getByRole("button", { name: "Mazzoldi", exact: true }).click();
    await expect(panel).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(panel).toBeHidden();
    await expect(foot.getByRole("button", { name: "Mazzoldi", exact: true })).toBeFocused();
    await expect.poll(async () => (await canvas.boundingBox())!.width).toBeGreaterThan(wide - 2);
    // The close button closes it too.
    await foot.getByRole("button", { name: "Mazzoldi", exact: true }).click();
    await panel.getByRole("button", { name: "Chiudi" }).click();
    await expect(panel).toBeHidden();
    await expect(foot.getByRole("button", { name: "Mazzoldi", exact: true })).toBeFocused();

    // Flashcards from a map go only under its own subject's exams. Fisica I has none, so even an exam of another subject
    // whose topic cites the same passages is not offered, and the dialog says why.
    const chem = new DatabaseSync(join(userData, "workspace", "pyxis.db"), { timeout: 10000 });
    seedPlan(chem, { id: "p-chem", subjectId: "chem", title: "Chimica generale", topics: [{ id: "t-chem", title: "Cinetica" }] });
    chem.exec("INSERT INTO topic_passages(topic_id,passage_id) VALUES('t-chem','pa-1'),('t-chem','pa-2'),('t-chem','pa-3')");
    chem.close();
    await page.getByRole("button", { name: "Crea flashcard da questa mappa" }).click();
    const cards = page.getByRole("dialog", { name: "Crea flashcard" });
    await expect(cards.getByText("Fisica I non ha ancora un esame con argomenti")).toBeVisible();
    await expect(cards.locator(".px-mc-where")).not.toContainText("Chimica generale");
    await expect(cards.getByLabel("Esame")).toBeDisabled();
    await saveShot(cards, "maps-subject/cards-no-exam.png");
    await cards.getByRole("button", { name: "Annulla" }).click();
    await expect(cards).toHaveCount(0);

    // An exam's map from before still opens at the exam's address, and an exam without a subject keeps it too.
    const again = new DatabaseSync(join(userData, "workspace", "pyxis.db"), { timeout: 10000 });
    seedPlan(again, { id: "p-mech", subjectId: "phys", title: "Meccanica", topics: [{ id: "t-motion", title: "Moto" }] });
    seedPlan(again, { id: "p-loose", title: "Appunti", topics: [{ id: "t-loose", title: "Varie" }] });
    const insert = again.prepare(
      "INSERT INTO maps(id,plan_id,topic_id,graph_json,grounding,created_at) VALUES(?,?,?,?,'sources',1)",
    );
    insert.run("row-motion", "p-mech", "t-motion", collection("m-motion", "Moto rettilineo", ["Moto", "Velocità", "Tempo"]));
    insert.run("row-loose", "p-loose", "t-loose", collection("m-loose", "Note sparse", ["Note", "Varie"]));
    again.close();
    await page.reload();
    await page.evaluate(() => {
      window.location.hash = "/plans/p-mech/map/t-motion";
    });
    await expect(page.getByRole("heading", { level: 1, name: "Moto rettilineo" })).toBeVisible();
    await expect(page.locator(".react-flow__node")).toHaveCount(3);
    await expect(page.getByRole("link", { name: "Apri l’esame Meccanica" })).toBeVisible();

    // Mappe groups maps by subject: the whole subject's map first, then its exams' maps; no subject comes last.
    await page.getByRole("link", { name: /^Mappe/ }).click();
    await expect(page).toHaveURL(/#\/maps$/);
    await expect(page.getByRole("status")).toHaveText("3 mappe");
    const groups = page.locator(".px-maps-subject");
    await expect(groups.locator("h2")).toHaveText(["Fisica I", "Nessuna materia"]);
    await expect(groups.first().locator(".px-maps-card-title")).toHaveText(["Fisica I", "Moto rettilineo"]);
    await expect(groups.first().locator(".px-maps-card-origin")).toHaveText(["Tutta la materia", "Meccanica · Moto"]);
    await saveShot(page, "maps-subject/maps-by-subject.png");
    // The exam's map opens by its subject now; the one without a subject at its exam's address.
    await page.getByRole("link", { name: /^Moto rettilineo Meccanica · Moto/ }).click();
    await expect(page).toHaveURL(/#\/maps\/phys\/t-motion\?from=maps&map=m-motion$/);
    await expect(page.locator(".react-flow__node")).toHaveCount(3);
    await page.getByRole("link", { name: /^Mappe/ }).click();
    await page.getByRole("link", { name: /^Note sparse/ }).click();
    await expect(page).toHaveURL(/#\/plans\/p-loose\/map\/t-loose\?from=maps&map=m-loose$/);
    await expect(page.locator(".react-flow__node")).toHaveCount(2);

    // A new map of one topic of the subject's exam opens by subject and topic.
    await page.getByRole("link", { name: /^Mappe/ }).click();
    await page.getByRole("button", { name: "Nuova mappa" }).click();
    await dialog.getByLabel("Materia").click();
    await page.locator('.ant-select-dropdown:visible .ant-select-item-option[title="Fisica I · 1 mappa"]').click();
    await dialog.getByLabel("Argomento").click();
    await expect(page.locator(".ant-select-dropdown:visible .ant-select-item-group")).toHaveText(["Meccanica"]);
    await page.locator('.ant-select-dropdown:visible .ant-select-item-option[title="Moto · 1 mappa"]').click();
    await dialog.getByRole("button", { name: "Continua" }).click();
    await expect(page).toHaveURL(/#\/maps\/phys\/t-motion\?from=maps$/);
    await expect(page.locator(".react-flow__node")).toHaveCount(3);
    expect(errors).toEqual([]);
  } finally {
    await app.close();
    removeTestFolder(userData);
  }
});

test("one request makes one map, even when the topic's material is read in three parts", async () => {
  test.setTimeout(180_000);
  const userData = mkdtempSync(join(tmpdir(), "pyxis-maps-parts-"));
  // Each part answers with its own twelve concepts and the concept "Velocità", which the parts share.
  const concepts = Array.from({ length: 12 }, (_, i) => `Parte {{call}}, concetto ${i + 1}`);
  const labels = ["Parte {{call}}", ...concepts, "Velocità"];
  const mapReplies = {
    nodes: {
      nodes: labels.map((label, i) => ({ id: `n${i}`, label, parent: i ? "n0" : null, sources: "{{allPassages}}" })),
      edges: [],
    },
  };
  const app = await launchPyxis({
    userData,
    env: { PYXIS_E2E_MAP_REPLIES: JSON.stringify(mapReplies), PYXIS_E2E_MAP_DELAY: "1500" },
  });
  try {
    const page = await app.firstWindow();
    await page.emulateMedia({ reducedMotion: "reduce" });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.getByRole("button", { name: "Salta" }).click();
    await fromChiediToExams(page);
    await page.evaluate(() => window.pyxis.invoke("plans.list", {}));
    // Fifty passages are three parts of the model's reading: 24, 24 and 2.
    const db = new DatabaseSync(join(userData, "workspace", "pyxis.db"), { timeout: 10000 });
    seedSubjects(db, [{ id: "phys", name: "Fisica I" }]);
    seedSource(db, {
      id: "mazzoldi",
      title: "Mazzoldi",
      subjectId: "phys",
      document: { id: "mazzoldi-doc" },
      passages: Array.from({ length: 50 }, (_, i) => ({
        id: `pa-${i + 1}`,
        text: `Il concetto ${i + 1} descrive un moto e le sue grandezze.`,
        section: "Moto",
      })),
    });
    seedPlan(db, { id: "p-mech", subjectId: "phys", title: "Meccanica", topics: [{ id: "t-motion", title: "Moto" }] });
    db.exec(
      "INSERT INTO topic_passages(topic_id,passage_id) SELECT 't-motion', id FROM passages WHERE source_id = 'mazzoldi'",
    );
    db.close();
    await page.reload();

    await page.getByText("Mappe", { exact: true }).click();
    await page.getByRole("button", { name: "Nuova mappa" }).click();
    const dialog = page.getByRole("dialog", { name: "Nuova mappa" });
    await dialog.getByLabel("Materia").click();
    await page.locator('.ant-select-dropdown:visible .ant-select-item-option[title="Fisica I"]').click();
    await dialog.getByLabel("Argomento").click();
    await page.locator('.ant-select-dropdown:visible .ant-select-item-option[title="Moto"]').click();
    await dialog.getByRole("button", { name: "Continua" }).click();
    await expect(page).toHaveURL(/#\/maps\/phys\/t-motion\?from=maps$/);
    await expect(page.locator(".px-map-working")).toBeVisible();
    await expect(page.locator(".react-flow__node").first()).toBeVisible({ timeout: 60_000 });

    // Three model calls, one map: the topic's name at the root, each part under it, "Velocità" once.
    const maps = (await page.evaluate(() =>
      window.pyxis.invoke("maps.list", { topicId: "t-motion" }),
    )) as Array<{ title: string; passageCount: number }>;
    expect(maps).toHaveLength(1);
    expect(maps[0]).toMatchObject({ title: "Moto", passageCount: 50 });
    const graph = (await page.evaluate(() =>
      window.pyxis.invoke("maps.open", { topicId: "t-motion" }),
    )) as { nodes: Array<{ id: string; label: string; parent: string | null }> };
    const root = graph.nodes.find((node) => node.parent === null)!;
    expect(root.label).toBe("Moto");
    expect(graph.nodes.filter((node) => node.parent === root.id).map((node) => node.label)).toEqual([
      "Parte 1",
      "Parte 2",
      "Parte 3",
    ]);
    expect(graph.nodes.filter((node) => node.label === "Velocità")).toHaveLength(1);
    expect(graph.nodes).toHaveLength(1 + 14 + 13 + 13);
    await expect(page.getByRole("heading", { level: 1, name: "Moto" })).toBeVisible();
    // 41 concepts in a column are too many to read at once, so it opens with each part folded and counted.
    await expect(page.locator(".react-flow__node")).toHaveCount(4);
    await saveShot(page, "maps-subject/merged-map.png");
    const part = page.locator('.react-flow__node[data-id="n0"] .px-concept-fold');
    await part.dispatchEvent("click");
    await expect(part).toHaveAttribute("aria-expanded", "true");
    await expect(page.locator(".react-flow__node")).toHaveCount(4 + 13);
    await saveShot(page, "maps-subject/merged-map-part-open.png");
    // Flashcards from the map take its whole outline and go under the topic's exam.
    await page.getByRole("button", { name: "Crea flashcard da questa mappa" }).click();
    const cards = page.getByRole("dialog", { name: "Crea flashcard" });
    await expect(cards.getByLabel("Esame")).toBeEnabled();
    await cards.getByRole("button", { name: "Annulla" }).click();
    await expect(cards).toHaveCount(0);

    // Mappe lists it as a single tile.
    await page.getByRole("link", { name: /^Mappe/ }).click();
    await expect(page.getByRole("status")).toHaveText("1 mappa");
    await expect(page.locator(".px-maps-subject").getByRole("link")).toHaveCount(1);
    await saveShot(page, "maps-subject/merged-tile.png");
    expect(errors).toEqual([]);
  } finally {
    await app.close();
    removeTestFolder(userData);
  }
});
