import { expect, test, type Page } from "@playwright/test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { importPickedSource } from "./picked-source";
import { launchPyxis } from "./app-under-test";
import { makeBook } from "./book";
import { expectNoAxeViolations } from "./axe";
import { saveShot } from "./shots";
import { removeTestFolder } from "./cleanup";
import { fromChiediToExams } from "./doors";

const block = (kind: string, body: unknown) =>
  ["```pyxis-" + kind, JSON.stringify(body), "```"].join("\n");

// A recorded smart text with a closing recap; every topic's lesson uses it.
const lesson = [
  "## Che cos'è una forza",
  "",
  "Una **forza** cambia lo stato di moto di un corpo.",
  "",
  block("recap", {
    questions: [
      {
        question: "Qual è l'unità della forza?",
        options: ["Joule", "Newton", "Watt"],
        answer: 1,
        explanation: "Il newton.",
      },
      {
        question: "Se raddoppi la forza su una massa fissa, l'accelerazione…",
        options: ["raddoppia", "si dimezza", "non cambia"],
        answer: 0,
        explanation: "$a = F/m$.",
      },
    ],
  }),
].join("\n");

const chapters = [
  { number: 1, title: "Forze" },
  { number: 2, title: "Energia e lavoro" },
  { number: 3, title: "Onde meccaniche e suono" },
];

type Read = {
  steps: Array<{ activity: string; topicId: string | null; result: unknown }>;
  topics: Array<{ id: string; title: string }>;
};

async function language(page: Page, value: "it" | "en", theme: "light" | "dark") {
  await page.evaluate(
    async ({ value, theme }) => {
      localStorage.setItem("pyxis.lang", value);
      await window.pyxis.setAppearance(theme);
    },
    { value, theme },
  );
  await page.reload();
  // The loading skeleton is also a `.px-exam-now`; the real suggested step is the one whose heading has text.
  await expect(page.locator(".px-exam-now").getByRole("heading")).toHaveText(/\S/);
}

/** Opens a topic's row on the path, unless it is open already, and returns the list of its steps. */
async function topicSteps(page: Page, title: string) {
  const head = page.locator(".px-xpath-list").getByRole("button", { name: new RegExp(`^${title}`) });
  await expect(head).toBeVisible();
  if ((await head.getAttribute("aria-expanded")) === "false") await head.click();
  await expect(head).toHaveAttribute("aria-expanded", "true");
  const steps = page.getByRole("list", { name: new RegExp(`^(Passi di|Steps for) ${title}$`) });
  await expect(steps).toBeVisible();
  return steps;
}

/** A full-page shot from the top, so the sticky app bar stays at the top of the image. */
async function shoot(page: Page, name: string) {
  await page.evaluate(() => window.scrollTo(0, 0));
  await saveShot(page, name, { fullPage: true });
}

test("plan path: nothing locked, every activity is on the path, any topic's lesson records a step", async () => {
  test.setTimeout(240000);
  const userData = mkdtempSync(join(tmpdir(), "pyxis-path-"));
  const book = join(userData, "fisica.ptsb");
  writeFileSync(
    book,
    makeBook({
      id: "path",
      chapters: chapters.map((chapter) => ({
        title: chapter.title,
        text: `## p${chapter.number} | ${chapter.title}\nTesto su ${chapter.title}.\n`,
      })),
    }),
  );
  const replies = {
    markdown: { markdown: lesson },
    questions: {
      questions: Array.from({ length: 10 }, (_, i) => ({
        stem: `Che cosa cambia una forza ${i + 1}?`,
        options: ["Il moto", "Il colore", "La massa", "Il volume"],
        correct: 0,
        // The diagnostic needs a question on every topic.
        topicIndex: i % chapters.length,
        passageIds: [],
        explanation: "Una forza cambia il moto.",
      })),
    },
  };
  const env = {
    PYXIS_E2E_PLAN_REPLIES: JSON.stringify(replies),
  };
  const app = await launchPyxis({ userData, env });
  const combos = [
    ["it", "light"],
    ["it", "dark"],
    ["en", "light"],
    ["en", "dark"],
  ] as const;
  try {
    const page = await app.firstWindow();
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.getByRole("button", { name: "Salta" }).click();
    // Skipping saves the profile, then moves to Chiedi; wait so a reload or route change cannot land on setup.
    await fromChiediToExams(page);
    const { sourceId } = (await importPickedSource(page, app, book)) as { sourceId: string };
    await expect
      .poll(async () =>
        (
          (await page.evaluate(() => window.pyxis.invoke("sources.list", {}))) as Array<{
            id: string;
            status: string;
          }>
        ).find((row) => row.id === sourceId)?.status,
      )
      .toBe("ready");
    const { planId } = (await page.evaluate(
      (sourceId) =>
        window.pyxis.invoke("plans.create", { title: "Fisica 1", sourceIds: [sourceId], language: "it" }),
      sourceId,
    )) as { planId: string };
    await expect
      .poll(
        async () => {
          const build = (await page.evaluate(
            (planId) => window.pyxis.invoke("plans.build", { planId }),
            planId,
          )) as { state: string; error: string | null } | null;
          return build?.state === "failed" ? `failed: ${build.error}` : build?.state;
        },
        { timeout: 60000 },
      )
      .toBe("succeeded");
    const read = () =>
      page.evaluate((planId) => window.pyxis.invoke("plans.read", { planId }), planId) as Promise<Read>;
    const topics = (await read()).topics;
    expect(topics.map((topic) => topic.title)).toEqual(chapters.map((c) => c.title));

    // A new plan: the introduction is suggested, every topic is a row, nothing is locked.
    await page.evaluate((planId) => {
      location.hash = `/plans/${planId}`;
    }, planId);
    const next = page.locator(".px-exam-now");
    await expect(next.getByText("Adesso")).toBeVisible();
    await expect(next.getByRole("heading", { name: "Introduzione" })).toBeVisible();
    await expect(page.getByText(/Si sblocca|Unlocks/)).toHaveCount(0);
    await expect(page.locator(".px-node.is-locked, .lucide-lock")).toHaveCount(0);
    const path = page.getByRole("list", { name: `Percorso: ${topics.length} argomenti` });
    // Each topic is a row that opens; none is open while the path suggests the introduction, and nothing was measured.
    await expect(path.getByRole("button", { expanded: false })).toHaveCount(topics.length);
    await expect(path.getByRole("button", { expanded: true })).toHaveCount(0);
    await expect(path.getByText(/^\d+\/30$/)).toHaveCount(0);
    for (const [lang, theme] of combos) {
      await language(page, lang, theme);
      await shoot(page, `plan-path/new-plan-${lang}-${theme}.png`);
    }
    await language(page, "it", "light");
    await expectNoAxeViolations(page);

    // Every activity is on the path, so the student can skip the introduction and the diagnostic.
    for (const name of ["Introduzione", "Test diagnostico", "Simulazione d'esame"])
      await expect(path.getByRole("button", { name: new RegExp(`^${name}`) })).toBeVisible();
    const forFirst = await topicSteps(page, topics[0]!.title);
    for (const name of ["Lezione", "Esercizi", "Quiz"])
      await expect(forFirst.getByRole("button", { name: new RegExp(`^${name}`) })).toBeVisible();
    await forFirst.getByRole("button", { name: /^Lezione/ }).click();
    await expect(page).toHaveURL(new RegExp(`#/plans/${planId}/lesson/${topics[0]!.id}$`));
    // Opening records nothing.
    await expect(page.getByText("Una forza cambia lo stato di moto", { exact: false })).toBeVisible({
      timeout: 20000,
    });
    expect((await read()).steps).toEqual([]);
    const recap = page.getByRole("region", { name: "Ripasso finale" });
    await recap.scrollIntoViewIfNeeded();
    await recap.getByRole("button", { name: /^(B\s*)?Newton$/ }).click();
    await recap.getByRole("button", { name: /si dimezza/ }).click();
    await expect(page.getByText("Lezione completata")).toBeVisible();
    expect((await read()).steps).toMatchObject([{ activity: "lesson", topicId: topics[0]!.id }]);

    // After the first lesson Adesso suggests work on it.
    await page.getByRole("button", { name: "Torna al percorso" }).click();
    await expect(next.getByText("Adesso")).toBeVisible();
    await expect(next.getByRole("heading")).toHaveText(`Esercizio assistito: ${topics[0]!.title}`);
    await expect(next.getByText("Fissa quello che hai appena letto.")).toBeVisible();
    // The topic the path is on opens with its steps, and the suggested one says so.
    const firstSteps = page.getByRole("list", { name: `Passi di ${topics[0]!.title}` });
    await expect(firstSteps.getByRole("button", { name: "Lezione, letto" })).toBeVisible();
    await expect(firstSteps.getByRole("button", { name: "Esercizi, adesso" })).toBeVisible();
    await expect(firstSteps.getByRole("button", { name: "Quiz, da fare" })).toBeVisible();

    // Another topic opens on a click, and closes the one before.
    const forThird = await topicSteps(page, topics[2]!.title);
    await expect(firstSteps).toHaveCount(0);
    for (const [lang, theme] of combos) {
      await language(page, lang, theme);
      await topicSteps(page, topics[2]!.title);
      await shoot(page, `plan-path/another-topic-${lang}-${theme}.png`);
    }
    await language(page, "it", "light");
    await topicSteps(page, topics[2]!.title);

    // A lesson on a topic the path did not suggest still records a done step.
    await forThird.getByRole("button", { name: /^Lezione/ }).click();
    await expect(page).toHaveURL(new RegExp(`#/plans/${planId}/lesson/${topics[2]!.id}$`));
    await expect(page.getByText("Una forza cambia lo stato di moto", { exact: false })).toBeVisible({
      timeout: 20000,
    });
    await recap.scrollIntoViewIfNeeded();
    await recap.getByRole("button", { name: /^(B\s*)?Newton$/ }).click();
    await recap.getByRole("button", { name: /raddoppia/ }).click();
    await expect(page.getByText("Lezione completata")).toBeVisible();
    expect((await read()).steps.map((step) => [step.activity, step.topicId])).toEqual([
      ["lesson", topics[0]!.id],
      ["lesson", topics[2]!.id],
    ]);
    // "Continue" on a finished lesson opens the path's next suggestion, not the plan.
    const guide = (await page.evaluate(
      (planId) => window.pyxis.invoke("plans.recommend", { planId }),
      planId,
    )) as { next: { activity: string; topicId: string | null } };
    await page.getByRole("button", { name: "Continua", exact: true }).click();
    await expect(page).toHaveURL(
      new RegExp(`#/plans/${planId}/${guide.next.activity}${guide.next.topicId ? `/${guide.next.topicId}` : ""}`),
    );
    await page.evaluate((planId) => {
      location.hash = `/plans/${planId}`;
    }, planId);
    // Both lessons are done steps on their topics.
    await expect((await topicSteps(page, topics[2]!.title)).getByRole("button", { name: /^Lezione, letto/ })).toBeVisible();
    // Any topic opens on a click, and its steps go straight to the activity; still nothing is locked.
    await path.getByRole("button", { name: new RegExp(`^${topics[1]!.title}`) }).click();
    const secondSteps = page.getByRole("list", { name: `Passi di ${topics[1]!.title}` });
    await expect(secondSteps.getByRole("button", { name: "Lezione, da fare" })).toBeVisible();
    await expect(page.getByRole("list", { name: `Passi di ${topics[0]!.title}` })).toHaveCount(0);
    await expect(page.locator(".px-node.is-locked, .lucide-lock")).toHaveCount(0);
    await expectNoAxeViolations(page);
    for (const [lang, theme] of combos) {
      await language(page, lang, theme);
      await shoot(page, `plan-path/mid-way-${lang}-${theme}.png`);
    }
  } finally {
    await app.close();
    removeTestFolder(userData);
  }
});

test("plan path: a finished lesson, quiz or exercise opens for review, and only Redo adds a step", async () => {
  test.setTimeout(240000);
  const userData = mkdtempSync(join(tmpdir(), "pyxis-path-review-"));
  const book = join(userData, "fisica.ptsb");
  writeFileSync(
    book,
    makeBook({
      id: "path-review",
      chapters: [
        { title: chapters[0]!.title, text: "## p1 | Forze\nUna forza cambia il moto.\n" },
        { title: chapters[1]!.title, text: "## p2 | Energia e lavoro\nIl lavoro è forza per spostamento.\n" },
      ],
      files: {
        "esercizi.md":
          ':::exercise{id="push" chapter="1"}\nQuanto vale la forza su 2 kg a 3 m/s²?\n:::solution\nF = m a = 6 N.\n:::\n:::',
      },
    }),
  );
  const replies = {
    markdown: { markdown: lesson },
    questions: {
      questions: Array.from({ length: 10 }, (_, i) => ({
        stem: `Che cosa cambia una forza ${i + 1}?`,
        options: ["Il moto", "Il colore", "La massa", "Il volume"],
        correct: 0,
        topicIndex: i % 2,
        passageIds: [],
        explanation: "Una forza cambia il moto.",
      })),
    },
    quizQuestions: {
      questions: Array.from({ length: 10 }, (_, i) => ({
        kind: "tf",
        stem: `Una forza cambia il moto. Affermazione {{question:${i}}}.`,
        correct: true,
        passageIds: ["{{passage:0}}"],
        explanation: "Una forza cambia il moto.",
      })),
    },
  };
  const env = {
    PYXIS_E2E_PLAN_REPLIES: JSON.stringify(replies),
  };
  const app = await launchPyxis({ userData, env });
  try {
    const page = await app.firstWindow();
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.getByRole("button", { name: "Salta" }).click();
    await fromChiediToExams(page);
    const invoke = <T,>(channel: string, input: unknown) =>
      page.evaluate(
        ({ channel, input }) => window.pyxis.invoke(channel as never, input as never),
        { channel, input },
      ) as Promise<T>;
    const { sourceId } = (await importPickedSource(page, app, book)) as { sourceId: string };
    await expect
      .poll(async () =>
        (await invoke<Array<{ id: string; status: string }>>("sources.list", {})).find(
          (row) => row.id === sourceId,
        )?.status,
      )
      .toBe("ready");
    const { planId } = await invoke<{ planId: string }>("plans.create", {
      title: "Fisica 1",
      sourceIds: [sourceId],
      language: "it",
    });
    await expect
      .poll(async () => (await invoke<{ state: string }>("plans.build", { planId }))?.state, {
        timeout: 60000,
      })
      .toBe("succeeded");
    type Steps = Array<{
      activity: string;
      topicId: string | null;
      attemptId: string | null;
      itemId: string | null;
    }>;
    const read = () => invoke<Omit<Read, "steps"> & { steps: Steps }>("plans.read", { planId });
    const topic = (await read()).topics[0]!;

    // A lesson read, a quiz handed in and a set of exercises finished, all on the first topic.
    await page.evaluate(
      ({ planId, topicId }) => {
        location.hash = `/plans/${planId}/lesson/${topicId}`;
      },
      { planId, topicId: topic.id },
    );
    await expect(page.getByText("Una forza cambia lo stato di moto", { exact: false })).toBeVisible({
      timeout: 20000,
    });
    await invoke("plans.complete", { planId, activity: "lesson", topicId: topic.id });
    const quiz = await invoke<{ attemptId: string }>("study.quizStart", {
      planId,
      topicId: topic.id,
      types: ["tf"],
    });
    await expect
      .poll(async () => (await invoke<{ state: string }>("study.quizRead", { attemptId: quiz.attemptId })).state)
      .toBe("succeeded");
    const { questions } = await invoke<{ questions: Array<{ id: string }> }>("study.quizRead", {
      attemptId: quiz.attemptId,
    });
    await invoke("study.quizSubmit", {
      attemptId: quiz.attemptId,
      picks: Object.fromEntries(questions.map((question, i) => [question.id, i < 6 ? "true" : "false"])),
    });
    await expect.poll(async () => (await read()).steps.length).toBe(2);
    await invoke("plans.complete", { planId, activity: "practice", topicId: topic.id });
    const before = (await read()).steps;
    expect(before.map((step) => [step.activity, step.attemptId])).toEqual([
      ["lesson", null],
      ["quiz", quiz.attemptId],
      ["practice", null],
    ]);

    await page.evaluate((planId) => {
      location.hash = `/plans/${planId}`;
    }, planId);
    // The path stays on the topic: after exercises, a quiz to check them.
    await expect(page.locator(".px-exam-now").getByRole("heading")).toHaveText(`Quiz: ${topic.title}`);
    const done = await topicSteps(page, topic.title);

    // The lesson opens as it was read, by its item, even after the profile's wording changed; no chooser opens, no
    // lesson is written and nothing is recorded.
    const lessonItem = before[0]!.itemId;
    expect(lessonItem).toBeTruthy();
    const lessonRows = () => {
      const db = new DatabaseSync(join(userData, "workspace", "pyxis.db"), { timeout: 10000 });
      try {
        return (db.prepare("SELECT COUNT(*) AS n FROM items WHERE kind = 'lesson'").get() as { n: number }).n;
      } finally {
        db.close();
      }
    };
    expect(lessonRows()).toBe(1);
    const db = new DatabaseSync(join(userData, "workspace", "pyxis.db"), { timeout: 10000 });
    db.prepare("UPDATE profile SET wording_level = 'technical'").run();
    db.close();
    await done.getByRole("button", { name: /^Lezione, letto/ }).click();
    await expect(page).toHaveURL(new RegExp(`#/plans/${planId}/lesson/${topic.id}\\?item=${lessonItem}$`));
    await expect(page.getByText("Una forza cambia lo stato di moto", { exact: false })).toBeVisible({
      timeout: 20000,
    });
    // The lesson was written at the default wording; the profile's new one does not replace it.
    await expect(page.getByRole("button", { name: "Livello Bilanciato" })).toBeVisible();
    expect(lessonRows()).toBe(1);
    expect((await read()).steps).toEqual(before);
    await page.goBack();

    // The quiz opens read-only on its own attempt, with the score and Redo.
    await topicSteps(page, topic.title);
    await done.getByRole("button", { name: /^Quiz, 6\/10/ }).click();
    await expect(page).toHaveURL(new RegExp(`quiz/${topic.id}\\?attempt=${quiz.attemptId}$`));
    await expect(page.locator(".px-res-headline")).toContainText("6 punti su 10.");
    await expect(page.getByText(/^Le tue risposte del /)).toBeVisible();
    await expect(page.getByRole("button", { name: "Torna al percorso" })).toBeVisible();
    await expect(page.locator(".px-qz-sheet")).toHaveCount(0);
    await expectNoAxeViolations(page);
    for (const [lang, theme] of [
      ["it", "light"],
      ["it", "dark"],
      ["en", "light"],
      ["en", "dark"],
    ] as const) {
      await page.evaluate(
        async ({ lang, theme }) => {
          localStorage.setItem("pyxis.lang", lang);
          await window.pyxis.setAppearance(theme);
        },
        { lang, theme },
      );
      await page.reload();
      await expect(page.getByRole("button", { name: /^(Rifai|Redo)$/ })).toBeVisible();
      await shoot(page, `plan-path/quiz-review-${lang}-${theme}.png`);
    }
    await page.evaluate(async () => {
      localStorage.setItem("pyxis.lang", "it");
      await window.pyxis.setAppearance("light");
    });
    await page.reload();
    expect((await read()).steps).toEqual(before);

    // Redo opens a new quiz; only handing it in adds a step, with its own attempt.
    await page.getByRole("button", { name: "Rifai", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`quiz/${topic.id}$`));
    await expect(page.getByRole("button", { name: "Inizia", exact: true })).toBeVisible();
    expect((await read()).steps).toEqual(before);
    await page.getByRole("button", { name: "Personalizza" }).click();
    await page.getByRole("button", { name: "Solo vero o falso", exact: true }).click();
    await page.getByRole("button", { name: "Inizia", exact: true }).click();
    const vero = page.getByRole("button", { name: "A Vero", exact: true });
    for (let i = 0; i < 10; i++) {
      await expect(page.getByText(`Domanda ${i + 1} di 10`, { exact: true })).toBeVisible();
      await vero.click();
      // Avanti, and on the last question Consegna, which hands in at once with nothing blank.
      await page.locator(".px-qz-nav .px-btn-primary").click();
    }
    await expect(page.locator(".px-res-headline")).toContainText("10 punti su 10.");
    // A quiz just handed in is not a review: it continues the path and offers no Redo.
    await expect(page.getByRole("button", { name: "Continua" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Rifai", exact: true })).toHaveCount(0);
    const after = (await read()).steps;
    expect(after.slice(0, 3)).toEqual(before);
    expect(after.slice(3)).toMatchObject([{ activity: "quiz", topicId: topic.id }]);
    expect(after[3]!.attemptId).not.toBe(quiz.attemptId);
    await page.getByRole("button", { name: "Continua" }).click();

    // Finished exercises open without "Mark as done"; going back records nothing.
    await topicSteps(page, topic.title);
    await done.getByRole("button", { name: "Esercizi, fatto" }).click();
    await expect(page).toHaveURL(new RegExp(`practice/${topic.id}\\?review=1$`));
    await expect(page.getByText("Hai già finito questi esercizi.", { exact: false })).toBeVisible();
    await expect(page.getByText("Quanto vale la forza", { exact: false })).toBeVisible();
    await expect(page.getByRole("button", { name: "Segna come fatto" })).toHaveCount(0);
    await expectNoAxeViolations(page);
    await shoot(page, `plan-path/practice-review-it-light.png`);
    await page.getByRole("button", { name: "Torna al percorso" }).click();
    await expect(page).toHaveURL(new RegExp(`#/plans/${planId}$`));
    expect((await read()).steps).toEqual(after);

    // A finished cards step opens in review: no cards are generated and no second step is recorded.
    await invoke("plans.complete", { planId, activity: "cards", topicId: topic.id });
    const withCards = (await read()).steps;
    expect(withCards).toHaveLength(after.length + 1);
    const cardJobs = () => {
      const db = new DatabaseSync(join(userData, "workspace", "pyxis.db"), { timeout: 10000 });
      try {
        return (db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE kind LIKE 'card%'").get() as { n: number }).n;
      } finally {
        db.close();
      }
    };
    expect(cardJobs()).toBe(0);
    await page.reload();
    await topicSteps(page, topic.title);
    await done.getByRole("button", { name: "Flashcard, fatto" }).click();
    await expect(page).toHaveURL(new RegExp(`cards/${topic.id}\\?review=1$`));
    await expect(page.getByText("Hai già fatto queste flashcard.", { exact: false })).toBeVisible();
    await expect(page.getByText("Nessuna flashcard in scadenza.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Segna come fatto" })).toHaveCount(0);
    await expectNoAxeViolations(page);
    await shoot(page, `plan-path/cards-review-it-light.png`);
    // The study bar's way back to the exam is the only way out of a card session.
    await expect(page.getByRole("button", { name: "Chiudi", exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: /^Torna all'esame: / }).click();
    await expect(page).toHaveURL(new RegExp(`#/plans/${planId}$`));
    expect(cardJobs()).toBe(0);
    expect((await read()).steps).toEqual(withCards);

    // Shared with its progress, the copy's finished quiz has no answers to show: the page says so and offers Redo.
    const file = await page.evaluate(
      (planId) => window.pyxis.invoke("plans.export", { planId, progress: true }),
      planId,
    );
    const copy = (await page.evaluate((file) => window.pyxis.invoke("plans.import", file), file)) as {
      planId: string;
    };
    await page.evaluate((planId) => {
      location.hash = `/plans/${planId}`;
    }, copy.planId);
    // The topic's quiz step reopens the latest one handed in.
    await topicSteps(page, topic.title);
    await done.getByRole("button", { name: /^Quiz, 10\/10/ }).click();
    await expect(page).toHaveURL(new RegExp(`#/plans/${copy.planId}/quiz/[^/?]+\\?attempt=`));
    await expect(page.getByText("Le risposte di questo tentativo non erano incluse nell'esame condiviso.")).toBeVisible();
    await expect(page.locator(".px-qz-sheet")).toHaveCount(0);
    await expect(page.locator(".px-res")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Torna al percorso" })).toBeVisible();
    await expectNoAxeViolations(page);
    for (const [lang, theme] of [
      ["it", "light"],
      ["it", "dark"],
      ["en", "light"],
      ["en", "dark"],
    ] as const) {
      await page.evaluate(
        async ({ lang, theme }) => {
          localStorage.setItem("pyxis.lang", lang);
          await window.pyxis.setAppearance(theme);
        },
        { lang, theme },
      );
      await page.reload();
      await expect(page.getByRole("button", { name: /^(Rifai|Redo)$/ })).toBeVisible();
      await expect(
        page.getByText(/^(Le risposte di questo tentativo non erano incluse|The answers of this attempt weren't included)/),
      ).toBeVisible();
      await shoot(page, `plan-path/quiz-imported-${lang}-${theme}.png`);
    }
    await page.evaluate(async () => {
      localStorage.setItem("pyxis.lang", "it");
      await window.pyxis.setAppearance("light");
    });
    await page.reload();
    await page.getByRole("button", { name: "Rifai", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`#/plans/${copy.planId}/quiz/[^/?]+$`));
    await expect(page.getByRole("button", { name: "Inizia", exact: true })).toBeVisible();
  } finally {
    await app.close();
    removeTestFolder(userData);
  }
});
