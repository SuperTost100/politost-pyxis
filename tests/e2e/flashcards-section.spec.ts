import { expect, test } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { launchPyxis } from "./app-under-test";
import { removeTestFolder } from "./cleanup";
import { seedPlan, seedSubjects } from "./seed";
import { saveShot } from "./shots";

test("the Flashcard section lists each subject's flashcards and starts every review from them, with no exam at all", async () => {
  test.setTimeout(120_000);
  const userData = mkdtempSync(join(tmpdir(), "pyxis-flashcards-section-"));
  const app = await launchPyxis({ userData });
  let opened: DatabaseSync | undefined;
  try {
    const page = await app.firstWindow();
    await page.getByRole("button", { name: "Salta" }).click();
    await expect(page).toHaveURL(/#\/ask$/);
    await page.evaluate(() => window.pyxis.invoke("plans.list", {}));
    // Two subjects and no exam: the flashcards made from a map or a lesson, filed under their subject.
    const db = new DatabaseSync(join(userData, "workspace", "pyxis.db"), { timeout: 10_000 });
    opened = db;
    seedSubjects(db, [
      { id: "chem", name: "Chimica", position: 0 },
      { id: "phys", name: "Fisica 2", position: 1 },
    ]);
    db.exec(`INSERT INTO cards(id,subject_id,front,back,created_at) VALUES
      ('s1','chem','Numero atomico?','Protoni nel nucleo.',10),
      ('s2','chem','Massa molare?','Grammi per mole.',11),
      ('s3','phys','Legge di Gauss?','Il flusso di E è la carica su ε₀.',12);`);

    const sections = page.getByRole("navigation", { name: "Sezioni" });
    await sections.getByRole("link", { name: "Flashcard", exact: true }).click();
    await expect(page).toHaveURL(/#\/flashcards$/);
    // A folded sidebar (under 1100 CSS px) shows the link's name as a tooltip under the pointer, which the link's own
    // name then repeats ("Flashcard Flashcard"), so the name is matched from its start.
    await expect(sections.getByRole("link", { name: /^Flashcard\b/ })).toHaveAttribute("aria-current", "page");
    await expect(page.getByRole("heading", { level: 1, name: "Flashcard" })).toBeVisible();
    const chem = page.getByRole("region", { name: "Chimica" });
    await expect(chem).toContainText("2 flashcard · 2 da ripassare oggi");
    await expect(chem.getByRole("heading", { level: 3, name: "Senza esame" })).toBeVisible();
    await expect(page.getByRole("region", { name: "Fisica 2" })).toContainText("1 flashcard · 1 da ripassare oggi");

    // The Library draws file covers, whose stylesheet puts a drop shadow on its own `svg`. Once it has loaded, the
    // Flashcard page must not pick any of that up.
    await page.evaluate(() => (location.hash = "/exams/library"));
    await expect(page.locator(".px-library-head")).toBeVisible();
    await page.evaluate(() => (location.hash = "/flashcards"));
    await expect(page.getByRole("heading", { level: 1, name: "Flashcard" })).toBeVisible();
    const noFilter = (selector: string) =>
      page.locator(selector).evaluate((element) => getComputedStyle(element).filter);
    for (const theme of ["light", "dark"] as const) {
      await page.evaluate((look) => window.pyxis.setAppearance(look), theme);
      await saveShot(page, `flashcards-section/after-library-it-${theme}.png`, { animations: "disabled" });
      expect(await noFilter(".px-flashcards")).toBe("none");
      expect(await noFilter(".px-flashcards h1")).toBe("none");
      expect(await noFilter(".px-fc-head")).toBe("none");
    }
    await page.evaluate(() => window.pyxis.setAppearance("light"));

    // The head holds the browser and a new flashcard as secondary buttons, the day's review sits in the band under it.
    const head = page.locator(".px-fc-head");
    await expect(head.getByRole("button", { name: "Sfoglia tutte", exact: true })).toBeVisible();
    await expect(head.getByRole("button", { name: "Nuova flashcard", exact: true })).toHaveClass(/ant-btn-default/);
    const band = page.locator(".px-fc-band");
    await expect(band).toContainText("Oggi ne hai 3 da ripassare, in 2 materie");

    // The daily review holds every subject's flashcards, though there is no exam, and closing it comes back here.
    await band.getByRole("button", { name: "Ripassa le 3 di oggi", exact: true }).click();
    await expect(page).toHaveURL(/#\/cards\/due$/);
    await expect(page.getByText("Numero atomico?", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: /Gira/ }).click();
    await page.getByRole("button", { name: "Facile", exact: true }).click();
    await expect(page.getByText("Massa molare?", { exact: true })).toBeVisible();
    await page.getByRole("banner").getByRole("button", { name: "Torna a Flashcard", exact: true }).click();
    await expect(page).toHaveURL(/#\/flashcards$/);
    await expect(page.getByRole("button", { name: "Ripassa le 2 di oggi", exact: true })).toBeVisible();
    await expect(band).toContainText("Oggi ne hai 2 da ripassare, in 2 materie");
    await expect(chem).toContainText("2 flashcard · 1 da ripassare oggi");

    // Fisica 2's review is its own flashcards only.
    await page.getByRole("button", { name: "Ripassa le flashcard di Fisica 2", exact: true }).click();
    await expect(page).toHaveURL(/#\/cards\/due\?subject=phys$/);
    await expect(page.getByText("Legge di Gauss?", { exact: true })).toBeVisible();
    await page.getByRole("banner").getByRole("button", { name: "Torna a Flashcard", exact: true }).click();
    await expect(page).toHaveURL(/#\/flashcards$/);

    // An exam for Chimica: its topic gets a row under the exam's name, the subject's review takes in its cards too, and
    // the topic opens as on the exam's page.
    seedPlan(db, {
      id: "p-chem",
      subjectId: "chem",
      title: "Chimica generale",
      language: "it",
      target: 0.75,
      examAt: Date.now() + 10 * 86_400_000,
      topics: [{ id: "t-atom", title: "Struttura dell’atomo" }],
    });
    // A card of the exam with no topic gets a row of its own under the exam, so the rows add up to the subject's count.
    db.exec(`INSERT INTO cards(id,plan_id,topic_id,front,back,created_at) VALUES
      ('e1','p-chem','t-atom','Che cos’è un orbitale?','La regione dove è probabile trovare l’elettrone.',20),
      ('e2','p-chem',NULL,'Che cos’è una mole?','Un numero di Avogadro di particelle.',21);`);
    db.close();
    await page.reload();
    await expect(chem).toContainText("4 flashcard · 3 da ripassare oggi");
    const exam = chem.getByRole("list", { name: "Chimica generale" });
    await expect(exam.getByRole("link")).toHaveText([/^Struttura dell’atomo1 flashcard/, /^Nessun argomento1 flashcard/]);
    await exam.getByRole("link", { name: /^Nessun argomento/ }).click();
    await expect(page).toHaveURL(/#\/cards\/due\?exam=p-chem&topic=none$/);
    await expect(page.getByText("Che cos’è una mole?", { exact: true })).toBeVisible();
    await expect(page.getByText("Che cos’è un orbitale?", { exact: true })).toHaveCount(0);
    await page.getByRole("banner").getByRole("button", { name: "Torna a Flashcard", exact: true }).click();
    await expect(page).toHaveURL(/#\/flashcards$/);
    await chem.getByRole("button", { name: "Ripassa le flashcard di Chimica", exact: true }).click();
    await expect(page).toHaveURL(/#\/cards\/due\?subject=chem$/);
    await expect(page.getByText("Che cos’è un orbitale?", { exact: true })).toBeVisible();
    await page.getByRole("banner").getByRole("button", { name: "Torna a Flashcard", exact: true }).click();
    await expect(page).toHaveURL(/#\/flashcards$/);
    await exam.getByRole("link", { name: /^Struttura dell’atomo/ }).click();
    await expect(page).toHaveURL(/#\/plans\/p-chem\/cards\/t-atom$/);
    await expect(page.getByText("Che cos’è un orbitale?", { exact: true })).toBeVisible();
    await page.getByRole("banner").getByRole("button", { name: "Torna a Flashcard", exact: true }).click();
    await expect(page).toHaveURL(/#\/flashcards$/);

    // The row of Chimica's flashcards with no exam opens them on their own.
    await chem.getByRole("list", { name: "Senza esame" }).getByRole("link").click();
    await expect(page).toHaveURL(/#\/cards\/subject\/chem$/);
    await expect(page.getByText("Massa molare?", { exact: true })).toBeVisible();
    await page.getByRole("banner").getByRole("button", { name: "Torna a Flashcard", exact: true }).click();
    await expect(page).toHaveURL(/#\/flashcards$/);

    // The search finds a subject's flashcards and opens the section on it.
    await page.getByRole("complementary", { name: "Barra laterale" }).getByRole("button", { name: /^Cerca/ }).click();
    const finder = page.getByRole("dialog", { name: "Cerca" });
    await finder.getByRole("combobox", { name: "Cerca" }).fill("fisica");
    await finder.getByRole("group", { name: "Flashcard" }).getByRole("option", { name: /^Fisica 2/ }).click();
    await expect(page).toHaveURL(/#\/flashcards$/);
    await expect(page.getByRole("heading", { level: 2, name: "Fisica 2" })).toBeFocused();
  } finally {
    if (opened?.isOpen) opened.close();
    await app.close();
    removeTestFolder(userData);
  }
});

test("after the last flashcard is removed, the Flashcard section still leads to the removed ones, where it can be restored", async () => {
  test.setTimeout(120_000);
  const userData = mkdtempSync(join(tmpdir(), "pyxis-flashcards-removed-"));
  const app = await launchPyxis({ userData });
  try {
    const page = await app.firstWindow();
    await page.getByRole("button", { name: "Salta" }).click();
    await page.evaluate(() => window.pyxis.invoke("plans.list", {}));
    const db = new DatabaseSync(join(userData, "workspace", "pyxis.db"), { timeout: 10_000 });
    try {
      seedSubjects(db, [{ id: "chem", name: "Chimica", position: 0 }]);
      // One flashcard Pyxis wrote, so deleting it only removes it.
      db.exec(`INSERT INTO cards(id,subject_id,front,back,seed_key,grounding,created_at) VALUES
        ('s1','chem','Numero atomico?','Protoni nel nucleo.','k1','sources',10);`);
    } finally {
      db.close();
    }
    await page.evaluate(() => (location.hash = "/flashcards"));
    await expect(page.getByRole("region", { name: "Chimica" })).toBeVisible();
    await page.locator(".px-fc-head").getByRole("button", { name: "Sfoglia tutte", exact: true }).click();
    await expect(page).toHaveURL(/#\/flashcards\/all$/);

    // The last flashcard is removed, and the message says where to find it.
    await page.getByRole("button", { name: /^Altre azioni: Numero atomico\?/ }).click();
    await page.getByRole("menuitem", { name: "Elimina la flashcard…", exact: true }).click();
    await page.getByRole("dialog", { name: "Eliminare questa flashcard?" }).getByRole("button", { name: "Elimina la flashcard", exact: true }).click();
    await expect(page.getByRole("status")).toHaveText("Flashcard rimossa. Puoi ripristinarla da Rimosse.");

    // The section has nothing left to list and offers one button, but the way to the removed ones is still there.
    await page.getByRole("button", { name: /^Torna a / }).click();
    await expect(page).toHaveURL(/#\/flashcards$/);
    await expect(page.getByRole("button", { name: "Nuova flashcard", exact: true })).toHaveCount(1);
    await page.locator(".px-fc-head").getByRole("button", { name: "Altro sulle flashcard", exact: true }).click();
    await page.getByRole("menuitem", { name: "Sfoglia tutte", exact: true }).click();
    await expect(page).toHaveURL(/#\/flashcards\/all$/);
    await page.getByRole("combobox", { name: "Mostra" }).click();
    await page.locator('.ant-select-dropdown:visible .ant-select-item-option[title="Rimosse"]').click();
    const removed = page.getByRole("listitem").filter({ hasText: "Numero atomico?" });
    await expect(removed).toBeVisible();
    await removed.getByRole("button", { name: /^Ripristina: Numero atomico\?/ }).click();
    await expect(page.getByRole("status")).toHaveText("Flashcard ripristinata.");
  } finally {
    await app.close();
    removeTestFolder(userData);
  }
});
