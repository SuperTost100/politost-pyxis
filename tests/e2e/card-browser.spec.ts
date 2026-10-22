import AxeBuilder from "@axe-core/playwright";
import {
  _electron as electron,
  expect,
  test,
  type Page,
} from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const MAIN = join(
  process.cwd(),
  process.env.PYXIS_OUT ?? "out",
  "main/index.js",
);

/** Two subjects, one exam with no subject, and cards that need the folding, the math and the cloze. */
function seed(db: DatabaseSync) {
  const now = Date.now();
  db.exec(`
    INSERT INTO subjects(id,name,position,created_at) VALUES('s-chem','Chimica',1,1),('s-phys','Fisica',0,1);
    INSERT INTO plans(id,subject_id,title,status,content_language,created_at,updated_at) VALUES
      ('p-phys','s-phys','Fisica 1','ready','it',1,1),
      ('p-chem','s-chem','Chimica generale','ready','it',1,1),
      ('p-none',NULL,'Appunti sparsi','ready','it',1,1);
    INSERT INTO topics(id,plan_id,title,position,created_at) VALUES
      ('t-dyn','p-phys','Dinamica',0,1),('t-kin','p-phys','Cinematica',1,1),
      ('t-atoms','p-chem','Atomi',0,1),('t-misc','p-none','Varie',0,1);
    INSERT INTO cards(id,plan_id,topic_id,front,back,seed_key,grounding,created_at) VALUES
      ('c-why','p-phys','t-dyn','Perché un corpo accelera?','Perché agisce una forza: $F=ma$.','k1','sources',1),
      ('c-unit','p-phys','t-dyn','Unità della forza?','Il newton.','k2','sources',2),
      ('c-speed','p-phys','t-kin','Velocità media?','Spazio diviso tempo.','k3','sources',3),
      ('c-atomic','p-chem','t-atoms','Numero atomico?','Protoni nel nucleo.','k4','sources',4),
      ('c-misc','p-none','t-misc','Sparsa','Senza materia.','k5','sources',5);
    INSERT INTO cards(id,plan_id,topic_id,front,back,created_at) VALUES
      ('c-cloze','p-chem','t-atoms','{{c1::Elettroni}} orbitano il nucleo.','Modello di Bohr.',6);
  `);
  const state = JSON.stringify({
    intervalDays: 10,
    ease: 2,
    dueAt: now + 10 * 86_400_000,
  });
  db.prepare(
    "INSERT INTO card_reviews(id,card_id,rating,state_json,reviewed_at) VALUES('r1','c-atomic','good',?,?)",
  ).run(state, now);
}

const reviewRows = (db: DatabaseSync) =>
  db.prepare("SELECT * FROM card_reviews WHERE card_id = 'c-atomic'").all();

/** Picks an action from a card's menu: Suspend, Resume and Delete sit there, next to Edit. */
async function cardAction(page: Page, card: string, action: string) {
  await page
    .getByRole("button", { name: new RegExp(`^More actions: ${card}`) })
    .click();
  await page
    .getByRole("menuitem", { name: action, exact: true })
    .click();
}

async function choose(page: Page, label: string, option: string) {
  await page.getByRole("combobox", { name: label }).click();
  // The listbox only exposes the options next to the active one, so pick from the visible list.
  await page
    .locator(
      `.ant-select-dropdown:visible .ant-select-item-option[title="${option}"]`,
    )
    .click();
}

test("the flashcard browser groups, searches, edits, suspends, deletes and restores", async () => {
  test.setTimeout(120_000);
  const userData = mkdtempSync(join(tmpdir(), "pyxis-card-browser-"));
  const env = { ...process.env, PYXIS_USER_DATA: userData, PYXIS_E2E: "1" };
  delete (env as NodeJS.ProcessEnv).ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ args: [MAIN], env });
  try {
    const page = await app.firstWindow();
    await page.getByRole("button", { name: "Salta" }).click();
    await expect(page).toHaveURL(/#\/exams$/);
    await page.evaluate(() => localStorage.setItem("pyxis.lang", "en"));
    const db = new DatabaseSync(join(userData, "workspace", "pyxis.db"), {
      timeout: 10_000,
    });
    seed(db);

    // Reached as a tab next to Sources.
    await page.evaluate(() => {
      location.hash = "#/exams";
    });
    await page.reload();
    await page
      .locator(".ant-segmented-item-label", { hasText: "Flashcards" })
      .click();
    await expect(page).toHaveURL(/#\/exams\/cards$/);
    await expect(page.getByRole("status")).toHaveText("6 flashcards");

    // Subjects in their saved order, the exam with no subject last, the exam and topic as sub-headings.
    await expect(page.getByRole("heading", { level: 2 })).toHaveText([
      "Fisica",
      "Chimica",
      "No subject",
    ]);
    await expect(page.getByRole("heading", { level: 3 })).toHaveText([
      "Fisica 1 · Dinamica",
      "Fisica 1 · Cinematica",
      "Chimica generale · Atomi",
      "Appunti sparsi · Varie",
    ]);
    // Each card is a compact row: Edit stays on the row, Suspend and Delete wait in its menu.
    await expect(page.getByRole("button", { name: /^Edit: / })).toHaveCount(6);
    await expect(
      page.getByRole("button", { name: /^(Suspend|Delete): / }),
    ).toHaveCount(0);
    // Math is rendered; a cloze shows its sentence with the answer filled in.
    await expect(
      page.locator(".px-cardbrowser-row .katex").first(),
    ).toBeVisible();
    await expect(
      page
        .getByRole("listitem")
        .filter({ hasText: "orbitano il nucleo" })
        .locator("strong"),
    ).toHaveText("Elettroni");
    // Cards fade in; contrast measured mid-fade reads too low on a slow runner.
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            document
              .getAnimations()
              .filter(
                (animation) =>
                  animation.playState === "running" &&
                  animation.effect?.getTiming().iterations !== Infinity,
              ).length,
        ),
      )
      .toBe(0);
    expect(
      (
        await new AxeBuilder({ page }).setLegacyMode(true).analyze()
      ).violations.map((v) => v.id),
    ).toEqual([]);

    // An accent-less search finds the accented card, in any case.
    const search = page.getByRole("textbox", { name: "Search flashcards" });
    await search.fill("PERCHE");
    await expect(page.getByRole("status")).toHaveText("1 flashcard");
    await expect(page.getByRole("listitem")).toHaveCount(1);
    await expect(page.getByText("Perché un corpo accelera?")).toBeVisible();
    await search.fill("zzz");
    await expect(page.getByText("No flashcard matches.")).toBeVisible();
    await page.getByRole("button", { name: "Clear filters" }).click();
    await expect(page.getByRole("status")).toHaveText("6 flashcards");

    // Exam, then topic.
    await expect(page.getByRole("combobox", { name: "Topic" })).toBeDisabled();
    await choose(page, "Exam", "Chimica generale");
    await expect(page.getByRole("status")).toHaveText("2 flashcards");
    await expect(page.getByRole("heading", { level: 2 })).toHaveText([
      "Chimica",
    ]);
    await choose(page, "Topic", "Atomi");
    await expect(page.getByRole("status")).toHaveText("2 flashcards");
    await page.getByRole("button", { name: "Clear filters" }).click();

    // Editing keeps the review schedule.
    const before = reviewRows(db);
    expect(before).toHaveLength(1);
    await page.getByRole("button", { name: /^Edit: Numero atomico\?/ }).click();
    const dialog = page.getByRole("dialog", { name: "Edit flashcard" });
    await dialog
      .getByRole("textbox", { name: "Front" })
      .fill("Numero atomico (Z)?");
    await dialog
      .getByRole("textbox", { name: "Back" })
      .fill("Il numero di protoni.");
    await dialog.getByRole("button", { name: "Save" }).click();
    await expect(dialog).toBeHidden();
    const edited = page
      .getByRole("listitem")
      .filter({ hasText: "Numero atomico (Z)?" });
    await expect(edited).toContainText("Il numero di protoni.");
    await expect(edited).toContainText("Next review");
    expect(reviewRows(db)).toEqual(before);

    // Suspend, find it under Suspended, resume.
    await cardAction(page, "Velocità media\\?", "Suspend");
    const speed = page
      .getByRole("listitem")
      .filter({ hasText: "Velocità media?" });
    await expect(speed).toContainText("Suspended");
    await choose(page, "Show", "Suspended");
    await expect(page.getByRole("listitem")).toHaveCount(1);
    await cardAction(page, "Velocità media\\?", "Resume");
    await expect(page.getByRole("listitem")).toHaveCount(0);
    await choose(page, "Show", "All flashcards");

    // A seeded card is removed, then restored.
    await cardAction(page, "Unità della forza\\?", "Delete");
    const confirm = page.getByRole("dialog", { name: "Delete this flashcard?" });
    await expect(confirm).toContainText("You can bring it back under Removed");
    await confirm.getByRole("button", { name: "Delete", exact: true }).click();
    await expect(page.getByRole("status")).toHaveText(
      "Flashcard removed. You can restore it under Removed.",
    );
    await expect(page.getByText("Unità della forza?")).toHaveCount(0);
    await choose(page, "Show", "Removed");
    const removed = page
      .getByRole("listitem")
      .filter({ hasText: "Unità della forza?" });
    await expect(removed).toContainText("Removed");
    await expect(page.getByRole("listitem")).toHaveCount(1);
    // A removed card offers Restore, and no edit.
    await expect(removed.getByRole("button", { name: /^Edit/ })).toHaveCount(0);
    await removed
      .getByRole("button", { name: /^Restore: Unità della forza\?/ })
      .click();
    await expect(page.getByRole("status")).toHaveText("Flashcard restored.");
    await choose(page, "Show", "All flashcards");
    await expect(page.getByText("Unità della forza?")).toBeVisible();

    // A hand-made card says its delete is permanent.
    await cardAction(page, "Elettroni orbitano", "Delete");
    const permanent = page.getByRole("dialog", { name: "Delete this flashcard?" });
    await expect(permanent).toContainText("deleting it is permanent");
    await permanent.getByRole("button", { name: "Delete forever" }).click();
    await expect(page.getByText("Flashcard deleted.")).toBeVisible();
    await choose(page, "Show", "Removed");
    await expect(page.getByRole("listitem")).toHaveCount(0);
    expect(
      db.prepare("SELECT COUNT(*) AS n FROM cards WHERE id = 'c-cloze'").get(),
    ).toEqual({ n: 0 });
    db.close();
  } finally {
    await app.close();
    rmSync(userData, { recursive: true, force: true });
  }
});

test("the flashcard browser says when there are no cards", async () => {
  const userData = mkdtempSync(join(tmpdir(), "pyxis-card-browser-empty-"));
  const env = { ...process.env, PYXIS_USER_DATA: userData, PYXIS_E2E: "1" };
  delete (env as NodeJS.ProcessEnv).ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ args: [MAIN], env });
  try {
    const page = await app.firstWindow();
    await page.getByRole("button", { name: "Salta" }).click();
    // Skipping saves the profile first; a reload before that lands back on setup.
    await expect(page).toHaveURL(/#\/exams$/);
    await page.evaluate(() => {
      localStorage.setItem("pyxis.lang", "en");
      location.hash = "#/exams/cards";
    });
    await page.reload();
    await expect(
      page.getByRole("heading", { name: "No flashcards yet" }),
    ).toBeVisible();
  } finally {
    await app.close();
    rmSync(userData, { recursive: true, force: true });
  }
});
