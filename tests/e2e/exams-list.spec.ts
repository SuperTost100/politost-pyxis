import { expect, test } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { launchPyxis } from "./app-under-test";
import { seedPlan, seedSubjects } from "./seed";
import { removeTestFolder } from "./cleanup";
import { fromChiediToExams } from "./doors";

const day = 86_400_000;

/** Two dated exams, one without a date and one archived after its exam, with one due card in each dated plan. */
function seed(db: DatabaseSync) {
  const now = Date.now();
  const plan = (id: string, title: string, examAt: number | null, topic: { id: string; title: string }) =>
    seedPlan(db, { id, title, language: "it", target: 0.75, examAt, topics: [topic] });
  plan("p-far", "Chimica generale", now + 20 * day, { id: "t-atoms", title: "Atomi" });
  plan("p-near", "Fisica 1", now + 4 * day, { id: "t-dyn", title: "Dinamica" });
  plan("p-none", "Inglese", null, { id: "t-cond", title: "Condizionali" });
  plan("p-old", "Informatica", now - 60 * day, { id: "t-java", title: "Classi" });
  db.prepare("UPDATE plans SET archived_at = ? WHERE id = 'p-old'").run(now - 30 * day);
  db.prepare(
    "INSERT INTO plan_sessions(id,plan_id,date,label,created_at) VALUES('s-near','p-near',?,'Written',1)",
  ).run(now + 4 * day);
  db.exec(`
    INSERT INTO cards(id,plan_id,topic_id,front,back,created_at) VALUES
      ('c-near','p-near','t-dyn','Unità della forza?','Il newton.',1),
      ('c-far','p-far','t-atoms','Numero atomico?','Protoni nel nucleo.',2);
  `);
}

test("Esami lists each exam with its rings, date and next step, the due flashcards as one line, and the archived ones", async () => {
  const userData = mkdtempSync(join(tmpdir(), "pyxis-exams-list-"));
  const app = await launchPyxis({ userData });
  try {
    const page = await app.firstWindow();
    await page.getByRole("button", { name: "Salta" }).click();
    await fromChiediToExams(page);
    await page.evaluate(() => window.pyxis.invoke("plans.list", {}));
    const db = new DatabaseSync(join(userData, "workspace", "pyxis.db"));
    seed(db);
    await page.evaluate(() => localStorage.setItem("pyxis.lang", "en"));
    await page.reload();

    await expect(page.getByRole("heading", { name: "Exams", exact: true })).toBeVisible();
    await expect(page.getByText("You have 2 flashcards to review today")).toBeVisible();
    await expect(page.getByText("1 from Fisica 1 and 1 from Chimica generale")).toBeVisible();

    // The closest exam first, the one without a date last; the archived one stays out of the list.
    const list = page.getByRole("list", { name: "Your exams" });
    const rows = list.getByRole("link");
    await expect(rows).toHaveCount(3);
    await expect(rows.nth(0)).toContainText("Fisica 1");
    await expect(rows.nth(0)).toContainText(/Written \w+day/);
    await expect(rows.nth(0)).toContainText("NowDiagnostic test");
    await expect(rows.nth(1)).toContainText("Chimica generale");
    await expect(rows.nth(2)).toContainText("IngleseDate to be set");
    // Each row's rings are one image that reads its three values.
    await expect(rows.nth(0).getByRole("img")).toHaveAccessibleName(
      "Preparation not measured yet, Path 0%, Today 0%",
    );

    // A lesson read today closes Today's ring and moves the path.
    await page.evaluate(() =>
      window.pyxis.invoke("plans.complete", { planId: "p-none", activity: "lesson", topicId: "t-cond" }),
    );
    await page.reload();
    await expect(rows.nth(2).getByRole("img")).toHaveAccessibleName(
      /^Preparation not measured yet, Path [1-9]\d?%, Today 100%$/,
    );

    // Archived exams wait behind their toggle, which grows the list out of itself.
    const toggle = page.getByRole("button", { name: "Archived" });
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    const archived = page.getByRole("list", { name: "Archived exams" });
    await expect(archived.getByRole("link")).toHaveCount(1);
    await expect(archived.getByRole("link")).toContainText("Informatica");
    await expect(archived.getByRole("link")).toContainText(/Taken in \w+/);

    // One session over both plans' cards, the closest exam's card first.
    await page.getByRole("button", { name: "Review 2", exact: true }).click();
    await expect(page).toHaveURL(/#\/cards\/due$/);
    await expect(page.getByText("Unità della forza?", { exact: true })).toBeVisible();
    // The header names the card's plan and counts the session.
    await expect(page.getByText("Fisica 1 · 1 of 2")).toBeVisible();
    // Undo takes back a rating across plans: the second plan's card shows, then the first one returns.
    await page.getByRole("button", { name: /Flip/ }).click();
    await page.getByRole("button", { name: "Easy", exact: true }).click();
    await expect(page.getByText("Numero atomico?", { exact: true })).toBeVisible();
    await expect(page.getByText("Chimica generale · 2 of 2")).toBeVisible();
    await page.getByRole("button", { name: "Undo last", exact: true }).click();
    await expect(page.getByText("Unità della forza?", { exact: true })).toBeVisible();
    await expect(page.getByText("Fisica 1 · 1 of 2")).toBeVisible();
    for (const front of ["Unità della forza?", "Numero atomico?"]) {
      // The card itself: after a rating its front is also in the "Next flashcard" announcement.
      await expect(page.getByText(front, { exact: true })).toBeVisible();
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
            "SELECT plan_id, topic_id FROM learning_events WHERE kind = 'lesson_completed' AND topic_id IN ('t-atoms','t-dyn') ORDER BY plan_id",
          )
          .all()
          .map((row) => `${row.plan_id}:${row.topic_id}`),
      )
      .toEqual(["p-far:t-atoms", "p-near:t-dyn"]);
    // The deck spans exams, so its way back is Exams; there is no close button.
    await expect(page.getByRole("button", { name: "Close", exact: true })).toHaveCount(0);
    await page.getByRole("banner").getByRole("button", { name: "Exams", exact: true }).click();
    await expect(page).toHaveURL(/#\/exams$/);
    // Nothing is due any more, so the line is gone.
    await expect(page.getByText(/to review today/)).toHaveCount(0);

    // A row is a link: the keyboard reaches it and Enter opens the exam.
    await rows.nth(0).focus();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/#\/plans\/p-near$/);
    db.close();
  } finally {
    await app.close();
    removeTestFolder(userData);
  }
});

test("the due line counts the flashcards with no exam, with exams or without any", async () => {
  const userData = mkdtempSync(join(tmpdir(), "pyxis-exams-due-free-"));
  const app = await launchPyxis({ userData });
  try {
    const page = await app.firstWindow();
    await page.getByRole("button", { name: "Salta" }).click();
    await fromChiediToExams(page);
    await page.evaluate(() => window.pyxis.invoke("plans.list", {}));
    const db = new DatabaseSync(join(userData, "workspace", "pyxis.db"));
    seedSubjects(db, [{ id: "phys", name: "Fisica I" }]);
    db.exec(`INSERT INTO cards(id,subject_id,front,back,created_at) VALUES
      ('c-free-1','phys','Che cos’è il campo?','Una grandezza in ogni punto.',1),
      ('c-free-2','phys','Che cos’è la massa?','La resistenza ad accelerare.',2)`);
    await page.evaluate(() => localStorage.setItem("pyxis.lang", "en"));
    await page.reload();

    // No exam at all: the list is empty, and the daily review still has both flashcards.
    await expect(page.getByRole("heading", { name: "Create an exam to get started" })).toBeVisible();
    await expect(page.getByText("You have 2 flashcards to review today")).toBeVisible();
    await expect(page.getByRole("button", { name: "Review 2", exact: true })).toBeVisible();

    // With an exam, the line adds them to the exam's own and names them apart.
    seedPlan(db, {
      id: "p-near",
      title: "Fisica 1",
      language: "it",
      target: 0.75,
      examAt: Date.now() + 4 * day,
      topics: [{ id: "t-dyn", title: "Dinamica" }],
    });
    db.prepare(
      "INSERT INTO cards(id,plan_id,topic_id,front,back,created_at) VALUES('c-near','p-near','t-dyn','Unità della forza?','Il newton.',3)",
    ).run();
    await page.reload();
    await expect(page.getByText("You have 3 flashcards to review today")).toBeVisible();
    await expect(page.getByText("1 from Fisica 1 and 2 with no exam")).toBeVisible();

    // The button opens the same session, which holds all three.
    await page.getByRole("button", { name: "Review 3", exact: true }).click();
    await expect(page).toHaveURL(/#\/cards\/due$/);
    await expect(page.getByText("Unità della forza?", { exact: true })).toBeVisible();
    await expect(page.getByText("Fisica 1 · 1 of 3")).toBeVisible();
    db.close();
  } finally {
    await app.close();
    removeTestFolder(userData);
  }
});

test("Esami with no exam says what will appear and keeps New exam and the import menu", async () => {
  const userData = mkdtempSync(join(tmpdir(), "pyxis-exams-empty-"));
  const app = await launchPyxis({ userData });
  try {
    const page = await app.firstWindow();
    await page.getByRole("button", { name: "Salta" }).click();
    await fromChiediToExams(page);
    await expect(page.getByRole("heading", { name: "Crea un esame per iniziare" })).toBeVisible();
    await expect(page.getByRole("list", { name: "I tuoi esami" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Archiviati" })).toHaveCount(0);
    // The Esami menu holds importing, every flashcard and the mistakes notebook.
    await page.getByRole("button", { name: "Altro" }).click();
    await expect(page.getByRole("menuitem", { name: "Importa da un file .pyxis" })).toBeVisible();
    await page.getByRole("menuitem", { name: "Tutte le flashcard" }).click();
    await expect(page).toHaveURL(/#\/exams\/cards$/);
    await expect(page.getByRole("heading", { name: "Tutte le flashcard" })).toBeVisible();
    await page.getByRole("main").getByRole("link", { name: "Esami", exact: true }).click();
    await page.getByRole("button", { name: "Nuovo esame" }).click();
    await expect(page).toHaveURL(/#\/plans\/new$/);
  } finally {
    await app.close();
    removeTestFolder(userData);
  }
});
