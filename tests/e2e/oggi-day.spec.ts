import { expect, test, type Page } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { launchPyxis } from "./app-under-test";
import { expectNoAxeViolations } from "./axe";
import { removeTestFolder } from "./cleanup";
import { fromChiediToExams } from "./doors";
import { seedPlan, seedSubjects } from "./seed";
import { SHOTS, saveShot } from "./shots";

const day = 86_400_000;

/** Three dated exams and one without a date, and a subject with flashcards that belong to no exam. */
function seedExams(db: DatabaseSync) {
  const now = Date.now();
  seedSubjects(db, [{ id: "s-phys", name: "Fisica 2" }]);
  const plan = (id: string, title: string, examAt: number | null, topic: string) =>
    seedPlan(db, { id, title, language: "it", target: 0.75, examAt, topics: [{ id: `t-${id}`, title: topic }] });
  plan("p-near", "Analisi Matematica 2", now + 4 * day, "Insiemi aperti e chiusi");
  plan("p-far", "Fisica 2", now + 30 * day, "Legge di Gauss");
  plan("p-none", "Chimica generale", null, "Legami chimici");
}

/** A card with a review at `at` that leaves it due at `dueAt`, and `seconds` for that review when known. */
function reviewedCard(db: DatabaseSync, id: string, owner: { planId: string; topicId: string } | { subjectId: string }, at: number, dueAt: number, seconds: number | null) {
  if ("planId" in owner)
    db.prepare("INSERT INTO cards(id,plan_id,topic_id,front,back,created_at) VALUES(?,?,?,?,?,1)").run(id, owner.planId, owner.topicId, `Fronte ${id}`, "Retro");
  else db.prepare("INSERT INTO cards(id,subject_id,front,back,created_at) VALUES(?,?,?,?,1)").run(id, owner.subjectId, `Fronte ${id}`, "Retro");
  db.prepare("INSERT INTO card_reviews(id,card_id,rating,state_json,reviewed_at,seconds) VALUES(?,?,?,?,?,?)").run(
    `r-${id}`,
    id,
    "good",
    JSON.stringify({ intervalDays: 1, ease: 2.5, dueAt }),
    at,
    seconds,
  );
}

async function openApp() {
  const userData = mkdtempSync(join(tmpdir(), "pyxis-oggi-day-"));
  const app = await launchPyxis({ userData });
  const page = await app.firstWindow();
  await page.getByRole("button", { name: "Salta" }).click();
  await fromChiediToExams(page);
  await page.evaluate(() => window.pyxis.invoke("plans.list", {}));
  const db = new DatabaseSync(join(userData, "workspace", "pyxis.db"));
  seedExams(db);
  return {
    page,
    db,
    async done() {
      db.close();
      await app.close().catch(() => undefined);
      removeTestFolder(userData);
    },
  };
}

/** Lets a spec move the page's clock, so a card seems to have been on screen for as long as it likes. */
async function installClock(page: Page) {
  await page.evaluate(() => {
    const real = Date.now.bind(Date);
    const skew = { ms: 0 };
    (window as unknown as { skew: typeof skew }).skew = skew;
    Date.now = () => real() + skew.ms;
  });
}
const moveClock = (page: Page, ms: number) =>
  page.evaluate((by) => {
    (window as unknown as { skew: { ms: number } }).skew.ms += by;
  }, ms);

const openExam = async (page: Page, planId: string) => {
  await page.evaluate((id) => {
    location.hash = `/plans/${id}`;
  }, planId);
  await expect(page.locator(".px-exam-rings")).toBeVisible();
};
const openExams = async (page: Page) => {
  await page.evaluate(() => {
    location.hash = "/exams";
  });
  await expect(page.getByRole("list", { name: /^(Your exams|I tuoi esami)$/ })).toBeVisible();
};

test("reviewing flashcards moves Oggi on every exam page and in the Esami list, and a card left open counts a minute", async () => {
  test.setTimeout(180_000);
  const { page, db, done } = await openApp();
  try {
    // Two reviews are due on an exam, one on another, two on a subject with no exam.
    db.exec(`
      INSERT INTO cards(id,plan_id,topic_id,front,back,created_at) VALUES
        ('c1','p-near','t-p-near','Prima','a',1), ('c2','p-near','t-p-near','Seconda','b',2),
        ('c3','p-far','t-p-far','Terza','c',3);
      INSERT INTO cards(id,subject_id,front,back,created_at) VALUES
        ('c4','s-phys','Quarta','d',4), ('c5','s-phys','Quinta','e',5);
    `);
    await page.evaluate(() => window.pyxis.invoke("plans.plannerHours", { hours: 7 }));
    await page.evaluate(() => localStorage.setItem("pyxis.lang", "en"));
    await page.reload();
    await openExams(page);

    // Nothing studied: every exam reads the same empty day, even the one with no date.
    const rows = page.getByRole("list", { name: "Your exams" }).getByRole("link");
    await expect(rows).toHaveCount(3);
    for (const index of [0, 1, 2]) {
      await expect(rows.nth(index).getByRole("img")).toHaveAccessibleName(/, Today 0 of 60 min$/);
      await expect(rows.nth(index)).toContainText("Today0 of 60 min");
    }
    await expect(page.locator(".px-exams-row .px-rings-arc.is-today")).toHaveCount(0);
    await expect(page.getByText("You have 5 flashcards to review today")).toBeVisible();

    // Review all five. The page's clock is moved before each rating, so the card seems to have been on screen for
    // 30 seconds, and for the last one ten minutes, which counts one.
    await installClock(page);
    await page.getByRole("button", { name: "Review 5", exact: true }).click();
    await expect(page).toHaveURL(/#\/cards\/due$/);
    for (const [index, minutes] of [0.5, 0.5, 0.5, 0.5, 10].entries()) {
      await expect(page.getByRole("button", { name: /Flip/ })).toBeVisible();
      await moveClock(page, minutes * 60_000);
      await page.getByRole("button", { name: /Flip/ }).click();
      await page.getByRole("button", { name: "Easy", exact: true }).click();
      if (index < 4) await expect(page.getByText(`${index + 2} of 5`).first()).toBeVisible();
    }
    await expect(page.getByText("No flashcards are due.")).toBeVisible();
    // Four reviews of about 30 seconds and one capped at 60: 3 minutes, flashcards with an exam and without one alike.
    const seconds = db.prepare("SELECT seconds FROM card_reviews ORDER BY reviewed_at").all() as Array<{ seconds: number }>;
    expect(seconds).toHaveLength(5);
    for (const [index, row] of seconds.entries()) {
      if (index < 4) expect(row.seconds).toBeGreaterThanOrEqual(30);
      if (index < 4) expect(row.seconds).toBeLessThan(40);
      else expect(row.seconds).toBe(60);
    }

    // The Esami list: the same 3 minutes on every row, in the ring and beside it, and the ring has moved.
    await openExams(page);
    for (const index of [0, 1, 2]) {
      await expect(rows.nth(index).getByRole("img")).toHaveAccessibleName(/, Today 3 of 60 min$/);
      await expect(rows.nth(index)).toContainText("Today3 of 60 min");
      await expect(rows.nth(index).locator(".px-rings-arc.is-today")).toHaveCount(1);
    }
    // Each exam's page says the same.
    for (const planId of ["p-near", "p-far", "p-none"]) {
      await openExam(page, planId);
      await expect(page.locator(".px-exam-rings").getByRole("img")).toHaveAccessibleName(/, Today 3 of 60 min$/);
      await expect(page.getByRole("list", { name: "Exam rings" }).getByRole("listitem").nth(2)).toHaveText(/^Today\s*3 of 60 min$/);
      await expect(page.locator(".px-exam-rings .px-rings-arc.is-today")).toHaveCount(1);
    }
    // The same in Italian.
    await page.evaluate(() => localStorage.setItem("pyxis.lang", "it"));
    await page.reload();
    await expect(page.locator(".px-exam-rings").getByRole("img")).toHaveAccessibleName(/, Oggi 3 di 60 min$/);
  } finally {
    await done();
  }
});

test("a rating is never lost to the time measured: a card open for days, or a clock that went back, is still rated", async () => {
  test.setTimeout(120_000);
  const { page, db, done } = await openApp();
  try {
    db.exec(`INSERT INTO cards(id,plan_id,topic_id,front,back,created_at) VALUES
      ('c1','p-near','t-p-near','Prima','a',1), ('c2','p-near','t-p-near','Seconda','b',2), ('c3','p-near','t-p-near','Terza','c',3);`);
    await page.evaluate(() => window.pyxis.invoke("plans.plannerHours", { hours: 7 }));
    await page.evaluate(() => localStorage.setItem("pyxis.lang", "en"));
    await page.reload();
    await installClock(page);
    await openExams(page);
    await page.getByRole("button", { name: "Review 3", exact: true }).click();
    await expect(page).toHaveURL(/#\/cards\/due$/);
    // The laptop slept for three days with the first card open; the clock then went back an hour on the second; the
    // third is rated after half a minute.
    for (const [index, ms] of [3 * 86_400_000, -3_600_000, 30_000].entries()) {
      await expect(page.getByRole("button", { name: /Flip/ })).toBeVisible();
      await moveClock(page, ms);
      await page.getByRole("button", { name: /Flip/ }).click();
      await page.getByRole("button", { name: "Easy", exact: true }).click();
      if (index < 2) await expect(page.getByText(`${index + 2} of 3`).first()).toBeVisible();
    }
    await expect(page.getByText("No flashcards are due.")).toBeVisible();
    await expect(page.getByText("The flashcard could not be rated")).toHaveCount(0);
    const seconds = db.prepare("SELECT seconds FROM card_reviews ORDER BY reviewed_at").all() as Array<{ seconds: number | null }>;
    // All three are saved: a minute, no time, and about half a minute.
    expect(seconds).toHaveLength(3);
    expect(seconds[0]!.seconds).toBe(60);
    expect(seconds[1]!.seconds).toBeNull();
    expect(seconds[2]!.seconds).toBeGreaterThanOrEqual(30);
    expect(seconds[2]!.seconds).toBeLessThan(40);
  } finally {
    await done();
  }
});

test("the Oggi ring in each state: nothing, part of the day, the day done, over it and without a goal, in both languages and themes", async () => {
  test.setTimeout(600_000);
  const { page, db, done } = await openApp();
  try {
    const now = Date.now();
    // Flashcards with no exam, a subject's: reviewed today for a minute each, which fill the day. Three more are due.
    let made = 0;
    const study = (minutes: number) => {
      for (let index = 0; index < minutes; index += 1) {
        made += 1;
        reviewedCard(db, `m${made}`, { subjectId: "s-phys" }, now - 1000, now + 30 * day, 60);
      }
    };
    for (const id of ["d1", "d2", "d3"])
      reviewedCard(db, id, { planId: "p-near", topicId: "t-p-near" }, now - day, now - day + 3_600_000, 60);
    await page.evaluate(() => window.pyxis.invoke("plans.plannerHours", { hours: 7 }));

    const combos = SHOTS
      ? ([
          ["it", "light", 1280],
          ["it", "dark", 1280],
          ["it", "light", 960],
          ["it", "dark", 960],
          ["en", "light", 1280],
          ["en", "dark", 1280],
          ["en", "light", 960],
          ["en", "dark", 960],
        ] as const)
      : ([
          ["it", "dark", 960],
          ["en", "light", 1280],
        ] as const);
    const states = [
      { name: "nothing", minutes: 0, it: "0 di 60 min", en: "0 of 60 min", arc: 0, bar: null },
      { name: "part", minutes: 24, it: "24 di 60 min", en: "24 of 60 min", arc: 0.4, bar: ["Oggi hai studiato 24 minuti su 60 · 3 flashcard da ripassare", "You've studied 24 minutes of 60 today · 3 flashcards to review"] },
      { name: "done", minutes: 36, it: "fatto, 60 min", en: "done, 60 min", arc: 1, bar: ["Oggi hai studiato 60 minuti su 60 · 3 flashcard da ripassare", "You've studied 60 minutes of 60 today · 3 flashcards to review"] },
      { name: "over", minutes: 2, it: "fatto, 62 min", en: "done, 62 min", arc: 1, bar: ["Oggi hai studiato 62 minuti su 60 · 3 flashcard da ripassare", "You've studied 62 minutes of 60 today · 3 flashcards to review"] },
      { name: "no-goal", minutes: 0, it: "non misurato", en: "not measured", arc: 0, bar: null },
    ] as const;
    for (const state of states) {
      study(state.minutes);
      if (state.name === "no-goal") await page.evaluate(() => window.pyxis.invoke("plans.plannerHours", { hours: null }));
      for (const [language, theme, width] of combos) {
        await page.evaluate(
          async ({ language, theme }) => {
            localStorage.setItem("pyxis.lang", language);
            await window.pyxis.setAppearance(theme);
          },
          { language, theme },
        );
        await page.setViewportSize({ width, height: 800 });
        await page.reload();
        const tag = `${state.name}-${language}-${theme}-${width}`;

        // The exam page: the ring, its legend and its accessible name.
        await openExam(page, "p-near");
        const legend = page.getByRole("list", { name: language === "it" ? "Anelli dell'esame" : "Exam rings" });
        const value = legend.getByRole("listitem").nth(2);
        if (state.name === "no-goal") {
          await expect(value).toContainText(language === "it" ? "Imposta obiettivo di studio" : "Set a study goal");
          await expect(page.locator(".px-exam-rings").getByRole("img")).toHaveAccessibleName(
            new RegExp(`, ${language === "it" ? "Oggi" : "Today"} ${state[language]}$`),
          );
        } else {
          await expect(value).toHaveText(new RegExp(`^(Oggi|Today)\\s*${state[language]}$`));
          await expect(page.locator(".px-exam-rings").getByRole("img")).toHaveAccessibleName(
            new RegExp(`, ${language === "it" ? "Oggi" : "Today"} ${state[language]}$`),
          );
        }
        const arc = page.locator(".px-exam-rings .px-rings-arc.is-today");
        await expect(arc).toHaveCount(state.arc > 0 ? 1 : 0);
        if (state.arc > 0) {
          // The arc is drawn to its share of the day from the top, all the way round once the day is done.
          const length = await arc.evaluate((element) => {
            const [drawn, around] = element.getAttribute("stroke-dasharray")!.split(" ").map(Number);
            return drawn! / around!;
          });
          expect(length).toBeCloseTo(state.arc, 2);
        }
        await expectNoAxeViolations(page);
        await saveShot(page.locator(".px-exam-head"), `exam-${tag}.png`, { animations: "disabled" });

        // The same day on the exam with no date, in the Esami list, with its line above.
        await openExams(page);
        const rows = page.getByRole("list", { name: language === "it" ? "I tuoi esami" : "Your exams" }).getByRole("link");
        await expect(rows).toHaveCount(3);
        for (const index of [0, 1, 2]) {
          await expect(rows.nth(index).getByRole("img")).toHaveAccessibleName(
            new RegExp(`, ${language === "it" ? "Oggi" : "Today"} ${state[language]}$`),
          );
          if (state.name !== "no-goal") await expect(rows.nth(index)).toContainText(`${language === "it" ? "Oggi" : "Today"}${state[language]}`);
        }
        if (state.bar) await expect(page.locator(".px-exams-due p")).toContainText(state.bar[language === "it" ? 0 : 1]);
        else await expect(page.locator(".px-exams-due p")).toContainText(language === "it" ? "Oggi hai 3 flashcard da ripassare" : "You have 3 flashcards to review today");
        await expectNoAxeViolations(page);
        await saveShot(page.locator(".px-exams"), `esami-${tag}.png`, { animations: "disabled" });
      }
    }
  } finally {
    await done();
  }
});
