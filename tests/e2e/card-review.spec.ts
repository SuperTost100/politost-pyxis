import { expect, test } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { launchPyxis } from "./app-under-test";
import { seedPlan, seedSource } from "./seed";
import { expectNoAxeViolations } from "./axe";
import { removeTestFolder } from "./cleanup";
import { fromChiediToExams } from "./doors";

/** One topic with three cards Pyxis wrote (one from a passage), one hand-made card, and a finished card build. */
function seed(db: DatabaseSync) {
  seedSource(db, {
    id: "src",
    title: "Appunti",
    document: { id: "doc" },
    passages: [
      {
        id: "pas",
        text: "La forza è il prodotto di massa e accelerazione.",
        locator: { chapter: 1 },
        section: "1. Dinamica",
      },
    ],
  });
  seedPlan(db, {
    id: "p",
    title: "Fisica 1",
    language: "it",
    sourceIds: ["src"],
    topics: [{ id: "t", title: "Dinamica" }],
  });
  db.exec(`
    INSERT INTO cards(id,plan_id,topic_id,front,back,passage_id,seed_key,grounding,created_at) VALUES
      ('c1','p','t','Seconda legge di Newton?','$F=ma$.','pas','k1','sources',1),
      ('c2','p','t','Unità della forza?','Il newton.',NULL,'k2','sources',2),
      ('c3','p','t','Velocità media?','Spazio diviso tempo.',NULL,'k3','sources',3);
    INSERT INTO cards(id,plan_id,topic_id,front,back,created_at) VALUES('c4','p','t','Mia carta','Scritta a mano.',4);
    INSERT INTO jobs(id,kind,params_json,state,created_at,updated_at) VALUES('job','cards-build','{"planId":"p","topicId":"t"}','succeeded',1,1);
  `);
}

test("card review: the study bar, ratings only under the card, undo, the card menu and asking the tutor", async () => {
  test.setTimeout(120_000);
  const userData = mkdtempSync(join(tmpdir(), "pyxis-card-review-"));
  const app = await launchPyxis({ userData });
  try {
    const page = await app.firstWindow();
    await page.getByRole("button", { name: "Salta" }).click();
    await fromChiediToExams(page);
    await page.evaluate(() => localStorage.setItem("pyxis.lang", "en"));
    const db = new DatabaseSync(join(userData, "workspace", "pyxis.db"), {
      timeout: 10_000,
    });
    seed(db);
    // Three new cards a day: the session holds three of the topic's four.
    db.exec(`INSERT INTO settings(key,value_json,updated_at) VALUES('cards.newPerDay','3',1)`);
    const count = (sql: string) => (db.prepare(sql).get() as { n: number }).n;
    await page.evaluate(() => {
      location.hash = "#/plans/p/cards/t";
    });
    await page.reload();

    const front = page.locator("article.px-card .px-card-front");
    const bar = page.getByRole("banner");
    const meta = page.locator(".px-studybar-title p");
    await expect(front).toHaveText("Seconda legge di Newton?");
    // The study bar: the way back named after the exam, the deck's name, and the deck's actions. No close button.
    await expect(bar.getByRole("heading", { level: 1 })).toHaveText("Dinamica");
    const back = bar.getByRole("button", { name: "Back to Fisica 1", exact: true });
    await expect(back).toBeVisible();
    await expect(page.getByRole("button", { name: "Close", exact: true })).toHaveCount(0);
    await expect(bar.getByRole("button", { name: "New flashcard", exact: true })).toBeVisible();
    await expect(bar.getByRole("button", { name: "More on the flashcards", exact: true })).toBeVisible();
    // Edit is not a tool of the bar: it is in the card's own menu.
    await expect(bar.getByRole("button", { name: "Edit", exact: true })).toHaveCount(0);
    const undoLast = bar.getByRole("button", { name: "Undo last", exact: true });
    await expect(undoLast).toBeDisabled();
    // The header counts the card on screen, and the deck counts say why the session is shorter than the deck.
    await expect(meta).toHaveText("Flashcards · 1 of 3");
    await expect(page.locator(".px-cards-toolbar .small")).toHaveText(
      "New 4 (3 today) · Learning 0 · Mastered 0",
    );
    // Export is in the bar's menu, not in the middle of the page (checked at the end).
    await expect(page.getByRole("button", { name: "Export", exact: true })).toHaveCount(0);
    // One way out, the bar's, and no authoring form open in the loop.
    await expect(page.getByRole("button", { name: /^Back to / })).toHaveCount(1);
    await expect(page.getByRole("button", { name: "Back", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Mark as done" })).toHaveCount(0);
    await expect(page.getByRole("textbox", { name: "Front" })).toBeHidden();

    // The card shows without turning; Space turns it to the back, with the question above the answer.
    const card = page.locator("article.px-card");
    await expect(card).toHaveAttribute("data-face", "front");
    await expect(card).not.toHaveAttribute("data-turn");
    await expect(page.getByText("Or press the space bar.")).toBeVisible();
    // Gira shows its key as a badge, and the badge stays out of the button's name.
    await expect(page.getByRole("button", { name: "Flip", exact: true })).toHaveText("FlipSpace");
    // After the flip, the row under the card holds the four ratings and nothing else.
    await page.keyboard.press("Space");
    // It turns away, shows the back half-way and turns back in, then rests.
    await expect(card).toHaveAttribute("data-face", "back");
    await expect(card).not.toHaveAttribute("data-turn");
    // The focus moves to the answer, so a screen reader reads it; Space turns back to the front and focus to Gira.
    // It holds the question too, where a cloze card shows its filled-in answer.
    const reveal = page.locator(".px-card-reveal");
    await expect(reveal).toBeFocused();
    await expect(reveal.locator(".px-card-asked")).not.toBeEmpty();
    await expect(reveal.locator(".px-card-back")).not.toBeEmpty();
    await page.keyboard.press("Space");
    await expect(page.getByRole("button", { name: "Flip" })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(reveal).toBeFocused();
    await expect(page.getByRole("group", { name: "How well did you know it?" })).toHaveText("Didn't know it1Hard2Knew it3Easy4");
    // Edit lives in the card's own menu, not beside the ratings and not in the bar.
    await expect(page.getByRole("button", { name: "Edit", exact: true })).toHaveCount(0);
    await expect(page.locator(".px-cards-stage").getByRole("button", { name: "Flashcard actions" })).toBeEnabled();
    await expectNoAxeViolations(page);

    // A rating can be taken back: the card shows again and its review and event are gone.
    await page.keyboard.press("3");
    await expect(page.locator(".px-cards-undo")).toContainText("You picked “Knew it”.");
    await expect(meta).toHaveText("Flashcards · 2 of 3");
    await expect(front).toHaveText("Unità della forza?");
    expect(count("SELECT COUNT(*) AS n FROM card_reviews")).toBe(1);
    // The next card can show before the rating's refresh ends, and keys wait for it; Undo turns on when it ends.
    await expect(undoLast).toBeEnabled();
    await page.keyboard.press("u");
    await expect(front).toHaveText("Seconda legge di Newton?");
    await expect(meta).toHaveText("Flashcards · 1 of 3");
    await expect(page.locator(".px-cards-undo")).toHaveCount(0);
    await expect(undoLast).toBeDisabled();
    expect(count("SELECT COUNT(*) AS n FROM card_reviews")).toBe(0);
    expect(
      count("SELECT COUNT(*) AS n FROM learning_events WHERE kind = 'card_rated'"),
    ).toBe(0);

    // Suspend from the card's menu, then Undo.
    await page.getByRole("button", { name: "Flashcard actions" }).click();
    await page.getByRole("menuitem", { name: /Suspend/ }).click();
    await expect(page.locator(".px-cards-undo")).toContainText("Flashcard suspended.");
    await expect(front).toHaveText("Unità della forza?");
    await undoLast.click();
    await expect(front).toHaveText("Seconda legge di Newton?");
    // The Undo button can keep focus while the bar is open, and the page's keys ignore a button as their target.
    await expect(page.locator(".px-cards-undo")).toHaveCount(0);
    expect(count("SELECT COUNT(*) AS n FROM cards WHERE suspended = 1")).toBe(0);

    // A right-click on the card opens the same menu as its dots, and a pick acts the same way. A menu that was just
    // closed fades out first, so the test waits until none is open before it opens the next one.
    const open = page.locator(".ant-dropdown:not(.ant-dropdown-hidden)");
    await expect(open).toHaveCount(0);
    const cardBox = (await page.locator(".px-card").boundingBox())!;
    const pointer = { x: cardBox.x + 60, y: cardBox.y + 60 };
    await page.mouse.click(pointer.x, pointer.y, { button: "right" });
    await expect(open).toHaveCount(1);
    for (const item of [/^Edit/, /^Suspend/, /^Delete/]) await expect(open.getByRole("menuitem", { name: item })).toBeVisible();
    // The menu holds the actions and nothing else: their keys live in Help's shortcuts dialog.
    await expect(open.getByRole("menuitem")).toHaveText(["Edit", "Suspend", "Delete"]);
    await expect(open.locator("kbd")).toHaveCount(0);
    // The stage turns the card in perspective, which must not move the menu: its corner is at the pointer.
    await expect
      .poll(async () => {
        const menuBox = (await open.boundingBox())!;
        return [Math.abs(menuBox.x - pointer.x) < 8, Math.abs(menuBox.y - pointer.y) < 12];
      })
      .toEqual([true, true]);
    // Opening the dots' menu while this one is open leaves only the dots', and a right-click then leaves only this one.
    const dots = page.getByRole("button", { name: "Flashcard actions" });
    await dots.click();
    await expect(open).toHaveCount(1);
    await expect(open.getByRole("menuitem", { name: /^Edit/ })).toBeVisible();
    await page.mouse.click(pointer.x, pointer.y, { button: "right" });
    await expect(open).toHaveCount(1);
    await expect(open.getByRole("menuitem", { name: /^Edit/ })).toBeVisible();
    await open.getByRole("menuitem", { name: /^Suspend/ }).click();
    await expect(page.locator(".px-cards-undo")).toContainText("Flashcard suspended.");
    await undoLast.click();
    await expect(front).toHaveText("Seconda legge di Newton?");
    await expect(page.locator(".px-cards-undo")).toHaveCount(0);
    expect(count("SELECT COUNT(*) AS n FROM cards WHERE suspended = 1")).toBe(0);

    // D removes a card Pyxis wrote with Undo at hand.
    await page.keyboard.press("d");
    await expect(page.locator(".px-cards-undo")).toContainText("Flashcard removed.");
    expect(count("SELECT COUNT(*) AS n FROM cards WHERE removed = 1")).toBe(1);
    await undoLast.click();
    await expect(front).toHaveText("Seconda legge di Newton?");
    expect(count("SELECT COUNT(*) AS n FROM cards WHERE removed = 1")).toBe(0);
    // The undo bar and its focused button go once the undo is done; until then Space is not the card's.
    await expect(page.locator(".px-cards-undo")).toHaveCount(0);

    // Ask the tutor after the flip: a chat seeded with front, back and the source passage.
    await page.keyboard.press("Space");
    await expect(page.getByRole("group", { name: "How well did you know it?" })).toHaveText("Didn't know it1Hard2Knew it3Easy4");
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
    await expect(page.getByRole("group", { name: "How well did you know it?" })).toHaveText("Didn't know it1Hard2Knew it3Easy4");
    await page.keyboard.press("3");
    await expect(front).toHaveText("Unità della forza?");
    await expect(undoLast).toBeEnabled();
    await page.keyboard.press("Space");
    await expect(page.getByRole("group", { name: "How well did you know it?" })).toHaveText("Didn't know it1Hard2Knew it3Easy4");
    await page.getByRole("button", { name: "Ask the tutor" }).click();
    await expect(page).toHaveURL(/#\/ask\/[\w-]+$/);
    // As on the first visit, the chat page settles first: the address changes before the page does, and coming back
    // before the flashcards page has gone would find it as it was left.
    await expect(page.getByRole("textbox", { name: "Message" })).toBeVisible();
    await expect.poll(() => cardSteps().length).toBe(1);
    expect(JSON.parse(cardSteps()[0]!.payload_json)).toMatchObject({
      activity: "cards",
      result: { correct: 1, total: 1 },
    });

    // Back to the exam records the session first, like leaving for the tutor.
    await page.evaluate(() => {
      location.hash = "#/plans/p/cards/t";
    });
    await expect(front).toHaveText("Unità della forza?");
    await page.keyboard.press("Space");
    await page.keyboard.press("3");
    await expect(front).toHaveText("Velocità media?");
    await expect(undoLast).toBeEnabled();
    await back.click();
    await expect(page).toHaveURL(/#\/plans\/p$/);
    await expect.poll(() => cardSteps().length).toBe(2);
    expect(JSON.parse(cardSteps()[1]!.payload_json)).toMatchObject({
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

    // Export is in the bar's menu.
    await bar.getByRole("button", { name: "More on the flashcards", exact: true }).click();
    await expect(page.getByRole("menuitem", { name: "Export", exact: true })).toBeEnabled();
    await page.keyboard.press("Escape");

    // Back closes the session and goes back to the exam.
    await back.click();
    await expect(page).toHaveURL(/#\/plans\/p$/);
    db.close();
  } finally {
    await app.close();
    removeTestFolder(userData);
  }
});

test("the Attività list on the cards page leaves the way the back control does, and takes none of the page's keys", async () => {
  test.setTimeout(120_000);
  const userData = mkdtempSync(join(tmpdir(), "pyxis-card-jobs-"));
  const app = await launchPyxis({ userData });
  try {
    const page = await app.firstWindow();
    await page.getByRole("button", { name: "Salta" }).click();
    await fromChiediToExams(page);
    await page.evaluate(() => localStorage.setItem("pyxis.lang", "en"));
    const db = new DatabaseSync(join(userData, "workspace", "pyxis.db"), { timeout: 10_000 });
    seed(db);
    // A job that failed for want of an AI tool: its card in Attività leads to Settings.
    db.prepare(
      "INSERT INTO jobs(id,kind,params_json,state,progress,error,created_at,updated_at) VALUES('j-fail','lesson-part',?,'failed',0,'engines.errors.engine-missing',?,?)",
    ).run(JSON.stringify({ planId: "p", topicId: "t", position: 1 }), Date.now(), Date.now());
    const count = (sql: string) => (db.prepare(sql).get() as { n: number }).n;
    const cardSteps = () =>
      count(
        "SELECT COUNT(*) AS n FROM learning_events WHERE kind = 'lesson_completed' AND plan_id = 'p' AND payload_json LIKE '%\"cards\"%'",
      );
    await page.evaluate(() => {
      location.hash = "#/plans/p/cards/t";
    });
    await page.reload();
    const card = page.locator("article.px-card");
    await expect(card.locator(".px-card-front")).toHaveText("Seconda legge di Newton?");
    await page.keyboard.press("Space");
    await page.keyboard.press("3");
    await expect(card.locator(".px-card-front")).toHaveText("Unità della forza?");
    await expect.poll(() => count("SELECT COUNT(*) AS n FROM card_reviews")).toBe(1);

    // The list has the focus once it opens: Space and a rating key do nothing to the card under it.
    await page.getByRole("banner").getByRole("button", { name: /^Background tasks/ }).click();
    await expect(page.locator(".px-jobs")).toBeFocused();
    await page.keyboard.press("Space");
    await page.keyboard.press("3");
    await expect(card).toHaveAttribute("data-face", "front");
    await expect(card.locator(".px-card-front")).toHaveText("Unità della forza?");
    expect(count("SELECT COUNT(*) AS n FROM card_reviews")).toBe(1);

    // Its link to Settings leaves the page like the back control: the session with a rating is recorded first.
    expect(cardSteps()).toBe(0);
    await page.getByRole("button", { name: "Go to AI tools" }).click();
    await expect(page).toHaveURL(/#\/settings\/engines/);
    expect(cardSteps()).toBe(1);
    db.close();
  } finally {
    await app.close();
    removeTestFolder(userData);
  }
});

test("Vai > Indietro on the cards page does what the back control does: the session with a rating is recorded first", async () => {
  test.setTimeout(120_000);
  const userData = mkdtempSync(join(tmpdir(), "pyxis-card-menu-back-"));
  const app = await launchPyxis({ userData });
  try {
    const page = await app.firstWindow();
    await page.getByRole("button", { name: "Salta" }).click();
    await fromChiediToExams(page);
    await page.evaluate(() => localStorage.setItem("pyxis.lang", "en"));
    const db = new DatabaseSync(join(userData, "workspace", "pyxis.db"), { timeout: 10_000 });
    seed(db);
    const cardSteps = () =>
      (
        db
          .prepare(
            "SELECT COUNT(*) AS n FROM learning_events WHERE kind = 'lesson_completed' AND plan_id = 'p' AND payload_json LIKE '%\"cards\"%'",
          )
          .get() as { n: number }
      ).n;
    await page.evaluate(() => {
      location.hash = "#/plans/p";
    });
    await page.evaluate(() => {
      location.hash = "#/plans/p/cards/t";
    });
    const front = page.locator("article.px-card .px-card-front");
    await expect(front).toHaveText("Seconda legge di Newton?");
    await page.keyboard.press("Space");
    await page.keyboard.press("3");
    await expect(front).toHaveText("Unità della forza?");
    expect(cardSteps()).toBe(0);
    await app.evaluate(({ Menu }) => Menu.getApplicationMenu()?.getMenuItemById("back")?.click());
    await expect(page).toHaveURL(/#\/plans\/p$/);
    await expect.poll(cardSteps).toBe(1);
    db.close();
  } finally {
    await app.close();
    removeTestFolder(userData);
  }
});

test("new flashcard: a form grown from the bar adds to the deck, closes on Esc and Cancel, and holds the card's keys", async () => {
  test.setTimeout(90_000);
  const userData = mkdtempSync(join(tmpdir(), "pyxis-card-new-"));
  const app = await launchPyxis({ userData });
  try {
    const page = await app.firstWindow();
    await page.getByRole("button", { name: "Salta" }).click();
    await fromChiediToExams(page);
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
    const card = page.locator("article.px-card");
    await expect(card.locator(".px-card-front")).toHaveText("Seconda legge di Newton?");
    await expect(page.locator(".px-cards-toolbar .small")).toHaveText("New 4 · Learning 0 · Mastered 0");
    // The old fold-out under the card is gone.
    await expect(page.getByText("Add a flashcard", { exact: true })).toHaveCount(0);

    // It opens from the bar with the focus in Front, and Add waits for both faces.
    const open = page.getByRole("banner").getByRole("button", { name: "New flashcard", exact: true });
    await expect(open).toHaveAttribute("aria-expanded", "false");
    await open.click();
    const form = page.getByRole("dialog", { name: "New flashcard" });
    await expect(form).toBeVisible();
    await expect(open).toHaveAttribute("aria-expanded", "true");
    // The card's menu and the bar's other actions wait, so the card editor can't open behind the form.
    const bar = page.getByRole("banner");
    await expect(page.getByRole("button", { name: "Flashcard actions" })).toBeDisabled();
    await expect(bar.getByRole("button", { name: "Undo last", exact: true })).toBeDisabled();
    const frontField = form.getByRole("textbox", { name: "Front", exact: true });
    const backField = form.getByRole("textbox", { name: "Back", exact: true });
    await expect(frontField).toBeFocused();
    const add = form.getByRole("button", { name: "Add", exact: true });
    await expect(add).toBeDisabled();
    // Tab goes round the form and stays in it.
    await page.keyboard.press("Shift+Tab");
    await expect(form.getByRole("button", { name: "Cancel", exact: true })).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(frontField).toBeFocused();
    await expectNoAxeViolations(page);

    // While it is open, Space and 1 to 4 are not the card's, even with the focus outside the form.
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.keyboard.press("Space");
    await page.keyboard.press("3");
    await expect(card).toHaveAttribute("data-face", "front");
    expect(count("SELECT COUNT(*) AS n FROM card_reviews")).toBe(0);
    await expect(form).toBeVisible();

    // Add saves the card into this deck, confirms in place and leaves the form empty for the next one.
    await frontField.fill("Prima legge di Newton?");
    await expect(add).toBeDisabled();
    await backField.fill("Un corpo resta in quiete o in moto rettilineo uniforme.");
    await add.click();
    await expect(form.getByRole("status")).toHaveText("Added. You can write another.");
    await expect(frontField).toHaveValue("");
    await expect(backField).toHaveValue("");
    await expect(frontField).toBeFocused();
    expect(
      count("SELECT COUNT(*) AS n FROM cards WHERE plan_id = 'p' AND topic_id = 't' AND front = 'Prima legge di Newton?'"),
    ).toBe(1);
    await expect(page.locator(".px-cards-toolbar .small")).toHaveText("New 5 · Learning 0 · Mastered 0");

    // Esc closes it and gives the focus back to the button; what was typed is still there when it opens again.
    await frontField.fill("Una bozza");
    await page.keyboard.press("Escape");
    await expect(form).toHaveCount(0);
    await expect(open).toBeFocused();
    await expect(open).toHaveAttribute("aria-expanded", "false");
    await open.click();
    await expect(frontField).toHaveValue("Una bozza");
    // Cancel closes it too and throws the draft away.
    await form.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(form).toHaveCount(0);
    await expect(open).toBeFocused();
    await open.click();
    await expect(frontField).toHaveValue("");
    await page.keyboard.press("Escape");
    await expect(form).toHaveCount(0);

    // Closed, the card's keys work again.
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.keyboard.press("Space");
    await expect(card).toHaveAttribute("data-face", "back");
    db.close();
  } finally {
    await app.close();
    removeTestFolder(userData);
  }
});

test("card build: cards show as each batch is stored, and Export waits for the first card", async () => {
  test.setTimeout(90_000);
  const userData = mkdtempSync(join(tmpdir(), "pyxis-card-build-"));
  const app = await launchPyxis({ userData });
  try {
    const page = await app.firstWindow();
    await page.getByRole("button", { name: "Salta" }).click();
    await fromChiediToExams(page);
    await page.evaluate(() => localStorage.setItem("pyxis.lang", "en"));
    const db = new DatabaseSync(join(userData, "workspace", "pyxis.db"), {
      timeout: 10_000,
    });
    seedPlan(db, { id: "p", title: "Fisica 1", language: "it", topics: [{ id: "t", title: "Dinamica" }] });
    // A build still writing: no card yet. Seeded after start-up, so the runner leaves it running.
    db.exec(
      `INSERT INTO jobs(id,kind,params_json,state,progress,created_at,updated_at)
       VALUES('job','cards-build','{"planId":"p","topicId":"t"}','running',0,1,1)`,
    );
    await page.evaluate(() => {
      location.hash = "#/plans/p/cards/t";
    });
    await page.reload();
    const building = page.getByText("Writing flashcards from your sources.", { exact: false });
    const exportItem = page.getByRole("menuitem", { name: "Export", exact: true });
    const moreOnCards = page.getByRole("button", { name: "More on the flashcards", exact: true });
    await expect(building).toBeVisible();
    await moreOnCards.click();
    await expect(exportItem).toBeDisabled();
    await page.keyboard.press("Escape");
    await expect(page.locator("article.px-card")).toHaveCount(0);
    // Until the first card arrives, a card waits where it will appear, with the mark at work.
    const waiting = page.locator(".px-card-waiting");
    await expect(waiting).toHaveText("Writing the first flashcard…");
    await expect(waiting.locator(".px-logo-working")).toBeVisible();

    // The first batch is stored and the build moves its progress: its cards show while the build goes on.
    db.exec(`
      INSERT INTO cards(id,plan_id,topic_id,front,back,seed_key,grounding,created_at) VALUES
        ('b1','p','t','Seconda legge di Newton?','$F=ma$.','g1','sources',1),
        ('b2','p','t','Unità della forza?','Il newton.','g2','sources',2);
      UPDATE jobs SET progress = 0.4 WHERE id = 'job';
    `);
    await expect(page.locator("article.px-card .px-card-front")).toHaveText("Seconda legge di Newton?");
    await expect(building).toBeVisible();
    await expect(page.locator(".px-studybar-title p")).toHaveText("Flashcards · 1 of 2");
    await moreOnCards.click();
    await expect(exportItem).toBeEnabled();
    await page.keyboard.press("Escape");
    db.close();
  } finally {
    await app.close();
    removeTestFolder(userData);
  }
});

test("card browser: a card forgotten six times is tagged and filtered", async () => {
  test.setTimeout(90_000);
  const userData = mkdtempSync(join(tmpdir(), "pyxis-card-leech-"));
  const app = await launchPyxis({ userData });
  try {
    const page = await app.firstWindow();
    await page.getByRole("button", { name: "Salta" }).click();
    await fromChiediToExams(page);
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
    removeTestFolder(userData);
  }
});

test("card limit: past today's new cards, the message links to the setting, after recording the session", async () => {
  const userData = mkdtempSync(join(tmpdir(), "pyxis-card-limit-"));
  const app = await launchPyxis({ userData });
  try {
    const page = await app.firstWindow();
    await page.getByRole("button", { name: "Salta" }).click();
    await fromChiediToExams(page);
    await page.evaluate(() => localStorage.setItem("pyxis.lang", "en"));
    const db = new DatabaseSync(join(userData, "workspace", "pyxis.db"), { timeout: 10_000 });
    seed(db);
    db.close();
    // One new card a day: rate it, and the rest wait for tomorrow.
    await page.evaluate(() => window.pyxis.invoke("study.saveCardSettings", { newPerDay: 1 }));
    await page.evaluate(() => {
      location.hash = "#/plans/p/cards/t";
    });
    await page.reload();
    await page.getByRole("button", { name: "Flip", exact: true }).click();
    await page.getByRole("button", { name: "Easy", exact: true }).click();
    await expect(page.getByText("That's today's 1 new flashcard for this exam. The rest start tomorrow.")).toBeVisible();
    // The session is recorded when it ends, which is when the limit shows; Change then opens the setting.
    await page.getByRole("link", { name: "Change", exact: true }).click();
    await expect(page).toHaveURL(/#\/settings\/flashcards$/);
    const steps = await page.evaluate(() => window.pyxis.invoke("plans.read", { planId: "p" }));
    expect((steps as { steps: Array<{ activity: string }> }).steps.some((step) => step.activity === "cards")).toBe(true);
    await expect(page.getByRole("textbox", { name: "New flashcards a day, for each exam" })).toHaveValue("1");
    // With no new cards a day, the message says so in its own words.
    await page.evaluate(() => window.pyxis.invoke("study.saveCardSettings", { newPerDay: 0 }));
    await page.evaluate(() => {
      location.hash = "#/plans/p/cards/t";
    });
    await page.reload();
    await expect(page.getByText("The limit for new flashcards is 0, so none start today.")).toBeVisible();
  } finally {
    await app.close();
    removeTestFolder(userData);
  }
});
