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
import { partText, recapText } from "./part-texts";
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

async function openExam(page: Page, planId = "p-an2") {
  await page.evaluate((planId) => {
    location.hash = `/plans/${planId}`;
  }, planId);
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

test("a recap read before the parts leaves the lesson unread on the exam page until the last missing part is done", async () => {
  test.setTimeout(120_000);
  const userData = mkdtempSync(join(tmpdir(), "pyxis-exam-parts-recap-"));
  const app = await launchPyxis({ userData });
  try {
    const page = await app.firstWindow();
    await page.getByRole("button", { name: "Salta" }).click();
    await fromChiediToExams(page);
    await page.evaluate(() => window.pyxis.invoke("plans.list", {}));
    withDb(userData, (db) => seed(db, Date.now() - 60_000));
    await page.evaluate(() => localStorage.setItem("pyxis.lang", "it"));
    await page.reload();
    const lessonStep = async () =>
      (
        (await page.evaluate(() => window.pyxis.invoke("plans.read", { planId: "p-an2" }))) as {
          steps: Array<{ activity: string; topicId: string | null }>;
        }
      ).steps.filter((step) => step.activity === "lesson" && step.topicId === "t-fun").length;
    const done = (position: number) =>
      page.evaluate((position) => window.pyxis.invoke("study.partDone", { planId: "p-an2", topicId: "t-fun", position }), position);

    // Parts 1 and 2 are read; the recap, which has no question here, is finished with Fatto before parts 3 to 8.
    expect(await done(9)).toEqual({ partDone: true, finished: false });
    expect(await lessonStep()).toBe(0);
    await openExam(page);
    const now = page.locator(".px-exam-now");
    await expect(now.getByRole("heading", { level: 2 })).toHaveText("Insiemi aperti e chiusi");
    const topic = page.locator(".px-xpath-row.is-open");
    await expect(topic.locator(".px-xpath-head .px-xpath-sub")).toHaveText("2 parti su 8 lette · circa 39 minuti alla fine");
    await expect(page.getByRole("list", { name: "Passi di Funzioni di più variabili" }).getByRole("button", { name: /^Lezione/ })).toHaveCount(0);
    await expect(page.getByText("Lezione in 8 parti e un ripasso")).toBeVisible();

    // The recap's own page ends with Continua going back to the path, because the lesson is still the suggestion there,
    // not on to the exercises as it would be if the recap had read the lesson.
    await page.evaluate(() => {
      location.hash = "/plans/p-an2/lesson/t-fun?part=9";
    });
    await expect(page.locator(".px-part-continue button")).toHaveText("Torna al percorso");

    // Every part but one: the card still names it and the lesson is not read. Part 3 is written with its question, which
    // only answering finishes, so it is marked done as that does.
    withDb(userData, (db) => {
      db.prepare("UPDATE lesson_parts SET done_at = ? WHERE outline_id = 'outline-t-fun' AND position = 3").run(Date.now());
    });
    for (const position of [4, 5, 6, 7]) await done(position);
    expect(await lessonStep()).toBe(0);
    await page.reload();
    await openExam(page);
    await expect(now.getByRole("heading", { level: 2 })).toHaveText("Derivate seconde e matrice hessiana");

    // The last one missing finishes the lesson: one step, the parts' line gone, the card on to the topic's exercises.
    expect(await done(8)).toEqual({ partDone: true, finished: true });
    expect(await lessonStep()).toBe(1);
    await page.reload();
    await openExam(page);
    await expect(now.getByRole("heading", { level: 2 })).toHaveText(/: Funzioni di più variabili$/);
    await expect(page.locator(".px-xpath-row.is-open .px-xpath-sub")).not.toContainText("lette");
    await expect(page.getByText("Lezione in 8 parti e un ripasso")).toBeVisible();
  } finally {
    await app.close();
    removeTestFolder(userData);
  }
});

/** About 24,000 characters in eight passages, which Pyxis plans in 3 to 5 parts; Taylor is small enough for one part. */
const walkPassages = Array.from({ length: 8 }, (_, i) => ({
  id: `pw-${i + 1}`,
  text: `Passaggio ${i + 1} del capitolo sulle funzioni di più variabili. `.repeat(46),
  locator: { chapter: 2, paragraph: `p${i + 1}` },
  section: `2.${Math.floor(i / 2) + 1}`,
}));
const walkOutline = {
  lessonParts: [
    { title: "Intorni e distanza in $\\mathbb{R}^n$", about: "Misurare la distanza tra due punti.", passages: ["P1", "P2"] },
    { title: "Interno, esterno, frontiera", about: "Dove sta un punto rispetto a un insieme.", passages: ["P3", "P4"] },
    { title: "Insiemi aperti e chiusi", about: "Quando un insieme è aperto o chiuso.", passages: ["P5", "P6"] },
    { title: "Limitati, compatti, connessi", about: "Tre proprietà degli insiemi.", passages: ["P7", "P8"] },
  ],
};

test("the exam page and the part page meet: Continua, Per oggi basta, a part row, Rileggi una parte and Riprendi da open the part the exam page names", async () => {
  test.setTimeout(240_000);
  const userData = mkdtempSync(join(tmpdir(), "pyxis-exam-parts-walk-"));
  // The recorded engine plans the chapter and writes its parts in the order the jobs ask: parts 1 to 4 (each written
  // when the one before it opens), the recap, then Taylor's one part.
  const app = await launchPyxis({
    userData,
    env: {
      PYXIS_E2E_PLAN_REPLIES: JSON.stringify({
        lessonParts: walkOutline,
        markdown: [
          { markdown: partText("Intorni") },
          { markdown: partText("Frontiera") },
          { markdown: partText("Aperti e chiusi") },
          { markdown: partText("Compatti") },
          { markdown: recapText },
          { markdown: partText("Taylor") },
        ],
      }),
    },
  });
  try {
    const page = await app.firstWindow();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.getByRole("button", { name: "Salta" }).click();
    await fromChiediToExams(page);
    await page.evaluate(() => window.pyxis.invoke("plans.list", {}));
    withDb(userData, (db) => {
      seedSource(db, {
        id: "s-walk",
        title: "Bramanti, Pagani, Salsa",
        document: { id: "d-walk" },
        passages: [
          ...walkPassages,
          { id: "pw-tay", text: "La formula di Taylor approssima una funzione con un polinomio.", locator: { chapter: 4, paragraph: "p1" }, section: "4.1" },
        ],
      });
      seedPlan(db, {
        id: "p-walk",
        title: "Analisi Matematica 2",
        language: "it",
        sourceIds: ["s-walk"],
        topics: [
          { id: "t-fun", title: "Funzioni di più variabili" },
          { id: "t-tay", title: "Formula di Taylor in più variabili" },
        ],
      });
      const link = db.prepare("INSERT INTO topic_passages(topic_id,passage_id) VALUES(?,?)");
      for (const passage of walkPassages) link.run("t-fun", passage.id);
      link.run("t-tay", "pw-tay");
      // The diagnostic is done, so the path suggests the first lesson.
      db.prepare(
        "INSERT INTO learning_events(id,kind,plan_id,payload_json,created_at) VALUES('ev-walk','lesson_completed','p-walk',?,?)",
      ).run(JSON.stringify({ activity: "diagnostic" }), Date.now() - 2 * day);
    });
    await page.evaluate(() => localStorage.setItem("pyxis.lang", "it"));
    await page.reload();
    await openExam(page, "p-walk");
    const now = page.locator(".px-exam-now");
    const title = page.getByRole("heading", { level: 1 });
    const verifica = page.getByRole("region", { name: "Verifica" });
    const enough = page.getByRole("button", { name: "Per oggi basta" });
    const rows = page.getByRole("list", { name: "Parti della lezione su Funzioni di più variabili" }).getByRole("link");

    // Before the topic is planned the card names the lesson. Continua opens it; the part page plans the chapter, writes
    // part 1 and names it in the address.
    await expect(now.getByRole("heading", { level: 2 })).toHaveText("Lezione: Funzioni di più variabili");
    await now.getByRole("button", { name: "Continua", exact: true }).click();
    await expect(page).toHaveURL(/#\/plans\/p-walk\/lesson\/t-fun\?part=1$/, { timeout: 20_000 });
    await expect(page.getByText("Intorni: l'idea")).toBeVisible({ timeout: 20_000 });
    await verifica.getByRole("button", { name: /La cosa giusta/ }).click();
    await expect(page.getByText("Giusto.", { exact: true })).toBeVisible();

    // Per oggi basta: the card names part 2, and the Percorso ticks part 1 and marks part 2 as the one now.
    await enough.click();
    await expect(page).toHaveURL(/#\/plans\/p-walk$/);
    await expect(now.locator(".px-exam-kicker")).toHaveText("Consigliato adesso");
    await expect(now.getByRole("heading", { level: 2 })).toHaveText("Interno, esterno, frontiera");
    await expect(now.locator("p")).toHaveText(/^Parte 2 di 4 · Funzioni di più variabili · circa \d+ minuti$/);
    await expect(rows).toHaveCount(5);
    await expect(rows.nth(0)).toHaveClass(/\bis-done\b/);
    await expect(rows.nth(0)).toHaveAccessibleName(/^Parte 1 · Intorni e distanza in .* ?, letta, \d+ min$/);
    await expect(rows.nth(1)).toHaveClass(/\bis-now\b/);

    // Continua opens part 2, written ahead while part 1 was read. Answered, it moves the card on to part 3.
    await now.getByRole("button", { name: "Continua", exact: true }).click();
    await expect(page).toHaveURL(/#\/plans\/p-walk\/lesson\/t-fun\?part=2$/);
    await expect(title).toHaveText("Interno, esterno, frontiera");
    await expect(page.getByText("Frontiera: l'idea")).toBeVisible({ timeout: 20_000 });
    await verifica.getByRole("button", { name: /La cosa giusta/ }).click();
    await expect(page.getByText("Giusto.", { exact: true })).toBeVisible();
    await enough.click();
    await expect(now.getByRole("heading", { level: 2 })).toHaveText("Insiemi aperti e chiusi");
    await expect(now.locator("p")).toHaveText(/^Parte 3 di 4 · /);
    await expect(rows.nth(1)).toHaveClass(/\bis-done\b/);

    // A part row opens its part.
    await rows.nth(2).click();
    await expect(page).toHaveURL(/#\/plans\/p-walk\/lesson\/t-fun\?part=3$/);
    await expect(title).toHaveText("Insiemi aperti e chiusi");
    await expect(page.getByText("Aperti e chiusi: l'idea")).toBeVisible({ timeout: 20_000 });
    await enough.click();

    // Rileggi una parte opens a part already read, with its answer.
    await now.getByRole("button", { name: "Scegli altro", exact: true }).click();
    await page.getByRole("menuitem", { name: /^Rileggi una parte/ }).hover();
    await page.getByRole("menuitem", { name: /^Parte 1 · Intorni/ }).click();
    await expect(page).toHaveURL(/#\/plans\/p-walk\/lesson\/t-fun\?part=1$/);
    await expect(title).toHaveText(/^Intorni e distanza in /);
    await expect(page.getByText("Giusto.", { exact: true })).toBeVisible();
    await enough.click();

    // The recap row opens the recap, once part 4 (written ahead of part 3) is written and its job has ended.
    await expect
      .poll(async () => {
        const read = (await page.evaluate(() => window.pyxis.invoke("study.parts", { planId: "p-walk", topicId: "t-fun" }))) as {
          outline: { parts: Array<{ state: string }> } | null;
        };
        return read.outline?.parts[3]?.state;
      }, { timeout: 20_000 })
      .toBe("written");
    await expect(rows.nth(4)).toHaveAttribute("href", "#/plans/p-walk/lesson/t-fun?part=5");
    await rows.nth(4).click();
    await expect(page).toHaveURL(/#\/plans\/p-walk\/lesson\/t-fun\?part=5$/);
    await expect(title).toHaveText("Ripasso del capitolo");
    await expect(page.getByRole("heading", { level: 2, name: "Il capitolo in breve" })).toBeVisible({ timeout: 20_000 });
    await enough.click();

    // On a later day, Riprendi da names the part after the last one read, and Riprendi opens it.
    withDb(userData, (db) => {
      db.prepare(
        "UPDATE lesson_parts SET done_at = ? + position WHERE done_at IS NOT NULL AND outline_id IN (SELECT id FROM lesson_outlines WHERE topic_id = 't-fun')",
      ).run(startOfToday() - 6 * 3_600_000);
    });
    await page.reload();
    await openExam(page, "p-walk");
    await expect(now.locator(".px-exam-kicker")).toHaveText("Riprendi da");
    await expect(now.getByRole("heading", { level: 2 })).toHaveText("Insiemi aperti e chiusi");
    await expect(now.locator("p")).toHaveText(/ · ieri hai finito la parte 2$/);
    await now.getByRole("button", { name: "Riprendi", exact: true }).click();
    await expect(page).toHaveURL(/#\/plans\/p-walk\/lesson\/t-fun\?part=3$/);
    await expect(title).toHaveText("Insiemi aperti e chiusi");
    await expect(page.getByText("Aperti e chiusi: l'idea")).toBeVisible();

    // A topic of one part: its one lesson step opens the part page, which names part 1 in the address and has no
    // "Parte 1 di 1"; back on the path it keeps its one step.
    await openExam(page, "p-walk");
    await page.locator(".px-xpath-list").getByRole("button", { name: /^Formula di Taylor in più variabili/ }).click();
    await page.getByRole("list", { name: "Passi di Formula di Taylor in più variabili" }).getByRole("button", { name: /^Lezione/ }).click();
    await expect(page).toHaveURL(/#\/plans\/p-walk\/lesson\/t-tay\?part=1$/, { timeout: 20_000 });
    await expect(page.getByText("Taylor: l'idea")).toBeVisible({ timeout: 20_000 });
    await expect(page.locator(".px-studybar-title")).not.toContainText("Parte 1");
    await openExam(page, "p-walk");
    await page.locator(".px-xpath-list").getByRole("button", { name: /^Formula di Taylor in più variabili/ }).click();
    await expect(page.getByRole("list", { name: "Passi di Formula di Taylor in più variabili" }).getByRole("button", { name: /^Lezione/ })).toBeVisible();
    await expect(page.getByRole("list", { name: "Parti della lezione su Formula di Taylor in più variabili" })).toHaveCount(0);
    expect(errors).toEqual([]);
  } finally {
    await app.close();
    removeTestFolder(userData);
  }
});
