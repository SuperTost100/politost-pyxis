import { expect, test, type ElectronApplication, type Locator, type Page } from "@playwright/test";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { launchPyxis } from "./app-under-test";
import { expectNoAxeViolations } from "./axe";
import { removeTestFolder } from "./cleanup";
import { fromChiediToExams } from "./doors";
import { seedPlan, seedSource, seedSubjects } from "./seed";
import { saveShot } from "./shots";

/**
 * Open gaps on the exam page and the page "Colma" opens. The gaps are written straight into the workspace the way the
 * analysis leaves them; the drill itself is built by the real job, from recorded model replies.
 */

const EXAM = "Analisi Matematica 2";
const PLAN = "p-an2";
const day = 86_400_000;
const EXPLANATION = "Un punto di frontiera non appartiene per forza all'insieme: guarda gli intorni, non l'insieme.";

type GapSeed = { id: string; topic: string; sentence: string | null; severe: boolean; wrong: number; age?: number };

const TOPICS = [
  { id: "t-fun", title: "Funzioni di più variabili" },
  { id: "t-taylor", title: "Formula di Taylor in più variabili" },
  { id: "t-int", title: "Integrali doppi e tripli" },
  { id: "t-vinc", title: "Massimi e minimi vincolati" },
];

/**
 * Eight gaps with sentences of different lengths, most serious first. The topics' evidence sets the level: Funzioni and
 * Taylor have none (serious), Integrali has two right quizzes (moderate), Massimi has twelve (at the target, so minor).
 */
const EIGHT: GapSeed[] = [
  { id: "g1", topic: "t-fun", severe: true, wrong: 6, sentence: "Confondi i punti di frontiera di un insieme con quelli che gli appartengono." },
  { id: "g2", topic: "t-fun", severe: true, wrong: 5, sentence: "Calcoli le derivate parziali senza controllare che la funzione sia differenziabile nel punto, e poi usi il gradiente come se bastasse." },
  { id: "g3", topic: "t-taylor", severe: true, wrong: 4, sentence: "Nel teorema di Schwarz dimentichi che le derivate seconde devono essere continue." },
  { id: "g4", topic: "t-int", severe: false, wrong: 4, sentence: "Scambi l'ordine di integrazione senza ridisegnare il dominio." },
  { id: "g6", topic: "t-int", severe: false, wrong: 3, sentence: "Dimentichi di cambiare gli estremi quando sostituisci le variabili." },
  { id: "g8", topic: "t-int", severe: false, wrong: 2, sentence: "Nel passaggio a coordinate polari dimentichi lo jacobiano ρ." },
  { id: "g5", topic: "t-vinc", severe: false, wrong: 3, sentence: "Usi i moltiplicatori di Lagrange anche quando il vincolo non è regolare." },
  { id: "g7", topic: "t-vinc", severe: false, wrong: 2, sentence: "Cerchi i massimi sul bordo senza controllare gli angoli del dominio." },
];

function seed(db: DatabaseSync) {
  seedSubjects(db, [{ id: "s-an", name: "Analisi" }]);
  const passages = Array.from({ length: 4 }, (_, i) => ({
    id: `ps-${i + 1}`,
    text: `Un intorno di un punto è un disco aperto centrato nel punto, paragrafo ${i + 1}.`,
    section: "Funzioni di più variabili",
    locator: { page: i + 1 },
  }));
  seedSource(db, { id: "src-an", title: "Bramanti, Pagani, Salsa", subjectId: "s-an", document: { id: "doc-an" }, passages });
  seedPlan(db, { id: PLAN, subjectId: "s-an", title: EXAM, language: "it", target: 0.75, examAt: Date.now() + 40 * day, sourceIds: ["src-an"], topics: TOPICS });
  const link = db.prepare("INSERT INTO topic_passages(topic_id,passage_id) VALUES('t-fun',?)");
  for (const passage of passages) link.run(passage.id);
  // The quiz the wrong answers come from, handed in a week ago.
  const then = Date.now() - 7 * day;
  db.prepare("INSERT INTO items(id,plan_id,topic_id,kind,body_json,engine_provider,model_id,created_at) VALUES('quiz-old',?,'t-fun','quiz',?,'claude','m',?)").run(
    PLAN,
    JSON.stringify({ complete: true, questions: [] }),
    then,
  );
  db.prepare("INSERT INTO attempts(id,plan_id,item_id,started_at,submitted_at) VALUES('a-old',?,'quiz-old',?,?)").run(PLAN, then, then);
  // Older than every gap, so they set the topics' mastery and close nothing.
  const answer = db.prepare("INSERT INTO learning_events(id,kind,plan_id,topic_id,payload_json,created_at) VALUES(?,'answer_given',?,?,?,?)");
  const right = JSON.stringify({ score: 1, scores: [1, 1, 1, 1] });
  for (let i = 0; i < 12; i++) {
    if (i < 2) answer.run(`ev-int-${i}`, PLAN, "t-int", right, Date.now() - (30 - i) * day);
    answer.run(`ev-vinc-${i}`, PLAN, "t-vinc", right, Date.now() - (30 - i) * day);
  }
}

/** The gaps the exam has, as the analysis leaves them: each linked to its wrong answers of the old quiz. */
function setGaps(db: DatabaseSync, gaps: GapSeed[]) {
  db.prepare("DELETE FROM gaps WHERE plan_id = ?").run(PLAN);
  const insert = db.prepare("INSERT INTO gaps(id,plan_id,topic_id,opened_at,misconception,severity) VALUES(?,?,?,?,?,?)");
  const link = db.prepare("INSERT INTO gap_answers(gap_id,attempt_id,question_id) VALUES(?,'a-old',?)");
  for (const gap of gaps) {
    insert.run(gap.id, PLAN, gap.topic, Date.now() - (gap.age ?? 5) * day, gap.sentence, gap.severe ? "severe" : "minor");
    for (let n = 0; n < gap.wrong; n++) link.run(gap.id, `${gap.id}-q${n}`);
  }
}

function drillReply() {
  const kinds = ["mcq", "tf", "completion", "mcq", "tf"];
  return {
    questions: kinds.map((kind, i) => ({
      kind,
      stem: kind === "completion" ? `Completa {{1}} nel caso ${i}.` : `Affermazione ${i} {{question:${i}}}.`,
      ...(kind === "mcq" ? { options: ["Uno", "Due", "Tre", "Quattro"], correct: 0 } : {}),
      ...(kind === "tf" ? { correct: true } : {}),
      ...(kind === "completion" ? { accepted: ["risposta"] } : {}),
      passageIds: ["{{passage:0}}"],
      explanation: "Perché sì.",
    })),
  };
}

type Run = { app: ElectronApplication; page: Page; userData: string; release: string; db: <T>(use: (db: DatabaseSync) => T) => T };

/** One app with one exam and its recorded drill replies; the questions wait for the test to create `release`. */
async function start(extra: object = {}): Promise<Run> {
  const userData = mkdtempSync(join(tmpdir(), "pyxis-exam-gaps-"));
  const release = join(userData, "release-drill");
  const app = await launchPyxis({
    userData,
    env: {
      PYXIS_E2E_PLAN_REPLIES: JSON.stringify({
        markdown: { markdown: "## Ripasso\nUsa le formule [P1]." },
        explanation: { explanation: EXPLANATION },
        quizQuestions: { ...drillReply(), hold: release, ...extra },
      }),
    },
  });
  const page = await app.firstWindow();
  page.setDefaultTimeout(30_000);
  await page.getByRole("button", { name: "Salta" }).click();
  await fromChiediToExams(page);
  const db = <T,>(use: (db: DatabaseSync) => T): T => {
    const handle = new DatabaseSync(join(userData, "workspace", "pyxis.db"), { timeout: 10_000 });
    try {
      return use(handle);
    } finally {
      handle.close();
    }
  };
  db(seed);
  await page.reload();
  return { app, page, userData, release, db };
}

async function stop(run: Run | undefined) {
  await run?.app.close();
  if (run) removeTestFolder(run.userData);
}

const side = (page: Page) => page.getByRole("complementary", { name: /^Flashcard, domande da rifare, lacune aperte/ });
const block = (page: Page) => side(page).locator("section").filter({ has: page.getByRole("heading", { level: 2, name: "Lacune aperte" }) });
const rows = (page: Page) => block(page).locator("li.px-gap");

/** Opens the exam from another page, so its block reads the gaps again as a student coming back does. */
async function openExam(page: Page) {
  await page.evaluate(() => {
    location.hash = "/exams";
  });
  await expect(page).toHaveURL(/#\/exams$/);
  // The exam page is gone before it opens again: the router can take a hash change back before it drew the page.
  await expect(page.locator(".px-exam-aside")).toHaveCount(0);
  await page.evaluate((id) => {
    location.hash = `/plans/${id}`;
  }, PLAN);
  await expect(page.getByRole("heading", { level: 1, name: EXAM })).toBeVisible();
  await expect(block(page)).toBeVisible();
}

const visibleRows = async (rowsOf: Locator) => {
  const all = await rowsOf.all();
  const shown: Locator[] = [];
  for (const row of all) if (await row.isVisible()) shown.push(row);
  return shown;
};

test.describe("the block of open gaps in the exam's side column", () => {
  test.describe.configure({ mode: "serial" });
  let run: Run;
  test.beforeAll(async () => {
    run = await start();
  });
  test.afterAll(async () => stop(run));

  test("with no gap it says Pyxis looks for them in wrong answers, with no count", async () => {
    const { page, db } = run;
    db((handle) => setGaps(handle, []));
    await openExam(page);
    await expect(block(page).getByRole("heading", { level: 2 })).toHaveText("Lacune aperte");
    await expect(block(page)).toContainText("Nessuna lacuna aperta. Pyxis le cerca nelle risposte sbagliate di quiz ed esercizi.");
    await expect(rows(page)).toHaveCount(0);
    await saveShot(side(page), "gaps-none-it.png", { animations: "disabled" });
  });

  test("with one gap it counts it and shows its sentence, its level and its topic", async () => {
    const { page, db } = run;
    db((handle) => setGaps(handle, EIGHT.slice(0, 1)));
    await openExam(page);
    await expect(block(page).getByRole("heading", { level: 2 })).toHaveText("Lacune aperte1 lacuna");
    await expect(rows(page)).toHaveCount(1);
    const row = rows(page).first();
    await expect(row).toContainText(EIGHT[0]!.sentence!);
    // The level is a word, with the topic after it.
    await expect(row.locator(".px-gap-meta")).toHaveText("Seria · Funzioni di più variabili");
    await expect(row.getByRole("button", { name: `Colma: ${EIGHT[0]!.sentence}`, exact: true })).toBeVisible();
    await expect(block(page).getByRole("button", { name: /^Altre|Mostra meno/ })).toHaveCount(0);
    await saveShot(side(page), "gaps-one-it.png", { animations: "disabled" });
  });

  test("with three gaps it shows all three, most serious first", async () => {
    const { page, db } = run;
    db((handle) => setGaps(handle, EIGHT.slice(0, 3)));
    await openExam(page);
    await expect(block(page).getByRole("heading", { level: 2 })).toHaveText("Lacune aperte3 lacune");
    await expect(rows(page)).toHaveCount(3);
    await expect(rows(page).locator(".px-gap-meta")).toHaveText([
      "Seria · Funzioni di più variabili",
      "Seria · Funzioni di più variabili",
      "Seria · Formula di Taylor in più variabili",
    ]);
    await expect(block(page).getByRole("button", { name: /^Altre|Mostra meno/ })).toHaveCount(0);
    await saveShot(side(page), "gaps-three-it.png", { animations: "disabled" });
  });

  test("with eight it shows three and the rest unfold from the button and fold back", async () => {
    const { page, db } = run;
    db((handle) => setGaps(handle, EIGHT));
    await openExam(page);
    await expect(block(page).getByRole("heading", { level: 2 })).toHaveText("Lacune aperte8 lacune");
    const more = block(page).getByRole("button", { name: "Altre 5 lacune", exact: true });
    await expect(more).toHaveAttribute("aria-expanded", "false");
    expect(await visibleRows(rows(page))).toHaveLength(3);
    // The folded rows are out of the tab order too: their buttons cannot be reached.
    await expect(block(page).getByRole("button", { name: /^Colma: Scambi l'ordine/ })).toHaveCount(0);
    await saveShot(side(page), "gaps-eight-folded-it.png", { animations: "disabled" });
    await more.click();
    const less = block(page).getByRole("button", { name: "Mostra meno", exact: true });
    await expect(less).toHaveAttribute("aria-expanded", "true");
    await expect(rows(page).last()).toBeVisible();
    expect(await visibleRows(rows(page))).toHaveLength(8);
    await expect(rows(page).locator(".px-gap-meta")).toHaveText([
      "Seria · Funzioni di più variabili",
      "Seria · Funzioni di più variabili",
      "Seria · Formula di Taylor in più variabili",
      "Media · Integrali doppi e tripli",
      "Media · Integrali doppi e tripli",
      "Media · Integrali doppi e tripli",
      "Lieve · Massimi e minimi vincolati",
      "Lieve · Massimi e minimi vincolati",
    ]);
    await saveShot(side(page), "gaps-eight-open-it.png", { animations: "disabled" });
    await expectNoAxeViolations(page);
    await less.click();
    await expect(more).toHaveAttribute("aria-expanded", "false");
    await expect(rows(page).last()).toBeHidden();
    // The state is the component's own: it folds again once the page is left and opened again.
    await more.click();
    await openExam(page);
    await expect(block(page).getByRole("button", { name: "Altre 5 lacune", exact: true })).toHaveAttribute("aria-expanded", "false");
  });

  test("a gap whose sentence is not written says how many wrong answers it has, and shows the working mark while it is read", async () => {
    const { page, db } = run;
    db((handle) => {
      setGaps(handle, [{ ...EIGHT[0]!, sentence: null, wrong: 4 }, EIGHT[3]!]);
      // The analysis of that topic's answers is running.
      handle
        .prepare("INSERT INTO jobs(id,kind,params_json,state,progress,created_at,updated_at) VALUES('j-insight','gap-insight',?,'running',0,?,?)")
        .run(JSON.stringify({ planId: PLAN, topicId: "t-fun" }), Date.now(), Date.now());
    });
    await openExam(page);
    const first = rows(page).first();
    await expect(first.locator(".px-gap-text")).toContainText("4 risposte sbagliate su questo argomento");
    await expect(first.locator(".px-gap-reading")).toHaveCount(1);
    // The other row has its sentence and no mark.
    await expect(rows(page).nth(1).locator(".px-gap-reading")).toHaveCount(0);
    await expect(first.getByRole("button", { name: "Colma la lacuna su Funzioni di più variabili", exact: true })).toBeVisible();
    await saveShot(side(page), "gaps-unwritten-it.png", { animations: "disabled" });
    // The job ends: the mark goes.
    run.db((handle) => handle.prepare("UPDATE jobs SET state = 'succeeded' WHERE id = 'j-insight'").run());
    await openExam(page);
    await expect(rows(page).first().locator(".px-gap-text")).toContainText("4 risposte sbagliate su questo argomento");
    await expect(rows(page).first().locator(".px-gap-reading")).toHaveCount(0);
  });

  test("a read that fails says so with Riprova, and Riprova reads again", async () => {
    const { page, db } = run;
    db((handle) => setGaps(handle, EIGHT.slice(0, 2)));
    await openExam(page);
    await expect(rows(page)).toHaveCount(2);
    // The gaps are away while the exam opens again: the other reads of the page are still fresh, this one is not.
    db((handle) => handle.exec("ALTER TABLE gaps RENAME TO gaps_away"));
    try {
      await page.evaluate(() => {
        location.hash = "/exams";
      });
      await expect(page).toHaveURL(/#\/exams$/);
      await expect(page.locator(".px-exam-aside")).toHaveCount(0);
      await page.evaluate((id) => {
        location.hash = `/plans/${id}`;
      }, PLAN);
      await expect(block(page)).toContainText("Non riesco a caricarlo.");
    } finally {
      db((handle) => handle.exec("ALTER TABLE gaps_away RENAME TO gaps"));
    }
    await saveShot(side(page), "gaps-failed-it.png", { animations: "disabled" });
    await block(page).getByRole("button", { name: "Riprova", exact: true }).click();
    await expect(rows(page)).toHaveCount(2);
    await expect(block(page)).not.toContainText("Non riesco a caricarlo.");
  });
});

/** Answers the five drill questions right, in the order the recorded reply asks them (a multiple-choice question shuffles its options). */
async function answerDrill(page: Page) {
  const sheet = page.locator(".px-qz-sheet");
  for (let i = 0; i < 5; i++) {
    await expect(page.getByText(`Domanda ${i + 1} di 5`, { exact: true })).toBeVisible();
    if (i === 2) await sheet.getByRole("textbox").fill("risposta");
    else await sheet.getByRole("button", { name: /^[A-D] (Uno|Vero)$/ }).click();
    await page.locator(".px-qz-nav .px-btn-primary").click();
  }
}

const drillJobs = (run: Run) => run.db((handle) => (handle.prepare("SELECT COUNT(*) AS n FROM jobs WHERE kind = 'gap-drill'").get() as { n: number }).n);

test.describe("Colma", () => {
  test.describe.configure({ mode: "serial" });
  let run: Run;
  test.beforeAll(async () => {
    run = await start();
    run.db((handle) => setGaps(handle, [EIGHT[0]!, EIGHT[2]!]));
  });
  test.afterAll(async () => stop(run));

  test("opens the gap's page at once, shows the drill being written in place, and replaces itself with the drill", async () => {
    test.setTimeout(120_000);
    const { page } = run;
    await openExam(page);
    await rows(page).first().getByRole("button", { name: /^Colma: Confondi/ }).click();
    await expect(page).toHaveURL(/#\/plans\/p-an2\/gap\/g1$/);
    // The bar: the way back named by the exam, the topic and the line; the sheet: the gap and its sentence.
    await expect(page.getByRole("button", { name: `Torna a ${EXAM}`, exact: true })).toBeVisible();
    await expect(page.locator(".px-studybar-title")).toContainText("Funzioni di più variabili");
    await expect(page.locator(".px-studybar-title")).toContainText("Colma una lacuna · circa 6 minuti");
    const sheet = page.locator(".px-gp-sheet");
    await expect(sheet.getByRole("heading", { level: 1, name: "Funzioni di più variabili" })).toBeVisible();
    await expect(sheet.getByText("La lacuna", { exact: true })).toBeVisible();
    await expect(sheet.locator(".px-gap-sentence")).toHaveText(EIGHT[0]!.sentence!);
    // The questions are held back: the page shows the working mark with what it is doing, and still lines.
    await expect(sheet.getByRole("status")).toContainText("Preparo una spiegazione breve e 5 domande");
    await expect(sheet.getByRole("status")).toContainText("Parto da 6 risposte sbagliate.");
    await expect(sheet.locator(".px-gp-shape")).toBeVisible();
    await expect(page.locator(".px-studybar-actions > :last-child")).toHaveClass(/px-jobs-button/);
    await saveShot(page, "gap-drill-preparing-it.png", { animations: "disabled" });
    await expectNoAxeViolations(page);
    expect(drillJobs(run)).toBe(1);
    // Going back and forward does not start another drill.
    await page.evaluate(() => window.history.back());
    await expect(page).toHaveURL(/#\/plans\/p-an2$/);
    await page.evaluate(() => window.history.forward());
    await expect(page).toHaveURL(/#\/plans\/p-an2\/gap\/g1$/);
    await expect(sheet.getByRole("status")).toContainText("Preparo una spiegazione breve");
    expect(drillJobs(run)).toBe(1);
    // The drill is ready: the page's entry becomes the quiz, with the same title and line and the gap above the explanation.
    writeFileSync(run.release, "");
    await expect(page).toHaveURL(/#\/plans\/p-an2\/quiz\/t-fun\?attempt=[^&]+&gap=g1$/);
    await expect(page.locator(".px-studybar-title")).toContainText("Funzioni di più variabili");
    await expect(page.locator(".px-studybar-title")).toContainText("Colma una lacuna · circa 6 minuti");
    const card = page.locator(".px-qz-sheet");
    await expect(card.locator(".px-gap-sentence")).toHaveText(EIGHT[0]!.sentence!);
    await expect(card.getByRole("heading", { name: "Prima una breve spiegazione" })).toBeVisible();
    await expect(card.getByText(EXPLANATION)).toBeVisible();
    await saveShot(page, "gap-drill-it.png", { animations: "disabled" });
    expect(drillJobs(run)).toBe(1);
    // One entry: Back from the drill lands on the exam, whose block still lists the gap.
    await page.getByRole("button", { name: `Torna a ${EXAM}`, exact: true }).click();
    await expect(page).toHaveURL(/#\/plans\/p-an2$/);
    await expect(rows(page)).toHaveCount(2);
    await expect(rows(page).first().getByRole("button", { name: /^Colma: Confondi/ })).toBeFocused();
  });

  test("right answers on one day say what closes the gap, and the gap stays in the block", async () => {
    test.setTimeout(120_000);
    const { page } = run;
    await rows(page).first().getByRole("button", { name: /^Colma: Confondi/ }).click();
    await expect(page).toHaveURL(/#\/plans\/p-an2\/quiz\/t-fun\?attempt=[^&]+&gap=g1$/);
    await answerDrill(page);
    await expect(page.locator(".px-res-title")).toHaveText("Hai preso 30/30");
    const end = page.locator(".px-gap-end");
    await expect(end).toHaveText("Risposte giuste. La lacuna si chiude se rispondi giusto anche in un altro giorno.");
    await expect(page.getByText("Lacuna colmata")).toHaveCount(0);
    await saveShot(page, "gap-drill-done-open-it.png", { animations: "disabled" });
    await page.getByRole("button", { name: `Torna a ${EXAM}`, exact: true }).click();
    await expect(page).toHaveURL(/#\/plans\/p-an2$/);
    await expect(block(page).getByText(EIGHT[0]!.sentence!)).toBeVisible();
  });
});

test.describe("Colma, with an earlier day of right answers", () => {
  test.describe.configure({ mode: "serial" });
  let run: Run;
  test.beforeAll(async () => {
    run = await start();
    run.db((handle) => {
      setGaps(handle, [EIGHT[0]!, EIGHT[2]!]);
      // An earlier session, a day ago and after the gap opened, answered every question of the topic right.
      handle
        .prepare("INSERT INTO learning_events(id,kind,plan_id,topic_id,payload_json,created_at) VALUES('ev-prev','answer_given',?,'t-fun',?,?)")
        .run(PLAN, JSON.stringify({ attemptId: "a-old", score: 1, scores: [1, 1, 1] }), Date.now() - day);
    });
    writeFileSync(run.release, "");
  });
  test.afterAll(async () => stop(run));

  test("right answers on a second day close the gap: the end says so, offers the next one, and the block no longer lists it", async () => {
    test.setTimeout(120_000);
    const { page } = run;
    await openExam(page);
    await rows(page).first().getByRole("button", { name: /^Colma: Confondi/ }).click();
    await expect(page).toHaveURL(/#\/plans\/p-an2\/quiz\/t-fun\?attempt=[^&]+&gap=g1$/);
    await answerDrill(page);
    await expect(page.locator(".px-res-title")).toHaveText("Hai preso 30/30");
    const end = page.locator(".px-gap-end");
    await expect(end.getByRole("heading", { name: "Lacuna colmata" })).toBeVisible();
    await expect(end).toContainText("Tornando all'esame non la trovi più tra le lacune aperte.");
    const next = end.getByRole("button", { name: "Colma la prossima: Formula di Taylor in più variabili", exact: true });
    await expect(next).toBeVisible();
    await saveShot(page, "gap-drill-done-closed-it.png", { animations: "disabled" });
    await expectNoAxeViolations(page);
    // "Colma la prossima" opens that gap's page, and back on the exam the closed gap is gone from the block.
    await next.click();
    await expect(page).toHaveURL(/#\/plans\/p-an2\/gap\/g3$/);
    await expect(page.locator(".px-gp-sheet").getByRole("heading", { level: 1, name: "Formula di Taylor in più variabili" })).toBeVisible();
    await openExam(page);
    await expect(block(page).getByRole("heading", { level: 2 })).toHaveText("Lacune aperte1 lacuna");
    await expect(block(page).getByText(EIGHT[0]!.sentence!)).toHaveCount(0);
    await expect(block(page).getByText(EIGHT[2]!.sentence!)).toBeVisible();
  });

  test("a gap that is no longer open says so on its page", async () => {
    const { page } = run;
    await page.evaluate(() => {
      location.hash = "/plans/p-an2/gap/g1";
    });
    await expect(page.getByRole("status").filter({ hasText: "Questa lacuna non è più aperta" })).toBeVisible();
    await expect(page.locator(".px-gp-working")).toHaveCount(0);
  });
});

test("a drill that fails shows the notice with Riprova in place of the working mark", async () => {
  test.setTimeout(120_000);
  const failing = await start({ fail: "engine down" });
  try {
    const { page } = failing;
    failing.db((handle) => setGaps(handle, [EIGHT[0]!]));
    await openExam(page);
    await page.getByRole("button", { name: /^Colma: Confondi/ }).click();
    await expect(page).toHaveURL(/#\/plans\/p-an2\/gap\/g1$/);
    // The questions never come, and the job ends: the page says so where the working mark was.
    writeFileSync(failing.release, "");
    const sheet = page.locator(".px-gp-sheet");
    const alert = sheet.getByRole("alert");
    await expect(alert).toContainText("Non sono riuscito a preparare la spiegazione e le domande.");
    await expect(sheet.locator(".px-gp-working")).toHaveCount(0);
    await expect(sheet.locator(".px-gap-sentence")).toHaveText(EIGHT[0]!.sentence!);
    await saveShot(page, "gap-drill-failed-it.png", { animations: "disabled" });
    const before = drillJobs(failing);
    await alert.getByRole("button", { name: "Riprova", exact: true }).click();
    // A new drill for the same gap is asked for: its job is a second one, and the page shows the notice again when it fails.
    await expect.poll(() => drillJobs(failing)).toBe(before + 1);
    await expect(sheet.getByRole("alert")).toContainText("Non sono riuscito a preparare");
    expect(existsSync(failing.release)).toBe(true);
  } finally {
    await stop(failing);
  }
});
