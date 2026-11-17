import { saveShot } from "./shots";
import {
  expect,
  test,
  type Page,
} from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { launchPyxis } from "./app-under-test";
import { seedPlan, seedSubjects } from "./seed";
import { expectNoAxeViolations } from "./axe";
import { animationsSettled } from "./settled";
import { removeTestFolder } from "./cleanup";
import { fromChiediToExams, toAllFlashcards } from "./doors";

/** Two subjects, one exam with no subject, and cards that need the folding, the math and the cloze. */
function seed(db: DatabaseSync) {
  const now = Date.now();
  seedSubjects(db, [{ id: "s-chem", name: "Chimica", position: 1 }, { id: "s-phys", name: "Fisica", position: 0 }]);
  seedPlan(db, {
    id: "p-phys",
    subjectId: "s-phys",
    title: "Fisica 1",
    language: "it",
    topics: [{ id: "t-dyn", title: "Dinamica" }, { id: "t-kin", title: "Cinematica" }],
  });
  seedPlan(db, {
    id: "p-chem",
    subjectId: "s-chem",
    title: "Chimica generale",
    language: "it",
    topics: [{ id: "t-atoms", title: "Atomi" }],
  });
  seedPlan(db, { id: "p-none", title: "Appunti sparsi", language: "it", topics: [{ id: "t-misc", title: "Varie" }] });
  db.exec(`
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

/** Picks an action from a card's menu: Suspend, Resume and Delete the flashcard… sit there, next to Edit. */
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
  const item = page.locator(
    `.ant-select-dropdown:visible .ant-select-item-option[title="${option}"]`,
  );
  // The list opens growing from 80% of its height. A slow Mac drew that opening late, holding the list at its first
  // frame, still and invisible, where the click found the option; the list grew before the button came back up, the
  // release landed on the group's label above it, and nothing was chosen. A student cannot click what is not drawn yet.
  await item.waitFor();
  await animationsSettled(page);
  await item.click();
}

test("the flashcard browser groups, searches, edits, suspends, deletes and restores", async () => {
  test.setTimeout(120_000);
  const userData = mkdtempSync(join(tmpdir(), "pyxis-card-browser-"));
  let opened: DatabaseSync | undefined;
  const app = await launchPyxis({ userData });
  try {
    const page = await app.firstWindow();
    await page.getByRole("button", { name: "Salta" }).click();
    await fromChiediToExams(page);
    await page.evaluate(() => localStorage.setItem("pyxis.lang", "en"));
    const db = new DatabaseSync(join(userData, "workspace", "pyxis.db"), {
      timeout: 10_000,
    });
    opened = db;
    seed(db);

    // Reached from the Flashcard section, and no longer from the Esami menu.
    await page.evaluate(() => {
      location.hash = "#/exams";
    });
    await page.reload();
    await page.getByRole("button", { name: "More for Exams", exact: true }).click();
    await expect(page.getByRole("menuitem").filter({ hasText: /flashcards/i })).toHaveCount(0);
    await page.keyboard.press("Escape");
    await toAllFlashcards(page);
    await expect(page.getByRole("status")).toHaveText("6 flashcards");

    // Subjects in their saved order, the exam with no subject last, each card naming its topic.
    await expect(page.getByRole("heading", { level: 2 })).toHaveText([
      "Fisica",
      "Chimica",
      "No subject",
    ]);
    await expect(page.locator(".px-ct-topic")).toHaveText([
      "Dinamica",
      "Dinamica",
      "Cinematica",
      "Atomi",
      "Atomi",
      "Varie",
    ]);
    // Each card is one small card: Edit is the card itself, Suspend and Delete wait in its menu.
    await expect(page.getByRole("button", { name: /^Edit: / })).toHaveCount(6);
    await expect(
      page.getByRole("button", { name: /^(Suspend|Delete): / }),
    ).toHaveCount(0);
    // Math is rendered; a cloze shows its sentence with the answer filled in.
    await expect(
      page.locator(".px-ct .katex").first(),
    ).toBeVisible();
    await expect(
      page
        .getByRole("listitem")
        .filter({ hasText: "orbitano il nucleo" })
        .locator("strong"),
    ).toHaveText("Elettroni");
    // Cards fade in; contrast measured mid-fade reads too low on a slow runner.
    await animationsSettled(page);
    await expectNoAxeViolations(page);

    // An accent-less search finds the accented card, in any case.
    const search = page.getByRole("textbox", { name: "Search flashcards" });
    await search.fill("PERCHE");
    await expect(page.getByRole("status")).toHaveText("1 flashcard");
    await expect(page.getByRole("listitem")).toHaveCount(1);
    await expect(page.getByText("Perché un corpo accelera?")).toBeVisible();
    await search.fill("zzz");
    await expect(page.getByText("No flashcard contains “zzz”.")).toBeVisible();
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

    // Editing happens where the card stands, and keeps the review schedule.
    const before = reviewRows(db);
    expect(before).toHaveLength(1);
    await page.getByRole("button", { name: /^Edit: Numero atomico\?/ }).click();
    const editor = page.getByRole("group", { name: "Edit flashcard" });
    await expect(editor).toBeVisible();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(editor.getByRole("textbox", { name: "Front" })).toBeFocused();
    // Saving needs both faces.
    await editor.getByRole("textbox", { name: "Back" }).fill("");
    await expect(editor.getByRole("button", { name: "Save" })).toBeDisabled();
    await editor.getByRole("textbox", { name: "Front" }).fill("Numero atomico (Z)?");
    await editor.getByRole("textbox", { name: "Back" }).fill("Il numero di protoni.");
    await editor.getByRole("button", { name: "Save" }).click();
    await expect(editor).toBeHidden();
    const edited = page
      .getByRole("listitem")
      .filter({ hasText: "Numero atomico (Z)?" });
    await expect(edited).toContainText("Il numero di protoni.");
    await expect(edited).toContainText("Next review");
    expect(reviewRows(db)).toEqual(before);
    // The focus comes back to the card that was edited.
    await expect(page.getByRole("button", { name: /^Edit: Numero atomico \(Z\)\?/ })).toBeFocused();

    // Typing that would be lost is asked about: on Cancel, on Escape and on opening another card to edit.
    await page.getByRole("button", { name: /^Edit: Numero atomico \(Z\)\?/ }).click();
    const again = page.getByRole("group", { name: "Edit flashcard" });
    await again.getByRole("textbox", { name: "Back" }).fill("Cambiato.");
    await again.getByRole("button", { name: "Cancel" }).click();
    const leave = page.getByRole("dialog", { name: "Leave without saving?" });
    await expect(leave).toBeVisible();
    await leave.getByRole("button", { name: "Stay here" }).click();
    await expect(leave).toHaveCount(0);
    await expect(again.getByRole("textbox", { name: "Back" })).toHaveValue("Cambiato.");
    await page.getByRole("button", { name: /^Edit: Velocità media\?/ }).click();
    await expect(leave).toBeVisible();
    await leave.getByRole("button", { name: "Stay here" }).click();
    await expect(leave).toHaveCount(0);
    await expect(again).toBeVisible();
    await again.getByRole("textbox", { name: "Back" }).press("Escape");
    await expect(leave).toBeVisible();
    await leave.getByRole("button", { name: "Leave without saving" }).click();
    await expect(again).toBeHidden();
    await expect(edited).toContainText("Il numero di protoni.");
    await expect(page.getByRole("button", { name: /^Edit: Numero atomico \(Z\)\?/ })).toBeFocused();
    // An edit with nothing typed closes without a question.
    await page.getByRole("button", { name: /^Edit: Numero atomico \(Z\)\?/ }).click();
    await page.getByRole("group", { name: "Edit flashcard" }).getByRole("button", { name: "Cancel" }).click();
    await expect(page.getByRole("group", { name: "Edit flashcard" })).toBeHidden();
    await expect(page.getByRole("dialog")).toHaveCount(0);

    // Escape closes the edit also when the focus is elsewhere on the page: on another card's dots, whose menu it closes first.
    const editBox = page.getByRole("group", { name: "Edit flashcard" });
    await page.getByRole("button", { name: /^Edit: Numero atomico \(Z\)\?/ }).click();
    await page.getByRole("button", { name: /^More actions: Velocità media\?/ }).click();
    await expect(page.getByRole("menu")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("menu")).toHaveCount(0);
    await expect(editBox).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(editBox).toBeHidden();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.getByRole("button", { name: /^Edit: Numero atomico \(Z\)\?/ })).toBeFocused();
    await saveShot(page, "card-browser-escape-closed-en-light.png", { animations: "disabled" });
    // With typing in it, the same Escape asks once, and the answer decides.
    await page.getByRole("button", { name: /^Edit: Numero atomico \(Z\)\?/ }).click();
    await editBox.getByRole("textbox", { name: "Back" }).fill("Cambiato di nuovo.");
    await page.getByRole("button", { name: /^More actions: Velocità media\?/ }).click();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("menu")).toHaveCount(0);
    await page.keyboard.press("Escape");
    const askLeave = page.getByRole("dialog", { name: "Leave without saving?" });
    await expect(askLeave).toBeVisible();
    await askLeave.getByRole("button", { name: "Stay here" }).click();
    await expect(askLeave).toHaveCount(0);
    await expect(editBox).toBeVisible();
    await expect(editBox.getByRole("textbox", { name: "Back" })).toHaveValue("Cambiato di nuovo.");
    await page.keyboard.press("Escape");
    await expect(askLeave).toBeVisible();
    await askLeave.getByRole("button", { name: "Leave without saving" }).click();
    await expect(editBox).toBeHidden();

    // A right-click on a card's row opens the same menu as its dots, and a pick acts the same way.
    const speedRow = page.getByRole("listitem").filter({ hasText: "Velocità media?" });
    await speedRow.click({ button: "right" });
    await expect(page.getByRole("region", { name: "More actions" }).getByRole("menuitem")).toHaveText(["Edit", "Suspend", "Delete the flashcard…"]);
    await page.getByRole("menuitem", { name: "Suspend", exact: true }).click();
    await expect(speedRow).toContainText("Suspended");
    await cardAction(page, "Velocità media\\?", "Resume");
    await expect(speedRow).not.toContainText("Suspended");

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
    await cardAction(page, "Unità della forza\\?", "Delete the flashcard…");
    const confirm = page.getByRole("dialog", { name: "Delete this flashcard?" });
    await expect(confirm).toContainText("You can bring it back under Removed");
    // Cancel leaves the card where it is and the focus on the dots that opened the dialog, not on the list's summary.
    await confirm.getByRole("button", { name: "Cancel" }).click();
    await expect(confirm).toHaveCount(0);
    await expect(page.getByRole("button", { name: /^More actions: Unità della forza/ })).toBeFocused();
    await expect(page.getByText("Unità della forza?")).toBeVisible();
    await cardAction(page, "Unità della forza\\?", "Delete the flashcard…");
    await confirm.getByRole("button", { name: "Delete the flashcard", exact: true }).click();
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
    await cardAction(page, "Elettroni orbitano", "Delete the flashcard…");
    const permanent = page.getByRole("dialog", { name: "Delete this flashcard?" });
    await expect(permanent).toContainText("deleting it is permanent");
    // The write lock is held, so the delete waits in core: the dialog stays open and busy, and its button cannot fire twice.
    db.exec("BEGIN IMMEDIATE");
    const forever = permanent.getByRole("button", { name: "Delete the flashcard", exact: true });
    await forever.click();
    await expect(permanent).toHaveAttribute("aria-busy", "true");
    await expect(forever).toBeDisabled();
    await expect(permanent.getByRole("button", { name: "Cancel" })).toBeDisabled();
    await expect(page.getByRole("list", { name: "Chimica" }).getByText("Elettroni orbitano il nucleo.")).toBeVisible();
    db.exec("ROLLBACK");
    await expect(permanent).toHaveCount(0);
    await expect(page.getByText("Flashcard deleted.")).toBeVisible();
    await choose(page, "Show", "Removed");
    await expect(page.getByRole("listitem")).toHaveCount(0);
    expect(
      db.prepare("SELECT COUNT(*) AS n FROM cards WHERE id = 'c-cloze'").get(),
    ).toEqual({ n: 0 });
    db.close();
  } finally {
    if (opened?.isOpen) opened.close();
    await app.close();
    removeTestFolder(userData);
  }
});

test("the flashcard browser says when there are no cards", async () => {
  const userData = mkdtempSync(join(tmpdir(), "pyxis-card-browser-empty-"));
  const app = await launchPyxis({ userData });
  try {
    const page = await app.firstWindow();
    await page.getByRole("button", { name: "Salta" }).click();
    // Skipping saves the profile first; a reload before that lands back on setup.
    await fromChiediToExams(page);
    await page.evaluate(() => {
      localStorage.setItem("pyxis.lang", "en");
      location.hash = "#/flashcards/all";
    });
    await page.reload();
    await expect(page.getByText(/^All your flashcards will appear here/)).toBeVisible();
  } finally {
    await app.close();
    removeTestFolder(userData);
  }
});

test("the old address of the list, from a saved address or a reminder, opens the list under Flashcard", async () => {
  test.setTimeout(120_000);
  const userData = mkdtempSync(join(tmpdir(), "pyxis-card-browser-old-"));
  const app = await launchPyxis({ userData });
  try {
    const page = await app.firstWindow();
    await page.getByRole("button", { name: "Salta" }).click();
    await fromChiediToExams(page);
    await page.evaluate(() => localStorage.setItem("pyxis.lang", "en"));
    const db = new DatabaseSync(join(userData, "workspace", "pyxis.db"), { timeout: 10_000 });
    seed(db);
    db.close();
    await page.reload();
    await expect(page.getByRole("heading", { level: 1, name: "Exams" })).toBeVisible();

    // An address typed or saved with the old path keeps its filter on the way.
    await page.evaluate(() => {
      location.hash = "#/exams/cards?exam=p-phys";
    });
    await expect(page).toHaveURL(/#\/flashcards\/all\?exam=p-phys$/);
    await expect(page.getByRole("heading", { level: 1, name: "All flashcards" })).toBeVisible();
    await expect(page.getByRole("status")).toHaveText("3 flashcards");

    // A message from main that still names the old path opens the list too.
    await page.evaluate(() => {
      location.hash = "#/exams";
    });
    await expect(page.getByRole("heading", { level: 1, name: "Exams" })).toBeVisible();
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]!.webContents.send("app:open-path", "/exams/cards"),
    );
    await expect(page).toHaveURL(/#\/flashcards\/all$/);
    await expect(page.getByRole("status")).toHaveText("6 flashcards");
  } finally {
    await app.close();
    removeTestFolder(userData);
  }
});

test("the flashcard grid shows eight cards of a subject, unfolds the rest from its button and starts over with a search", async () => {
  test.setTimeout(120_000);
  const userData = mkdtempSync(join(tmpdir(), "pyxis-card-grid-"));
  const app = await launchPyxis({ userData });
  try {
    const page = await app.firstWindow();
    await page.getByRole("button", { name: "Salta" }).click();
    await fromChiediToExams(page);
    await page.evaluate(() => localStorage.setItem("pyxis.lang", "en"));
    const db = new DatabaseSync(join(userData, "workspace", "pyxis.db"), { timeout: 10_000 });
    seedSubjects(db, [{ id: "s-phys", name: "Fisica", position: 0 }, { id: "s-chem", name: "Chimica", position: 1 }]);
    seedPlan(db, { id: "p-phys", subjectId: "s-phys", title: "Fisica 1", language: "it", topics: [{ id: "t-dyn", title: "Dinamica" }] });
    seedPlan(db, { id: "p-chem", subjectId: "s-chem", title: "Chimica generale", language: "it", topics: [{ id: "t-atoms", title: "Atomi" }] });
    const insert = db.prepare(
      "INSERT INTO cards(id,plan_id,topic_id,front,back,seed_key,grounding,created_at) VALUES(?,?,?,?,?,?,?,?)",
    );
    for (let index = 1; index <= 11; index++)
      insert.run(`f${index}`, "p-phys", "t-dyn", `Forza numero ${String(index).padStart(2, "0")}?`, `Risposta ${index}.`, `kf${index}`, "sources", index);
    for (let index = 1; index <= 3; index++)
      insert.run(`c${index}`, "p-chem", "t-atoms", `Atomo numero ${index}?`, `Risposta ${index}.`, `kc${index}`, "sources", 20 + index);
    db.close();
    await page.evaluate(() => {
      location.hash = "#/flashcards/all";
    });
    await page.reload();

    // Eight of the eleven physics cards and all three chemistry cards, with the rest offered under the eight.
    const tiles = page.locator(".px-ct");
    await expect(tiles).toHaveCount(11);
    await expect(page.getByRole("status")).toHaveText("14 flashcards");
    await expect(page.getByText("14 flashcards in 2 subjects.")).toBeVisible();
    await expect(page.getByRole("button", { name: /^Show the other/ })).toHaveCount(1);
    const more = page.getByRole("button", { name: "Show the other 3 flashcards" });
    await expect(page.getByText("Forza numero 09?")).toHaveCount(0);

    // A click unfolds them from the button, which keeps the focus and now offers to fold them again.
    await more.click();
    await expect(tiles).toHaveCount(14);
    await expect(page.getByText("Forza numero 11?")).toBeVisible();
    const fewer = page.getByRole("button", { name: "Show fewer" });
    await expect(fewer).toHaveAttribute("aria-expanded", "true");
    await expect(fewer).toBeFocused();
    await fewer.click();
    await expect(tiles).toHaveCount(11);
    await more.click();
    await expect(tiles).toHaveCount(14);

    // A search starts again from eight a subject, and so does clearing it.
    const search = page.getByRole("textbox", { name: "Search flashcards" });
    await search.fill("forza");
    await expect(page.getByRole("status")).toHaveText("11 flashcards");
    await expect(tiles).toHaveCount(8);
    await expect(page.getByRole("button", { name: "Show the other 3 flashcards" })).toBeVisible();
    await page.getByRole("button", { name: "Show the other 3 flashcards" }).click();
    await expect(tiles).toHaveCount(11);
    await expect(page.getByRole("heading", { level: 2 })).toHaveText(["Fisica"]);
    await page.getByRole("button", { name: "Clear filters" }).click();
    await expect(tiles).toHaveCount(11);

    // The arrow keys move between the cards, and Enter edits the one that has the focus.
    const first = page.getByRole("button", { name: /^Edit: Forza numero 01/ });
    await first.focus();
    await page.keyboard.press("ArrowRight");
    await expect(page.getByRole("button", { name: /^Edit: Forza numero 02/ })).toBeFocused();
    await page.keyboard.press("ArrowLeft");
    await expect(first).toBeFocused();
    await page.keyboard.press("ArrowDown");
    const columns = await tiles.evaluateAll((nodes) => nodes.filter((node) => node.getBoundingClientRect().top === nodes[0]!.getBoundingClientRect().top).length);
    await expect(page.getByRole("button", { name: new RegExp(`^Edit: Forza numero 0${columns + 1}`) })).toBeFocused();
    await page.keyboard.press("ArrowUp");
    await expect(first).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("group", { name: "Edit flashcard" }).getByRole("textbox", { name: "Front" })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(first).toBeFocused();
  } finally {
    await app.close();
    removeTestFolder(userData);
  }
});

/** Eleven physics cards (eight show) and three chemistry cards, with the app open on their list. */
async function openForza(label: string) {
  const userData = mkdtempSync(join(tmpdir(), `pyxis-card-${label}-`));
  const app = await launchPyxis({ userData });
  const page = await app.firstWindow();
  await page.getByRole("button", { name: "Salta" }).click();
  await fromChiediToExams(page);
  await page.evaluate(() => localStorage.setItem("pyxis.lang", "en"));
  const db = new DatabaseSync(join(userData, "workspace", "pyxis.db"), { timeout: 10_000 });
  seedSubjects(db, [{ id: "s-phys", name: "Fisica", position: 0 }, { id: "s-chem", name: "Chimica", position: 1 }]);
  seedPlan(db, { id: "p-phys", subjectId: "s-phys", title: "Fisica 1", language: "it", topics: [{ id: "t-dyn", title: "Dinamica" }] });
  seedPlan(db, { id: "p-chem", subjectId: "s-chem", title: "Chimica generale", language: "it", topics: [{ id: "t-atoms", title: "Atomi" }] });
  const insert = db.prepare(
    "INSERT INTO cards(id,plan_id,topic_id,front,back,seed_key,grounding,created_at) VALUES(?,?,?,?,?,?,?,?)",
  );
  for (let index = 1; index <= 11; index++)
    insert.run(`f${index}`, "p-phys", "t-dyn", `Forza numero ${String(index).padStart(2, "0")}?`, `Risposta ${index}.`, `kf${index}`, "sources", 10 + index);
  for (let index = 1; index <= 3; index++)
    insert.run(`c${index}`, "p-chem", "t-atoms", `Atomo numero ${index}?`, `Risposta ${index}.`, `kc${index}`, "sources", 50 + index);
  await page.evaluate(() => {
    location.hash = "#/flashcards/all";
  });
  await page.reload();
  await expect(page.getByRole("status")).toHaveText("14 flashcards");
  return {
    page,
    db,
    insert,
    close: async () => {
      if (db.isOpen) db.close();
      await app.close();
      removeTestFolder(userData);
    },
  };
}

const editFlashcard = (page: Page) => page.getByRole("group", { name: "Edit flashcard" });

test("a search or a filter that would take the edited card off the page asks first, and staying keeps the typing", async () => {
  test.setTimeout(120_000);
  const { page, close } = await openForza("lose-search");
  try {
    const leave = page.getByRole("dialog", { name: "Leave without saving?" });
    const search = page.getByRole("textbox", { name: "Search flashcards" });
    await page.getByRole("button", { name: /^Edit: Forza numero 01/ }).click();
    await editFlashcard(page).getByRole("textbox", { name: "Front" }).fill("Forza uno cambiata?");

    // A search with no room for the card asks; staying puts the search back and keeps the typing.
    await search.fill("atomo");
    await expect(leave).toBeVisible();
    await leave.getByRole("button", { name: "Stay here" }).click();
    await expect(leave).toHaveCount(0);
    await expect(search).toHaveValue("");
    await expect(editFlashcard(page).getByRole("textbox", { name: "Front" })).toHaveValue("Forza uno cambiata?");
    await expect(page.getByRole("status")).toHaveText("14 flashcards");

    // A filter asks the same, and staying leaves it as it was.
    await choose(page, "Show", "Suspended");
    await expect(leave).toBeVisible();
    await leave.getByRole("button", { name: "Stay here" }).click();
    await expect(leave).toHaveCount(0);
    await expect(page.locator("#card-status").locator("xpath=ancestor::*[contains(@class,'ant-select')][1]")).toContainText("All flashcards");
    await expect(editFlashcard(page).getByRole("textbox", { name: "Front" })).toHaveValue("Forza uno cambiata?");

    // Leaving drops the typing, and the card comes back as it was saved.
    await search.fill("atomo");
    await expect(leave).toBeVisible();
    await leave.getByRole("button", { name: "Leave without saving" }).click();
    await expect(leave).toHaveCount(0);
    await expect(editFlashcard(page)).toHaveCount(0);
    await expect(page.getByRole("status")).toHaveText("3 flashcards");
    await page.getByRole("button", { name: "Clear filters" }).click();
    await expect(page.getByText("Forza numero 01?")).toBeVisible();
    await expect(page.getByText("Forza uno cambiata?")).toHaveCount(0);
  } finally {
    await close();
  }
});

test("the typing in a card survives a refresh that moves the card to another list", async () => {
  test.setTimeout(120_000);
  const { page, close } = await openForza("lose-move");
  try {
    // Unfolded, the ninth card is in the second list; deleting one of the first eight moves it into the first.
    await page.getByRole("button", { name: "Show the other 3 flashcards" }).click();
    await expect(page.locator(".px-ct")).toHaveCount(14);
    await page.getByRole("button", { name: /^Edit: Forza numero 09/ }).click();
    const editor = editFlashcard(page);
    await editor.getByRole("textbox", { name: "Back" }).fill("Una bozza lunga.");
    await cardAction(page, "Forza numero 01\\?", "Delete the flashcard…");
    await page
      .getByRole("dialog", { name: "Delete this flashcard?" })
      .getByRole("button", { name: "Delete the flashcard", exact: true })
      .click();
    await expect(page.getByText("Forza numero 01?")).toHaveCount(0);
    await expect(editFlashcard(page).getByRole("textbox", { name: "Back" })).toHaveValue("Una bozza lunga.");
    await expect(editFlashcard(page).getByRole("textbox", { name: "Front" })).toHaveValue("Forza numero 09?");
  } finally {
    await close();
  }
});

test("a card that a refresh pushes past its subject's first eight stays open with its typing", async () => {
  test.setTimeout(120_000);
  const { page, db, insert, close } = await openForza("lose-push");
  try {
    await page.getByRole("button", { name: /^Edit: Forza numero 08/ }).click();
    await editFlashcard(page).getByRole("textbox", { name: "Back" }).fill("Una bozza lunga.");
    // A new card sorts before it (as an import does), and the next change refreshes the list.
    insert.run("f0", "p-phys", "t-dyn", "Forza numero 00?", "Risposta 0.", "kf0", "sources", 1);
    await cardAction(page, "Forza numero 02\\?", "Suspend");
    await expect(page.getByText("Forza numero 00?")).toBeVisible();
    await expect(editFlashcard(page).getByRole("textbox", { name: "Back" })).toHaveValue("Una bozza lunga.");
    await editFlashcard(page).getByRole("button", { name: "Save" }).click();
    await expect(editFlashcard(page)).toHaveCount(0);
    expect(db.prepare("SELECT back FROM cards WHERE id = 'f8'").get()).toEqual({ back: "Una bozza lunga." });
  } finally {
    await close();
  }
});

test("a save that finishes after another card was opened closes nothing of that card", async () => {
  test.setTimeout(120_000);
  const { page, db, close } = await openForza("lose-save");
  try {
    await page.getByRole("button", { name: /^Edit: Forza numero 01/ }).click();
    await editFlashcard(page).getByRole("textbox", { name: "Front" }).fill("Forza uno salvata?");
    // The write lock is held, so the save waits in core.
    db.exec("BEGIN IMMEDIATE");
    await editFlashcard(page).getByRole("button", { name: "Save" }).click();
    await expect(editFlashcard(page).getByRole("button", { name: "Save" })).toBeDisabled();
    // Another card is opened meanwhile; it opens once the save is over, without a question about the saved one.
    await page.getByRole("button", { name: /^Edit: Forza numero 02/ }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    db.exec("ROLLBACK");
    await expect(page.getByText("Forza uno salvata?")).toBeVisible();
    const second = editFlashcard(page);
    await expect(second.getByRole("textbox", { name: "Front" })).toHaveValue("Forza numero 02?");
    await second.getByRole("textbox", { name: "Front" }).fill("Forza due cambiata?");
    // Nothing the finished save does touches the editor that is open now.
    await page.waitForTimeout(500);
    await expect(second.getByRole("textbox", { name: "Front" })).toHaveValue("Forza due cambiata?");
    expect(db.prepare("SELECT front FROM cards WHERE id = 'f1'").get()).toEqual({ front: "Forza uno salvata?" });
  } finally {
    await close();
  }
});

test("an edit of a card that no longer exists closes, and leaves no question behind", async () => {
  test.setTimeout(120_000);
  const { page, db, close } = await openForza("lose-gone");
  try {
    await page.getByRole("button", { name: /^Edit: Forza numero 03/ }).click();
    await editFlashcard(page).getByRole("textbox", { name: "Back" }).fill("Una bozza.");
    // The card is deleted behind the page's back, and the next change refreshes the list. A card being edited has no
    // menu of its own, so this is the way it can disappear.
    db.exec("DELETE FROM cards WHERE id = 'f3'");
    await cardAction(page, "Forza numero 02\\?", "Suspend");
    await expect(page.getByText("Forza numero 03?")).toHaveCount(0);
    await expect(editFlashcard(page)).toHaveCount(0);
    // There is no typing left to lose, so leaving the page goes straight.
    await page.getByRole("link", { name: /^Flashcards?\b/ }).click();
    await expect(page).toHaveURL(/#\/flashcards$/);
    await expect(page.getByRole("dialog")).toHaveCount(0);
  } finally {
    await close();
  }
});
