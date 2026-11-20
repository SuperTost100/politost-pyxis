import { expect, test, type Page } from "@playwright/test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { launchPyxis } from "./app-under-test";
import { seedPlan, seedSource } from "./seed";
import { expectNoAxeViolations } from "./axe";
import { removeTestFolder } from "./cleanup";
import { fromChiediToExams } from "./doors";
import { clickSettled } from "./settled";

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
    // Every button at the bar's right end, New flashcard included, has its name as a tooltip, which is all an icon-only
    // tool shows under 1,100 px.
    const tools = await bar.locator(".px-studybar-actions button").all();
    expect(tools.length).toBeGreaterThanOrEqual(4);
    const names: string[] = [];
    for (const tool of tools) {
      const name = (await tool.getAttribute("title")) ?? "";
      names.push(name);
      expect(name, "a bar tool has a tooltip").not.toBe("");
      await expect(tool).toHaveAccessibleName(name);
    }
    expect(new Set(names).size, "no two tools share a name").toBe(names.length);
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
    await clickSettled(page, page.getByRole("menuitem", { name: /Suspend/ }));
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
    // A card Pyxis wrote is removed at once, and Undo brings it back, so its item has no "…".
    for (const item of [/^Edit/, /^Suspend/, /^Delete the flashcard$/]) await expect(open.getByRole("menuitem", { name: item })).toBeVisible();
    // The menu holds the actions and nothing else: their keys live in Help's shortcuts dialog.
    await expect(open.getByRole("menuitem")).toHaveText(["Edit", "Suspend", "Delete the flashcard"]);
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
    await clickSettled(page, open.getByRole("menuitem", { name: /^Suspend/ }));
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
    // Its menu says a confirmation follows.
    await page.mouse.click(pointer.x, pointer.y, { button: "right" });
    await expect(open.getByRole("menuitem", { name: "Delete the flashcard…" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(open).toHaveCount(0);
    await page.keyboard.press("d");
    const confirm = page.getByRole("dialog", { name: "Delete this flashcard?" });
    await expect(confirm).toBeVisible();
    await clickSettled(page, confirm.getByRole("button", { name: "Cancel" }));
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
    await page.getByRole("button", { name: "AI tools", exact: true }).click();
    await expect(page).toHaveURL(/#\/settings\/engines/);
    expect(cardSteps()).toBe(1);
    db.close();
  } finally {
    await app.close();
    removeTestFolder(userData);
  }
});

test("a link in the Attività list, held by the save of a rated session, does not move a student who went elsewhere meanwhile", async () => {
  test.setTimeout(120_000);
  const userData = mkdtempSync(join(tmpdir(), "pyxis-card-jobs-held-"));
  // The save that the link waits for is held back, so there is time to go to another page while it is on its way.
  const app = await launchPyxis({ userData, env: { PYXIS_E2E_READ_DELAY: "plans.complete=2500" } });
  try {
    const page = await app.firstWindow();
    await page.getByRole("button", { name: "Salta" }).click();
    await fromChiediToExams(page);
    await page.evaluate(() => localStorage.setItem("pyxis.lang", "en"));
    const db = new DatabaseSync(join(userData, "workspace", "pyxis.db"), { timeout: 10_000 });
    seed(db);
    db.prepare(
      "INSERT INTO jobs(id,kind,params_json,state,progress,error,created_at,updated_at) VALUES('j-fail','lesson-part',?,'failed',0,'engines.errors.engine-missing',?,?)",
    ).run(JSON.stringify({ planId: "p", topicId: "t", position: 1 }), Date.now(), Date.now());
    const cardSteps = () =>
      (
        db
          .prepare(
            "SELECT COUNT(*) AS n FROM learning_events WHERE kind = 'lesson_completed' AND plan_id = 'p' AND payload_json LIKE '%\"cards\"%'",
          )
          .get() as { n: number }
      ).n;
    await page.evaluate(() => {
      location.hash = "#/plans/p/cards/t";
    });
    await page.reload();
    await expect(page.locator("article.px-card .px-card-front")).toHaveText("Seconda legge di Newton?");
    await page.keyboard.press("Space");
    await page.keyboard.press("3");
    await expect(page.locator("article.px-card .px-card-front")).toHaveText("Unità della forza?");

    // The list's link to Settings waits for the save, which is held. Maps is chosen from the menu while it is on its way.
    await page.getByRole("banner").getByRole("button", { name: /^Background tasks/ }).click();
    await page.getByRole("button", { name: "AI tools", exact: true }).click();
    await app.evaluate(({ Menu }) => Menu.getApplicationMenu()?.getMenuItemById("maps")?.click());
    await expect(page).toHaveURL(/#\/maps/);
    // The save ends while the student is on Maps: it is recorded, and the link that waited for it, which belongs to a page
    // they left, moves nothing.
    await expect.poll(cardSteps).toBe(1);
    await page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
    await page.evaluate(() => window.pyxis.invoke("plans.list", {}));
    await expect(page).toHaveURL(/#\/maps/);
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

test("Indietro on the cards page, held by the save of a rated session, does not undo a page the student chose meanwhile", async () => {
  test.setTimeout(120_000);
  const userData = mkdtempSync(join(tmpdir(), "pyxis-card-back-held-"));
  // The save that Indietro waits for is held back, so there is time to choose another page while it is on its way.
  const app = await launchPyxis({ userData, env: { PYXIS_E2E_READ_DELAY: "plans.complete=2500" } });
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

    // Maps' code has not loaded yet, and the test holds it back: going to Maps stays under way, with the cards still on
    // screen, until the test lets it through. A slow computer has the same moment, shorter.
    await app.evaluate(({ session }) => {
      const held = globalThis as unknown as { releaseMaps?: () => void };
      const release = new Promise<void>((resolve) => {
        held.releaseMaps = resolve;
      });
      session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
        if (/\/assets\/MapsHome-[\w-]+\.js$/.test(details.url)) void release.then(() => callback({}));
        else callback({});
      });
    });
    // Back starts the save, which is held. Maps is chosen from the app menu while it is on its way, and is still loading
    // when the save ends.
    await page.getByRole("banner").getByRole("button", { name: /^(Back to|Torna a) / }).click();
    await app.evaluate(({ Menu }) => Menu.getApplicationMenu()?.getMenuItemById("maps")?.click());
    await expect.poll(cardSteps).toBe(1);
    await page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
    // The save has ended and the back step that waited for it was not taken: Maps loads and is where the student ends.
    await app.evaluate(() => (globalThis as unknown as { releaseMaps: () => void }).releaseMaps());
    await expect(page).toHaveURL(/#\/maps/);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    db.close();
  } finally {
    await app.evaluate(({ session }) => session.defaultSession.webRequest.onBeforeRequest(null));
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
    await clickSettled(page, form.getByRole("button", { name: "Cancel", exact: true }));
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
      location.hash = "#/flashcards/all";
    });
    await page.reload();
    await expect(page.getByRole("status")).toHaveText("4 flashcards");
    await page.getByRole("combobox", { name: "Show" }).click();
    await clickSettled(
      page,
      page
        .locator('.ant-select-dropdown:visible .ant-select-item-option[title="Often forgotten"]'),
    );
    await expect(page.getByRole("status")).toHaveText("1 flashcard");
    const card = page.getByRole("listitem");
    await expect(card).toContainText("Often forgotten");
    // Open source sits in the card's menu, next to Edit, Suspend and Delete.
    await card.getByRole("button", { name: /^More actions: Seconda legge/ }).click();
    await expect(page.getByRole("menuitem", { name: "Open source" })).toBeVisible();
    await page.keyboard.press("Escape");
    // Rewriting opens the card where it stands, and says what a card forgotten this often needs.
    await card.getByRole("button", { name: /^Rewrite: Seconda legge/ }).click();
    const editor = page.getByRole("group", { name: "Edit flashcard" });
    await expect(editor).toBeVisible();
    await expect(editor).toContainText("Forgotten 7 times.");
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

/** Today's cards (the daily review), English, with the exam's subject so the lists can name it. */
async function openToday(userData: string, extra?: (db: DatabaseSync) => void, env?: Record<string, string>) {
  const app = await launchPyxis({ userData, env });
  const page = await app.firstWindow();
  await page.getByRole("button", { name: "Salta" }).click();
  await fromChiediToExams(page);
  await page.evaluate(() => localStorage.setItem("pyxis.lang", "en"));
  const db = new DatabaseSync(join(userData, "workspace", "pyxis.db"), { timeout: 10_000 });
  seed(db);
  db.exec(`INSERT INTO subjects(id,name,position,created_at) VALUES('s1','Fisica 1',0,1);
    UPDATE plans SET subject_id = 's1' WHERE id = 'p'`);
  extra?.(db);
  await page.evaluate(() => {
    location.hash = "#/cards/due";
  });
  await page.reload();
  return { app, page, db };
}

const TODAY = ["Seconda legge di Newton?", "Unità della forza?", "Velocità media?", "Mia carta"];

/** Answers today's cards in order with the given keys (1 didn't know it, 2 hard, 3 knew it, 4 easy). */
async function answerToday(page: Page, keys: Array<"1" | "2" | "3" | "4">) {
  const front = page.locator("article.px-card .px-card-front");
  for (const [index, key] of keys.entries()) {
    await expect(front).toHaveText(TODAY[index]!);
    await page.keyboard.press("Space");
    await expect(page.locator("article.px-card")).toHaveAttribute("data-face", "back");
    await page.keyboard.press(key);
  }
}

const answers = (page: Page) => page.getByRole("list", { name: "Your answers" }).getByRole("listitem");

test("session end: the last card's four answers carry their colours without a dot", async () => {
  test.setTimeout(120_000);
  const userData = mkdtempSync(join(tmpdir(), "pyxis-session-end-"));
  const { app, page, db } = await openToday(userData);
  try {
    await answerToday(page, ["4", "4", "4"]);
    await expect(page.locator("article.px-card .px-card-front")).toHaveText("Mia carta");
    await page.keyboard.press("Space");
    const rates = page.getByRole("group", { name: "How well did you know it?" }).getByRole("button");
    await expect(rates).toHaveText(["Didn't know it1", "Hard2", "Knew it3", "Easy4"]);
    // One colour for each answer, from the app's own tokens, as a bottom edge on the button and nothing else.
    const colours = await rates.evaluateAll((buttons) =>
      buttons.map((button) => {
        const style = getComputedStyle(button);
        return { rate: button.getAttribute("data-rate"), edge: style.boxShadow, fill: style.backgroundColor, dots: button.querySelectorAll("i, .gd").length };
      }),
    );
    expect(colours.map((item) => item.rate)).toEqual(["again", "hard", "good", "easy"]);
    expect(new Set(colours.map((item) => item.edge)).size, "each answer has its own edge colour").toBe(4);
    expect(new Set(colours.map((item) => item.fill)).size, "the four buttons share one fill: no tint").toBe(1);
    for (const item of colours) {
      expect(item.edge).toMatch(/inset/);
      expect(item.dots, "no dot on a button").toBe(0);
    }
    await expectNoAxeViolations(page);
  } finally {
    db.close();
    await app.close();
    removeTestFolder(userData);
  }
});

test("session end: a card still to learn counts down, and the answers sit under their colours", async () => {
  test.setTimeout(120_000);
  const userData = mkdtempSync(join(tmpdir(), "pyxis-session-end-"));
  const { app, page, db } = await openToday(userData);
  try {
    await answerToday(page, ["1", "2", "4", "4"]);
    const timer = page.getByRole("timer");
    await expect(page.locator(".px-end-kicker")).toHaveText("2 flashcards come back, the first in");
    await expect(timer).toHaveText(/^(0:[0-5]\d|1:00)$/);
    // The countdown is not a live region: a screen reader hears the state once, in the status.
    await expect(timer).toHaveAttribute("aria-live", "off");
    await expect(page.locator(".px-end .visually-hidden[role=status]")).toHaveText(
      "A flashcard you are learning comes back in 1 minute. Stay here and I'll show it.",
    );
    await expect(page.locator(".px-end-text")).toHaveText(
      "You are still learning them, so I'll show them again as soon as they are due. You can stay here.",
    );
    // The four answers as bars with their counts; the two cards still to come are listed on their own, then the rest.
    await expect(answers(page)).toHaveText(["Didn't know it1", "Hard1", "Knew it0", "Easy2"]);
    const groups = page.locator(".px-end-group");
    await expect(groups.nth(0).getByRole("heading")).toHaveText("Coming back soon2");
    await expect(groups.nth(0).getByRole("listitem")).toHaveCount(2);
    await expect(groups.nth(0).getByRole("listitem").first()).toContainText("Seconda legge di Newton?");
    await expect(groups.nth(0).getByRole("listitem").first()).toContainText("Fisica 1");
    await expect(groups.nth(1).getByRole("heading")).toHaveText("Easy2");
    await expect(groups.nth(1).getByRole("listitem")).toHaveText([/Velocità media\?/, /Mia carta/]);
    await expect(groups).toHaveCount(2);
    await expect(page.getByRole("button", { name: "Done for today" })).toBeVisible();
    await expect(page.locator(".px-end-fine")).toHaveText("If you stop, the flashcards wait for your next review.");
    // No dot anywhere on the screen, and the four bars have four colours.
    await expect(page.locator(".px-end .gd, .px-end-group h2 i")).toHaveCount(0);
    // A group's name sits on a tint of its answer's colour.
    const chip = groups.nth(1).locator(".px-end-chip");
    await expect(chip).not.toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    const fills = await page.locator(".px-end-bar > i").evaluateAll((bars) => bars.map((bar) => getComputedStyle(bar).backgroundColor));
    expect(new Set(fills).size).toBe(4);
    await expectNoAxeViolations(page);
  } finally {
    db.close();
    await app.close();
    removeTestFolder(userData);
  }
});

test("session end: finished with nothing left today, Undo last from this screen brings the last card back", async () => {
  test.setTimeout(120_000);
  const userData = mkdtempSync(join(tmpdir(), "pyxis-session-end-"));
  const { app, page, db } = await openToday(userData);
  const count = (sql: string) => (db.prepare(sql).get() as { n: number }).n;
  try {
    await answerToday(page, ["4", "4", "4", "4"]);
    await expect(page.getByRole("heading", { level: 2, name: "You're done for today" })).toBeVisible();
    await expect(page.locator(".px-end-text")).toHaveText(/^You gave 4 answers\. The next 4 come back (tomorrow|on [A-Z][a-z]+, [A-Z][a-z]+ \d+)\.$/);
    await expect(page.getByRole("timer")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Done for today" })).toHaveCount(0);
    await expect(answers(page)).toHaveText(["Didn't know it0", "Hard0", "Knew it0", "Easy4"]);
    // The old three lines are gone: no summary, no "You picked".
    await expect(page.getByText(/^Seen 4\./)).toHaveCount(0);
    await expect(page.locator(".px-cards-undo")).toHaveCount(0);
    // A few cards per answer, then "1 more" unfolds the rest and folds it back.
    const easy = page.locator(".px-end-group");
    await expect(easy.getByRole("heading")).toHaveText("Easy4");
    await expect(easy.getByRole("listitem")).toHaveCount(4);
    const more = easy.getByRole("button", { name: "1 more" });
    await expect(more).toHaveAttribute("aria-expanded", "false");
    await expect(easy.locator(".px-end-row")).toHaveCount(3);
    await more.click();
    await expect(easy.locator(".px-end-row")).toHaveCount(4);
    await expect(easy.getByRole("button", { name: "Show fewer" })).toHaveAttribute("aria-expanded", "true");
    await easy.getByRole("button", { name: "Show fewer" }).click();
    await expect(easy.locator(".px-end-row")).toHaveCount(3);
    await expectNoAxeViolations(page);

    // Undo last works from here: the last card comes back, its review is gone and the counts follow.
    expect(count("SELECT COUNT(*) AS n FROM card_reviews")).toBe(4);
    await page.getByRole("banner").getByRole("button", { name: "Undo last", exact: true }).click();
    await expect(page.locator("article.px-card .px-card-front")).toHaveText("Mia carta");
    await expect(page.locator(".px-end")).toHaveCount(0);
    expect(count("SELECT COUNT(*) AS n FROM card_reviews")).toBe(3);
    // A Hard answer sends it to learning, so the screen counts down this time, with the first answer given back to it.
    await page.keyboard.press("Space");
    await page.keyboard.press("2");
    await expect(page.getByRole("timer")).toBeVisible();
    await expect(answers(page)).toHaveText(["Didn't know it0", "Hard1", "Knew it0", "Easy3"]);
  } finally {
    db.close();
    await app.close();
    removeTestFolder(userData);
  }
});

test("session end: finished with more coming back later today, they are listed with their time", async () => {
  test.setTimeout(120_000);
  const userData = mkdtempSync(join(tmpdir(), "pyxis-session-end-"));
  // A card reviewed before, due a couple of hours from now, or a second before midnight when that is sooner.
  const midnight = new Date().setHours(24, 0, 0, 0);
  const at = Math.min(Date.now() + 2 * 3_600_000, midnight - 1000);
  const { app, page, db } = await openToday(userData, (setup) => {
    setup.exec(`INSERT INTO cards(id,plan_id,topic_id,front,back,seed_key,created_at) VALUES('c5','p','t','Già ripassata','Sì.','k5',5)`);
    setup
      .prepare("INSERT INTO card_reviews(id,card_id,rating,state_json,reviewed_at) VALUES('r5','c5','good',?,1)")
      .run(JSON.stringify({ intervalDays: 1, ease: 2.5, dueAt: at }));
  });
  try {
    await answerToday(page, ["4", "4", "4", "4"]);
    const time = new Intl.DateTimeFormat("en", { hour: "numeric", minute: "2-digit" }).format(at);
    await expect(page.getByRole("heading", { level: 2, name: "You're done for now" })).toBeVisible();
    await expect(page.locator(".px-end-text")).toHaveText(`You gave 4 answers. Another one comes back today, at ${time}.`);
    const today = page.locator(".px-end-group").first();
    await expect(today.getByRole("heading")).toHaveText("Coming back today1");
    await expect(today.getByRole("listitem")).toHaveText(`1 flashcard from Fisica 1${time}`);
    await expect(page.locator(".px-end .visually-hidden[role=status]")).toHaveText(
      `You're done for now. You gave 4 answers. Another one comes back today, at ${time}.`,
    );
    await expectNoAxeViolations(page);
  } finally {
    db.close();
    await app.close();
    removeTestFolder(userData);
  }
});

test("session end: when what comes back later cannot be read, the page keeps the results, says so and retries", async () => {
  test.setTimeout(120_000);
  const userData = mkdtempSync(join(tmpdir(), "pyxis-session-end-"));
  // The first read of study.dueLater is lost; the next one, from Try again, comes back.
  const lose = join(tmpdir(), `pyxis-session-end-lose-${process.pid}-${Date.now()}`);
  const { app, page, db } = await openToday(userData, undefined, { PYXIS_E2E_READ_FAIL: `study.dueLater=${lose}` });
  try {
    writeFileSync(lose, "");
    await answerToday(page, ["4", "4", "4", "4"]);
    // Not "done for today": nothing is known of what comes back, and the page says that and keeps the answers.
    await expect(page.getByRole("heading", { level: 2, name: "Session finished" })).toBeVisible();
    await expect(page.locator(".px-end-text")).toHaveText("You gave 4 answers. I couldn't read when the next flashcards come back.");
    await expect(page.getByText("You're done for today")).toHaveCount(0);
    await expect(answers(page)).toHaveText(["Didn't know it0", "Hard0", "Knew it0", "Easy4"]);
    await expect(page.locator(".px-end-group")).toHaveCount(1);
    await expect(page.locator(".px-end .visually-hidden[role=status]")).toHaveText(
      "Session finished. You gave 4 answers. I couldn't read when the next flashcards come back.",
    );
    await expectNoAxeViolations(page);
    // Retry reads it once more, and this time the session ends as it would have.
    await page.getByRole("button", { name: "Retry" }).click();
    await expect(page.getByRole("heading", { level: 2, name: "You're done for today" })).toBeVisible();
    await expect(page.locator(".px-end-text")).toHaveText(/^You gave 4 answers\. The next 4 come back /);
    await expect(page.getByRole("button", { name: "Retry" })).toHaveCount(0);
  } finally {
    db.close();
    await app.close();
    removeTestFolder(userData);
  }
});

/** One card due today and the rest parked, so a single answer leaves a card counting down. */
const oneCard = (db: DatabaseSync) => db.exec("UPDATE cards SET suspended = 1 WHERE id <> 'c1'");

test("session end: the card shows by itself when its time comes", async () => {
  test.setTimeout(120_000);
  const userData = mkdtempSync(join(tmpdir(), "pyxis-session-end-"));
  const { app, page, db } = await openToday(userData, oneCard);
  try {
    // The page's clock is the test's; core's is real, so the card is made due in the database as the clock moves.
    await page.clock.install();
    await answerToday(page, ["1"]);
    await expect(page.getByRole("timer")).toBeVisible();
    await expect(page.locator(".px-end-kicker")).toHaveText("A flashcard comes back in");
    await expect(page.locator(".px-end-text")).toHaveText(
      "You are still learning it, so I'll show it again as soon as it is due. You can stay here.",
    );
    db.prepare("UPDATE card_reviews SET state_json = json_set(state_json, '$.dueAt', ?) WHERE card_id = 'c1'").run(Date.now() - 1000);
    await page.clock.fastForward("01:05");
    // The end screen goes and the card is there, flipped to its front, announced once as the next flashcard.
    await expect(page.locator("article.px-card .px-card-front")).toHaveText("Seconda legge di Newton?");
    await expect(page.locator(".px-end")).toHaveCount(0);
    await expect(page.getByRole("status").filter({ hasText: "Next flashcard: Seconda legge di Newton?" })).toHaveCount(1);
    await expect(page.getByRole("timer")).toHaveCount(0);
    // And it can be answered like any other: the session ends again, this time with the card's second answer.
    await page.keyboard.press("Space");
    await page.keyboard.press("4");
    await expect(answers(page)).toHaveText(["Didn't know it1", "Hard0", "Knew it0", "Easy1"]);
  } finally {
    db.close();
    await app.close();
    removeTestFolder(userData);
  }
});

test("session end: Done for today leaves for the Flashcard section, records the session and keeps the card for later", async () => {
  test.setTimeout(120_000);
  const userData = mkdtempSync(join(tmpdir(), "pyxis-session-end-"));
  const { app, page, db } = await openToday(userData, oneCard);
  const rows = (sql: string) => db.prepare(sql).all() as Array<{ payload_json: string }>;
  try {
    await answerToday(page, ["2"]);
    await expect(page.getByRole("timer")).toBeVisible();
    await page.getByRole("button", { name: "Done for today" }).click();
    await expect(page).toHaveURL(/#\/flashcards$/);
    await expect
      .poll(() => rows("SELECT payload_json FROM learning_events WHERE kind = 'lesson_completed' AND payload_json LIKE '%\"cards\"%'").length)
      .toBe(1);
    // The card was not removed or suspended: it keeps its review and waits for its next time.
    expect(
      db.prepare("SELECT COUNT(*) AS n FROM cards WHERE id = 'c1' AND removed = 0 AND suspended = 0").get(),
    ).toEqual({ n: 1 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM card_reviews WHERE card_id = 'c1'").get()).toEqual({ n: 1 });
  } finally {
    db.close();
    await app.close();
    removeTestFolder(userData);
  }
});
