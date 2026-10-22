import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { launchPyxis } from "./app-under-test";

/** One topic with three cards Pyxis wrote (one from a passage), one hand-made card, and a finished card build. */
function seed(db: DatabaseSync) {
  db.exec(`
    INSERT INTO sources(id,kind,title,status,library,created_at,updated_at) VALUES('src','excerpt','Appunti','ready',1,1,1);
    INSERT INTO source_documents(id,source_id,version,tree_json,created_at) VALUES('doc','src',1,'{"kind":"excerpt"}',1);
    INSERT INTO passages(id,source_id,document_id,text,locator_json,section_path,created_at) VALUES('pas','src','doc','La forza è il prodotto di massa e accelerazione.','{"chapter":1}','1. Dinamica',1);
    INSERT INTO plans(id,title,status,content_language,created_at,updated_at) VALUES('p','Fisica 1','ready','it',1,1);
    INSERT INTO plan_sources(plan_id,source_id) VALUES('p','src');
    INSERT INTO topics(id,plan_id,title,position,created_at) VALUES('t','p','Dinamica',0,1);
    INSERT INTO cards(id,plan_id,topic_id,front,back,passage_id,seed_key,grounding,created_at) VALUES
      ('c1','p','t','Seconda legge di Newton?','$F=ma$.','pas','k1','sources',1),
      ('c2','p','t','Unità della forza?','Il newton.',NULL,'k2','sources',2),
      ('c3','p','t','Velocità media?','Spazio diviso tempo.',NULL,'k3','sources',3);
    INSERT INTO cards(id,plan_id,topic_id,front,back,created_at) VALUES('c4','p','t','Mia carta','Scritta a mano.',4);
    INSERT INTO jobs(id,kind,params_json,state,created_at,updated_at) VALUES('job','cards-build','{"planId":"p","topicId":"t"}','succeeded',1,1);
  `);
}

test("card review: ratings only in the footer, undo, the card menu and asking the tutor", async () => {
  test.setTimeout(120_000);
  const userData = mkdtempSync(join(tmpdir(), "pyxis-card-review-"));
  const app = await launchPyxis({ userData });
  try {
    const page = await app.firstWindow();
    await page.getByRole("button", { name: "Salta" }).click();
    await expect(page).toHaveURL(/#\/exams$/);
    await page.evaluate(() => localStorage.setItem("pyxis.lang", "en"));
    const db = new DatabaseSync(join(userData, "workspace", "pyxis.db"), {
      timeout: 10_000,
    });
    seed(db);
    const count = (sql: string) => (db.prepare(sql).get() as { n: number }).n;
    await page.evaluate(() => {
      location.hash = "#/plans/p/cards/t";
    });
    await page.reload();

    const front = page.locator("article.px-card .px-card-front");
    const meta = page.locator(".focus-meta");
    await expect(front).toHaveText("Seconda legge di Newton?");
    await expect(meta).toHaveText("0 of 4");
    // One way out, and no authoring form open in the loop.
    await expect(page.getByRole("button", { name: "Back" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Mark as done" })).toHaveCount(0);
    await expect(page.getByRole("textbox", { name: "Front" })).toBeHidden();

    // After the flip the foot holds the four ratings and nothing else.
    await page.keyboard.press("Space");
    await expect(page.locator(".px-card-foot")).toHaveText("AgainHardGoodEasy");
    await expect(page.getByRole("button", { name: "Edit", exact: true })).toHaveCount(0);
    expect(
      (await new AxeBuilder({ page }).setLegacyMode(true).analyze()).violations.map(
        (violation) => violation.id,
      ),
    ).toEqual([]);

    // A rating can be taken back: the card shows again and its review and event are gone.
    await page.keyboard.press("3");
    await expect(page.locator(".px-cards-undo")).toContainText("Rated Good.");
    await expect(meta).toHaveText("1 of 4");
    await expect(front).toHaveText("Unità della forza?");
    expect(count("SELECT COUNT(*) AS n FROM card_reviews")).toBe(1);
    await page.keyboard.press("u");
    await expect(front).toHaveText("Seconda legge di Newton?");
    await expect(meta).toHaveText("0 of 4");
    await expect(page.locator(".px-cards-undo")).toHaveCount(0);
    expect(count("SELECT COUNT(*) AS n FROM card_reviews")).toBe(0);
    expect(
      count("SELECT COUNT(*) AS n FROM learning_events WHERE kind = 'card_rated'"),
    ).toBe(0);

    // Suspend from the card's menu, then Undo.
    await page.getByRole("button", { name: "Flashcard actions" }).click();
    await page.getByRole("menuitem", { name: /Suspend/ }).click();
    await expect(page.locator(".px-cards-undo")).toContainText("Flashcard suspended.");
    await expect(front).toHaveText("Unità della forza?");
    await page.getByRole("button", { name: "Undo" }).click();
    await expect(front).toHaveText("Seconda legge di Newton?");
    expect(count("SELECT COUNT(*) AS n FROM cards WHERE suspended = 1")).toBe(0);

    // D removes a card Pyxis wrote with Undo at hand.
    await page.keyboard.press("d");
    await expect(page.locator(".px-cards-undo")).toContainText("Flashcard removed.");
    expect(count("SELECT COUNT(*) AS n FROM cards WHERE removed = 1")).toBe(1);
    await page.getByRole("button", { name: "Undo" }).click();
    await expect(front).toHaveText("Seconda legge di Newton?");
    expect(count("SELECT COUNT(*) AS n FROM cards WHERE removed = 1")).toBe(0);
    // The undo bar and its focused button go once the undo is done; until then Space is not the card's.
    await expect(page.locator(".px-cards-undo")).toHaveCount(0);

    // Ask the tutor after the flip: a chat seeded with front, back and the source passage.
    await page.keyboard.press("Space");
    await expect(page.locator(".px-card-foot")).toHaveText("AgainHardGoodEasy");
    await page.getByRole("button", { name: "Ask the tutor" }).click();
    await expect(page).toHaveURL(/#\/ask\/[\w-]+$/);
    const chat = db
      .prepare("SELECT context_json FROM chats ORDER BY created_at DESC LIMIT 1")
      .get() as { context_json: string };
    const context = JSON.parse(chat.context_json) as { body: string };
    expect(context.body).toContain("Seconda legge di Newton?");
    expect(context.body).toContain("$F=ma$.");
    expect(context.body).toContain("La forza è il prodotto di massa e accelerazione.");
    // The chat page settles before the test leaves it.
    await expect(page.getByRole("textbox", { name: "Message" })).toBeVisible();

    // Leaving for the tutor after rating records the card session on the path, like the X does.
    const cardSteps = () =>
      db
        .prepare(
          "SELECT payload_json FROM learning_events WHERE kind = 'lesson_completed' AND plan_id = 'p' AND payload_json LIKE '%\"cards\"%'",
        )
        .all() as Array<{ payload_json: string }>;
    expect(cardSteps()).toHaveLength(0);
    await page.evaluate(() => {
      location.hash = "#/plans/p/cards/t";
    });
    await expect(front).toHaveText("Seconda legge di Newton?");
    await page.keyboard.press("Space");
    await expect(page.locator(".px-card-foot")).toHaveText("AgainHardGoodEasy");
    await page.keyboard.press("3");
    await expect(front).toHaveText("Unità della forza?");
    await page.keyboard.press("Space");
    await expect(page.locator(".px-card-foot")).toHaveText("AgainHardGoodEasy");
    await page.getByRole("button", { name: "Ask the tutor" }).click();
    await expect(page).toHaveURL(/#\/ask\/[\w-]+$/);
    await expect.poll(() => cardSteps().length).toBe(1);
    expect(JSON.parse(cardSteps()[0]!.payload_json)).toMatchObject({
      activity: "cards",
      result: { correct: 1, total: 1 },
    });

    // A hand-made card is deleted for good, so D asks first.
    // Through core, as Suspend does: core keeps each plan's cards in memory and only its own writes refresh that copy.
    await page.evaluate(async () => {
      for (const cardId of ["c1", "c2", "c3"])
        await window.pyxis.invoke("study.suspend", { cardId, suspended: true });
    });
    await page.evaluate(() => {
      location.hash = "#/plans/p/cards/t";
    });
    await expect(front).toHaveText("Mia carta");
    await page.keyboard.press("d");
    const confirm = page.getByRole("dialog", { name: "Delete this flashcard?" });
    await expect(confirm).toBeVisible();
    await confirm.getByRole("button", { name: "Cancel" }).click();
    expect(count("SELECT COUNT(*) AS n FROM cards WHERE id = 'c4'")).toBe(1);

    // The X closes the session and goes back to the exam.
    await page.getByRole("button", { name: "Close", exact: true }).click();
    await expect(page).toHaveURL(/#\/plans\/p$/);
    db.close();
  } finally {
    await app.close();
    rmSync(userData, { recursive: true, force: true });
  }
});

test("card browser: a card forgotten six times is tagged and filtered", async () => {
  test.setTimeout(90_000);
  const userData = mkdtempSync(join(tmpdir(), "pyxis-card-leech-"));
  const app = await launchPyxis({ userData });
  try {
    const page = await app.firstWindow();
    await page.getByRole("button", { name: "Salta" }).click();
    await expect(page).toHaveURL(/#\/exams$/);
    await page.evaluate(() => localStorage.setItem("pyxis.lang", "en"));
    const db = new DatabaseSync(join(userData, "workspace", "pyxis.db"), {
      timeout: 10_000,
    });
    seed(db);
    const state = JSON.stringify({
      intervalDays: 0,
      ease: 8,
      dueAt: Date.now() + 3_600_000,
      fsrs: { lapses: 7, state: 3, reps: 14, stability: 0.3 },
    });
    db.prepare(
      "INSERT INTO card_reviews(id,card_id,rating,state_json,reviewed_at) VALUES('r','c1','again',?,?)",
    ).run(state, Date.now());
    db.close();
    await page.evaluate(() => {
      location.hash = "#/exams/cards";
    });
    await page.reload();
    await expect(page.getByRole("status")).toHaveText("4 flashcards");
    await page.getByRole("combobox", { name: "Show" }).click();
    await page
      .locator('.ant-select-dropdown:visible .ant-select-item-option[title="Often forgotten"]')
      .click();
    await expect(page.getByRole("status")).toHaveText("1 flashcard");
    const card = page.getByRole("listitem");
    await expect(card).toContainText("Often forgotten");
    await expect(card).toContainText("Forgotten 7 times.");
    // Open source sits in the row's menu, next to Suspend and Delete.
    await card.getByRole("button", { name: /^More actions: Seconda legge/ }).click();
    await expect(page.getByRole("menuitem", { name: "Open source" })).toBeVisible();
    await page.keyboard.press("Escape");
    await card.getByRole("button", { name: /^Rewrite: Seconda legge/ }).click();
    await expect(page.getByRole("dialog", { name: "Edit flashcard" })).toBeVisible();
  } finally {
    await app.close();
    rmSync(userData, { recursive: true, force: true });
  }
});
