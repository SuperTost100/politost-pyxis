import { expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { launchPyxis, setUp } from "./app-under-test";
import { expectNoAxeViolations } from "./axe";
import { removeTestFolder } from "./cleanup";
import { fromChiediToExams } from "./doors";
import type Database from "better-sqlite3";
import { partMarkdown, seedOutline } from "../../src/core/study/test-parts";
import { seedPlan, seedSource } from "./seed";
import { SHOTS, saveShot } from "./shots";

/** Eight questions on «Cinematica», handed in an hour ago: right, wrong, half right, "Non lo so" and one reported. */
const questions = [
  { id: "q1", stem: "Un ciclista percorre 6 km in 15 minuti. Qual è la sua velocità media in km/h?", options: ["24 km/h", "12 km/h", "40 km/h", "90 km/h"], answer: { kind: "mcq", correct: 0, picked: -1 } },
  { id: "q2", stem: "Un sasso lanciato verso l'alto con $v_0 = 12\\,m/s$ ricade nel punto di partenza dopo 2,4 s. Quanto vale lo spostamento complessivo?", options: ["0 m", "14,7 m", "7,35 m", "29,4 m"], answer: { kind: "mcq", correct: 0, picked: -1 } },
  { id: "q3", stem: "Un'auto parte da ferma e accelera con $a = 2\\,m/s^2$. Quanta strada percorre nei primi 5 secondi?", options: ["10 m", "25 m", "50 m", "5 m"], answer: { kind: "mcq", correct: 1, picked: -1 } },
  { id: "q4", stem: "Dal grafico di $v(t) = 3t^2 - 2t$, sapendo che a $t = 0$ il punto è in $x = 1\\,m$, scrivi la legge oraria $x(t)$.", answer: { kind: "open", answer: "", reference: "$x(t) = t^3 - t^2 + 1$" } },
  { id: "q5", stem: "Se $x(t) = 4t^2 + 3t$, quanto vale l'accelerazione?", options: ["$8\\,m/s^2$", "$4\\,m/s^2$", "$3\\,m/s^2$", "$11\\,m/s^2$"], answer: { kind: "mcq", correct: 0, picked: -1 } },
  { id: "q6", stem: "Un punto si muove verso l'origine partendo da $x = 5\\,m$. La sua velocità è negativa.", answer: { kind: "tf", correct: true, picked: false } },
  { id: "q7", stem: "La velocità scende in linea retta da 4 m/s a $t = 0$ fino a −4 m/s a $t = 4\\,s$. Quanta strada percorre il punto in totale?", options: ["0 m", "8 m", "16 m", "4 m"], answer: { kind: "mcq", correct: 1, picked: -1 } },
  { id: "q8", stem: "In quale unità del Sistema Internazionale si misura l'accelerazione?", options: ["$m/s^2$", "$m/s$", "$N$", "$J$"], answer: { kind: "mcq", correct: 0, picked: -1 } },
].map((question) => ({ ...question, topicId: "t-kin", sourceIds: ["s-pass"] }));

const picks = { q1: "0", q2: "1", q3: "1", q4: "$x(t) = t^3 - t^2$", q5: "0", q6: "", q7: "0", q8: "0" };
const results = [
  { id: "q1", score: 1, expected: "24 km/h", explanation: "6 km in un quarto d'ora sono 24 km in un'ora." },
  { id: "q2", score: 0, expected: "0 m", explanation: "Hai calcolato la distanza percorsa. Lo spostamento somma i tratti con il segno: il sasso torna dove è partito [P1]." },
  { id: "q3", score: 1, expected: "25 m", explanation: "$x = \\tfrac12 a t^2 = 25\\,m$." },
  { id: "q4", score: 0.5, expected: "$x(t) = t^3 - t^2 + 1$", explanation: "L'integrale è giusto, ma manca la posizione iniziale $x_0 = 1\\,m$.", provider: "claude", model: "claude-sonnet-5" },
  { id: "q5", score: 1, expected: "$8\\,m/s^2$", explanation: "La derivata seconda è 8." },
  { id: "q6", score: 0, expected: "true", explanation: "Verso l'origine la coordinata diminuisce." },
  { id: "q7", score: 0, expected: "8 m", explanation: "Le due aree si sommano senza segno, 4 m + 4 m." },
  { id: "q8", score: 1, expected: "$m/s^2$", explanation: "Metri al secondo quadrato.", flagged: true },
];

function seed(db: DatabaseSync) {
  const at = Date.now() - 3_600_000;
  db.prepare("INSERT INTO subjects(id,name,position,created_at) VALUES('sub-fis','Fisica',0,1)").run();
  seedSource(db, {
    id: "s-book",
    title: "Mazzoldi",
    document: { id: "s-doc" },
    passages: [
      {
        id: "s-pass",
        text: "Lo spostamento è la differenza tra la posizione finale e quella iniziale.",
        locator: { page: 35 },
        section: "Cinematica",
      },
    ],
  });
  seedPlan(db, {
    id: "p-fis",
    subjectId: "sub-fis",
    title: "Fisica I",
    language: "it",
    target: 0.75,
    sourceIds: ["s-book"],
    topics: [
      { id: "t-kin", title: "Cinematica" },
      { id: "t-din", title: "Dinamica" },
    ],
  });
  db.prepare(
    "INSERT INTO items(id,plan_id,topic_id,kind,body_json,engine_provider,grounding,created_at) VALUES('i-quiz','p-fis','t-kin','quiz',?,'fixture','sources',?)",
  ).run(JSON.stringify({ questions, config: { count: 8, feedback: true, types: ["mcq"] }, complete: true }), at);
  db.prepare("INSERT INTO attempts(id,plan_id,item_id,started_at,submitted_at) VALUES('a-quiz','p-fis','i-quiz',?,?)").run(
    at - 600_000,
    at,
  );
  db.prepare("INSERT INTO attempt_answers(id,attempt_id,payload_json,created_at) VALUES('a-quiz-answers','a-quiz',?,?)").run(
    JSON.stringify({ picks, score: 4.5 / 7, results }),
    at,
  );
  const event = db.prepare(
    "INSERT INTO learning_events(id,kind,plan_id,topic_id,payload_json,created_at) VALUES(?,'answer_given','p-fis','t-kin',?,?)",
  );
  event.run("e-before", '{"score":0.5,"scores":[0.5,0.5]}', at - 86_400_000);
  event.run("e-quiz", JSON.stringify({ attemptId: "a-quiz", score: 4.5 / 7, scores: [1, 0, 1, 0.5, 1, 0, 0], evidenceKind: "quiz" }), at);
  db.prepare(
    "INSERT INTO gaps(id,plan_id,topic_id,opened_at,origin,misconception,severity) VALUES('g-1','p-fis','t-kin',?,'misconception',?,'severe')",
  ).run(at, "Le due risposte sbagliate nascono dallo stesso punto: confondi lo spostamento con la distanza percorsa.");
  db.prepare("INSERT INTO gap_answers(gap_id,attempt_id,question_id) VALUES('g-1','a-quiz','q2'),('g-1','a-quiz','q7')").run();
}

async function launch(env: Record<string, string> = {}) {
  const userData = mkdtempSync(join(tmpdir(), "pyxis-quiz-results-"));
  const app = await launchPyxis({ userData, env });
  return setUp(app, userData, async () => {
    const page = await app.firstWindow();
    await page.getByRole("button", { name: "Salta" }).click();
    await fromChiediToExams(page);
    await page.evaluate(() => window.pyxis.invoke("plans.list", {}));
    const db = new DatabaseSync(join(userData, "workspace", "pyxis.db"), { timeout: 10000 });
    seed(db);
    db.close();
    return {
      app,
      page,
      userData,
      done: async () => {
        await app.close();
        removeTestFolder(userData);
      },
    };
  });
}

async function open(page: Page) {
  await page.evaluate(() => {
    location.hash = "/plans/p-fis/quiz/t-kin?attempt=a-quiz";
  });
  await expect(page.locator(".px-res-title")).toBeVisible();
}

const rows = (page: Page) => page.locator(".px-res-q");

test("results list every question in order, right ones folded in green, the others open with the right answer", async () => {
  test.setTimeout(120_000);
  const { page, done } = await launch();
  try {
    await page.setViewportSize({ width: 1280, height: 800 });
    await open(page);
    // The grade is the title, in words; the tally, the topic that moved and what changes in the path follow.
    await expect(page.locator(".px-studybar-title b, .px-studybar-title h1")).toHaveText("Cinematica");
    await expect(page.locator(".px-studybar-title p")).toHaveText("Quiz · Risultati");
    // The attempt is over, so the bar has no progress line under it.
    await expect(page.locator(".px-studybar-progress")).toHaveCount(0);
    await expect(page.locator(".px-res-title")).toHaveText(/^Hai preso \d+(,\d)?\/30$/);
    await expect(page.locator(".px-res-headline")).toContainText("3 giuste, 1 a metà, 3 sbagliate. 1 domanda esclusa.");
    await expect(page.locator(".px-res-rises")).toContainText(/^Cinematica sale da \d+\/30 a \d+\/30$/);
    const changes = page.locator(".px-res-changes");
    await expect(changes).toContainText("confondi lo spostamento con la distanza percorsa");
    await expect(changes).toContainText("Nuovo passo: rivedi gli errori");
    await expectNoAxeViolations(page);

    // Every question, in the order it was asked.
    await expect(page.getByRole("heading", { name: "Le 8 domande" })).toBeVisible();
    await expect(rows(page)).toHaveCount(8);
    await expect(rows(page).locator(".px-res-n")).toHaveText(["1", "2", "3", "4", "5", "6", "7", "8"]);
    // Right: one folded line with the quiet green "Giusta · 1/1"; it opens on the student's answer.
    const first = rows(page).nth(0);
    await expect(first).toHaveClass(/is-correct/);
    await expect(first.locator(".px-res-st")).toHaveText("Giusta · 1/1");
    expect(
      await first.locator(".px-res-st").evaluate((element) => {
        const probe = document.createElement("span");
        probe.style.color = "var(--ok)";
        document.body.append(probe);
        const same = getComputedStyle(probe).color === getComputedStyle(element).color;
        probe.remove();
        return same;
      }),
    ).toBe(true);
    const head = first.locator(".px-res-q-head");
    await expect(head).toHaveAttribute("aria-expanded", "false");
    await head.click();
    await expect(head).toHaveAttribute("aria-expanded", "true");
    await expect(first.locator(".px-res-answer.is-yours")).toContainText("24 km/h");
    // Wrong: open, with the student's answer, the right one in green and the explanation with its source.
    const second = rows(page).nth(1);
    await expect(second.locator(".px-res-st")).toHaveText("Sbagliata · 0/1");
    await expect(second.locator(".px-res-answer.is-yours")).toContainText("14,7 m");
    await expect(second.locator(".px-res-answer.is-expected")).toContainText("0 m");
    await expect(second.locator(".px-res-why")).toContainText("Hai calcolato la distanza percorsa.");
    await expect(second.getByRole("button", { name: "Crea una flashcard" })).toBeVisible();
    // The explanation's source opens the source panel at the cited passage, beside the results; Escape gives the focus
    // back to the citation.
    const cite = second.locator(".px-res-why .px-cite");
    await cite.click();
    const sourcePanel = page.locator("aside.source-panel");
    await expect(sourcePanel.locator(".source-viewer-paragraph.is-current")).toContainText(
      "Lo spostamento è la differenza tra la posizione finale e quella iniziale.",
    );
    await page.keyboard.press("Escape");
    await expect(sourcePanel).toHaveCount(0);
    await expect(cite).toBeFocused();
    // Half right, graded by the AI tool, and a "Non lo so".
    await expect(rows(page).nth(3).locator(".px-res-st")).toHaveText("A metà · 0,5/1");
    await expect(rows(page).nth(3)).toContainText("Valutata da");
    await expect(rows(page).nth(5).locator(".px-res-st")).toHaveText("Non lo so · 0/1");
    await expect(rows(page).nth(5).locator(".px-res-answer-empty")).toHaveText("Non lo so");
    await expect(rows(page).nth(5).locator(".px-res-answer.is-expected")).toContainText("Vero");
    // The reported one says it is left out of the score.
    await expect(rows(page).nth(7)).toContainText("Esclusa dal punteggio");
    await shoot(page, "results");
    await saveShot(page, "quiz-results/results-it-light.png", { animations: "disabled" });

    // Rivedi gli errori drills the gap this quiz opened, from the exam's path.
    await expect(page.locator(".px-res .ant-btn-primary")).toHaveCount(1);
    await expect(page.locator(".px-res .ant-btn-primary")).toHaveText("Rivedi i 4 errori");
    // Going to the exam is the quiet second action, between the step and the ghost button.
    await expect(page.getByRole("button", { name: "Torna all'esame", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Rifai solo le 4 da rivedere" })).toBeVisible();
    await page.getByRole("button", { name: "Rivedi i 4 errori", exact: true }).click();
    // The drill is prepared where the student is: the results stay, with no detour through the exam page.
    // This workspace has no model to write it, so the drill stops with its notice, and the results are still the page.
    await page.waitForTimeout(1000);
    await expect(page).toHaveURL(/#\/plans\/p-fis\/quiz\/t-kin\?attempt=a-quiz$/);
    await expect(page.locator(".px-res-title")).toBeVisible();
    // Its wrong answers can also be asked again on their own.
    await page.getByRole("button", { name: "Rifai solo le 4 da rivedere" }).click();
    await expect(page).toHaveURL(/#\/plans\/p-fis\/review\?from=a-quiz$/);
  } finally {
    await done();
  }
});

test("the next steps wait for the read that decides them, and stay once they are shown", async () => {
  test.setTimeout(120_000);
  // What the attempt did to the path (its open gap) comes a moment after the questions; hold it back for 2 seconds.
  const { page, done } = await launch({ PYXIS_E2E_READ_DELAY: "study.attemptOutcome=2000" });
  try {
    await page.setViewportSize({ width: 1280, height: 800 });
    await open(page);
    await expect(rows(page)).toHaveCount(8);
    const actions = page.locator(".px-res-actions");
    // Until the gap is known, Rivedi gli errori would open the wrong answers instead of the gap's drill, so it is not
    // offered yet: the place of both buttons is held by a placeholder.
    await expect(actions).toHaveAttribute("aria-busy", "true");
    await expect(page.getByRole("button", { name: /^Rivedi (l'errore|i \d+ errori)$/ })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /^Rifai solo le/ })).toHaveCount(0);
    // Once the read is in, both buttons are there, and from then on none of them is removed or relabelled.
    const targeted = page.getByRole("button", { name: /^Rivedi (l'errore|i \d+ errori)$/ });
    await expect(targeted).toBeVisible({ timeout: 10_000 });
    await expect(actions).not.toHaveAttribute("aria-busy", "true");
    await expect(page.getByRole("button", { name: "Rifai solo le 4 da rivedere" })).toBeVisible();
    const handle = await targeted.elementHandle();
    await page.waitForTimeout(1500);
    expect(await handle!.evaluate((element) => element.isConnected), "Rivedi gli errori stays in the page").toBe(true);
    await expect(page.getByRole("button", { name: "Rifai solo le 4 da rivedere" })).toBeVisible();
    // The first click prepares the gap's drill in place, on the results.
    await targeted.click();
    await page.waitForTimeout(1000);
    await expect(page).toHaveURL(/#\/plans\/p-fis\/quiz\/t-kin\?attempt=a-quiz$/);
    await expect(page.locator(".px-res-title")).toBeVisible();
  } finally {
    await done();
  }
});

test("the change in the path shows a gap's later description without a reload once a question is marked wrong", async () => {
  test.setTimeout(120_000);
  const { page, userData, done } = await launch();
  try {
    await page.setViewportSize({ width: 1280, height: 800 });
    await open(page);
    const changes = page.locator(".px-res-changes");
    await expect(changes).toContainText("confondi lo spostamento con la distanza percorsa");

    // The grading can finish before the gap-insight job has written its reading of the mistake, so the page may have
    // read the gap without it. Writing the reading now stands for the job's end; marking a question wrong recomputes
    // the gaps and makes the page read the outcome again.
    const db = new DatabaseSync(join(userData, "workspace", "pyxis.db"), { timeout: 10000 });
    try {
      db.prepare("UPDATE gaps SET misconception = ?, severity = 'minor' WHERE id = 'g-1'").run(
        "Dopo una seconda lettura: sommi le aree senza tenere conto del segno della velocità.",
      );
    } finally {
      db.close();
    }
    await page.getByRole("button", { name: "Domanda sbagliata?" }).first().click();
    await expect(changes).toContainText("sommi le aree senza tenere conto del segno della velocità");
    await expect(changes).not.toContainText("confondi lo spostamento con la distanza percorsa");
  } finally {
    await done();
  }
});

test("the exam page's cleanup of `?drill=` never lands on the page opened right after it", async () => {
  test.setTimeout(120_000);
  const { page, done } = await launch();
  try {
    await page.setViewportSize({ width: 1280, height: 800 });
    // The results are opened once, so the router already holds their code and can open them again without waiting.
    await open(page);
    // React draws a page first and runs its effects a moment later, and on a slow machine the student can already be on
    // the next page by then. This puts the router's move to the results into that gap: the exam page has been drawn
    // (its `?drill=` is in the address), and its first data request is the moment the page is leaving.
    await page.evaluate(() => {
      const RealAbortController = window.AbortController;
      let armed = false;
      window.AbortController = class extends RealAbortController {
        constructor() {
          super();
          if (!armed) return;
          armed = false;
          history.pushState(null, "", "#/plans/p-fis/quiz/t-kin?attempt=a-quiz");
          dispatchEvent(new PopStateEvent("popstate"));
        }
      };
      const push = history.pushState.bind(history);
      history.pushState = (...args: Parameters<History["pushState"]>) => {
        if (String(args[2]).includes("drill=")) {
          armed = true;
          (window as unknown as { drillPushed?: boolean }).drillPushed = true;
        }
        push(...args);
      };
    });
    // A step of the exam's path asks for a drill in the address, as a link inside the app does: the router moves there.
    await page.evaluate(() => {
      const node = document.querySelector("main") ?? document.body;
      const key = Object.keys(node).find((name) => name.startsWith("__reactFiber$"))!;
      type Fiber = { return: Fiber | null; memoizedProps?: { router?: { navigate: (to: string) => Promise<void> } } };
      let fiber = (node as unknown as Record<string, Fiber>)[key] ?? null;
      while (fiber && !fiber.memoizedProps?.router?.navigate) fiber = fiber.return;
      void fiber!.memoizedProps!.router!.navigate("/plans/p-fis?drill=t-kin");
    });
    await expect(page.locator(".px-res-title")).toBeVisible();
    // Give a late cleanup time to land. It would drop `?attempt=` and show the intro of a new quiz in place of the results.
    await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 1000)));
    await expect(page).toHaveURL(/#\/plans\/p-fis\/quiz\/t-kin\?attempt=a-quiz$/);
    await expect(page.locator(".px-res-title")).toBeVisible();
    // The race was set up: the exam page's request did go through the address.
    expect(await page.evaluate(() => (window as unknown as { drillPushed?: boolean }).drillPushed)).toBe(true);
  } finally {
    await done();
  }
});

test("a redo with an open gap offers the Rivedi gli errori its summary announces, and the exam as the quiet second action", async () => {
  test.setTimeout(120_000);
  const { page, done } = await launch();
  try {
    await page.setViewportSize({ width: 1280, height: 800 });
    // The mistakes notebook asks the questions again as a redo, which has no wrong answers to ask a third time.
    await page.evaluate(() => {
      location.hash = "/plans/p-fis/redo?attempt=a-quiz";
    });
    await expect(page.locator(".px-res-title")).toBeVisible();
    await expect(page.locator(".px-res-changes")).toContainText("Nuovo passo: rivedi gli errori");
    await expect(page.getByRole("button", { name: /^Rifai solo le \d+ da rivedere$/ })).toHaveCount(0);
    // The announced step is the one primary action, and going to the exam sits under it as a secondary one.
    await expect(page.locator(".px-res .ant-btn-primary")).toHaveCount(1);
    await expect(page.locator(".px-res .ant-btn-primary")).toHaveText("Rivedi gli errori");
    await expect(page.getByRole("button", { name: "Torna all'esame", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Continua", exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "Rivedi gli errori", exact: true }).click();
    // The drill is prepared on this page: it stays, with the button at work.
    await page.waitForTimeout(1000);
    await expect(page).toHaveURL(/#\/plans\/p-fis\/redo\?attempt=a-quiz$/);
    await expect(page.locator(".px-res-title")).toBeVisible();
  } finally {
    await done();
  }
});

test("the end of a lesson offers the quiz of its topic, with its size once the quiz exists", async () => {
  test.setTimeout(120_000);
  const { page, userData, done } = await launch();
  try {
    await page.setViewportSize({ width: 1280, height: 832 });
    const at = Date.now();
    const db = new DatabaseSync(join(userData, "workspace", "pyxis.db"), { timeout: 10000 });
    // Cinematica is read and well known except for what the plan still asks: its quiz is what comes after its lesson.
    db.exec(
      "DELETE FROM gap_answers; DELETE FROM gaps; DELETE FROM attempt_answers; DELETE FROM attempts; DELETE FROM learning_events; DELETE FROM items;",
    );
    seedOutline(db as unknown as Database.Database, {
      planId: "p-fis",
      topicId: "t-kin",
      parts: [{ title: "Cinematica del punto", minutes: 8, markdown: partMarkdown("Cinematica del punto") }],
    });
    const event = db.prepare(
      "INSERT INTO learning_events(id,kind,plan_id,topic_id,payload_json,created_at) VALUES(?,'answer_given','p-fis',?,?,?)",
    );
    for (const [i, topic] of ["t-din", "t-din", "t-kin"].entries())
      event.run(`e-${i}`, topic, JSON.stringify({ score: 1, scores: [1, 1, 1, 1], evidenceKind: "quiz" }), at - 3_600_000 * (i + 1));
    db.close();
    await page.evaluate(() => window.pyxis.invoke("plans.complete", { planId: "p-fis", activity: "lesson", topicId: "t-din" }));
    const endOfLesson = async () => {
      await page.evaluate(() => {
        location.hash = "/plans/p-fis/lesson/t-kin?part=1";
      });
      await expect(page.locator(".px-part-foot")).toBeVisible();
      if (!(await page.locator(".px-part-foot.is-active").count())) {
        await page.getByRole("group", { name: "Opzioni" }).getByRole("button").first().click();
        await expect(page.locator(".px-part-foot.is-active")).toBeVisible();
      }
    };
    await endOfLesson();
    // The exercises came after the lesson, so the quiz is the step that follows.
    await page.evaluate(() => window.pyxis.invoke("plans.complete", { planId: "p-fis", activity: "practice", topicId: "t-kin" }));
    await page.reload();
    const quiz = page.getByRole("button", { name: /^Fai il quiz/ });
    await expect(quiz).toBeVisible();
    // No quiz exists yet, so there is no size to say.
    await expect(quiz).toHaveText("Fai il quiz");
    await expect(page.getByRole("button", { name: "Torna all'esame", exact: true })).toBeVisible();
    // A quiz started and left, written in full: its size is said beside the button.
    const again = new DatabaseSync(join(userData, "workspace", "pyxis.db"), { timeout: 10000 });
    again
      .prepare(
        "INSERT INTO items(id,plan_id,topic_id,kind,body_json,engine_provider,grounding,created_at) VALUES('i-open','p-fis','t-kin','quiz',?,'fixture','sources',?)",
      )
      .run(JSON.stringify({ questions, config: { count: 8, feedback: true, types: ["mcq"] }, complete: true }), at);
    again.prepare("INSERT INTO attempts(id,plan_id,item_id,started_at) VALUES('a-open','p-fis','i-open',?)").run(at);
    again.close();
    await page.reload();
    await expect(page.getByRole("button", { name: /^Fai il quiz/ })).toHaveText(/^Fai il quiz\s*8 domande$/);
  } finally {
    await done();
  }
});

test("the end of a lesson opened without the plan's diagnostic does not offer it as the next step", async () => {
  test.setTimeout(120_000);
  const { page, userData, done } = await launch();
  try {
    await page.setViewportSize({ width: 1280, height: 832 });
    // A plan nothing was studied in, which would still start with its diagnostic; the student opens a lesson instead.
    const db = new DatabaseSync(join(userData, "workspace", "pyxis.db"), { timeout: 10000 });
    db.exec(
      "DELETE FROM gap_answers; DELETE FROM gaps; DELETE FROM attempt_answers; DELETE FROM attempts; DELETE FROM learning_events; DELETE FROM items;",
    );
    seedOutline(db as unknown as Database.Database, {
      planId: "p-fis",
      topicId: "t-kin",
      parts: [{ title: "Cinematica del punto", minutes: 8, markdown: partMarkdown("Cinematica del punto") }],
    });
    db.close();
    const guide = (await page.evaluate(() => window.pyxis.invoke("plans.recommend", { planId: "p-fis" }))) as {
      next: { activity: string } | null;
    };
    expect(guide.next?.activity).toBe("diagnostic");
    await page.evaluate(() => {
      location.hash = "/plans/p-fis/lesson/t-kin?part=1";
    });
    const foot = page.locator(".px-part-foot");
    await expect(foot).toBeVisible();
    // The diagnostic comes before every lesson: the topic's own exercises follow this one.
    await expect(foot.getByRole("button", { name: /^Continua: / })).toHaveText("Continua: Esercizio assistito");
    await expect(foot).not.toContainText("diagnostico");
    await foot.scrollIntoViewIfNeeded();
    await saveShot(page, "quiz-results/lesson-end-without-diagnostic-it.png", { animations: "disabled" });
    await foot.getByRole("button", { name: /^Continua: / }).click();
    await expect(page).toHaveURL(/#\/plans\/p-fis\/practice\/t-kin$/);
  } finally {
    await done();
  }
});

test("the end of the lesson the plan suggests has the one exam action, with the exam's name, and no other way to leave", async () => {
  test.setTimeout(120_000);
  const { page, userData, done } = await launch();
  try {
    await page.setViewportSize({ width: 1280, height: 832 });
    // Something is studied, and the lesson of Cinematica is what the plan suggests next: no step follows this lesson.
    const db = new DatabaseSync(join(userData, "workspace", "pyxis.db"), { timeout: 10000 });
    db.exec(
      "DELETE FROM gap_answers; DELETE FROM gaps; DELETE FROM attempt_answers; DELETE FROM attempts; DELETE FROM learning_events; DELETE FROM items;",
    );
    seedOutline(db as unknown as Database.Database, {
      planId: "p-fis",
      topicId: "t-kin",
      parts: [{ title: "Cinematica del punto", minutes: 8, markdown: partMarkdown("Cinematica del punto") }],
    });
    db.prepare(
      "INSERT INTO learning_events(id,kind,plan_id,topic_id,payload_json,created_at) VALUES('e-1','answer_given','p-fis','t-din',?,?)",
    ).run(JSON.stringify({ score: 1, scores: [1, 1, 1, 1], evidenceKind: "quiz" }), Date.now() - 3_600_000);
    db.close();
    const guide = (await page.evaluate(() => window.pyxis.invoke("plans.recommend", { planId: "p-fis" }))) as {
      next: { activity: string; topicId: string | null } | null;
    };
    expect(guide.next).toMatchObject({ activity: "lesson", topicId: "t-kin" });
    await page.evaluate(() => {
      location.hash = "/plans/p-fis/lesson/t-kin?part=1";
    });
    const foot = page.locator(".px-part-foot");
    await expect(foot).toBeVisible();
    // One button goes to the exam, named for it; the old "Torna al percorso" and "Per oggi basta" would be a second one.
    await expect(foot.getByRole("button", { name: "Torna all'esame", exact: true })).toHaveCount(1);
    await expect(foot.getByRole("button", { name: "Torna all'esame", exact: true })).toHaveClass(/px-btn/);
    await expect(foot.getByRole("button", { name: "Torna al percorso" })).toHaveCount(0);
    await expect(foot.getByRole("button", { name: "Per oggi basta" })).toHaveCount(0);
    await expect(foot.getByRole("button", { name: /^Continua/ })).toHaveCount(0);
    await foot.getByRole("button", { name: "Torna all'esame", exact: true }).click();
    await expect(page).toHaveURL(/#\/plans\/p-fis$/);
  } finally {
    await done();
  }
});

test("a flashcard made from a wrong answer is filed under its topic and its exam's subject, and says what is missing", async () => {
  test.setTimeout(120_000);
  const { page, userData, done } = await launch();
  try {
    await page.setViewportSize({ width: 1280, height: 832 });
    // The exam belongs to no subject, though its files are in one: its cards go with the exam, which has none.
    const db = new DatabaseSync(join(userData, "workspace", "pyxis.db"), { timeout: 10000 });
    db.exec("UPDATE plans SET subject_id = NULL; UPDATE sources SET subject_id = 'sub-fis';");
    db.close();
    await open(page);
    const dialog = page.getByRole("dialog", { name: "Crea flashcard" });
    await page.getByRole("button", { name: "Crea una flashcard" }).first().click();
    await expect(dialog).toBeVisible();
    // The exam and the question's topic are filled in, which is somewhere to file the card: nothing is asked.
    await expect(dialog.getByText("Cinematica", { exact: true })).toBeVisible();
    const needSubject = dialog.getByText("Scegli la materia: senza, le flashcard non hanno dove andare.");
    const needTopic = dialog.getByText("Scegli l'argomento dell'esame per salvarle qui, oppure togli l'esame.");
    const make = dialog.getByRole("button", { name: "Crea flashcard" });
    await expect(needSubject).toHaveCount(0);
    await expect(needTopic).toHaveCount(0);
    await expect(make).toBeEnabled();
    // The exam has no subject, so its cards will have none either, and the dialog says so instead of showing one.
    await expect(dialog.getByText("Questo esame non ha una materia: le flashcard restano nell'esame")).toBeVisible();
    await expect(dialog.locator("#mc-subject").locator("xpath=ancestor::div[contains(@class,'ant-select')][1]")).not.toContainText("Fisica");
    await saveShot(page, "quiz-results/flashcard-dialog-it.png", { animations: "disabled" });
    // Without an exam the card needs a subject, and the dialog says so beside the field.
    await dialog.locator("#mc-plan").click();
    await page.locator(".ant-select-item-option", { hasText: /^Nessun esame$/ }).click();
    await expect(needSubject).toBeVisible();
    await expect(dialog.locator("#mc-subject")).toHaveAttribute("aria-describedby", "mc-subject-need");
    await saveShot(page, "quiz-results/flashcard-dialog-subject-needed-it.png", { animations: "disabled" });
    await expect(make).toBeDisabled();
    await dialog.getByRole("button", { name: "Annulla" }).click();
    await expect(dialog).toBeHidden();
    // An exam that has a subject: it is the card's subject too, since the exam's cards are saved with it.
    const again = new DatabaseSync(join(userData, "workspace", "pyxis.db"), { timeout: 10000 });
    again.exec("UPDATE plans SET subject_id = 'sub-fis';");
    again.close();
    await page.reload();
    await expect(page.locator(".px-res-title")).toBeVisible();
    await page.getByRole("button", { name: "Crea una flashcard" }).first().click();
    await expect(dialog.getByText("Questo esame non ha una materia")).toHaveCount(0);
    await expect(dialog.locator("#mc-subject").locator("xpath=ancestor::div[contains(@class,'ant-select')][1]")).toContainText("Fisica");
    await dialog.locator("#mc-plan").click();
    await page.locator(".ant-select-item-option", { hasText: /^Nessun esame$/ }).click();
    await expect(dialog.locator("#mc-subject").locator("xpath=ancestor::div[contains(@class,'ant-select')][1]")).toContainText("Fisica");
    await expect(needSubject).toHaveCount(0);
    await expect(make).toBeEnabled();
    // The exam again has no topic yet: the dialog says the topic is what is missing, next to that field.
    await dialog.locator("#mc-plan").click();
    await page.locator(".ant-select-item-option", { hasText: /^Fisica I$/ }).click();
    await expect(needTopic).toBeVisible();
    await needTopic.click();
    await saveShot(page, "quiz-results/flashcard-dialog-topic-needed-it.png", { animations: "disabled" });
    await expect(dialog.locator("#mc-topic")).toHaveAttribute("aria-describedby", "mc-topic-need");
    await expect(make).toBeDisabled();
  } finally {
    await done();
  }
});

/** Screenshots for review, in Italian dark and English light at 1280 and 960, when PYXIS_SHOTS is set. */
async function shoot(page: Page, name: string) {
  if (!SHOTS) return;
  for (const [language, theme] of [
    ["it", "dark"],
    ["en", "light"],
  ] as const)
    for (const width of [1280, 960]) {
      await page.evaluate(
        async ({ language, theme }) => {
          localStorage.setItem("pyxis.lang", language);
          await window.pyxis.setAppearance(theme);
        },
        { language, theme },
      );
      await page.reload();
      await page.setViewportSize({ width, height: 800 });
      await expect(page.locator(".px-res-title")).toBeVisible();
      await page.evaluate(() => document.fonts.ready);
      await saveShot(page, `quiz-results/${name}-${language}-${theme}-${width}.png`, { animations: "disabled" });
    }
  await page.evaluate(async () => {
    localStorage.setItem("pyxis.lang", "it");
    await window.pyxis.setAppearance("light");
  });
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.reload();
  await expect(page.locator(".px-res-title")).toBeVisible();
}

/** Sets the window to `width` device pixels at `zoom`, as Ctrl and plus do. */
async function zoomWindow(app: ElectronApplication, page: Page, width: number, zoom: number) {
  await app.evaluate(
    ({ BrowserWindow }, { width, zoom }) => {
      const window = BrowserWindow.getAllWindows()[0]!;
      window.setContentSize(width, 800);
      window.webContents.setZoomFactor(zoom);
    },
    { width, zoom },
  );
  await expect.poll(() => page.evaluate(() => innerWidth)).toBe(Math.round(width / zoom));
}

/** The window's own pixels: Playwright's page screenshot takes CSS pixels, which at 200% zoom are half the window. */
async function shootWindow(app: ElectronApplication, name: string) {
  if (!SHOTS) return;
  const png = await app.evaluate(async ({ BrowserWindow }) => {
    const image = await BrowserWindow.getAllWindows()[0]!.webContents.capturePage();
    return image.toPNG().toString("base64");
  });
  const path = join(SHOTS, name);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, Buffer.from(png, "base64"));
}

test("the summary goes over the questions when the page is narrow, from its own width", async () => {
  test.setTimeout(120_000);
  const { app, page, done } = await launch();
  try {
    for (const size of [
      { name: "1280", width: 1280, zoom: 1, text: "md", stacked: false },
      { name: "960", width: 960, zoom: 1, text: "md", stacked: false },
      { name: "960-large", width: 960, zoom: 1, text: "lg", stacked: false },
      { name: "960-zoom200", width: 960, zoom: 2, text: "md", stacked: true },
    ] as const) {
      await page.evaluate((textSize) => window.pyxis.invoke("profile.save", { dyslexia: false, textSize }), size.text);
      await zoomWindow(app, page, size.width, size.zoom);
      await page.reload();
      await open(page);
      const summary = (await page.locator(".px-res-summary").boundingBox())!;
      const list = (await page.locator(".px-res-list").boundingBox())!;
      if (size.stacked) expect(summary.y + summary.height, `${size.name}: the summary sits over the questions`).toBeLessThanOrEqual(list.y + 1);
      else expect(list.x, `${size.name}: the questions sit beside the summary`).toBeGreaterThanOrEqual(summary.x + summary.width);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${size.name}: nothing overflows`).toBe(true);
      // The questions keep room for about forty letters of their own size.
      expect(list.width, `${size.name}: the questions are not squeezed`).toBeGreaterThanOrEqual(300);
      await shootWindow(app, `quiz-results/narrow-${size.name}.png`);
    }
  } finally {
    await done();
  }
});
