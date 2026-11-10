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
  // The recorded flashcards a map's outline gives: a question tied to the first passage and a concept with none.
  const cardReplies = {
    cards: {
      cards: [
        { kind: "qa", front: "Che cos'è la velocità media?", back: "Lo spostamento diviso il tempo.", passageId: "{{passage:0}}" },
        { kind: "concept", term: "Accelerazione", definition: "Quanto cambia la velocità in un istante.", passageId: null },
      ],
    },
  };
  const app = await launchPyxis({
    userData,
    env: {
      PYXIS_E2E_MAP_REPLIES: JSON.stringify(mapReplies),
      PYXIS_E2E_PLAN_REPLIES: JSON.stringify(cardReplies),
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

    // Flashcards from a map belong to its subject. Fisica I has no exam, so the dialog only says where they go, and an
    // exam of another subject whose topic cites the same passages is not offered.
    const chem = new DatabaseSync(join(userData, "workspace", "pyxis.db"), { timeout: 10000 });
    seedPlan(chem, { id: "p-chem", subjectId: "chem", title: "Chimica generale", topics: [{ id: "t-chem", title: "Cinetica" }] });
    chem.exec("INSERT INTO topic_passages(topic_id,passage_id) VALUES('t-chem','pa-1'),('t-chem','pa-2'),('t-chem','pa-3')");
    chem.close();
    await page.getByRole("button", { name: "Crea flashcard da questa mappa" }).click();
    const cards = page.getByRole("dialog", { name: "Crea flashcard" });
    await expect(cards.locator(".px-mc-lead")).toHaveText(
      "Vanno in Fisica I, che non ha esami: le ritrovi tra le flashcard della materia.",
    );
    await expect(cards.locator("#mc-plan")).toHaveCount(0);
    await expect(cards.locator("#mc-subject")).toHaveCount(0);
    await expect(cards).not.toContainText("Chimica generale");
    await saveShot(cards, "maps-subject/cards-no-exam.png");
    await cards.getByRole("button", { name: "Crea flashcard", exact: true }).click();
    const proposed = cards.getByRole("list", { name: "Flashcard proposte" }).getByRole("listitem");
    await expect(proposed).toHaveCount(2);
    await cards.getByRole("button", { name: "Salva 2 flashcard" }).click();
    await expect(cards).toHaveCount(0);
    await expect(page.getByText("2 flashcard salvate in Fisica I.")).toBeVisible();
    const saved = new DatabaseSync(join(userData, "workspace", "pyxis.db"), { timeout: 10000 });
    expect(
      saved.prepare("SELECT front, plan_id, topic_id, subject_id, passage_id FROM cards ORDER BY front").all(),
    ).toEqual([
      { front: "Accelerazione", plan_id: null, topic_id: null, subject_id: "phys", passage_id: null },
      { front: "Che cos'è la velocità media?", plan_id: null, topic_id: null, subject_id: "phys", passage_id: "pa-1" },
    ]);
    saved.close();

    // They are due in the daily review with every other flashcard, and the card says which subject it belongs to.
    await page.evaluate(() => {
      window.location.hash = "/cards/due";
    });
    const card = page.getByRole("article", { name: "Flashcard" });
    await expect(card).toContainText("Che cos'è la velocità media?");
    await expect(page.getByText("Fisica I · 1 di 2")).toBeVisible();
    await page.getByRole("button", { name: /^Gira/ }).click();
    await expect(card).toContainText("Lo spostamento diviso il tempo.");
    await saveShot(page, "maps-subject/cards-review-no-exam.png");
    await page.getByRole("button", { name: /^La sapevo/ }).click();
    await expect(card).toContainText("Accelerazione");
    const reviewed = new DatabaseSync(join(userData, "workspace", "pyxis.db"), { timeout: 10000 });
    expect(reviewed.prepare("SELECT COUNT(*) AS n FROM card_reviews").get()).toEqual({ n: 1 });
    // A card with no exam is evidence for no exam's path.
    expect(reviewed.prepare("SELECT COUNT(*) AS n FROM learning_events WHERE kind = 'card_rated'").get()).toEqual({ n: 0 });
    reviewed.close();

    // The card browser lists them under their subject, as "Senza esame", and reviews them on their own from there.
    await page.evaluate(() => {
      window.location.hash = "/exams/cards";
    });
    const physics = page.locator(".px-cardbrowser-subject").filter({ has: page.getByRole("heading", { name: "Fisica I" }) });
    await expect(physics.getByRole("heading", { level: 3 })).toHaveText(["Senza esame"]);
    await expect(physics.locator(".px-cardbrowser-row")).toHaveCount(2);
    await saveShot(page, "maps-subject/cards-browser-no-exam.png");
    await page.locator("#card-exam").click();
    await page.locator('.ant-select-dropdown:visible .ant-select-item-option[title="Senza esame"]').click();
    await expect(page.locator(".px-cardbrowser-summary")).toContainText("2 flashcard");
    await physics.getByRole("button", { name: "Ripassa le flashcard senza esame di Fisica I" }).click();
    await expect(page).toHaveURL(/#\/cards\/subject\/phys$/);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Flashcard · Fisica I");
    await expect(card).toContainText("Accelerazione");
    await page.getByRole("button", { name: /^Gira/ }).click();
    await page.getByRole("button", { name: /^La sapevo/ }).click();
    await expect(card).toHaveCount(0);
    expect(errors).toEqual([]);

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

    // Now Fisica I has an exam: from the map of one of its topics the dialog offers the exam, optional and preselected
    // on the exam and topic that hold the map's topic.
    await page.getByRole("button", { name: "Crea flashcard da questa mappa" }).click();
    await expect(cards.locator(".px-mc-lead")).toHaveText("Vanno in Fisica I.");
    const picked = (id: string) => cards.locator(id).locator("xpath=ancestor::div[contains(@class,'ant-select')][1]");
    await expect(picked("#mc-plan")).toContainText("Meccanica");
    await expect(picked("#mc-topic")).toContainText("Moto");
    await expect(cards.getByText("Con l’esame contano anche nel suo percorso.")).toBeVisible();
    await saveShot(cards, "maps-subject/cards-with-exam.png");
    // "Nessun esame" takes the exam away again, and the cards can still be made.
    await cards.locator("#mc-plan").click();
    await page.locator('.ant-select-dropdown:visible .ant-select-item-option[title="Nessun esame"]').click();
    await expect(cards.locator("#mc-topic")).toHaveCount(0);
    await expect(cards.getByRole("button", { name: "Crea flashcard", exact: true })).toBeEnabled();
    await cards.getByRole("button", { name: "Annulla" }).click();
    expect(errors).toEqual([]);
  } finally {
    await app.close();
    removeTestFolder(userData);
  }
});
