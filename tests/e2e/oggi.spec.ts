import { _electron as electron, expect, test } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const MAIN = join(
  process.cwd(),
  process.env.PYXIS_OUT ?? "out",
  "main/index.js",
);

/** Two dated exams and one without a date, with one due card in each dated plan. */
function seed(db: DatabaseSync) {
  const now = Date.now();
  const day = 86_400_000;
  db.exec(`
    INSERT INTO plans(id,title,status,content_language,target,exam_at,created_at,updated_at) VALUES
      ('p-far','Chimica generale','ready','it',0.75,${now + 20 * day},1,1),
      ('p-near','Fisica 1','ready','it',0.75,${now + 4 * day},1,1),
      ('p-none','Inglese','ready','it',0.75,NULL,1,1);
    INSERT INTO topics(id,plan_id,title,position,created_at) VALUES
      ('t-atoms','p-far','Atomi',0,1),('t-dyn','p-near','Dinamica',0,1),('t-cond','p-none','Condizionali',0,1);
    INSERT INTO cards(id,plan_id,topic_id,front,back,created_at) VALUES
      ('c-near','p-near','t-dyn','Unità della forza?','Il newton.',1),
      ('c-far','p-far','t-atoms','Numero atomico?','Protoni nel nucleo.',2);
  `);
}

test("Oggi lists due cards from every plan as one item, then each exam's next step, and ticks them off", async () => {
  const userData = mkdtempSync(join(tmpdir(), "pyxis-oggi-"));
  const env = { ...process.env, PYXIS_USER_DATA: userData, PYXIS_E2E: "1" };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ args: [MAIN], env });
  try {
    const page = await app.firstWindow();
    await page.getByRole("button", { name: "Salta" }).click();
    await expect(page).toHaveURL(/#\/exams$/);
    await page.evaluate(() => window.pyxis.invoke("plans.list", {}));
    const db = new DatabaseSync(join(userData, "workspace", "pyxis.db"));
    seed(db);
    await page.evaluate(() => localStorage.setItem("pyxis.lang", "en"));
    await page.reload();

    const today = page.getByRole("region", { name: "Today" });
    const rows = today.getByRole("listitem");
    await expect(rows).toHaveCount(4);
    await expect(rows.nth(0)).toContainText("Flashcards to review");
    await expect(rows.nth(0)).toContainText("2 flashcards due · from 2 exams");
    await expect(rows.nth(0)).toContainText("Suggested");
    // The closest exam first, the plan without a date last; each opens its path's next step.
    await expect(rows.nth(1)).toContainText("Fisica 1");
    await expect(rows.nth(2)).toContainText("Chimica generale");
    await expect(rows.nth(3)).toContainText("Inglese · No date yet");
    await expect(rows.nth(1)).toContainText("Diagnostic test");

    // One session over both plans' cards, the closest exam's card first.
    await rows.nth(0).getByRole("button").click();
    await expect(page).toHaveURL(/#\/cards\/due$/);
    await expect(page.getByText("Unità della forza?")).toBeVisible();
    for (const front of ["Unità della forza?", "Numero atomico?"]) {
      await expect(page.getByText(front)).toBeVisible();
      await page.getByRole("button", { name: /Flip/ }).click();
      // Easy moves a new card out of today's learning steps, so the session ends.
      await page.getByRole("button", { name: "Easy", exact: true }).click();
    }
    await expect(page.getByText("No flashcards are due.")).toBeVisible();
    // Each plan's path gets a cards step on the topic it rated.
    await expect
      .poll(() =>
        db
          .prepare(
            "SELECT plan_id, topic_id FROM learning_events WHERE kind = 'lesson_completed' ORDER BY plan_id",
          )
          .all()
          .map((row) => `${row.plan_id}:${row.topic_id}`),
      )
      .toEqual(["p-far:t-atoms", "p-near:t-dyn"]);
    await page.getByRole("button", { name: "Back", exact: true }).click();
    await expect(page).toHaveURL(/#\/exams$/);
    await expect(rows.nth(0)).toContainText("Flashcards reviewed");
    await expect(rows.nth(0)).toContainText("Done");
    // The suggestion moves to the next item not done.
    await expect(rows.nth(1)).toContainText("Suggested");

    await today.getByRole("link", { name: "Session plan" }).click();
    await expect(page.getByRole("heading", { name: "Session plan" })).toBeVisible();
    const hours = page.getByRole("spinbutton", { name: "Hours you can study each week" });
    await hours.fill("1");
    await hours.press("Enter");
    // One hour a week cannot cover the closest exam.
    await expect(page.getByText(/At this pace Fisica 1 reaches its 75% target/)).toBeVisible();
    await page.getByText("By day").click();
    await expect(page.getByText("today", { exact: true })).toBeVisible();
    db.close();
  } finally {
    await app.close();
    rmSync(userData, { recursive: true, force: true });
  }
});
