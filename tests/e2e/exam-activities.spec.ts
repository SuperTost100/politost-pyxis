import {
  expect,
  test,
  type ElectronApplication,
  type Locator,
  type Page,
} from "@playwright/test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchPyxis } from "./app-under-test";
import { expectNoAxeViolations } from "./axe";
import { makeBook } from "./book";
import { removeTestFolder } from "./cleanup";
import { fromChiediToExams } from "./doors";
import { importPickedSource } from "./picked-source";
import { animationsSettled, atRest } from "./settled";
import { saveShot } from "./shots";

const replies = {
  // The plan's build writes a diagnostic: ten questions over the book's two chapters.
  questions: {
    questions: Array.from({ length: 10 }, (_, i) => ({
      stem: `Diagnosi ${i}: che cosa descrive ${i % 2 ? "la derivata" : "il limite"}?`,
      options: ["Un cambiamento", "Una massa", "Una carica", "Una temperatura"],
      correct: 0,
      topicIndex: i % 2,
      passageIds: [`{{passage:${i % 2}}}`],
      explanation: `Lo dice il libro [{{passage:${i % 2}}}].`,
    })),
  },
  markdown: {
    markdown: "## Il limite\nIl limite descrive dove va una funzione [P1].",
  },
  quizQuestions: {
    questions: Array.from({ length: 10 }, (_, i) => ({
      kind: "tf",
      stem: `Un limite può non esistere. Affermazione {{question:${i}}}.`,
      correct: true,
      passageIds: ["{{passage:0}}"],
      explanation:
        "Una funzione può oscillare senza avvicinarsi a nessun valore.",
    })),
  },
};

async function invoke<T = unknown>(
  page: Page,
  channel: string,
  input: unknown,
): Promise<T> {
  return (await page.evaluate(
    ({ channel, input }) =>
      window.pyxis.invoke(channel as never, input as never),
    { channel, input },
  )) as T;
}

/** A fresh app on a two-chapter smartbook, with an exam built from it and dated in 30 days. */
async function launch() {
  const userData = mkdtempSync(join(tmpdir(), "pyxis-activities-"));
  const file = join(userData, "book.ptsb");
  writeFileSync(
    file,
    makeBook({
      id: "analisi",
      title: "Analisi",
      chapters: [
        {
          title: "Limiti",
          text: "## p1 | Il limite\nIl limite descrive dove va una funzione.\n",
        },
        {
          title: "Derivate",
          text: "## p1 | La derivata\nLa derivata misura come cambia una funzione.\n",
        },
      ],
    }),
  );
  const app: ElectronApplication = await launchPyxis({
    userData,
    env: {
      PYXIS_E2E_PLAN_REPLIES: JSON.stringify(replies),
      PYXIS_E2E_PLAN_DELAY: "0",
    },
  });
  const page = await app.firstWindow();
  await page.getByRole("button", { name: "Salta" }).click();
  await fromChiediToExams(page);
  const source = (await importPickedSource(page, app, file)) as {
    sourceId: string;
  };
  await expect
    .poll(
      async () =>
        (
          await invoke<Array<{ id: string; status: string }>>(
            page,
            "sources.list",
            {},
          )
        ).find((row) => row.id === source.sourceId)?.status,
    )
    .toBe("ready");
  const { planId } = await invoke<{ planId: string }>(page, "plans.create", {
    title: "Analisi 1",
    sourceIds: [source.sourceId],
  });
  await expect
    .poll(
      async () =>
        (await invoke<{ state: string }>(page, "plans.build", { planId }))
          .state,
      { timeout: 60_000 },
    )
    .toBe("succeeded");
  const examDay = new Date();
  examDay.setDate(examDay.getDate() + 30);
  examDay.setHours(12, 0, 0, 0);
  await invoke(page, "plans.settings", {
    planId,
    title: "Analisi 1",
    target: 0.75,
    sessions: [{ date: examDay.getTime() }],
  });
  const plan = await invoke<{ topics: Array<{ id: string; title: string }> }>(
    page,
    "plans.read",
    { planId },
  );
  const done = async () => {
    await app.close();
    removeTestFolder(userData);
  };
  return { app, page, userData, planId, topics: plan.topics, done };
}

async function openExam(page: Page, planId: string) {
  await page.evaluate((id) => {
    location.hash = `/plans/${id}`;
  }, planId);
  await expect(
    page.getByRole("heading", { level: 1, name: "Analisi 1" }),
  ).toBeVisible();
}

const dialogOf = (page: Page) =>
  page.getByRole("dialog", { name: "Crea un'attività" });

/** Opens "Crea un'attività" from the exam page's Altro menu. */
async function fromAltro(page: Page) {
  await page
    .locator(".px-exam-head")
    .getByRole("button", { name: "Altro", exact: true })
    .click();
  await page.getByRole("menuitem", { name: "Crea un'attività" }).click();
  const dialog = dialogOf(page);
  await expect(dialog).toBeVisible();
  await animationsSettled(page);
  return dialog;
}

/** Opens a topic on the path and its "Crea un'attività". */
async function fromTopic(page: Page, title: string) {
  const path = page.locator(".px-xpath-list");
  const head = path.getByRole("button", { name: new RegExp(`^${title}`) });
  if ((await head.getAttribute("aria-expanded")) !== "true") await head.click();
  const plus = path
    .locator(".px-xpath-tools")
    .getByRole("button", { name: "Crea un'attività" });
  await plus.click();
  const dialog = dialogOf(page);
  await expect(dialog).toBeVisible();
  await animationsSettled(page);
  return { dialog, plus };
}

const kind = (dialog: Locator, name: string) =>
  dialog.getByRole("radio", { name, exact: true });

test("Crea un'attività starts every kind in one step, from Altro and from a topic, by mouse and keyboard", async () => {
  test.setTimeout(180_000);
  const { page, planId, topics, done } = await launch();
  try {
    await openExam(page, planId);
    const [limiti, derivate] = topics;

    // From Altro: the dialog opens on a quiz, on the topic the path is on, with the focus on the chosen kind.
    const altro = page
      .locator(".px-exam-head")
      .getByRole("button", { name: "Altro", exact: true });
    let dialog = await fromAltro(page);
    await expect(kind(dialog, "Quiz")).toBeFocused();
    await expect(kind(dialog, "Quiz")).toHaveAttribute("aria-checked", "true");
    await expect(dialog.getByLabel("Argomento")).toHaveValue(limiti!.id);
    await expectNoAxeViolations(page);
    // One step: no Back, and Annulla beside Crea.
    await expect(
      dialog.getByRole("button", { name: /^(Indietro|Back)$/ }),
    ).toHaveCount(0);
    await expect(dialog.getByRole("button", { name: "Annulla" })).toBeVisible();

    // The kinds of question are toggle chips, all pressed. Tab reaches them and Space turns one off; the last one on
    // stays on and says why.
    const chips = dialog
      .getByRole("group", { name: "Domande", exact: true })
      .getByRole("button");
    await expect(chips).toHaveCount(5);
    for (const chip of await chips.all())
      await expect(chip).toHaveAttribute("aria-pressed", "true");
    await chips.first().focus();
    await page.keyboard.press("Space");
    await expect(chips.first()).toHaveAttribute("aria-pressed", "false");
    for (const name of ["Completamento", "Abbinamento", "Risposta aperta"])
      await dialog.getByRole("button", { name, exact: true }).click();
    const last = dialog.getByRole("button", {
      name: "Vero o falso",
      exact: true,
    });
    await expect(last).toHaveAttribute("aria-disabled", "true");
    await expect(last).toHaveAccessibleDescription(
      "Almeno un tipo di domanda resta scelto.",
    );
    // Space on the held chip changes nothing.
    await last.focus();
    await page.keyboard.press("Space");
    await expect(last).toHaveAttribute("aria-pressed", "true");
    // How many questions stops at what core writes.
    const more = dialog.getByRole("button", { name: "Una domanda in più" });
    // It starts at 8; two more reach ten, and the button stops there.
    await more.click();
    await more.click();
    await expect(more).toBeDisabled();
    await expect(
      dialog
        .getByRole("group", { name: /^Quante domande/ })
        .getByRole("textbox"),
    ).toHaveValue("10");
    await saveShot(dialog, "exam-activities/dialog-quiz.png", {
      animations: "disabled",
    });

    // The arrow keys move the kind, and its options change in place.
    await kind(dialog, "Quiz").focus();
    await page.keyboard.press("ArrowRight");
    await expect(kind(dialog, "Flashcard")).toBeFocused();
    await expect(dialog.getByText(/Le flashcard dell'argomento/)).toBeVisible();
    await page.keyboard.press("ArrowLeft");
    await expect(kind(dialog, "Quiz")).toHaveAttribute("aria-checked", "true");

    // Escape closes it and gives the focus back to Altro.
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(altro).toBeFocused();

    // A quiz by keyboard: Altro's menu, the topic, Crea. Adesso shows the work, then the quiz opens.
    await altro.press("Enter");
    await page
      .getByRole("menuitem", { name: "Crea un'attività" })
      .press("Enter");
    dialog = dialogOf(page);
    await expect(kind(dialog, "Quiz")).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(dialog.getByLabel("Argomento")).toBeFocused();
    await dialog.getByLabel("Argomento").selectOption(derivate!.id);
    // Tab walks the chips; Space leaves only true or false, the kind the recorded replies write.
    for (const name of ["Scelta multipla", "Completamento", "Abbinamento", "Vero o falso", "Risposta aperta"]) {
      await page.keyboard.press("Tab");
      await expect(dialog.getByRole("button", { name, exact: true })).toBeFocused();
      if (name !== "Vero o falso") await page.keyboard.press("Space");
    }
    await dialog.getByRole("button", { name: "Crea", exact: true }).focus();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(
      new RegExp(`#/plans/${planId}/quiz/${derivate!.id}\\?attempt=`),
    );
    await expect(page.getByText(/^Domanda 1 di \d+$/)).toBeVisible();

    // From a topic's "+": the dialog opens on that topic. A lesson, flashcards, exercises and a map open their pages.
    for (const [name, path] of [
      ["Lezione", "lesson"],
      ["Flashcard", "cards"],
      ["Esercizi", "practice"],
      ["Mappa", "map"],
    ] as const) {
      await openExam(page, planId);
      const opened = await fromTopic(page, "Derivate");
      await expect(opened.dialog.getByLabel("Argomento")).toHaveValue(
        derivate!.id,
      );
      await kind(opened.dialog, name).click();
      await opened.dialog
        .getByRole("button", { name: "Crea", exact: true })
        .click();
      await expect(page, name).toHaveURL(
        new RegExp(`#/plans/${planId}/${path}/${derivate!.id}`),
      );
    }

    // Annulla from a topic gives the focus back to its "+".
    await openExam(page, planId);
    const fromPlus = await fromTopic(page, "Limiti");
    await fromPlus.dialog.getByRole("button", { name: "Annulla" }).click();
    await expect(fromPlus.dialog).toBeHidden();
    await expect(fromPlus.plus).toBeFocused();

    // A simulation covers the whole exam and offers its length and material in place.
    dialog = await fromAltro(page);
    await kind(dialog, "Simulazione").click();
    await expect(dialog.getByText("Tutto il programma")).toBeVisible();
    await expect(
      dialog.getByRole("radiogroup", { name: "Durata" }).getByRole("radio"),
    ).toHaveCount(4);
    await expect(
      dialog.getByRole("radiogroup", { name: "Materiale" }).getByRole("radio"),
    ).toHaveCount(2);
    await dialog.getByRole("radio", { name: "30 min" }).click();
    await saveShot(dialog, "exam-activities/dialog-simulation.png", {
      animations: "disabled",
    });
    await expectNoAxeViolations(page);
    await dialog.getByRole("button", { name: "Crea", exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(page).toHaveURL(
      new RegExp(`#/plans/${planId}/(simulation|exam/)`),
      { timeout: 30_000 },
    );
  } finally {
    await done();
  }
});

test("Da finire lists an unfinished quiz, resumes it at its question, and deletes by menu and by right-click", async () => {
  test.setTimeout(180_000);
  const { page, planId, topics, userData, done } = await launch();
  try {
    const [limiti, derivate] = topics;
    // Two quizzes started and left: one with two answers given, on its third question; one not answered yet.
    const first = await invoke<{ attemptId: string }>(page, "study.quizStart", {
      planId,
      topicId: limiti!.id,
      count: 8,
      types: ["tf"],
    });
    await expect
      .poll(
        async () =>
          (
            await invoke<{ state: string }>(page, "study.quizRead", {
              attemptId: first.attemptId,
              planId,
            })
          ).state,
        {
          timeout: 30_000,
        },
      )
      .toBe("succeeded");
    const read = await invoke<{ questions: Array<{ id: string }> }>(
      page,
      "study.quizRead",
      { attemptId: first.attemptId, planId },
    );
    await invoke(page, "study.quizDraft", {
      attemptId: first.attemptId,
      planId,
      picks: {
        [read.questions[0]!.id]: "true",
        [read.questions[1]!.id]: "false",
      },
      index: 2,
    });
    const second = await invoke<{ attemptId: string }>(
      page,
      "study.quizStart",
      { planId, topicId: derivate!.id, count: 5, types: ["tf"] },
    );
    await expect
      .poll(
        async () =>
          (
            await invoke<{ state: string }>(page, "study.quizRead", {
              attemptId: second.attemptId,
              planId,
            })
          ).state,
        {
          timeout: 30_000,
        },
      )
      .toBe("succeeded");

    await openExam(page, planId);
    const block = page.locator(".px-unf");
    await expect(
      block.getByRole("heading", { name: /^Da finire/ }),
    ).toContainText("2 attività");
    const quizLimiti = block.getByRole("button", {
      name: /^Riprendi: Quiz su Limiti/,
    });
    await expect(quizLimiti).toContainText(/2 di \d+ domande · oggi alle/);
    await expect(
      block.getByRole("button", { name: /^Riprendi: Quiz su Derivate/ }),
    ).toContainText(/0 di 5 domande/);
    // The newest first.
    await expect(block.locator(".px-unf-open").first()).toContainText(
      "Quiz su Derivate",
    );
    // The topic's own row on the path keeps its quizzes.
    await expectNoAxeViolations(page);
    await saveShot(page, "exam-activities/unfinished.png", {
      fullPage: true,
      animations: "disabled",
    });

    // Riprendi returns to the question the student left.
    await quizLimiti.click();
    await expect(page).toHaveURL(
      new RegExp(`quiz/${limiti!.id}\\?attempt=${first.attemptId}`),
    );
    await expect(page.getByText(/^Domanda 3 di \d+$/)).toBeVisible();

    // Elimina from the dots: the confirmation says what is lost, Annulla is the safe default.
    await openExam(page, planId);
    await block
      .getByRole("button", { name: "Azioni su Quiz su Limiti" })
      .click();
    await expect(page.getByRole("menuitem")).toHaveText([
      "Riprendi",
      "Elimina…",
    ]);
    await page.getByRole("menuitem", { name: "Elimina…" }).click();
    const confirm = page.getByRole("dialog", {
      name: "Eliminare «Quiz su Limiti»?",
    });
    await expect(confirm).toContainText(
      "Le 2 risposte che hai già dato si perdono. Il quiz resta nel percorso, da rifare.",
    );
    await expect(
      confirm.getByRole("button", { name: "Annulla" }),
    ).toBeFocused();
    await confirm.getByRole("button", { name: "Elimina", exact: true }).click();
    await expect(
      block.getByRole("button", { name: /^Riprendi: Quiz su Limiti/ }),
    ).toHaveCount(0);
    await expect(
      page
        .getByRole("status")
        .filter({ hasText: "Attività eliminata: Quiz su Limiti" }),
    ).toBeAttached();
    await expect(
      block.getByRole("heading", { name: /^Da finire/ }),
    ).toContainText("1 attività");
    // Its answers are gone; the quiz stays among the topic's activities.
    const db = new DatabaseSync(join(userData, "workspace", "pyxis.db"));
    expect(
      db
        .prepare("SELECT COUNT(*) AS n FROM attempts WHERE id = ?")
        .get(first.attemptId),
    ).toEqual({ n: 0 });
    db.close();

    // Elimina from a right-click on the row: the same menu, at the pointer. Once nothing is left, the block goes.
    const row = block.locator(".px-unf-item").first();
    await atRest(row);
    await row.click({ button: "right" });
    await expect(page.getByRole("menuitem")).toHaveText([
      "Riprendi",
      "Elimina…",
    ]);
    await page.getByRole("menuitem", { name: "Elimina…" }).click();
    const again = page.getByRole("dialog", {
      name: "Eliminare «Quiz su Derivate»?",
    });
    await expect(again).toContainText(
      "Non hai ancora risposto a nessuna domanda.",
    );
    await again.getByRole("button", { name: "Elimina", exact: true }).click();
    await expect(page.locator(".px-unf")).toHaveCount(0);
    await expect(
      page
        .getByRole("status")
        .filter({ hasText: "Attività eliminata: Quiz su Derivate" }),
    ).toBeAttached();
  } finally {
    await done();
  }
});

/** Starts a quiz on a topic through core and waits until its questions are written. */
async function startQuiz(page: Page, planId: string, topicId: string) {
  const started = await invoke<{ attemptId: string }>(page, "study.quizStart", {
    planId,
    topicId,
    count: 5,
    types: ["tf"],
  });
  await expect
    .poll(
      async () =>
        (
          await invoke<{ state: string }>(page, "study.quizRead", {
            attemptId: started.attemptId,
            planId,
          })
        ).state,
      { timeout: 30_000 },
    )
    .toBe("succeeded");
  return started.attemptId;
}

test("Da finire says when its list cannot be read, and Riprova reads it again", async () => {
  test.setTimeout(120_000);
  const { page, planId, topics, userData, done } = await launch();
  try {
    await startQuiz(page, planId, topics[0]!.id);
    // A quiz row whose body cannot be read makes the whole list fail, as a damaged workspace would.
    const db = new DatabaseSync(join(userData, "workspace", "pyxis.db"));
    db.prepare(
      "INSERT INTO items (id, plan_id, topic_id, kind, body_json, created_at) VALUES ('broken', ?, ?, 'quiz', '[]', 1)",
    ).run(planId, topics[0]!.id);
    db.prepare(
      "INSERT INTO attempts (id, plan_id, item_id, started_at) VALUES ('broken-attempt', ?, 'broken', 1)",
    ).run(planId);
    await openExam(page, planId);
    const block = page.locator(".px-unf");
    await expect(block).toContainText("Non riesco a leggere le attività da finire.");
    await expectNoAxeViolations(page);
    // Mended, Riprova shows what was there.
    db.prepare("DELETE FROM attempts WHERE id = 'broken-attempt'").run();
    db.prepare("DELETE FROM items WHERE id = 'broken'").run();
    db.close();
    await block.getByRole("button", { name: "Riprova" }).click();
    await expect(block.getByRole("button", { name: /^Riprendi: Quiz su Limiti/ })).toBeVisible();
    await expect(block).not.toContainText("Non riesco a leggere");
  } finally {
    await done();
  }
});

test("Elimina on a row whose activity is already gone drops the row, with no failure to retry", async () => {
  test.setTimeout(120_000);
  const { page, planId, topics, userData, done } = await launch();
  try {
    const attemptId = await startQuiz(page, planId, topics[0]!.id);
    await openExam(page, planId);
    const block = page.locator(".px-unf");
    await expect(block.getByRole("button", { name: /^Riprendi: Quiz su Limiti/ })).toBeVisible();
    // The activity goes while its row is still on screen (a review expiring does the same).
    const db = new DatabaseSync(join(userData, "workspace", "pyxis.db"));
    db.prepare("DELETE FROM attempts WHERE id = ?").run(attemptId);
    db.close();
    await block.getByRole("button", { name: "Azioni su Quiz su Limiti" }).click();
    await page.getByRole("menuitem", { name: "Elimina…" }).click();
    await page
      .getByRole("dialog", { name: "Eliminare «Quiz su Limiti»?" })
      .getByRole("button", { name: "Elimina", exact: true })
      .click();
    await expect(page.locator(".px-unf")).toHaveCount(0);
    await expect(page.getByText("Non riesco a eliminare")).toHaveCount(0);
  } finally {
    await done();
  }
});

test("a quiz started in a dialog that was cancelled and reopened leaves the new dialog as it was", async () => {
  test.setTimeout(120_000);
  const { page, planId, userData, done } = await launch();
  try {
    await openExam(page, planId);
    // Another connection holds the workspace's write lock, so Crea's request waits in core.
    const lock = new DatabaseSync(join(userData, "workspace", "pyxis.db"));
    lock.exec("BEGIN IMMEDIATE");
    let dialog = await fromAltro(page);
    await dialog.getByRole("button", { name: "Crea", exact: true }).click();
    await dialog.getByRole("button", { name: "Annulla" }).click();
    await expect(dialog).toBeHidden();
    // Open again and change something: a simulation, which Crea would not have started.
    dialog = await fromAltro(page);
    await kind(dialog, "Simulazione").click();
    // The first request goes through now, and its reply reaches the page before the answer to any later call.
    lock.exec("ROLLBACK");
    lock.close();
    await expect
      .poll(async () => (await invoke<unknown[]>(page, "plans.unfinished", { planId })).length, { timeout: 30_000 })
      .toBe(1);
    // A reply that closed the dialog would be shrinking it now: let any such animation finish before looking.
    await animationsSettled(page);
    await expect(dialog).toBeVisible();
    await expect(kind(dialog, "Simulazione")).toHaveAttribute("aria-checked", "true");
    // The page did not take the cancelled quiz for something to show in Adesso.
    await expect(page.locator(".px-exam-now.is-working")).toHaveCount(0);
  } finally {
    await done();
  }
});

test("Oggi counts the day's minutes against the goal: the introduction alone does not fill it, and a day done does", async () => {
  test.setTimeout(180_000);
  const { page, planId, topics, done } = await launch();
  try {
    // 6 hours a week is a goal of 51 minutes a day, whatever pace the planner needs for an exam 30 days away.
    await invoke(page, "plans.plannerHours", { hours: 6 });
    const stages = [
      { steps: [["intro", null]], it: "10 di 51 min", en: "10 of 51 min", name: "intro" },
      { steps: [["practice", topics[0]!.id]], it: "30 di 51 min", en: "30 of 51 min", name: "half" },
      { steps: [["lesson", topics[0]!.id]], it: "fatto, 60 min", en: "done, 60 min", name: "done" },
    ] as const;
    for (const stage of stages) {
      for (const [activity, topicId] of stage.steps)
        await invoke(page, "plans.complete", { planId, activity, topicId });
      for (const [language, theme, width] of [
        ["it", "dark", 1280],
        ["en", "light", 960],
      ] as const) {
        await page.evaluate(
          async ({ language, theme }) => {
            localStorage.setItem("pyxis.lang", language);
            await window.pyxis.setAppearance(theme);
          },
          { language, theme },
        );
        await page.setViewportSize({ width, height: 800 });
        await page.reload();
        await openExam(page, planId);
        const legend = page.locator(".px-rings-legend");
        const value = legend.getByRole("listitem").nth(2);
        await expect(value).toHaveText(
          new RegExp(`^(Oggi|Today)\\s*${stage[language]}$`),
        );
        await expect(
          page.locator(".px-exam-rings").getByRole("img"),
        ).toHaveAccessibleName(new RegExp(`, (Oggi|Today) ${stage[language]}$`));
        // The ring is drawn part of the way until the day is done.
        const arc = page.locator(".px-rings-arc.is-today");
        await expect(arc).toHaveCount(1);
        await saveShot(
          page.locator(".px-exam-head"),
          `oggi-target-${stage.name}-${language}-${theme}-${width}.png`,
          { animations: "disabled" },
        );
      }
    }
  } finally {
    await done();
  }
});

test("Oggi measures nothing without a study goal, and its action opens the weekly hours that start the measure", async () => {
  test.setTimeout(120_000);
  const { page, planId, done } = await launch();
  try {
    await openExam(page, planId);
    // Without weekly hours a step done today fills nothing: the ring stays empty and its legend offers to set a goal.
    await invoke(page, "plans.complete", {
      planId,
      activity: "intro",
      topicId: null,
    });
    await page.reload();
    await expect(
      page.locator(".px-exam-rings").getByRole("img"),
    ).toHaveAccessibleName(/, Oggi non misurato$/);
    await expect(page.locator(".px-rings-arc.is-today")).toHaveCount(0);
    const legend = page.getByRole("list", { name: "Anelli dell'esame" });
    const setGoal = legend.getByRole("button", {
      name: "Imposta obiettivo di studio",
    });
    await expect(setGoal).toBeVisible();
    await expectNoAxeViolations(page);
    await saveShot(
      page.locator(".px-exam-head"),
      "exam-activities/rings-no-goal.png",
      { animations: "disabled" },
    );
    // The Esami list reads it the same way.
    await page.evaluate(() => {
      location.hash = "/exams";
    });
    await expect(
      page.locator(".px-exams-row", { hasText: "Analisi 1" }).getByRole("img"),
    ).toHaveAccessibleName(/Oggi non misurato$/);
    await openExam(page, planId);

    // The action opens the exam's settings at the weekly hours, which say they count for every exam.
    await setGoal.press("Enter");
    await expect(page).toHaveURL(new RegExp(`#/plans/${planId}/settings$`));
    const hours = page.getByRole("spinbutton", { name: "Ore a settimana" });
    await expect(hours).toBeFocused();
    await expect(
      page.getByText("Le ore valgono per tutti i tuoi esami"),
    ).toBeVisible();
    await hours.fill("7");
    await page
      .getByRole("region", { name: "Modifiche da salvare" })
      .getByRole("button", { name: "Salva" })
      .click();
    await expect(page.getByText("Modifiche salvate")).toBeVisible();

    // Back on the exam, Oggi measures today's minutes against the goal: 7 hours a week is 60 minutes a day, and the
    // introduction done above took 10 of them.
    await openExam(page, planId);
    await expect(
      legend.getByRole("button", { name: "Imposta obiettivo di studio" }),
    ).toHaveCount(0);
    await expect(legend.getByRole("listitem").nth(2)).toHaveText(
      /^Oggi\s*10 di 60 min$/,
    );
    await expect(
      page.locator(".px-exam-rings").getByRole("img"),
    ).toHaveAccessibleName(/, Oggi 10 di 60 min$/);
  } finally {
    await done();
  }
});
