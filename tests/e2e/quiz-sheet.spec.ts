import { expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { launchPyxis } from "./app-under-test";
import { expectNoAxeViolations } from "./axe";
import { removeTestFolder } from "./cleanup";
import { fromChiediToExams } from "./doors";
import { seedPlan } from "./seed";
import { SHOTS, saveShot } from "./shots";

/** Eight questions of every kind a quiz asks, on «Cinematica», with formulas in the stems and the options. */
const questions = [
  {
    id: "q-auto",
    stem: "Un'auto parte da ferma e accelera in linea retta con accelerazione costante $a = 2\\,m/s^2$. Quanta strada percorre nei primi 5 secondi?",
    options: ["10 m", "25 m", "50 m", "5 m"],
    answer: { kind: "mcq", correct: 1, picked: -1 },
  },
  {
    id: "q-segno",
    stem: "Un punto che si muove verso l'origine partendo da $x = 5\\,m$ ha velocità negativa.",
    answer: { kind: "tf", correct: true, picked: false },
  },
  {
    id: "q-media",
    stem: "Un ciclista percorre 6 km in 15 minuti. Qual è la sua velocità media?",
    options: ["$24\\,km/h$", "$12\\,km/h$", "$0{,}4\\,km/min$ cioè $40\\,km/h$", "$90\\,km/h$"],
    answer: { kind: "mcq", correct: 0, picked: -1 },
  },
  {
    id: "q-legge",
    stem: "La velocità di un punto che si muove lungo una retta è $v(t) = 3t^2 - 2t$. All'istante $t = 0$ il punto si trova in $x = 1\\,m$. Scrivi la legge oraria $x(t)$.",
    answer: { kind: "open", answer: "", reference: "$x(t) = t^3 - t^2 + 1$" },
  },
  {
    id: "q-unita",
    stem: "Nel Sistema Internazionale l'accelerazione si misura in {{1}}.",
    answer: { kind: "completion", answers: [], accepted: [["m/s^2", "m/s²", "metri al secondo quadrato"]] },
  },
  {
    id: "q-grandezze",
    stem: "Abbina a ogni grandezza la sua unità.",
    left: ["$v$", "$a$"],
    right: ["$m/s$", "$m/s^2$"],
    answer: { kind: "matching", pairs: [], correct: [["$v$", "$m/s$"], ["$a$", "$m/s^2$"]] },
  },
  {
    id: "q-sasso",
    stem: "Un sasso lanciato verso l'alto con $v_0 = 12\\,m/s$ ricade nel punto di partenza dopo 2,4 s. Quanto vale lo spostamento complessivo?",
    options: ["0 m", "14,7 m", "7,35 m", "29,4 m"],
    answer: { kind: "mcq", correct: 0, picked: -1 },
  },
  {
    id: "q-grafico",
    stem: "La velocità scende in linea retta da 4 m/s a $t = 0$ fino a −4 m/s a $t = 4\\,s$. Quanta strada percorre il punto in totale?",
    options: ["0 m", "8 m", "16 m", "4 m"],
    answer: { kind: "mcq", correct: 1, picked: -1 },
  },
].map((question) => ({ ...question, topicId: "t-kin", explanation: "Lo spostamento somma i tratti con il segno." }));

function seed(db: DatabaseSync) {
  const now = Date.now();
  db.prepare("INSERT INTO subjects(id,name,position,created_at) VALUES('sub-fis','Fisica',0,1)").run();
  seedPlan(db, {
    id: "p-fis",
    subjectId: "sub-fis",
    title: "Fisica I",
    language: "it",
    target: 0.75,
    topics: [
      { id: "t-kin", title: "Cinematica" },
      { id: "t-din", title: "Dinamica" },
    ],
  });
  const item = db.prepare(
    "INSERT INTO items(id,plan_id,topic_id,kind,body_json,engine_provider,grounding,created_at) VALUES(?,'p-fis',?,?,?,'fixture','sources',?)",
  );
  item.run(
    "i-quiz",
    "t-kin",
    "quiz",
    JSON.stringify({ questions, config: { count: questions.length, feedback: true, types: ["mcq"] }, complete: true }),
    now,
  );
  item.run(
    "i-sim",
    "t-kin",
    "simulation",
    JSON.stringify({
      minutes: 30,
      questions: [
        { id: "e-1", topicId: "t-kin", stem: "Calcola la velocità media di un'auto che percorre 120 km in 1,5 ore.", answer: { kind: "completion", accepted: [["80 km/h"]] } },
        { id: "e-2", topicId: "t-kin", stem: "Un corpo cade da fermo per 2 s. Quanta strada percorre? Usa $g = 9{,}8\\,m/s^2$.", answer: { kind: "completion", accepted: [["19,6 m"]] } },
        { id: "e-3", topicId: "t-kin", stem: "Scrivi la legge oraria di un moto uniformemente accelerato.", answer: { kind: "completion", accepted: [["x = x0 + v0 t + a t^2 / 2"]] } },
      ],
    }),
    now,
  );
  const attempt = db.prepare("INSERT INTO attempts(id,plan_id,item_id,started_at) VALUES(?,'p-fis',?,?)");
  attempt.run("a-quiz", "i-quiz", now);
  attempt.run("a-sim", "i-sim", now);
}

async function launch() {
  const userData = mkdtempSync(join(tmpdir(), "pyxis-quiz-sheet-"));
  const app = await launchPyxis({ userData });
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
}

async function go(page: Page, hash: string) {
  await page.evaluate((value) => {
    location.hash = value;
  }, hash);
}

const heading = (page: Page) => page.locator(".px-qz-head h1");
const sheet = (page: Page) => page.getByRole("complementary", { name: /^(Domande|Questions)$/ });
const tile = (page: Page, name: string) => sheet(page).getByRole("button", { name, exact: true });
const read = (page: Page, attemptId: string) =>
  page.evaluate(
    (attemptId) => window.pyxis.invoke("study.quizRead", { attemptId }),
    attemptId,
  ) as Promise<{ draft?: { picks: Record<string, string>; index: number; marked?: string[] } }>;

/** Screenshots for review, in Italian dark and English light at 1280 and 960, when PYXIS_SHOTS is set. */
async function shoot(page: Page, name: string, prepare?: () => Promise<void>) {
  if (!SHOTS) return;
  // Answers save 500 ms after the last change, and a reload in between would drop them.
  await page.waitForTimeout(800);
  const back = await page.evaluate(() => [localStorage.getItem("pyxis.lang"), document.documentElement.dataset.theme]);
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
      await expect(heading(page)).toBeVisible();
      await prepare?.();
      await page.evaluate(() => document.fonts.ready);
      await saveShot(page, `quiz-sheet/${name}-${language}-${theme}-${width}.png`, { animations: "disabled" });
    }
  await page.evaluate(
    async ([language, theme]) => {
      localStorage.setItem("pyxis.lang", language ?? "it");
      await window.pyxis.setAppearance(theme === "dark" ? "dark" : "light");
    },
    back,
  );
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.reload();
  await expect(heading(page)).toBeVisible();
  await prepare?.();
}

test("the quiz answers in one column: keys, the Domande card, Non lo so, Segna per dopo and Consegna with blanks", async () => {
  test.setTimeout(180_000);
  const { page, done } = await launch();
  try {
    await page.setViewportSize({ width: 1280, height: 800 });
    await go(page, "/plans/p-fis/quiz/t-kin?attempt=a-quiz");
    await expect(heading(page)).toHaveText("Domanda 1 di 8");
    await expect(page.locator(".px-qz-kicker")).toHaveText("Scelta multipla");
    // The way back names the exam; the line under the title says the quiz has no time limit.
    await expect(page.locator(".px-studybar-back")).toHaveAccessibleName("Torna all'esame: Fisica I");
    await expect(page.locator(".px-studybar-title p")).toHaveText("Fisica I · senza limite di tempo");
    await expect(sheet(page).locator(".px-qz-count")).toHaveText("0 di 8 date");
    // A new question takes focus, so a screen reader hears its position and its text.
    const card = page.locator(".px-qz-sheet");
    await expect(card).toBeFocused();
    await expect(card).toHaveAccessibleName("Domanda 1 di 8");
    await expect(page.getByText("Tasti 1-4 per scegliere, Invio per andare avanti")).toBeVisible();
    await expectNoAxeViolations(page);

    // Number keys pick and change the pick freely; Indietro is not there on the first question.
    await page.keyboard.press("3");
    await page.keyboard.press("2");
    await expect(page.getByRole("button", { name: /^B 25 m/ })).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByRole("button", { name: /^C 50 m/ })).toHaveAttribute("aria-pressed", "false");
    await expect(page.getByRole("button", { name: "Indietro", exact: true })).toHaveCount(0);
    await expect(tile(page, "Domanda 1, risposta data")).toHaveAttribute("aria-current", "step");
    await expect(sheet(page).locator(".px-qz-count")).toHaveText("1 di 8 data");
    await shoot(page, "mcq");

    // Enter goes on; S marks the question for later and 0 says "Non lo so", both pressed buttons, both on its number.
    await page.keyboard.press("Enter");
    await expect(heading(page)).toHaveText("Domanda 2 di 8");
    await expect(card).toBeFocused();
    await page.keyboard.press("s");
    await page.keyboard.press("0");
    await expect(page.getByRole("button", { name: "Segna per dopo", exact: true })).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByRole("button", { name: "Non lo so", exact: true })).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByText("Conta come una risposta sbagliata, e quella giusta la vedi nei risultati.")).toBeVisible();
    await expect(tile(page, "Domanda 2, non lo so, segnata per dopo")).toBeVisible();
    await shoot(page, "marked");

    // The Domande card jumps to any question. A fill-in answer typed and erased goes back to blank.
    await tile(page, "Domanda 5").click();
    await expect(heading(page)).toHaveText("Domanda 5 di 8");
    const blank = page.getByRole("textbox", { name: "Spazio 1" });
    await blank.fill("m/s^2");
    await expect(tile(page, "Domanda 5, risposta data")).toBeVisible();
    await blank.fill("");
    await expect(tile(page, "Domanda 5")).toBeVisible();
    await blank.fill("m/s^2");
    await tile(page, "Domanda 4").click();
    await expect(page.locator(".px-qz-kicker")).toHaveText("Risposta aperta");
    await expect(page.getByRole("textbox", { name: "La tua risposta" })).toBeVisible();
    await shoot(page, "open");

    // Coming back to a quiz left halfway opens it where it was, with its answers and its marks.
    await expect.poll(async () => (await read(page, "a-quiz")).draft).toMatchObject({
      index: 3,
      marked: ["q-segno"],
      picks: { "q-auto": "1", "q-segno": "", "q-unita": JSON.stringify(["m/s^2"]) },
    });
    await page.locator(".px-studybar-back").click();
    await expect(page.locator(".px-qz-sheet")).toHaveCount(0);
    await go(page, "/plans/p-fis/quiz/t-kin?attempt=a-quiz");
    await expect(heading(page)).toHaveText("Domanda 4 di 8");
    await expect(tile(page, "Domanda 2, non lo so, segnata per dopo")).toBeVisible();
    await expect(sheet(page).locator(".px-qz-count")).toHaveText("3 di 8 date");

    // Consegna asks first, with how many are blank and marked; Escape closes it and gives focus back to Consegna.
    const handIn = sheet(page).getByRole("button", { name: "Consegna", exact: true });
    await handIn.click();
    const confirm = page.getByRole("group", { name: /^Consegni con/ });
    await expect(confirm).toHaveAccessibleName(
      "Consegni con 5 domande vuote e 1 domanda segnata per dopo? Le vuote contano come «non lo so».",
    );
    await expect(confirm.getByRole("button", { name: "Consegna" })).toBeFocused();
    await expectNoAxeViolations(page);
    await shoot(page, "confirm", async () => {
      await sheet(page).locator(".px-qz-handin > .px-btn").click();
      await expect(page.locator(".px-qz-confirm")).toBeVisible();
    });
    await page.keyboard.press("Escape");
    await expect(confirm).toHaveCount(0);
    await expect(handIn).toBeFocused();

    // The last question's step forward is Consegna too, and it asks under itself.
    await tile(page, "Domanda 8").click();
    await expect(page.getByRole("button", { name: "Avanti" })).toHaveCount(0);
    await page.locator(".px-qz-nav").getByRole("button", { name: "Consegna" }).click();
    await page.locator(".px-qz-nav-confirm").getByRole("button", { name: "Consegna" }).click();
    // Blank answers count as "Non lo so": two right answers of eight.
    await expect(page.locator(".px-res-headline")).toContainText("2 punti su 8.");
    await expect(page.locator(".px-qz-sheet")).toHaveCount(0);
  } finally {
    await done();
  }
});

test("the exam simulation runs on the same sheet, with its clock, Segna per dopo and Consegna", async () => {
  test.setTimeout(90_000);
  const { page, done } = await launch();
  try {
    await page.setViewportSize({ width: 1280, height: 800 });
    await go(page, "/plans/p-fis/exam/a-sim");
    await expect(heading(page)).toHaveText("Domanda 1 di 3");
    await expect(page.getByRole("timer", { name: "Tempo rimanente" })).toBeVisible();
    // A running exam has no way out until it is handed in.
    await expect(page.locator(".px-studybar-back")).toHaveCount(0);
    await page.getByRole("textbox", { name: "La tua risposta" }).click();
    await page.keyboard.type("80 km/h");
    await page.getByRole("button", { name: "Avanti" }).click();
    await expect(heading(page)).toHaveText("Domanda 2 di 3");
    await page.getByRole("button", { name: "Segna per dopo", exact: true }).click();
    await expect(tile(page, "Domanda 2, segnata per dopo")).toHaveAttribute("aria-current", "step");
    await expect(sheet(page).locator(".px-qz-count")).toHaveText("1 di 3 data");
    await expectNoAxeViolations(page);
    await shoot(page, "simulation");
    // The mark and the answer are saved with the exam.
    await expect
      .poll(() =>
        page.evaluate(() => window.pyxis.invoke("study.simulationRead", { attemptId: "a-sim" })).then((run) => [run.marked, run.picks["e-1"]]),
      )
      .toEqual([["e-2"], "80 km/h"]);
    await page.reload();
    await expect(tile(page, "Domanda 2, segnata per dopo")).toBeVisible();
    await sheet(page).getByRole("button", { name: "Consegna", exact: true }).click();
    await expect(page.getByRole("group", { name: /^Consegni con/ })).toHaveAccessibleName(
      "Consegni con 2 domande vuote e 1 domanda segnata per dopo? Le vuote contano come «non lo so».",
    );
    await page.getByRole("button", { name: "Torna alle domande" }).click();
    await expect(page.getByRole("group", { name: /^Consegni con/ })).toHaveCount(0);
  } finally {
    await done();
  }
});

test("a running exam reopens on the question it was left on, with its clock still running", async () => {
  test.setTimeout(90_000);
  const { page, userData, done } = await launch();
  try {
    await page.setViewportSize({ width: 1280, height: 800 });
    // The exam started ten minutes ago, so a restarted clock would show about 30 minutes, not about 20.
    const db = new DatabaseSync(join(userData, "workspace", "pyxis.db"), { timeout: 10000 });
    db.prepare("UPDATE attempts SET started_at=? WHERE id='a-sim'").run(Date.now() - 10 * 60_000);
    db.close();
    await go(page, "/plans/p-fis/exam/a-sim");
    await expect(heading(page)).toHaveText("Domanda 1 di 3");
    await page.getByRole("button", { name: "Avanti" }).click();
    await page.getByRole("button", { name: "Avanti" }).click();
    await expect(heading(page)).toHaveText("Domanda 3 di 3");
    await expect
      .poll(() =>
        page.evaluate(() => window.pyxis.invoke("study.simulationRead", { attemptId: "a-sim" })).then((run) => run.current),
      )
      .toBe("e-3");
    const left = (text: string | null) => Number(text?.split(":")[0]);
    const before = left(await page.getByRole("timer", { name: "Tempo rimanente" }).textContent());
    expect(before).toBeLessThanOrEqual(20);
    await page.reload();
    await expect(heading(page)).toHaveText("Domanda 3 di 3");
    await expect(tile(page, "Domanda 3")).toHaveAttribute("aria-current", "step");
    expect(left(await page.getByRole("timer", { name: "Tempo rimanente" }).textContent())).toBeLessThanOrEqual(before);
    // Leaving the page and coming back opens the same question too.
    await go(page, "/plans/p-fis");
    await go(page, "/plans/p-fis/exam/a-sim");
    await expect(heading(page)).toHaveText("Domanda 3 di 3");
  } finally {
    await done();
  }
});

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

test("the Domande card becomes a strip over the question when the page is narrow, from its own width", async () => {
  test.setTimeout(120_000);
  const { app, page, done } = await launch();
  try {
    for (const size of [
      { name: "960", width: 960, zoom: 1, text: "md", strip: false },
      { name: "960-large", width: 960, zoom: 1, text: "lg", strip: false },
      { name: "960-zoom200", width: 960, zoom: 2, text: "md", strip: true },
      { name: "1280-zoom200", width: 1280, zoom: 2, text: "md", strip: true },
    ] as const) {
      await page.evaluate((textSize) => window.pyxis.invoke("profile.save", { dyslexia: false, textSize }), size.text);
      await zoomWindow(app, page, size.width, size.zoom);
      await go(page, "/plans/p-fis/quiz/t-kin?attempt=a-quiz");
      await page.reload();
      await expect(heading(page)).toBeVisible();
      const card = (await page.locator(".px-qz-sheet").boundingBox())!;
      const side = (await sheet(page).boundingBox())!;
      if (size.strip) expect(side.y + side.height, `${size.name}: the strip sits over the question`).toBeLessThanOrEqual(card.y);
      else expect(side.x, `${size.name}: the card sits beside the question`).toBeGreaterThanOrEqual(card.x + card.width);
      // The question keeps room for a line of text, and nothing runs off the side.
      expect(card.width, size.name).toBeGreaterThanOrEqual(300);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), size.name).toBe(true);
      await shootWindow(app, `quiz-sheet/narrow-${size.name}.png`);
    }
  } finally {
    await done();
  }
});
