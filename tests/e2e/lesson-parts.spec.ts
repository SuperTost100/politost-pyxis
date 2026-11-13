import { expect, test, type Page } from "@playwright/test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { launchPyxis } from "./app-under-test";
import { expectNoAxeViolations } from "./axe";
import { removeTestFolder } from "./cleanup";
import { fromChiediToExams } from "./doors";
import { seedPlan, seedSource, seedSubjects } from "./seed";
import { animationsSettled, atRest } from "./settled";
import { saveShot } from "./shots";

// A topic's lesson in parts, with the recorded engine: the plan of the parts, part 1, the part written ahead, a part
// that is not ready yet, a write that fails and Riprova, the recap, a topic of one part, a part without an AI tool, and
// the keys and the narrow window's list.

const fence = (kind: string, body: unknown) => ["```" + kind, JSON.stringify(body), "```"].join("\n");

/** Prose for one section of a part: enough words that each part has the length a part must have. */
function prose(name: string): string {
  return Array.from(
    { length: 7 },
    (_, i) => `${name} torna in molti esercizi del corso, e questa frase numero ${i + 1} lo spiega con calma e con un esempio.`,
  ).join(" ");
}

/** A teaching part as the model writes it: an opening, two sections, one check whose right answer is B, the takeaway. */
function partText(name: string): string {
  return [
    `Qui si parla di ${name.toLowerCase()}.`,
    "",
    `## ${name}: l'idea`,
    "",
    prose(name),
    "",
    prose(name),
    "",
    `## ${name}: un esempio`,
    "",
    prose(name),
    "",
    prose(name),
    "",
    fence("pyxis-check", {
      question: `Che cosa dice la parte su ${name.toLowerCase()}?`,
      options: ["Una cosa sbagliata", "La cosa giusta", "Un'altra cosa"],
      answer: 1,
      explanation: "Lo dice la parte che hai letto.",
    }),
    "",
    fence("pyxis-takeaway", { text: `Riassunto di ${name.toLowerCase()}: la cosa giusta. Serve nella parte dopo.` }),
  ].join("\n");
}

/** The recap part: one section with a point per part, the closing recap of three questions, the takeaway. */
const recapText = [
  "## Il capitolo in breve",
  "",
  "- Intorni e distanza.",
  "- Interno e frontiera.",
  "- Aperti e chiusi.",
  "- Compatti e connessi.",
  "",
  fence("pyxis-recap", {
    questions: [1, 2, 3].map((n) => ({
      question: `Domanda di ripasso ${n}?`,
      options: ["Giusta", "Sbagliata"],
      answer: 0,
    })),
  }),
  "",
  fence("pyxis-takeaway", { text: "Il capitolo in breve: intorni, frontiera, aperti, compatti." }),
].join("\n");

/** Eight passages of about 3,000 characters: a topic of about 24,000, which Pyxis plans in 3 to 5 parts. */
const passages = Array.from({ length: 8 }, (_, i) => ({
  id: `pa-${i + 1}`,
  text: `Passaggio ${i + 1} del capitolo sulle funzioni di più variabili. `.repeat(46),
  section: `2.${Math.floor(i / 2) + 1}`,
}));

const outline = {
  lessonParts: [
    { title: "Intorni e distanza in $\\mathbb{R}^n$", about: "Misurare la distanza tra due punti.", passages: ["P1", "P2"] },
    { title: "Interno, esterno, frontiera", about: "Dove sta un punto rispetto a un insieme.", passages: ["P3", "P4"] },
    { title: "Insiemi aperti e chiusi", about: "Quando un insieme è aperto o chiuso.", passages: ["P5", "P6"] },
    { title: "Limitati, compatti, connessi", about: "Tre proprietà degli insiemi.", passages: ["P7", "P8"] },
  ],
};

type Started = { page: Page; userData: string; prompts: string; db: () => DatabaseSync; close: () => Promise<void> };

/** The app with Analisi 2 seeded, the recorded engine answering with `markdown`, and its prompts logged. */
async function start(markdown: unknown[], topics: Array<{ id: string; title: string; passages: typeof passages }>): Promise<Started> {
  const userData = mkdtempSync(join(tmpdir(), "pyxis-lesson-parts-"));
  const prompts = join(userData, "plan-prompts.log");
  const app = await launchPyxis({
    userData,
    env: {
      PYXIS_E2E_PLAN_REPLIES: JSON.stringify({ lessonParts: outline, markdown }),
      // Every call takes this long, so the planning and writing states stay on screen while the test reads them.
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
    passages: topics.flatMap((topic) => topic.passages),
  });
  seedPlan(seeding, {
    id: "p-an2",
    subjectId: "an2",
    title: "Analisi Matematica 2",
    language: "it",
    sourceIds: ["bramanti"],
    topics: topics.map(({ id, title }) => ({ id, title })),
  });
  for (const topic of topics)
    for (const passage of topic.passages)
      seeding.prepare("INSERT INTO topic_passages(topic_id,passage_id) VALUES(?,?)").run(topic.id, passage.id);
  seeding.close();
  await page.reload();
  return {
    page,
    userData,
    prompts,
    db,
    close: async () => {
      await app.close();
      removeTestFolder(userData);
    },
  };
}

const open = (page: Page, topicId: string, part?: number) =>
  page.evaluate((hash) => {
    location.hash = hash;
  }, `/plans/p-an2/lesson/${topicId}${part ? `?part=${part}` : ""}`);

const parts = (page: Page) => page.getByRole("navigation", { name: "Parti del capitolo" });
const continueButton = (page: Page) => page.getByRole("button", { name: /^Continua/ });
/** The letter of the final question's option that reads `text`: options are drawn in their own order. */
async function letterOf(page: Page, text: string): Promise<string> {
  const options = await page.getByRole("region", { name: "Verifica" }).locator(".px-opt-text").allInnerTexts();
  const index = options.findIndex((option) => option.trim() === text);
  expect(index, `"${text}" among ${options.join(", ")}`).toBeGreaterThanOrEqual(0);
  return String.fromCharCode(97 + index);
}

const working = (page: Page, text: string | RegExp) => page.getByRole("status").filter({ hasText: text });

test("a topic never read: Pyxis plans its parts, writes part 1 and one part ahead, and the recap finishes the lesson", async () => {
  test.setTimeout(240_000);
  // Part 3's reply waits for this file, so the test reaches part 3 before it is written.
  const holdDir = mkdtempSync(join(tmpdir(), "pyxis-part-hold-"));
  const hold = join(holdDir, "part-3");
  const { page, prompts, close } = await start(
    [
      { markdown: partText("Intorni") },
      // Part 2, written ahead, comes back twice in a shape the reader cannot show.
      { markdown: "Testo senza sezioni." },
      { markdown: "Ancora testo senza sezioni." },
      { markdown: partText("Frontiera") },
      { markdown: partText("Aperti e chiusi"), hold },
      { markdown: partText("Compatti") },
      { markdown: recapText },
    ],
    [{ id: "t-funzioni", title: "Funzioni di più variabili", passages }],
  );
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    // First open: the chapter is planned in place, with no column yet, and the way back takes the focus.
    await open(page, "t-funzioni");
    await expect(working(page, "Sto dividendo il capitolo in parti")).toBeVisible();
    await expect(page.getByRole("button", { name: "Torna al percorso" })).toBeFocused();
    await expect(parts(page)).toHaveCount(0);
    await saveShot(page, "lesson-parts/planning-it-light.png");
    // The plan is saved: the column fills in with every part, and the block says which part is written.
    await expect(working(page, "Sto scrivendo la parte 1")).toBeVisible();
    await expect(parts(page).getByRole("link")).toHaveCount(5);
    await expect(parts(page).getByRole("link", { name: /Interno, esterno, frontiera.*non ancora scritta/ })).toBeVisible();
    await expect(page.locator(".px-studybar-title")).toContainText("Parte 1 di 4");

    // Part 1: its title and the column draw the formula, never its TeX.
    const title = page.getByRole("heading", { level: 1 });
    await expect(title.locator(".katex")).toHaveCount(1, { timeout: 20_000 });
    await expect(page.getByText(/^Circa \d+ minuti · una domanda alla fine$/)).toBeVisible();
    await expect(parts(page).locator(".katex")).toHaveCount(1);
    // KaTeX keeps the source in its MathML for screen readers; no text drawn on the page shows it.
    const drawnTex = await page.evaluate(() => {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      const shown: string[] = [];
      for (let node = walker.nextNode(); node; node = walker.nextNode())
        if (!node.parentElement?.closest(".katex-mathml") && node.textContent?.includes("\\mathbb")) shown.push(node.textContent);
      return shown;
    });
    expect(drawnTex).toEqual([]);
    await expect(parts(page).locator("a[aria-current=page]")).toContainText("Intorni e distanza");
    await expect(page.getByRole("region", { name: "Verifica" })).toBeVisible();
    await expect(page.getByText("Fine della parte 1")).toBeVisible();
    await expect(page.getByText("Riassunto di intorni: la cosa giusta.")).toBeVisible();
    await expectNoAxeViolations(page);
    await saveShot(page, "lesson-parts/part-1-it-light.png");
    // The part's dots are a lone button, so they open its menu by click, right-click and Shift+F10, and one Escape
    // closes it with the focus back on them.
    const dots = page.getByRole("button", { name: "Altre azioni" });
    for (const openMenu of [
      () => dots.click(),
      () => dots.click({ button: "right" }),
      async () => {
        await dots.focus();
        await page.keyboard.press("Shift+F10");
      },
    ]) {
      await openMenu();
      await expect(page.getByRole("menuitem", { name: "Mappa" })).toBeVisible();
      await expect(dots).toHaveAttribute("aria-expanded", "true");
      await page.keyboard.press("Escape");
      await expect(page.getByRole("menu")).toHaveCount(0);
      await expect(dots).toBeFocused();
    }

    // Part 2's job, started ahead, fails on its shape while part 1 is read.
    await expect
      .poll(async () => {
        const read = (await page.evaluate(() =>
          window.pyxis.invoke("study.parts", { planId: "p-an2", topicId: "t-funzioni" }),
        )) as { outline: { parts: Array<{ state: string }> } | null };
        return read.outline?.parts[1]?.state;
      }, { timeout: 20_000 })
      .toBe("failed");

    // The B key answers the final question from the page, and the focus moves to Continua.
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.keyboard.press(await letterOf(page, "La cosa giusta"));
    await expect(page.getByText("Giusto.", { exact: true })).toBeVisible();
    await expect(continueButton(page)).toBeFocused();
    await expect(continueButton(page)).toContainText("Continua: Interno, esterno, frontiera");
    await expect(parts(page).getByRole("link", { name: /Intorni e distanza.*letta/ })).toBeVisible();
    // The answer was saved for the part: a reload shows it answered.
    await saveShot(page, "lesson-parts/part-1-answered-it-light.png");

    // Leaving the lesson and opening it again from a link without a part opens the first part not read, part 2, and the
    // address names it: never the part just finished, which an earlier read of the same address had chosen.
    await page.getByRole("button", { name: "Per oggi basta" }).click();
    await expect(page).toHaveURL(/#\/plans\/p-an2$/);
    await open(page, "t-funzioni");
    await expect(page.getByRole("heading", { level: 1, name: "Interno, esterno, frontiera" })).toBeVisible();
    await expect(page).toHaveURL(/\?part=2$/);

    // Part 2's write failed: Riprova, then the part, with the focus on its title.
    const failed = page.getByText("Non sono riuscito a scrivere la parte 2.");
    await expect(failed).toBeVisible();
    await expectNoAxeViolations(page);
    await saveShot(page, "lesson-parts/part-2-failed-it-light.png");
    await page.getByRole("button", { name: "Riprova" }).click();
    await expect(working(page, "Sto scrivendo la parte 2")).toBeVisible();
    await expect(page.getByText("Riparte da dove finisce la parte 1", { exact: false })).toBeVisible();
    await expect(page.getByRole("heading", { level: 1, name: "Interno, esterno, frontiera" })).toBeFocused({ timeout: 20_000 });
    await expect(page.getByText("Frontiera: l'idea")).toBeVisible();
    // Part 2's prompt carried what part 1 taught.
    const sent = readFileSync(prompts, "utf8").trim().split("\n").map((line) => JSON.parse(line) as string);
    expect(sent.some((prompt) => prompt.includes("Part 2 of") && prompt.includes("Riassunto di intorni"))).toBe(true);

    // A wrong answer, picked with the pointer, is a mistake to redo, and still finishes the part.
    await page.getByRole("region", { name: "Verifica" }).getByRole("button", { name: /Una cosa sbagliata/ }).click();
    await expect(page.getByText("Non proprio.", { exact: true })).toBeVisible();
    await expect(continueButton(page)).toBeFocused();
    const mistakes = (await page.evaluate(() => window.pyxis.invoke("study.mistakes", { planId: "p-an2" }))) as {
      plans: Array<{ count: number }>;
    };
    expect(mistakes.plans[0]?.count).toBe(1);

    // Part 3 is still being written: the page shows it in place, the column marks it, and Attività lists the job.
    await continueButton(page).click();
    await expect(working(page, "Sto scrivendo la parte 3")).toBeVisible();
    await expect(page.getByRole("heading", { level: 1, name: "Insiemi aperti e chiusi" })).toBeVisible();
    await expect(parts(page).getByRole("link", { name: /Insiemi aperti e chiusi.*in scrittura/ })).toBeVisible();
    await expect(page.getByRole("button", { name: "Torna al percorso" })).toBeFocused();
    await expectNoAxeViolations(page);
    await saveShot(page, "lesson-parts/part-3-writing-it-light.png");
    const jobs = (await page.evaluate(() => window.pyxis.invoke("jobs.list", {}))) as Array<{
      kind: string;
      state: string;
      title: string | null;
    }>;
    expect(jobs.find((job) => job.kind === "lesson-part" && job.state === "running")?.title).toBe(
      "Parte 3 · Insiemi aperti e chiusi",
    );
    // Torna al percorso leaves the job running; back on the part, it arrives in place and the title takes the focus.
    await page.getByRole("button", { name: "Torna al percorso" }).click();
    await expect(page).toHaveURL(/#\/plans\/p-an2$/);
    await page.goBack();
    await expect(working(page, "Sto scrivendo la parte 3")).toBeVisible();
    writeFileSync(hold, "");
    await expect(page.getByText("Aperti e chiusi: l'idea")).toBeVisible({ timeout: 20_000 });
    await expect(working(page, "Sto scrivendo la parte 3")).toHaveCount(0);
    await expect(page.getByRole("heading", { level: 1, name: "Insiemi aperti e chiusi" })).toBeFocused();

    // The arrows move between the options, round at both ends, and Invio answers.
    const options = page.getByRole("region", { name: "Verifica" }).locator(".px-opt");
    const right = (await letterOf(page, "La cosa giusta")).charCodeAt(0) - 97;
    await options.first().focus();
    await page.keyboard.press("ArrowUp");
    await expect(options.nth(2)).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(options.nth(0)).toBeFocused();
    for (let step = 0; step < right; step++) await page.keyboard.press("ArrowDown");
    await expect(options.nth(right)).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.getByText("Giusto.", { exact: true })).toBeVisible();
    await expect(continueButton(page)).toBeFocused();
    // Tab from Continua reaches Scegli altro, then Per oggi basta.
    await page.keyboard.press("Tab");
    await expect(page.getByRole("button", { name: "Scegli altro" })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("menuitem", { name: /Esercizi · Funzioni di più variabili/ })).toBeVisible();
    await expect(page.getByRole("menuitem", { name: /Flashcard · Funzioni di più variabili/ })).toBeVisible();
    await expect(page.getByRole("menuitem", { name: /Rileggi una parte/ })).toBeVisible();
    await animationsSettled(page);
    await saveShot(page, "lesson-parts/part-3-other-it-light.png");
    await page.keyboard.press("Escape");
    await expect(page.getByRole("button", { name: "Scegli altro" })).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(page.getByRole("button", { name: "Per oggi basta" })).toBeFocused();

    // A part picked in the column, from far down this one, opens at its title, which takes the focus. Back returns to
    // where the student was in the part before, as on every page.
    const toBottom = () => page.evaluate(() => window.scrollTo({ top: document.documentElement.scrollHeight }));
    await toBottom();
    await atRest(parts(page));
    const left = await page.evaluate(() => window.scrollY);
    expect(left).toBeGreaterThan(500);
    await parts(page).getByRole("link", { name: /Intorni e distanza/ }).click();
    const firstTitle = page.getByRole("heading", { level: 1, name: /Intorni e distanza/ });
    await expect(firstTitle).toBeFocused();
    await expect(firstTitle).toBeInViewport();
    await page.goBack();
    await expect(page.getByRole("heading", { level: 1, name: "Insiemi aperti e chiusi" })).toBeVisible();
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(left);

    // The narrow window: the column goes, and the bar's title opens the same list in a popover.
    // Part 4, written ahead, is ready to open from the popover.
    await expect
      .poll(async () => {
        const read = (await page.evaluate(() =>
          window.pyxis.invoke("study.parts", { planId: "p-an2", topicId: "t-funzioni" }),
        )) as { outline: { parts: Array<{ state: string }> } | null };
        return read.outline?.parts[3]?.state;
      }, { timeout: 20_000 })
      .toBe("written");
    await page.setViewportSize({ width: 960, height: 640 });
    await toBottom();
    const titleMenu = page.locator(".px-studybar-title-menu");
    await atRest(titleMenu);
    await expect(parts(page)).toHaveCount(0);
    await titleMenu.click();
    const popover = page.getByRole("dialog", { name: "Parti del capitolo" });
    await expect(popover).toBeVisible();
    await expect(titleMenu).toHaveAttribute("aria-expanded", "true");
    await animationsSettled(page);
    await expectNoAxeViolations(page);
    await saveShot(page, "lesson-parts/popover-it-light-960.png");
    await popover.getByRole("link", { name: /Compatti|Limitati/ }).click();
    await expect(popover).toHaveCount(0);
    await expect(page).toHaveURL(/\?part=4$/);
    // Picked from far down part 3, part 4 opens at its title, which takes the focus.
    const fourthTitle = page.getByRole("heading", { level: 1, name: "Limitati, compatti, connessi" });
    await expect(fourthTitle).toBeFocused();
    await expect(fourthTitle).toBeInViewport();
    await page.setViewportSize({ width: 1280, height: 800 });

    // Part 4, written ahead, opens at once; the C key answers it.
    await expect(page.getByRole("heading", { level: 1, name: "Limitati, compatti, connessi" })).toBeVisible();
    await expect(page.getByText("Compatti: l'idea")).toBeVisible({ timeout: 20_000 });
    await page.getByRole("heading", { level: 1 }).focus();
    await page.keyboard.press(await letterOf(page, "La cosa giusta"));
    await expect(continueButton(page)).toBeFocused();
    await expect(continueButton(page)).toContainText("Continua: Ripasso del capitolo");

    // The recap: three questions, answered with the A key in turn, finish the lesson.
    await page.keyboard.press("Enter");
    await expect(page.getByRole("heading", { level: 2, name: "Il capitolo in breve" })).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole("heading", { level: 1, name: "Ripasso del capitolo" })).toBeFocused();
    await expect(page.locator(".px-studybar-title")).toContainText("Ripasso del capitolo");
    await expect(page.getByText("tre domande alla fine", { exact: false })).toBeVisible();
    // A letter pressed in the second question's options answers that question, and the first stays open.
    const recapQuestions = page.getByRole("region", { name: "Ripasso finale" }).locator(".px-sb-question");
    const second = recapQuestions.nth(1);
    const secondOptions = await second.locator(".px-opt-text").allInnerTexts();
    await second.locator(".px-opt").first().focus();
    await page.keyboard.press(String.fromCharCode(97 + secondOptions.findIndex((option) => option.trim() === "Giusta")));
    await expect(second.locator(".px-sb-feedback")).toBeVisible();
    await expect(recapQuestions.nth(0).locator(".px-sb-feedback")).toHaveCount(0);
    // From the title, a letter answers the first question still open, then the next one.
    await page.getByRole("heading", { level: 1 }).focus();
    await page.keyboard.press("a");
    await expect(recapQuestions.nth(0).locator(".px-sb-feedback")).toBeVisible();
    await page.keyboard.press("a");
    await expect(page.getByText("Fine del capitolo")).toBeVisible();
    await expect(continueButton(page)).toBeFocused();
    await expect
      .poll(async () => {
        const plan = (await page.evaluate(() => window.pyxis.invoke("plans.read", { planId: "p-an2" }))) as {
          steps: Array<{ activity: string; topicId: string | null }>;
        };
        return plan.steps.some((step) => step.activity === "lesson" && step.topicId === "t-funzioni");
      })
      .toBe(true);
    // Continua names the path's next step, which is no longer the lesson.
    await expect(continueButton(page)).toHaveText(/^Continua: (?!Lezione)/);
    await saveShot(page, "lesson-parts/recap-done-it-light.png");

    // The part's menu opens from the dots and from a right-click on its head.
    await page.getByRole("heading", { level: 1 }).click({ button: "right" });
    await expect(page.getByRole("menuitem", { name: "Mappa" })).toBeVisible();
    await page.keyboard.press("Escape");
    await page.getByRole("heading", { level: 1 }).focus();
    await page.keyboard.press("Shift+F10");
    await expect(page.getByRole("menuitem", { name: "Esporta" })).toBeVisible();
    await page.keyboard.press("Escape");
    expect(errors).toEqual([]);
  } finally {
    await close();
    rmSync(holdDir, { recursive: true, force: true });
  }
});

test("a part whose failed job was dismissed in Attività stays failed, and Riprova writes it", async () => {
  test.setTimeout(180_000);
  const { page, close } = await start(
    [
      { markdown: partText("Intorni") },
      // Part 2, written ahead, comes back twice in a shape the reader cannot show, then right on Riprova.
      { markdown: "Testo senza sezioni." },
      { markdown: "Ancora testo senza sezioni." },
      { markdown: partText("Frontiera") },
      { markdown: partText("Aperti e chiusi") },
    ],
    [{ id: "t-funzioni", title: "Funzioni di più variabili", passages }],
  );
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const partTwoJobs = async () =>
    ((await page.evaluate(() => window.pyxis.invoke("jobs.list", {}))) as Array<{ kind: string; state: string; title: string | null }>).filter(
      (job) => job.kind === "lesson-part" && job.title?.startsWith("Parte 2 "),
    );
  try {
    await open(page, "t-funzioni");
    await expect(page.getByText("Intorni: l'idea")).toBeVisible({ timeout: 30_000 });
    await expect.poll(async () => (await partTwoJobs()).map((job) => job.state), { timeout: 20_000 }).toEqual(["failed"]);

    // Attività lists the failure, and Chiudi removes its job.
    await page.getByRole("button", { name: /^Attività/ }).click();
    const problem = page.locator(".px-jobs-problem").filter({ hasText: "Parte 2" });
    await expect(problem).toContainText("non riuscita");
    await problem.getByRole("button", { name: /^Chiudi/ }).click();
    await expect.poll(partTwoJobs).toEqual([]);
    await page.keyboard.press("Escape");

    // Back on the path, then on part 2: the page says the part could not be written and waits for Riprova, with no
    // job started, and the column has the part as the open one, not as one being written.
    await page.evaluate(() => {
      location.hash = "/plans/p-an2";
    });
    await expect(page.getByRole("heading", { level: 1, name: "Analisi Matematica 2" })).toBeVisible();
    await open(page, "t-funzioni", 2);
    await expect(page.getByText("Non sono riuscito a scrivere la parte 2.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Riprova" })).toBeVisible();
    expect(await partTwoJobs()).toEqual([]);
    await expect(parts(page).locator("a[aria-current=page]")).toContainText("Interno, esterno, frontiera");
    await expect(parts(page).getByRole("link", { name: /Interno, esterno, frontiera.*in scrittura/ })).toHaveCount(0);
    await expectNoAxeViolations(page);

    // Riprova writes it.
    await page.getByRole("button", { name: "Riprova" }).click();
    await expect(page.getByText("Frontiera: l'idea")).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText("Non sono riuscito a scrivere la parte 2.")).toHaveCount(0);
    expect(errors).toEqual([]);
  } finally {
    await close();
  }
});

test("a topic of one part has no column and no planning call, and a part without an AI tool is its book text with Fatto", async () => {
  test.setTimeout(180_000);
  const taylor = [{ id: "pt-1", text: "La formula di Taylor approssima una funzione con un polinomio.", section: "4.1" }];
  const series = Array.from({ length: 6 }, (_, i) => ({
    id: `ps-${i + 1}`,
    text: `Le serie di funzioni, paragrafo ${i + 1}. `.repeat(80),
    section: "5.1",
  }));
  const { page, prompts, db, close } = await start(
    [{ markdown: partText("Taylor") }],
    [
      { id: "t-taylor", title: "Formula di Taylor", passages: taylor },
      { id: "t-serie", title: "Serie di funzioni", passages: series },
    ],
  );
  try {
    await open(page, "t-taylor");
    await expect(working(page, "Sto scrivendo la lezione")).toBeVisible();
    await expect(page.getByText("Taylor: l'idea")).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole("heading", { level: 1, name: "Formula di Taylor" })).toBeVisible();
    await expect(parts(page)).toHaveCount(0);
    await expect(page.locator(".px-studybar-title")).not.toContainText("Parte 1");
    await expect(page.locator(".px-studybar-title")).toContainText("Analisi 2 · Analisi Matematica 2");
    await expect(page.getByText("Fine della lezione")).toBeVisible();
    // A narrow window has no list to open either.
    await page.setViewportSize({ width: 960, height: 640 });
    await expect(page.locator(".px-studybar-title-menu")).toHaveCount(0);
    await page.setViewportSize({ width: 1280, height: 800 });
    await expectNoAxeViolations(page);
    await saveShot(page, "lesson-parts/one-part-it-light.png");
    // One call wrote it: no planning call went out.
    const sent = readFileSync(prompts, "utf8").trim().split("\n").map((line) => JSON.parse(line) as string);
    expect(sent).toHaveLength(1);
    expect(sent[0]).not.toContain('"target"');

    // A planned topic, and no AI tool set up: part 1 shows its passages as book text, and Fatto finishes it.
    const write = db();
    write.exec("DELETE FROM feature_engines");
    write.exec(`INSERT INTO lesson_outlines(id,plan_id,topic_id,passage_key,origin,created_at) VALUES('o-serie','p-an2','t-serie','k','model',1);
      INSERT INTO lesson_parts(id,outline_id,position,kind,title,about,passage_ids_json,minutes) VALUES
        ('o-serie-1','o-serie',1,'part','Convergenza puntuale','', '["ps-1","ps-2","ps-3"]',6),
        ('o-serie-2','o-serie',2,'part','Convergenza uniforme','', '["ps-4","ps-5","ps-6"]',6);`);
    write.close();
    await open(page, "t-serie", 1);
    await expect(page.getByText("Non è stato possibile scrivere la lezione. Stai leggendo il testo delle fonti.", { exact: false })).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.getByText("Le serie di funzioni, paragrafo 1.", { exact: false }).first()).toBeVisible();
    await expect(page.getByText("Le serie di funzioni, paragrafo 4.", { exact: false })).toHaveCount(0);
    await saveShot(page, "lesson-parts/book-it-light.png");
    await page.getByRole("button", { name: "Fatto", exact: true }).click();
    await expect(continueButton(page)).toBeFocused();
    await expect(continueButton(page)).toContainText("Continua: Convergenza uniforme");
    await expect(parts(page).getByRole("link", { name: /Convergenza puntuale.*letta/ })).toBeVisible();
    await expectNoAxeViolations(page);
  } finally {
    await close();
  }
});
