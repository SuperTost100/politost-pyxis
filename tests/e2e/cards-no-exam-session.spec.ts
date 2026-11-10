import { expect, test } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { launchPyxis } from "./app-under-test";
import { seedPlan, seedSubjects } from "./seed";
import { removeTestFolder } from "./cleanup";
import { fromChiediToExams } from "./doors";

/** One dated exam with one due card, and a subject with no exam that has three. */
function seed(db: DatabaseSync) {
  seedSubjects(db, [{ id: "chem", name: "Chimica" }]);
  seedPlan(db, {
    id: "p-near",
    title: "Fisica 1",
    language: "it",
    target: 0.75,
    examAt: Date.now() + 4 * 86_400_000,
    topics: [{ id: "t-dyn", title: "Dinamica" }],
  });
  db.exec(`
    INSERT INTO cards(id,plan_id,topic_id,front,back,created_at) VALUES
      ('c-exam','p-near','t-dyn','Unità della forza?','Il newton.',1);
    INSERT INTO cards(id,subject_id,front,back,created_at) VALUES
      ('s1','chem','Numero atomico?','Protoni nel nucleo.',10),
      ('s2','chem','Massa molare?','Grammi per mole.',11),
      ('s3','chem','Cos’è un isotopo?','Stesso numero atomico, massa diversa.',12);
  `);
}

test("flashcards with no exam: Oggi's count follows them, and Undo on one leaves an exam card's rating alone", async () => {
  test.setTimeout(120_000);
  const userData = mkdtempSync(join(tmpdir(), "pyxis-cards-no-exam-"));
  const app = await launchPyxis({ userData });
  try {
    const page = await app.firstWindow();
    await page.getByRole("button", { name: "Salta" }).click();
    await fromChiediToExams(page);
    await page.evaluate(() => window.pyxis.invoke("plans.list", {}));
    const db = new DatabaseSync(join(userData, "workspace", "pyxis.db"), { timeout: 10_000 });
    seed(db);
    await page.evaluate(() => localStorage.setItem("pyxis.lang", "en"));
    await page.reload();

    const first = page.getByRole("region", { name: "Today" }).getByRole("listitem").first();
    await expect(first).toContainText("4 flashcards due");

    // Reviewing the subject's own deck changes what is due today, and Oggi, still fresh in the app's cache, says so.
    await page.evaluate(() => {
      location.hash = "#/cards/subject/chem";
    });
    await expect(page.getByText("Numero atomico?", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: /Flip/ }).click();
    await page.getByRole("button", { name: "Easy", exact: true }).click();
    await expect(page.getByText("Massa molare?", { exact: true })).toBeVisible();
    await page.evaluate(() => {
      location.hash = "#/exams";
    });
    await expect(first).toContainText("3 flashcards due");

    // The daily review: the exam's card, then the subject's. Undo takes back only the last rating, the subject's, so
    // the exam's rating still reaches its path when the session closes.
    await first.getByRole("button").click();
    await expect(page).toHaveURL(/#\/cards\/due$/);
    await expect(page.getByText("Unità della forza?", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: /Flip/ }).click();
    await page.getByRole("button", { name: "Easy", exact: true }).click();
    await expect(page.getByText("Massa molare?", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: /Flip/ }).click();
    await page.getByRole("button", { name: "Easy", exact: true }).click();
    await expect(page.getByText("Cos’è un isotopo?", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Undo last", exact: true }).click();
    await expect(page.getByText("Massa molare?", { exact: true })).toBeVisible();
    await page.getByRole("banner").getByRole("button", { name: "Exams", exact: true }).click();
    await expect(page).toHaveURL(/#\/exams$/);
    await expect
      .poll(() =>
        db
          .prepare("SELECT plan_id, topic_id FROM learning_events WHERE kind = 'lesson_completed'")
          .all()
          .map((row) => `${row.plan_id}:${row.topic_id}`),
      )
      .toEqual(["p-near:t-dyn"]);
    db.close();
  } finally {
    await app.close();
    removeTestFolder(userData);
  }
});
