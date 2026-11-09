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
  const mapReplies = {
    title: {
      title: "Cinematica del punto",
      nodes: labels.map((label, i) => ({ id: `n${i}`, label, parent: i ? "n0" : null, sources: "{{allPassages}}" })),
      edges: [],
    },
  };
  const app = await launchPyxis({ userData, env: { PYXIS_E2E_MAP_REPLIES: JSON.stringify(mapReplies) } });
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
    await page.goBack();
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
    await expect(page.getByRole("heading", { name: "Crea una mappa di questa materia" })).toBeVisible();
    await expect(page.locator(".px-map-title p")).toHaveText("Fisica I");
    await page.getByRole("button", { name: "Crea la mappa", exact: true }).click();
    await expect(page.locator(".react-flow__node")).toHaveCount(labels.length, { timeout: 60_000 });
    await expect(page.getByRole("heading", { level: 1, name: "Cinematica del punto" })).toBeVisible();
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
    await expect(groups.first().locator(".px-maps-card-title")).toHaveText(["Cinematica del punto", "Moto rettilineo"]);
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
