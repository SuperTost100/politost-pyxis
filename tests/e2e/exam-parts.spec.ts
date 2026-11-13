import { expect, test, type Locator, type Page } from "@playwright/test";
import type Database from "better-sqlite3";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { partMarkdown, seedOutline, type SeedPart } from "../../src/core/study/test-parts";
import { launchPyxis } from "./app-under-test";
import { expectNoAxeViolations } from "./axe";
import { removeTestFolder } from "./cleanup";
import { fromChiediToExams } from "./doors";
import { seedPlan, seedSource } from "./seed";
import { animationsSettled, atRest } from "./settled";

const day = 86_400_000;
const startOfToday = () => new Date().setHours(0, 0, 0, 0);

/** The mockup's topic: eight parts and a recap, the first with a formula in its title. */
const titles: Array<[string, number]> = [
  ["Intorni e distanza in $\\mathbb{R}^n$", 5],
  ["Interno, esterno, frontiera", 6],
  ["Insiemi aperti e chiusi", 6],
  ["Limitati, compatti, connessi", 5],
  ["Limiti e continuità", 7],
  ["Derivate parziali e gradiente", 7],
  ["Differenziabilità e piano tangente", 8],
  ["Derivate seconde e matrice hessiana", 6],
];

/**
 * Analisi Matematica 2 with four topics. The diagnostic is done, so the path suggests a lesson; "Funzioni di più
 * variabili" is a lesson in parts with parts 1 and 2 read at `doneAt` and part 3 written, so it is the lesson the
 * student started. "Massimi e minimi liberi" is a topic of one part; Taylor has no outline yet. One exercise is on the
 * parted topic.
 */
function seed(db: DatabaseSync, doneAt: number) {
  seedSource(db, {
    id: "s-an2",
    kind: "smartbook",
    title: "Bramanti, Pagani, Salsa",
    document: { id: "d-an2" },
    passages: [
      { id: "pa-fun", text: "Un insieme è aperto se ogni suo punto è interno.", locator: { chapter: 2, paragraph: "p1" }, section: "2. Funzioni" },
    ],
  });
  seedPlan(db, {
    id: "p-an2",
    title: "Analisi Matematica 2",
    language: "it",
    target: 0.75,
    examAt: Date.now() + 81 * day,
    sourceIds: ["s-an2"],
    topics: [
      { id: "t-succ", title: "Successioni e serie di funzioni" },
      { id: "t-fun", title: "Funzioni di più variabili" },
      { id: "t-tay", title: "Formula di Taylor in più variabili" },
      { id: "t-max", title: "Massimi e minimi liberi" },
    ],
  });
  db.exec(`INSERT INTO topic_passages(topic_id,passage_id) VALUES('t-fun','pa-fun');
    INSERT INTO smartbooks(id,source_id,meta_json,created_at) VALUES('b-an2','s-an2','{"title":"Analisi 2","chapters":[]}',1);
    INSERT INTO exercises(id,smartbook_id,passage_id,prompt,answer,locator_json,grounding,created_at)
      VALUES('x-fun','b-an2','pa-fun','Dimostra che il disco aperto è aperto.','Ogni punto ha un intorno nel disco.','{"chapter":2,"kind":"esame"}','sources',1);`);
  db.prepare(
    "INSERT INTO learning_events(id,kind,plan_id,payload_json,created_at) VALUES('ev-diag','lesson_completed','p-an2',?,?)",
  ).run(JSON.stringify({ activity: "diagnostic" }), Date.now() - 2 * day);
  const parts: SeedPart[] = titles.map(([title, minutes], index) => ({
    title,
    minutes,
    markdown: index < 3 ? partMarkdown(title) : null,
    doneAt: index < 2 ? doneAt + index : null,
  }));
  parts.push({ kind: "recap", title: "Ripasso del capitolo", minutes: 4 });
  // The app's database is node:sqlite here; the helper uses only prepare and run, which both drivers share.
  const sqlite = db as unknown as Database.Database;
  seedOutline(sqlite, { planId: "p-an2", topicId: "t-fun", parts });
  seedOutline(sqlite, { planId: "p-an2", topicId: "t-max", parts: [{ title: "Massimi e minimi liberi", minutes: 9 }] });
}

function withDb(userData: string, run: (db: DatabaseSync) => void) {
  const db = new DatabaseSync(join(userData, "workspace", "pyxis.db"));
  try {
    run(db);
  } finally {
    db.close();
  }
}

async function openExam(page: Page) {
  await page.evaluate(() => {
    location.hash = "/plans/p-an2";
  });
  await expect(page.getByRole("heading", { level: 1, name: "Analisi Matematica 2" })).toBeVisible();
  // The suggestion has loaded: its heading has text, not the skeleton.
  await expect(page.locator(".px-exam-now h2")).toHaveText(/\S/);
}

/**
 * A part row's name: its title, then what the row says about it. The state is visually hidden text, which the name
 * computation reads as a block of its own, so a space can come before its comma.
 */
function named(title: string, rest: string): RegExp {
  const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${escape(title)} ?, ${escape(rest)}$`);
}

/** The text an element draws: KaTeX's MathML for screen readers, which holds the TeX source, left out. */
function drawnText(element: Locator) {
  return element.evaluate((node) => {
    const copy = node.cloneNode(true) as Element;
    copy.querySelectorAll(".katex-mathml").forEach((math) => math.remove());
    return copy.textContent ?? "";
  });
}

async function backToExam(page: Page, address: RegExp) {
  await expect(page).toHaveURL(address);
  await openExam(page);
}

test("the exam page suggests the next part of a lesson in parts, picks up from it on a later day, and lists the parts on the path", async () => {
  test.setTimeout(180_000);
  const userData = mkdtempSync(join(tmpdir(), "pyxis-exam-parts-"));
  const app = await launchPyxis({ userData });
  try {
    const page = await app.firstWindow();
    await page.getByRole("button", { name: "Salta" }).click();
    await fromChiediToExams(page);
    await page.evaluate(() => window.pyxis.invoke("plans.list", {}));
    withDb(userData, (db) => seed(db, Date.now() - 60_000));
    await page.evaluate(() => localStorage.setItem("pyxis.lang", "it"));
    await page.reload();
    await openExam(page);

    // Consigliato adesso: the part to read next, its place in the lesson and its minutes, one Continua.
    const now = page.locator(".px-exam-now");
    await expect(now.locator(".px-exam-kicker")).toHaveText("Consigliato adesso");
    await expect(now.getByRole("heading", { level: 2 })).toHaveText("Insiemi aperti e chiusi");
    await expect(now.locator("p")).toHaveText("Parte 3 di 8 · Funzioni di più variabili · circa 6 minuti");
    await expect(now.getByRole("button", { name: "Riprendi", exact: true })).toHaveCount(0);

    // The path opens on that topic: its line counts the parts read and the minutes left, and the lesson step is the
    // list of its parts, then Esercizi and Quiz as before.
    const topic = page.locator(".px-xpath-row.is-open");
    await expect(topic.locator(".px-xpath-title")).toHaveText("Funzioni di più variabili");
    await expect(topic.locator(".px-xpath-head .px-xpath-sub")).toHaveText("2 parti su 8 lette · circa 43 minuti alla fine");
    await expect(topic.locator(".px-xpath-parts-head")).toHaveText("Lezione in 8 parti e un ripasso");
    const parts = page.getByRole("list", { name: "Parti della lezione su Funzioni di più variabili" });
    const rows = parts.getByRole("link");
    await expect(rows).toHaveCount(9);
    // Each row is a link named with its state: read, suggested now, not written yet. Playwright's name leaves out KaTeX's
    // MathML, so the formula in part 1's name is checked as drawn below.
    await expect(rows.nth(0)).toHaveAccessibleName(/^Parte 1 · Intorni e distanza in .* ?, letta, 5 min$/);
    await expect(rows.nth(1)).toHaveAccessibleName(named("Parte 2 · Interno, esterno, frontiera", "letta, 6 min"));
    await expect(rows.nth(2)).toHaveAccessibleName(named("Parte 3 · Insiemi aperti e chiusi", "adesso · 6 min"));
    await expect(rows.nth(3)).toHaveAccessibleName(named("Parte 4 · Limitati, compatti, connessi", "non ancora scritta, 5 min"));
    await expect(rows.nth(8)).toHaveAccessibleName(named("Ripasso del capitolo", "non ancora scritto, 4 min"));
    await expect(rows.nth(2)).toHaveClass(/\bis-now\b/);
    await expect(rows.nth(3)).toHaveClass(/\bis-unwritten\b/);
    // The formula in part 1's title is drawn, not shown as TeX.
    await expect(rows.nth(0).locator(".katex")).toHaveCount(1);
    expect(await drawnText(rows.nth(0))).not.toContain("\\");
    await expect(topic.getByText("Pyxis scrive le parti tratteggiate quando arrivi a quella prima.")).toBeVisible();
    const steps = page.getByRole("list", { name: "Passi di Funzioni di più variabili" });
    await expect(steps.getByRole("button", { name: /^Lezione/ })).toHaveCount(0);
    await expect(steps.getByRole("button", { name: /^Esercizi/ })).toBeVisible();
    await expect(steps.getByRole("button", { name: /^Quiz/ })).toBeVisible();
    await expectNoAxeViolations(page);

    // Continua opens the suggested part.
    await now.getByRole("button", { name: "Continua", exact: true }).click();
    await backToExam(page, /#\/plans\/p-an2\/lesson\/t-fun\?part=3$/);
    // A part row opens its part, from the pointer and from the keyboard.
    await rows.nth(3).click();
    await backToExam(page, /#\/plans\/p-an2\/lesson\/t-fun\?part=4$/);
    await topic.locator(".px-xpath-head").focus();
    await page.keyboard.press("Tab");
    await expect(rows.nth(0)).toBeFocused();
    await page.keyboard.press("Enter");
    await backToExam(page, /#\/plans\/p-an2\/lesson\/t-fun\?part=1$/);

    // Scegli altro: the topic's exercises, its flashcards and a part to read again. It opens from the keyboard and closes
    // on one Escape with the focus back on its button.
    const other = now.getByRole("button", { name: "Scegli altro", exact: true });
    await other.focus();
    await page.keyboard.press("Enter");
    const items = page.getByRole("menuitem");
    await expect(items).toHaveCount(3);
    await expect(items.nth(0)).toHaveAccessibleName(/^Esercizi · Funzioni di più variabili\s*1 esercizio$/);
    await expect(items.nth(1)).toHaveAccessibleName(/^Flashcard · Funzioni di più variabili\s*Crea le flashcard$/);
    await expect(items.nth(2)).toHaveAccessibleName(/^Rileggi una parte\s*2 parti lette$/);
    await animationsSettled(page);
    await expectNoAxeViolations(page);
    await page.keyboard.press("Escape");
    await expect(items).toHaveCount(0);
    await expect(other).toBeFocused();
    await other.click();
    await page.getByRole("menuitem", { name: /^Esercizi/ }).click();
    await backToExam(page, /#\/plans\/p-an2\/practice\/t-fun$/);
    await other.click();
    await page.getByRole("menuitem", { name: /^Flashcard/ }).click();
    await backToExam(page, /#\/plans\/p-an2\/cards\/t-fun$/);
    // Rileggi una parte lists the parts read, with the right arrow.
    await other.click();
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowDown");
    await expect(page.getByRole("menuitem", { name: /^Rileggi una parte/ })).toBeFocused();
    await page.keyboard.press("ArrowRight");
    const reread = page.getByRole("menuitem", { name: /^Parte \d/ });
    await expect(reread).toHaveCount(2);
    await atRest(reread.last());
    await expect(reread.first().locator(".katex")).toHaveCount(1);
    expect(await drawnText(reread.first())).not.toContain("\\");
    await reread.last().click();
    await backToExam(page, /#\/plans\/p-an2\/lesson\/t-fun\?part=2$/);

    // On a later day, the card picks up after the last part read: the part's number moves into the title and the line
    // says when the last one was finished. The path counts three parts read.
    withDb(userData, (db) => {
      db.prepare("UPDATE lesson_parts SET done_at = ? + position WHERE outline_id = 'outline-t-fun' AND position <= 3").run(startOfToday() - 6 * 3_600_000);
    });
    await page.reload();
    await openExam(page);
    await expect(now.locator(".px-exam-kicker")).toHaveText("Riprendi da");
    await expect(now.getByRole("heading", { level: 2 })).toHaveText("Parte 4 · Limitati, compatti, connessi");
    await expect(now.locator("p")).toHaveText("Funzioni di più variabili · circa 5 minuti · ieri hai finito la parte 3");
    await expect(topic.locator(".px-xpath-head .px-xpath-sub")).toHaveText("3 parti su 8 lette · circa 37 minuti alla fine");
    await expect(rows.nth(3)).toHaveAccessibleName(named("Parte 4 · Limitati, compatti, connessi", "adesso · 5 min"));
    await now.getByRole("button", { name: "Riprendi", exact: true }).click();
    await backToExam(page, /#\/plans\/p-an2\/lesson\/t-fun\?part=4$/);

    // A formula in the suggested part's title is drawn in the card too.
    withDb(userData, (db) => {
      db.prepare("UPDATE lesson_parts SET title = ? WHERE outline_id = 'outline-t-fun' AND position = 4").run("Compatti in $\\mathbb{R}^n$");
    });
    await page.reload();
    await openExam(page);
    await expect(now.getByRole("heading", { level: 2 }).locator(".katex")).toHaveCount(1);
    expect(await drawnText(now.getByRole("heading", { level: 2 }))).not.toContain("\\");

    // The same in English.
    await page.evaluate(() => localStorage.setItem("pyxis.lang", "en"));
    await page.reload();
    await openExam(page);
    await expect(now.locator(".px-exam-kicker")).toHaveText("Pick up from");
    await expect(now.locator("p")).toHaveText("Funzioni di più variabili · about 5 minutes · you finished part 3 yesterday");
    await expect(now.getByRole("button", { name: "Resume", exact: true })).toBeVisible();
    await expect(topic.locator(".px-xpath-head .px-xpath-sub")).toHaveText("3 of 8 parts read · about 37 minutes to go");
    await expect(topic.locator(".px-xpath-parts-head")).toHaveText("Lesson in 8 parts and a recap");
  } finally {
    await app.close();
    removeTestFolder(userData);
  }
});

test("a suggestion that is not a lesson reads as before under Consigliato adesso, and a topic of one part or with no parts keeps its one lesson step", async () => {
  test.setTimeout(120_000);
  const userData = mkdtempSync(join(tmpdir(), "pyxis-exam-parts-other-"));
  const app = await launchPyxis({ userData });
  try {
    const page = await app.firstWindow();
    await page.getByRole("button", { name: "Salta" }).click();
    await fromChiediToExams(page);
    await page.evaluate(() => window.pyxis.invoke("plans.list", {}));
    withDb(userData, (db) => {
      seed(db, Date.now() - 60_000);
      // Taylor's lesson was just read, so the path stays on it with exercises before the lesson started in parts.
      db.prepare(
        "INSERT INTO learning_events(id,kind,plan_id,topic_id,payload_json,created_at) VALUES('ev-tay','lesson_completed','p-an2','t-tay',?,?)",
      ).run(JSON.stringify({ activity: "lesson" }), Date.now() - 30_000);
    });
    await page.evaluate(() => localStorage.setItem("pyxis.lang", "it"));
    await page.reload();
    await openExam(page);

    const now = page.locator(".px-exam-now");
    await expect(now.locator(".px-exam-kicker")).toHaveText("Consigliato adesso");
    await expect(now.getByRole("heading", { level: 2 })).toHaveText("Esercizio assistito: Formula di Taylor in più variabili");
    await expect(now.locator("p")).toHaveText("Fissa quello che hai appena letto.");
    // Scegli altro leaves out the step the card suggests, and has no part to read again on a topic with no parts.
    await now.getByRole("button", { name: "Scegli altro", exact: true }).click();
    await expect(page.getByRole("menuitem")).toHaveCount(1);
    await expect(page.getByRole("menuitem")).toHaveAccessibleName(/^Flashcard · Formula di Taylor in più variabili\s*Crea le flashcard$/);
    await page.keyboard.press("Escape");
    await now.getByRole("button", { name: "Continua", exact: true }).click();
    await backToExam(page, /#\/plans\/p-an2\/practice\/t-tay$/);

    // Taylor, with no outline, keeps its one lesson step and the path's usual line.
    const path = page.locator(".px-xpath-list");
    const taylor = page.getByRole("list", { name: "Passi di Formula di Taylor in più variabili" });
    await expect(taylor.getByRole("button", { name: /^Lezione/ })).toBeVisible();
    await expect(page.locator(".px-xpath-parts")).toHaveCount(0);
    await expect(page.locator(".px-xpath-row.is-open .px-xpath-head .px-xpath-sub")).toHaveText(/ su 3 fatti$/);

    // A topic of one part does too.
    await path.getByRole("button", { name: /^Massimi e minimi liberi/ }).click();
    const one = page.getByRole("list", { name: "Passi di Massimi e minimi liberi" });
    await expect(one.getByRole("button", { name: /^Lezione/ })).toBeVisible();
    await expect(page.locator(".px-xpath-parts")).toHaveCount(0);

    // The parted topic, opened while the card suggests something else, lists its parts with none marked "adesso".
    await path.getByRole("button", { name: /^Funzioni di più variabili/ }).click();
    const rows = page.getByRole("list", { name: "Parti della lezione su Funzioni di più variabili" }).getByRole("link");
    await expect(rows).toHaveCount(9);
    await expect(rows.nth(2)).toHaveAccessibleName(named("Parte 3 · Insiemi aperti e chiusi", "6 min"));
    await expect(page.locator(".px-xpath-substep.is-now")).toHaveCount(0);
  } finally {
    await app.close();
    removeTestFolder(userData);
  }
});
