import { expect, test, type Page } from "@playwright/test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parseSmartText, smartQuestions } from "../../src/shared/smart-text";
import { launchPyxis } from "./app-under-test";
import { expectNoAxeViolations } from "./axe";
import { removeTestFolder } from "./cleanup";
import { fromChiediToExams } from "./doors";
import { seedLessonBeforeParts } from "./lesson-before-parts";
import { partText } from "./part-texts";
import { seedPlan, seedSource, seedSubjects } from "./seed";
import { animationsSettled, atRest } from "./settled";
import { saveShot } from "./shots";

// Lessons written before parts, with the recorded engine: an unfinished one is rewritten in parts when it is opened,
// with its earlier version one click away; a rewrite that fails, or finds no AI tool, leaves it as it was; a finished
// one opens as it was and is rewritten only through "Riscrivi in parti", which asks first. The exam page is checked
// before and after each.

const day = 86_400_000;

/** Two topics of eight passages of about 3,000 characters, which the recorded outline cuts in four parts each. */
const passagesOf = (topic: string) =>
  Array.from({ length: 8 }, (_, i) => ({
    id: `${topic}-${i + 1}`,
    text: `Passaggio ${i + 1} del capitolo, sulle funzioni di più variabili. `.repeat(46),
    section: `2.${Math.floor(i / 2) + 1}`,
  }));

const outline = {
  lessonParts: [
    { title: "Intorni e distanza", about: "Misurare la distanza tra due punti.", passages: ["P1", "P2"] },
    { title: "Interno, esterno, frontiera", about: "Dove sta un punto rispetto a un insieme.", passages: ["P3", "P4"] },
    { title: "Insiemi aperti e chiusi", about: "Quando un insieme è aperto o chiuso.", passages: ["P5", "P6"] },
    { title: "Limitati, compatti, connessi", about: "Tre proprietà degli insiemi.", passages: ["P7", "P8"] },
  ],
};

const fence = (kind: string, body: unknown) => ["```" + kind, JSON.stringify(body), "```"].join("\n");

/** The lesson the student had before parts: a section, a quick check and the closing recap. */
const oldText = [
  "## Intorni nel piano",
  "",
  "Un intorno di un punto è una palla aperta centrata nel punto, e serve a dire che cosa vuol dire «vicino».",
  "",
  fence("pyxis-check", {
    question: "Che cos'è un intorno di un punto?",
    options: ["Una palla aperta centrata nel punto", "Una retta per il punto", "Il punto stesso"],
    answer: 0,
    explanation: "Un intorno è una palla aperta.",
  }),
  "",
  fence("pyxis-recap", {
    questions: [1, 2, 3].map((n) => ({
      question: `Domanda di ripasso sugli intorni ${n}?`,
      options: ["Giusta", "Sbagliata"],
      answer: 0,
    })),
  }),
].join("\n");
const [quickCheck] = [...smartQuestions(parseSmartText(oldText)).keys()];

type Started = { page: Page; prompts: string; db: () => DatabaseSync; close: () => Promise<void> };

/** The app with Analisi 2 seeded, the diagnostic done, `old` lessons seeded and the recorded engine answering `replies`. */
async function start(
  replies: unknown,
  old: (db: DatabaseSync) => void,
  topics = [{ id: "t-funzioni", title: "Funzioni di più variabili" }],
): Promise<Started> {
  const userData = mkdtempSync(join(tmpdir(), "pyxis-old-lessons-"));
  const prompts = join(userData, "plan-prompts.log");
  const app = await launchPyxis({
    userData,
    env: {
      PYXIS_E2E_PLAN_REPLIES: JSON.stringify(replies),
      // Every call takes this long, so the working states stay on screen while the test reads them.
      PYXIS_E2E_PLAN_DELAY: "1500",
      PYXIS_E2E_PLAN_PROMPTS: prompts,
    },
  });
  const page = await app.firstWindow();
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.getByRole("button", { name: "Salta" }).click();
  await fromChiediToExams(page);
  await page.evaluate(() => window.pyxis.invoke("plans.list", {}));
  const db = () => new DatabaseSync(join(userData, "workspace", "pyxis.db"), { timeout: 10000 });
  const seeding = db();
  seedSubjects(seeding, [{ id: "an2", name: "Analisi 2" }]);
  seedSource(seeding, {
    id: "bramanti",
    title: "Bramanti, Pagani, Salsa",
    subjectId: "an2",
    document: { id: "bramanti-doc" },
    passages: topics.flatMap((topic) => passagesOf(topic.id)),
  });
  seedPlan(seeding, {
    id: "p-an2",
    subjectId: "an2",
    title: "Analisi Matematica 2",
    language: "it",
    sourceIds: ["bramanti"],
    topics,
  });
  for (const topic of topics)
    for (const passage of passagesOf(topic.id))
      seeding.prepare("INSERT INTO topic_passages(topic_id,passage_id) VALUES(?,?)").run(topic.id, passage.id);
  // The diagnostic is done, so the path suggests the first lesson.
  seeding
    .prepare("INSERT INTO learning_events(id,kind,plan_id,payload_json,created_at) VALUES('ev-diag','lesson_completed','p-an2',?,?)")
    .run(JSON.stringify({ activity: "diagnostic" }), Date.now() - 2 * day);
  old(seeding);
  seeding.close();
  await page.evaluate(() => localStorage.setItem("pyxis.lang", "it"));
  await page.reload();
  return {
    page,
    prompts,
    db,
    close: async () => {
      await app.close();
      removeTestFolder(userData);
    },
  };
}

const openExam = async (page: Page) => {
  await page.evaluate(() => {
    location.hash = "/plans/p-an2";
  });
  await expect(page.getByRole("heading", { level: 1, name: "Analisi Matematica 2" })).toBeVisible();
  await expect(page.locator(".px-exam-now h2")).toHaveText(/\S/);
};
const openLesson = (page: Page, topicId = "t-funzioni") =>
  page.evaluate((hash) => {
    location.hash = hash;
  }, `/plans/p-an2/lesson/${topicId}`);

const working = (page: Page, text: string | RegExp) => page.getByRole("status").filter({ hasText: text });
const parts = (page: Page) => page.getByRole("navigation", { name: "Parti del capitolo" });
const nowHeading = (page: Page) => page.locator(".px-exam-now").getByRole("heading", { level: 2 });
/** The prompts the recorded engine was sent, one per call. */
const sent = (prompts: string): string[] => {
  try {
    return readFileSync(prompts, "utf8").trim().split("\n").filter(Boolean);
  } catch {
    return [];
  }
};
const planningCalls = (prompts: string) => sent(prompts).filter((line) => line.includes('\\"target\\"')).length;
const lessonSteps = async (page: Page, topicId = "t-funzioni") =>
  (
    (await page.evaluate(() => window.pyxis.invoke("plans.read", { planId: "p-an2" }))) as {
      steps: Array<{ activity: string; topicId: string | null; itemId: string | null }>;
    }
  ).steps.filter((step) => step.activity === "lesson" && step.topicId === topicId);
const partJobs = async (page: Page) =>
  ((await page.evaluate(() => window.pyxis.invoke("jobs.list", {}))) as Array<{ kind: string }>).filter(
    (job) => job.kind === "lesson-part",
  ).length;

test("an unfinished old lesson is rewritten in parts when it is opened, once, and its earlier version stays readable", async () => {
  test.setTimeout(240_000);
  // The plan of the parts waits for this file, so the test reads the rewriting state and the earlier version first.
  const holdDir = mkdtempSync(join(tmpdir(), "pyxis-old-hold-"));
  const hold = join(holdDir, "outline");
  const { page, prompts, db, close } = await start(
    { lessonParts: { ...outline, hold }, markdown: [{ markdown: partText("Intorni") }, { markdown: partText("Frontiera") }] },
    (seeding) => seedLessonBeforeParts(seeding, "p-an2", ["t-funzioni"], { markdown: oldText, wording: "balanced" }),
  );
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const oldAnswers = () => {
    const read = db();
    try {
      return read.prepare("SELECT COUNT(*) AS n FROM learning_events WHERE item_id = 'before-parts-t-funzioni'").get() as { n: number };
    } finally {
      read.close();
    }
  };
  try {
    // The student opened the lesson before parts and answered its quick check with the first option shown, which is a
    // wrong one, and never finished it.
    await page.evaluate(
      (blockId) =>
        window.pyxis.invoke("study.lessonAnswer", { planId: "p-an2", itemId: "before-parts-t-funzioni", blockId, pick: 0 }),
      quickCheck!,
    );

    // Before: the exam page suggests the lesson as one lesson, and the path lists it as made.
    await openExam(page);
    await expect(nowHeading(page)).toHaveText("Lezione: Funzioni di più variabili");
    await expect(page.locator(".px-exam-now p")).not.toContainText("Parte");
    const made = page.locator(".px-xpath-items").getByRole("button", { name: /^Lezione · / });
    await expect(made).toHaveCount(1);
    await saveShot(page, "old-lessons/unfinished-exam-before-it-light.png");

    // Opening it rewrites it in parts, in place: the working state says so, and the earlier version is one click away.
    await page.locator(".px-exam-now").getByRole("button", { name: "Continua", exact: true }).click();
    const rewriting = working(page, "Sto riscrivendo la lezione in parti brevi");
    await expect(rewriting).toBeVisible();
    await expect(page.getByText("La versione di prima resta tra le cose fatte del capitolo.")).toBeVisible();
    await expect(page.locator(".px-part-working-status > p")).toBeFocused();
    await expect(parts(page)).toHaveCount(0);
    await expect(page).toHaveURL(/\/lesson\/t-funzioni\?part=1$/);
    await expectNoAxeViolations(page);
    await saveShot(page, "old-lessons/rewriting-it-light.png");

    // Leggi la versione di prima: the old text as it was, with its answer, read-only, and the way back to the parts.
    await page.getByRole("button", { name: "Leggi la versione di prima" }).click();
    await expect(page).toHaveURL(/\?item=before-parts-t-funzioni$/);
    await expect(page.getByText("Questa è la versione di prima della lezione, così com'era.", { exact: false })).toBeVisible();
    await expect(page.getByText("Un intorno di un punto è una palla aperta", { exact: false })).toBeVisible({ timeout: 20_000 });
    const quick = page.getByRole("region", { name: "Verifica rapida" });
    await expect(quick.getByText("Non proprio.", { exact: true })).toBeVisible();
    const recap = page.getByRole("region", { name: "Ripasso finale" });
    for (const option of await recap.getByRole("button").all()) await expect(option).toBeDisabled();
    await expect(page.getByRole("button", { name: /^Livello/ })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Fatto", exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "Altre azioni" }).click();
    await expect(page.getByRole("menuitem")).toHaveText(["Mappa", "Esporta"]);
    await page.keyboard.press("Escape");
    await expectNoAxeViolations(page);
    await saveShot(page, "old-lessons/earlier-it-light.png");
    await page.getByRole("button", { name: "Torna alle parti" }).click();
    await expect(rewriting).toBeVisible();

    // The plan of the parts arrives: the column fills in, then part 1 opens. Its parts start not read, whatever the
    // old lesson's answers were.
    writeFileSync(hold, "");
    await expect(parts(page).getByRole("link")).toHaveCount(5, { timeout: 20_000 });
    await expect(page.getByText("Intorni: l'idea")).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole("heading", { level: 1, name: "Intorni e distanza" })).toBeVisible();
    await expect(rewriting).toHaveCount(0);
    await expect(parts(page).getByRole("link", { name: /letta/ })).toHaveCount(0);
    expect(oldAnswers().n).toBe(1);
    expect(await lessonSteps(page)).toEqual([]);

    // After: the exam page names part 1, and the old lesson is still among the topic's made things.
    await openExam(page);
    await expect(page.locator(".px-exam-kicker")).toHaveText("Consigliato adesso");
    await expect(nowHeading(page)).toHaveText("Intorni e distanza");
    await expect(page.locator(".px-exam-now p")).toHaveText(/^Parte 1 di 4 · Funzioni di più variabili · circa \d+ minuti$/);
    await expect(page.getByText("Lezione in 4 parti e un ripasso")).toBeVisible();
    await expect(made).toHaveCount(1);
    await saveShot(page, "old-lessons/unfinished-exam-after-it-light.png");

    // It happens once: opening the lesson again opens part 1, with no new plan of the parts.
    await openLesson(page);
    await expect(page.getByText("Intorni: l'idea")).toBeVisible();
    await expect(rewriting).toHaveCount(0);
    expect(planningCalls(prompts)).toBe(1);
    // Part 1 finished, the lesson left and opened again from a link without a part: the first part not read, part 2,
    // and the address names it, as for a topic never read.
    await page.getByRole("region", { name: "Verifica" }).getByRole("button", { name: /La cosa giusta/ }).click();
    await expect(page.getByText("Giusto.", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Per oggi basta" }).click();
    await expect(page).toHaveURL(/#\/plans\/p-an2$/);
    await openLesson(page);
    await expect(page.getByRole("heading", { level: 1, name: "Interno, esterno, frontiera" })).toBeVisible();
    await expect(page).toHaveURL(/\?part=2$/);
    await expect(page.getByText("Frontiera: l'idea")).toBeVisible({ timeout: 20_000 });
    // The old lesson opens from what the topic made, as it was.
    await openExam(page);
    await made.click();
    await expect(
      page.getByRole("dialog", { name: "Lezione" }).getByText("Un intorno di un punto è una palla aperta", { exact: false }),
    ).toBeVisible();
    expect(errors).toEqual([]);
  } finally {
    await close();
    rmSync(holdDir, { recursive: true, force: true });
  }
});

test("a rewrite whose part 1 fails, or that finds no AI tool, leaves the old lesson as the topic's lesson, to read and finish, and Riprova rewrites it", async () => {
  test.setTimeout(240_000);
  const topics = [
    { id: "t-funzioni", title: "Funzioni di più variabili" },
    { id: "t-serie", title: "Serie di funzioni" },
  ];
  const { page, prompts, db, close } = await start(
    {
      lessonParts: outline,
      markdown: [{ fail: "Il motore non ha risposto." }, { markdown: partText("Intorni") }, { markdown: partText("Frontiera") }],
    },
    (seeding) =>
      seedLessonBeforeParts(seeding, "p-an2", ["t-funzioni", "t-serie"], { markdown: oldText, wording: "balanced" }),
    topics,
  );
  try {
    // The plan of the parts is saved and part 1 fails: the old lesson shows as it was, under what happened, and it can
    // still be answered; nothing on this screen rewrites it.
    await openLesson(page);
    await expect(working(page, "Sto riscrivendo la lezione in parti brevi")).toBeVisible();
    const failed = page.getByText("Non sono riuscito a riscrivere la lezione in parti. Qui sotto c'è la versione di prima, com'era.");
    await expect(failed).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText("Un intorno di un punto è una palla aperta", { exact: false })).toBeVisible();
    await expect(page.getByRole("button", { name: /^Livello/ })).toHaveCount(0);
    const quick = page.getByRole("region", { name: "Verifica rapida" });
    await page.getByRole("button", { name: "Altre azioni" }).click();
    await expect(page.getByRole("menuitem")).toHaveText(["Mappa", "Esporta"]);
    await page.keyboard.press("Escape");
    await quick.getByRole("button", { name: /Una palla aperta/ }).click();
    await expect(quick.getByText("Giusto.", { exact: true })).toBeVisible();
    await expectNoAxeViolations(page);
    await saveShot(page, "old-lessons/rewrite-failed-it-light.png");

    // The stored plan is no lesson of the student's yet: the exam page suggests the lesson as one lesson, the Percorso
    // keeps its one lesson step and lists no parts, and opening it again shows the failure, starting nothing.
    await openExam(page);
    await expect(nowHeading(page)).toHaveText("Lezione: Funzioni di più variabili");
    await expect(page.locator(".px-exam-now p")).not.toContainText("Parte");
    const steps = page.getByRole("list", { name: "Passi di Funzioni di più variabili" });
    await expect(steps.getByRole("button", { name: /^Lezione/ })).toBeVisible();
    await expect(page.getByText("Lezione in 4 parti e un ripasso")).toHaveCount(0);
    await saveShot(page, "old-lessons/rewrite-failed-exam-it-light.png");
    const calls = sent(prompts).length;
    await openLesson(page);
    await expect(failed).toBeVisible();
    await expect(quick.getByText("Giusto.", { exact: true })).toBeVisible();
    expect(sent(prompts)).toHaveLength(calls);

    // Riprova rewrites it: the working state, then part 1.
    await page.getByRole("button", { name: "Riprova", exact: true }).click();
    await expect(working(page, "Sto riscrivendo la lezione in parti brevi")).toBeVisible();
    await expect(page.getByText("Intorni: l'idea")).toBeVisible({ timeout: 20_000 });
    await expect(failed).toHaveCount(0);
    // Now the parts are the lesson: the card names part 1 and the Percorso lists the parts in the lesson step's place.
    await openExam(page);
    await expect(nowHeading(page)).toHaveText("Intorni e distanza");
    await expect(page.locator(".px-exam-now p")).toHaveText(/^Parte 1 di 4 · Funzioni di più variabili · circa \d+ minuti$/);
    await expect(page.getByText("Lezione in 4 parti e un ripasso")).toBeVisible();
    await expect(steps.getByRole("button", { name: /^Lezione/ })).toHaveCount(0);

    // No AI tool: the next topic's old lesson shows as it was with the engine's notice, and its recap still finishes it.
    const write = db();
    write.exec("DELETE FROM feature_engines");
    write.close();
    await openLesson(page, "t-serie");
    await expect(page.getByText(/^Non sono riuscito a riscrivere la lezione in parti\. .*com'era\. \S/)).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText("Un intorno di un punto è una palla aperta", { exact: false })).toBeVisible();
    await expect(page.getByRole("button", { name: "Riprova", exact: true })).toBeVisible();
    await expectNoAxeViolations(page);
    await saveShot(page, "old-lessons/rewrite-no-engine-it-light.png");
    const recap = page.getByRole("region", { name: "Ripasso finale" });
    for (let n = 0; n < 3; n++)
      await recap.getByRole("group", { name: "Opzioni" }).nth(n).getByRole("button", { name: /Giusta/ }).click();
    await expect(page.getByText("Lezione completata")).toBeVisible();
    expect(await lessonSteps(page, "t-serie")).toMatchObject([{ itemId: "before-parts-t-serie" }]);
  } finally {
    await close();
  }
});

test("a finished old lesson opens as it was, and Riscrivi in parti asks first, can be cancelled, and keeps the lesson done", async () => {
  test.setTimeout(240_000);
  const holdDir = mkdtempSync(join(tmpdir(), "pyxis-old-hold-"));
  // Part 1's reply waits for this file, so the test reads the earlier version while the rewrite has no part.
  const hold = join(holdDir, "part-1");
  const { page, prompts, close } = await start(
    { lessonParts: outline, markdown: [{ markdown: partText("Intorni"), hold }, { markdown: partText("Frontiera") }] },
    (seeding) =>
      seedLessonBeforeParts(seeding, "p-an2", ["t-funzioni"], { markdown: oldText, wording: "balanced", finished: true }),
  );
  try {
    // Before: the lesson is done, so the exam page suggests something else, and the path shows the step as read.
    await openExam(page);
    const suggested = await nowHeading(page).innerText();
    expect(suggested).not.toBe("Lezione: Funzioni di più variabili");
    const steps = page.getByRole("list", { name: "Passi di Funzioni di più variabili" });
    await expect(steps.getByRole("button", { name: "Lezione, letto" })).toBeVisible();
    await saveShot(page, "old-lessons/finished-exam-before-it-light.png");

    // It opens as it was, in the reader that came before parts, and nothing is written.
    await openLesson(page);
    await expect(page.getByText("Un intorno di un punto è una palla aperta", { exact: false })).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText("Lezione completata")).toBeVisible();
    expect(sent(prompts)).toEqual([]);

    // Its menu has Riscrivi in parti above Riscrivi.
    await page.getByRole("button", { name: "Altre azioni" }).click();
    await expect(page.getByRole("menuitem")).toHaveText(["Riscrivi in parti", "Riscrivi", "Riscrivi una sezione", "Mappa", "Esporta"]);
    await animationsSettled(page);
    await saveShot(page, "old-lessons/finished-menu-it-light.png");
    await page.keyboard.press("Escape");
    // The same menu in the other language and theme, at both widths.
    for (const [lang, theme, width] of [["it", "dark", 960], ["en", "light", 1280]] as const) {
      await page.evaluate(
        async ({ lang, theme }) => {
          localStorage.setItem("pyxis.lang", lang);
          await window.pyxis.setAppearance(theme);
        },
        { lang, theme },
      );
      await page.setViewportSize({ width, height: 800 });
      await page.reload();
      const more = page.getByRole("button", { name: /^(Altre azioni|More actions)$/ });
      await atRest(more);
      await more.click();
      await expect(page.getByRole("menuitem").first()).toHaveText(lang === "it" ? "Riscrivi in parti" : "Rewrite in parts");
      await animationsSettled(page);
      await saveShot(page, `old-lessons/finished-menu-${lang}-${theme}-${width}.png`);
      await page.keyboard.press("Escape");
    }
    await page.evaluate(async () => {
      localStorage.setItem("pyxis.lang", "it");
      await window.pyxis.setAppearance("light");
    });
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.reload();
    await expect(page.getByText("Un intorno di un punto è una palla aperta", { exact: false })).toBeVisible();
    await atRest(page.getByRole("button", { name: "Altre azioni" }));
    await page.getByRole("button", { name: "Altre azioni" }).click();

    // It asks first; Annulla leaves everything as it was.
    await page.getByRole("menuitem", { name: "Riscrivi in parti" }).click();
    const dialog = page.getByRole("dialog", { name: "Riscrivere la lezione in parti brevi?" });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("Pyxis divide il capitolo in parti brevi e scrive la prima adesso, le altre mentre leggi.");
    await expect(dialog).toContainText("la lezione resta completata");
    await animationsSettled(page);
    await expectNoAxeViolations(page);
    await saveShot(page, "old-lessons/rewrite-confirm-it-light.png");
    await dialog.getByRole("button", { name: "Annulla" }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByText("Un intorno di un punto è una palla aperta", { exact: false })).toBeVisible();
    expect(await partJobs(page)).toBe(0);
    expect(sent(prompts)).toEqual([]);

    // Then yes: the same working state, then part 1.
    await page.getByRole("button", { name: "Altre azioni" }).click();
    await page.getByRole("menuitem", { name: "Riscrivi in parti" }).click();
    await dialog.getByRole("button", { name: "Riscrivi in parti" }).click();
    await expect(page).toHaveURL(/\/lesson\/t-funzioni\?part=1$/);
    await expect(working(page, "Sto riscrivendo la lezione in parti brevi")).toBeVisible();
    // The plan is saved and part 1 is being written. The version the rewrite keeps opens read-only: no Livello, no
    // rewrite in its menu, and the way back to the parts.
    await expect(parts(page).getByRole("link")).toHaveCount(5, { timeout: 20_000 });
    await page.getByRole("button", { name: "Leggi la versione di prima" }).click();
    await expect(page).toHaveURL(/\?item=before-parts-t-funzioni$/);
    await expect(page.getByText("Questa è la versione di prima della lezione, così com'era.", { exact: false })).toBeVisible();
    await expect(page.getByText("Un intorno di un punto è una palla aperta", { exact: false })).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole("button", { name: /^Livello/ })).toHaveCount(0);
    await page.getByRole("button", { name: "Altre azioni" }).click();
    await expect(page.getByRole("menuitem")).toHaveText(["Mappa", "Esporta"]);
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Torna alle parti" }).click();
    await expect(working(page, "Sto riscrivendo la lezione in parti brevi")).toBeVisible();
    writeFileSync(hold, "");
    await expect(page.getByText("Intorni: l'idea")).toBeVisible({ timeout: 20_000 });
    await expect(parts(page).getByRole("link", { name: /letta/ })).toHaveCount(0);

    // After: the lesson is still done, once; the exam page suggests what it did before; the path keeps the step read
    // beside the parts, and the topic's line is not the line of a lesson half read.
    expect(await lessonSteps(page)).toMatchObject([{ itemId: "before-parts-t-funzioni" }]);
    await openExam(page);
    await expect(nowHeading(page)).toHaveText(suggested);
    await expect(steps.getByRole("button", { name: "Lezione, letto" })).toBeVisible();
    await expect(page.getByText("Lezione in 4 parti e un ripasso")).toBeVisible();
    await expect(page.locator(".px-xpath-row.is-open .px-xpath-sub")).not.toContainText("lette");
    await saveShot(page, "old-lessons/finished-exam-after-it-light.png");
    // The done step reopens the version the student finished.
    await steps.getByRole("button", { name: "Lezione, letto" }).click();
    await expect(page).toHaveURL(/\?item=before-parts-t-funzioni$/);
    await expect(page.getByText("Questa è la versione di prima della lezione, così com'era.", { exact: false })).toBeVisible();
  } finally {
    await close();
    rmSync(holdDir, { recursive: true, force: true });
  }
});

test("the old reader shows the lesson the address names, also when the address moves to another one of the topic", async () => {
  test.setTimeout(240_000);
  const shorter = "Una versione più breve della lezione sugli intorni, scritta a un altro livello.";
  const { page, close } = await start({ lessonParts: outline, markdown: [] }, (seeding) => {
    seedLessonBeforeParts(seeding, "p-an2", ["t-funzioni"], { markdown: oldText, wording: "balanced", finished: true });
    // A second lesson of the topic written before parts, at another level, that no step names.
    seeding
      .prepare(
        `INSERT INTO items(id,plan_id,topic_id,kind,body_json,engine_provider,prompt_template,prompt_version,grounding,created_at)
         VALUES('before-parts-shorter','p-an2','t-funzioni','lesson',?,'fixture','lesson.write','1','sources',0)`,
      )
      .run(JSON.stringify({ cacheKey: "shorter", markdown: `## Intorni, in breve\n\n${shorter}`, passageIds: [] }));
  });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const go = (item: string) =>
    page.evaluate((hash) => {
      location.hash = hash;
    }, `/plans/p-an2/lesson/t-funzioni?item=${item}`);
  const first = page.getByText("Un intorno di un punto è una palla aperta", { exact: false });
  const second = page.getByText(shorter, { exact: false });
  try {
    // The step's lesson, then its other version through the address: same page, same instance, other text.
    await go("before-parts-t-funzioni");
    await expect(first).toBeVisible({ timeout: 20_000 });
    await go("before-parts-shorter");
    await expect(second).toBeVisible({ timeout: 20_000 });
    await expect(first).toHaveCount(0);
    // And back again, with Indietro.
    await page.goBack();
    await expect(first).toBeVisible({ timeout: 20_000 });
    await expect(second).toHaveCount(0);
    expect(errors).toEqual([]);
  } finally {
    await close();
  }
});
