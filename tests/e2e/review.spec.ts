import { expect, test, type Page } from "@playwright/test";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
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
import { seedPlan } from "./seed";

// The built app can be pointed at another output folder so a test run never races a rebuild of out/.

const exercise = (id: string, chapter: number, n: number) =>
  `:::exercise{id="${id}" chapter="${chapter}"}\nDomanda ${id}?\n:::solution\nrisposta ${n}\n:::\n:::\n`;

test("LES-13 mixed Review keeps one stored queue across reloads and shows one progress", async () => {
  test.setTimeout(240000);
  const userData = mkdtempSync(join(tmpdir(), "pyxis-review-check-"));
  const file = join(userData, "fisica.ptsb");
  writeFileSync(
    file,
    makeBook({
      id: "fisica",
      chapters: [
        { title: "Forze", text: "## p1 | Forza\nLa forza vale massa per accelerazione.\n" },
        { title: "Energia", text: "## p1 | Energia\nL’energia cinetica dipende dalla velocità.\n" },
      ],
      files: {
        "esercizi.md":
          [1, 2, 3, 4].map((n) => exercise(`a${n}`, 1, n)).join("\n") +
          [5, 6, 7].map((n) => exercise(`b${n}`, 2, n)).join("\n"),
      },
    }),
  );
  const planReplies = {
    markdown: { markdown: "## Ripasso\nUsa le formule [P1]." },
    questions: {
      questions: Array.from({ length: 10 }, (_, i) => ({
        stem: `Diagnosi ${i}`,
        options: ["a", "b", "c", "d"],
        correct: 0,
        topicIndex: i % 2,
        passageIds: [`{{passage:${i % 2}}}`],
        explanation: "La relazione fisica.",
      })),
    },
  };
  const env = {
    PYXIS_E2E_PLAN_REPLIES: JSON.stringify(planReplies),
  };
  const app = await launchPyxis({ userData, env });
  try {
    const page = await app.firstWindow();
    await page.getByRole("button", { name: "Salta" }).click();
    // Skipping saves the profile, then moves to Chiedi; wait so a reload or route change cannot land on setup.
    await fromChiediToExams(page);
    const invoke = <T>(channel: string, input: object) =>
      page.evaluate(
        ([channel, input]) =>
          window.pyxis.invoke(channel as never, input as never),
        [channel, input] as const,
      ) as Promise<T>;
    const source = await importPickedSource(page, app, file) as { sourceId: string };
    await expect
      .poll(async () =>
        (await invoke<Array<{ id: string; status: string }>>("sources.list", {})).find(
          (row) => row.id === source.sourceId,
        )?.status,
      )
      .toBe("ready");
    const { planId } = await invoke<{ planId: string }>("plans.create", {
      title: "Fisica 1",
      sourceIds: [source.sourceId],
    });
    await expect
      .poll(async () => (await invoke<{ state: string }>("plans.build", { planId })).state)
      .toBe("succeeded");
    // The path's frontier is the topic whose lesson the student read last.
    const plan = await invoke<{ topics: Array<{ id: string }> }>("plans.read", { planId });
    await invoke("plans.complete", { planId, activity: "lesson", topicId: plan.topics[0]!.id });
    for (const n of [1, 2, 3, 4, 5, 6])
      await invoke("study.save", {
        planId,
        topicId: plan.topics[0]!.id,
        front: `Carta ${n}`,
        back: `Retro ${n}`,
      });

    const goto = (hash: string) =>
      page.evaluate((hash) => {
        window.location.hash = hash;
      }, hash);
    const progress = page.locator(".px-review-progress .small");
    const front = page.locator("article.px-card .px-markdown").first();
    const rate = async (key: string) => {
      await page.keyboard.press("Space");
      await page.keyboard.press(key);
    };

    await goto(`/plans/${planId}/review`);
    await page.getByRole("radiogroup", { name: "Flashcard in questo ripasso" }).getByRole("radio", { name: "5", exact: true }).click();
    await page.getByRole("button", { name: "Inizia il ripasso" }).click();
    await expect(page).toHaveURL(/\/review\/cards/);
    await expect(progress).toHaveText(/^0 di (\d+) fatti · 5 flashcard, (\d+) domande$/);
    const total = Number(/di (\d+) fatti/.exec((await progress.textContent()) ?? "")?.[1]);
    const questions = total - 5;
    expect(questions).toBeGreaterThan(0);

    // The rating buttons carry a label and their key as a badge, no next review time, and none stands out.
    // Space does nothing until the first card has loaded, and the progress line can show before it.
    await expect(page.getByRole("button", { name: /^Gira/ })).toBeVisible();
    await page.keyboard.press("Space");
    const labels = ["Non la sapevo", "Difficile", "La sapevo", "Facile"];
    for (const name of labels)
      await expect(page.getByRole("button", { name, exact: true })).toBeVisible();
    await expect(page.getByRole("group", { name: "Quanto la sapevi?" })).toHaveText(
      labels.map((label, index) => `${label}${index + 1}`).join(""),
    );
    await expect(page.getByRole("group", { name: "Quanto la sapevi?" }).locator(".ant-btn-primary")).toHaveCount(0);
    await page.keyboard.press("Space");

    // Every rating is "Non la sapevo", so a recycling queue would show a card twice.
    const seen: string[] = [];
    for (let done = 0; done < 2; done += 1) {
      await expect(front).not.toHaveText("");
      seen.push((await front.innerText()).trim());
      await rate("1");
      await expect(progress).toHaveText(new RegExp(`^${done + 1} di ${total} fatti`));
    }
    // A card that turns up now must not join the stored queue, and a reload must not rebuild it.
    await invoke("study.save", {
      planId,
      topicId: plan.topics[0]!.id,
      front: "Carta nuova",
      back: "Retro",
    });
    await page.reload();
    await expect(progress).toHaveText(new RegExp(`^2 di ${total} fatti · 5 flashcard`));
    for (let done = 2; done < 5; done += 1) {
      seen.push((await front.innerText()).trim());
      await rate("1");
      await expect(progress).toHaveText(new RegExp(`^${done + 1} di ${total} fatti`));
    }
    expect(new Set(seen).size).toBe(5);
    expect(seen).not.toContain("Carta nuova");

    // The card phase ends like a flashcard session: the five answers as bars, the cards under the answer given, and the
    // way on to the questions where "Per oggi basta" sits. The answers are read from the stored reviews, so a reload
    // keeps them.
    const end = page.locator(".px-end");
    await expect(end.getByRole("heading", { level: 2, name: "Hai finito le flashcard" })).toBeVisible();
    // Annulla l'ultima works from here: the last card comes back and its answer leaves the count.
    await page.getByRole("banner").getByRole("button", { name: "Annulla l'ultima", exact: true }).click();
    await expect(progress).toHaveText(new RegExp(`^4 di ${total} fatti`));
    await expect(end).toHaveCount(0);
    await expect(page.getByRole("button", { name: /^Gira/ })).toBeVisible();
    await rate("1");
    await expect(progress).toHaveText(new RegExp(`^5 di ${total} fatti`));
    for (const reloaded of [false, true]) {
      if (reloaded) await page.reload();
      await expect(end.getByRole("heading", { level: 2, name: "Hai finito le flashcard" })).toBeVisible();
      await expect(end.locator(".px-end-kicker")).toHaveText("Ripasso");
      await expect(end.locator(".px-end-text")).toHaveText("Hai dato 5 risposte. Restano le domande del ripasso.");
      await expect(end.getByRole("list", { name: "Le tue risposte" }).getByRole("listitem")).toHaveText([
        "Non la sapevo5",
        "Difficile0",
        "La sapevo0",
        "Facile0",
      ]);
      await expect(end.locator(".px-end-group")).toHaveCount(1);
      await expect(end.locator(".px-end-group").getByRole("heading")).toHaveText("Non la sapevo5");
      await expect(end.locator(".px-end-row")).toHaveCount(3);
      await expect(end.getByRole("button", { name: "Altre 2" })).toBeVisible();
      // The old closing lines and the dots are gone.
      await expect(page.getByText(/^Viste \d/)).toHaveCount(0);
      await expect(page.getByText("Nessuna flashcard in scadenza.")).toHaveCount(0);
      await expect(page.locator(".px-end .gd")).toHaveCount(0);
    }
    await expectNoAxeViolations(page);
    // Its progress line stays above, and the one way on is the button in the left column.
    await expect(progress).toHaveText(new RegExp(`^5 di ${total} fatti`));
    await expect(page.getByRole("button", { name: "Vai alle domande" })).toHaveCount(1);
    await page.getByRole("button", { name: "Vai alle domande" }).click();
    await expect(page).toHaveURL(/\/review\/questions\?attempt=/);
    await expect(page.getByText(`6 di ${total}`)).toBeVisible();

    // Reopening Review resumes the same session instead of building another.
    await goto(`/plans/${planId}/review`);
    await expect(page.getByText("Hai un ripasso in corso")).toBeVisible();
    await expect(progress).toHaveText(new RegExp(`^5 di ${total} fatti`));
    await expectNoAxeViolations(page);
    await page.getByRole("button", { name: "Continua il ripasso" }).click();
    await expect(page).toHaveURL(/\/review\/questions\?attempt=/);
    // The question screen continues the same queue: card count first, then the question.
    await expect(page.getByText(`6 di ${total}`)).toBeVisible();
    // It is the Review's own screen, not the diagnostic test's.
    await expect(page.locator(".px-studybar-title b")).toHaveText("Ripasso");
    // Each book exercise here has a short answer, so a multiple choice offers only answers of the same chapter.
    const firstChapter = ["risposta 1", "risposta 2", "risposta 3", "risposta 4"];
    for (const question of (await invoke<{ questions: Array<{ options?: string[] }> }>("study.reviewSession", { planId }))
      .questions)
      for (const option of question.options ?? []) expect(firstChapter).toContain(option);

    // Submitting the questions closes the session; the next start builds a new one.
    const open = await invoke<{ sessionId: string; attemptId: string } | null>("study.reviewSession", { planId });
    expect(open?.attemptId).toBeTruthy();
    await invoke("study.quizSubmit", { attemptId: open!.attemptId, picks: {} });
    await expect
      .poll(() => invoke("study.reviewSession", { planId }))
      .toBeNull();
    const db = new DatabaseSync(join(userData, "workspace", "pyxis.db"), { readOnly: true, timeout: 10000 });
    const events = db
      .prepare(
        "SELECT topic_id, payload_json FROM learning_events WHERE kind = 'answer_given' AND plan_id = ?",
      )
      .all(planId) as Array<{ topic_id: string; payload_json: string }>;
    db.close();
    // Every review question comes from the frontier topic; none is credited to the other.
    expect(events.length).toBeGreaterThan(0);
    expect(events.every((row) => row.topic_id === plan.topics[0]!.id)).toBe(true);

    // "Review mistakes" on a finished test starts from that test's wrong answers, not from a general review.
    const diagnostic = await invoke<{ attemptId: string; questions: Array<{ stem: string }> }>("study.diagnosticStart", {
      planId,
    });
    await invoke("study.quizSubmit", { attemptId: diagnostic.attemptId, picks: {} });
    await goto(`/plans/${planId}/review?from=${diagnostic.attemptId}`);
    await expect(page.getByText("Riparti dalle domande che hai sbagliato nel quiz.")).toBeVisible();
    await page.getByRole("button", { name: "Inizia il ripasso" }).click();
    await expect(page).toHaveURL(/\/review\/questions\?attempt=/);
    const mistakes = await invoke<{ fromAttemptId?: string; questions: Array<{ stem: string }> }>(
      "study.reviewSession",
      { planId },
    );
    expect(mistakes.fromAttemptId).toBe(diagnostic.attemptId);
    expect(mistakes.questions.map((question) => question.stem)).toEqual(
      diagnostic.questions.map((question) => question.stem),
    );
  } finally {
    await app.close();
    removeTestFolder(userData);
  }
});

test("the card phase of a Review that still waits for questions ends with the notice kept", async () => {
  test.setTimeout(120_000);
  const userData = mkdtempSync(join(tmpdir(), "pyxis-review-cards-end-"));
  const app = await launchPyxis({ userData });
  try {
    const page = await app.firstWindow();
    await page.getByRole("button", { name: "Salta" }).click();
    await fromChiediToExams(page);
    const db = new DatabaseSync(join(userData, "workspace", "pyxis.db"), { timeout: 10_000 });
    seedPlan(db, { id: "p", title: "Fisica 1", language: "it", topics: [{ id: "t", title: "Dinamica" }] });
    const now = Date.now();
    // A review of two cards, both answered after it began, and a gap drill that has not delivered its questions.
    const rows = [
      ["c1", "Seconda legge di Newton?", "good"],
      ["c2", "Unità della forza?", "easy"],
    ] as const;
    rows.forEach(([id, front, rating], index) => {
      db.prepare("INSERT INTO cards(id,plan_id,topic_id,front,back,seed_key,created_at) VALUES(?,'p','t',?,'Retro.',?,?)").run(id, front, id, index + 1);
      db.prepare("INSERT INTO card_reviews(id,card_id,rating,state_json,reviewed_at) VALUES(?,?,?,?,?)").run(
        `r-${id}`,
        id,
        rating,
        JSON.stringify({ intervalDays: 3, ease: 2.5, dueAt: now + 3 * 86_400_000 }),
        now + 10 + index,
      );
    });
    db.prepare("INSERT INTO items(id,plan_id,kind,body_json,engine_provider,grounding,created_at) VALUES('review-item','p','review',?,'fixture','sources',?)").run(
      JSON.stringify({ questions: [], config: { count: 5, feedback: false }, complete: true }),
      now,
    );
    db.prepare("INSERT INTO attempts(id,plan_id,item_id,started_at) VALUES('review-attempt','p','review-item',?)").run(now + 1);
    db.prepare("INSERT INTO items(id,plan_id,kind,body_json,grounding,created_at) VALUES('review-session','p','review_session',?,'sources',?)").run(
      JSON.stringify({ cardIds: ["c1", "c2"], attemptId: "review-attempt", drills: [{ topicId: "t", jobId: "drill", want: 3 }] }),
      now,
    );
    db.prepare("INSERT INTO jobs(id,kind,params_json,state,progress,created_at,updated_at) VALUES('drill','gap-drill',?,'running',0,?,?)").run(
      JSON.stringify({ planId: "p", topicId: "t" }),
      now,
      now,
    );
    db.close();
    await page.evaluate(() => {
      location.hash = "#/plans/p/review/cards";
    });
    await page.reload();
    const end = page.locator(".px-end");
    await expect(end.getByRole("heading", { level: 2, name: "Hai finito le flashcard" })).toBeVisible();
    await expect(end.locator(".px-end-text")).toHaveText("Hai dato 2 risposte. Le domande del ripasso non sono ancora pronte.");
    await expect(end.getByRole("list", { name: "Le tue risposte" }).getByRole("listitem")).toHaveText([
      "Non la sapevo0",
      "Difficile0",
      "La sapevo1",
      "Facile1",
    ]);
    // The notice that the questions are being prepared sits in the left column, with its way to the status, and there is
    // no way on to questions yet.
    await expect(end.getByText("Altre 3 domande sono in preparazione.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Vai alle domande" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Vedi lo stato" })).toHaveCount(1);
    await expectNoAxeViolations(page);
    await page.getByRole("button", { name: "Vedi lo stato" }).click();
    await expect(page).toHaveURL(/#\/plans\/p\/review$/);
  } finally {
    await app.close();
    removeTestFolder(userData);
  }
});

/** A plan with three flashcards and nothing else to ask, so a Ripasso of it is only those cards. */
async function reviewOfThreeCards(userData: string, env?: Record<string, string>) {
  const app = await launchPyxis({ userData, env });
  const page = await app.firstWindow();
  await page.getByRole("button", { name: "Salta" }).click();
  await fromChiediToExams(page);
  const db = new DatabaseSync(join(userData, "workspace", "pyxis.db"), { timeout: 10_000 });
  seedPlan(db, { id: "p", title: "Fisica 1", language: "it", topics: [{ id: "t", title: "Dinamica" }] });
  ["Prima carta?", "Seconda carta?", "Terza carta?"].forEach((front, index) =>
    db.prepare("INSERT INTO cards(id,plan_id,topic_id,front,back,seed_key,created_at) VALUES(?,'p','t',?,'Retro.',?,?)").run(`c${index + 1}`, front, `c${index + 1}`, index + 1),
  );
  db.close();
  await page.evaluate(() => window.pyxis.invoke("study.review", { planId: "p", count: 3 }));
  await page.evaluate(() => {
    location.hash = "#/plans/p/review/cards";
  });
  await page.reload();
  return { app, page };
}

test("a Ripasso of only flashcards, reloaded before its last card, ends with every answer the student gave", async () => {
  test.setTimeout(120_000);
  const userData = mkdtempSync(join(tmpdir(), "pyxis-review-reload-"));
  const { app, page } = await reviewOfThreeCards(userData);
  try {
    const front = page.locator("article.px-card .px-card-front");
    const rate = async (key: string) => {
      await page.keyboard.press("Space");
      await expect(page.locator("article.px-card")).toHaveAttribute("data-face", "back");
      await page.keyboard.press(key);
    };
    const bars = page.locator(".px-end").getByRole("list", { name: "Le tue risposte" }).getByRole("listitem");
    await expect(front).toHaveText("Prima carta?");
    await rate("1");
    await expect(front).toHaveText("Seconda carta?");
    await rate("4");
    await expect(front).toHaveText("Terza carta?");
    // The page is mounted again with two answers stored, and the last card ends the review at once.
    await page.reload();
    await expect(front).toHaveText("Terza carta?");
    await rate("3");
    await expect(page.locator(".px-end").getByRole("heading", { level: 2, name: "Hai finito le flashcard" })).toBeVisible();
    await expect(page.locator(".px-end-text")).toHaveText("Hai dato 3 risposte. Il ripasso è finito.");
    await expect(bars).toHaveText(["Non la sapevo1", "Difficile0", "La sapevo1", "Facile1"]);
    await expect(page.locator(".px-end-row")).toHaveCount(3);
    // Annulla l'ultima brings the third card back with two answers, and answering it again gives three once more.
    await page.getByRole("banner").getByRole("button", { name: "Annulla l'ultima", exact: true }).click();
    await expect(front).toHaveText("Terza carta?");
    await rate("2");
    await expect(page.locator(".px-end-text")).toHaveText("Hai dato 3 risposte. Il ripasso è finito.");
    await expect(bars).toHaveText(["Non la sapevo1", "Difficile1", "La sapevo0", "Facile1"]);
    // Leaving the page and coming back reads the same three from the stored reviews.
    await page.reload();
    await expect(bars).toHaveText(["Non la sapevo1", "Difficile1", "La sapevo0", "Facile1"]);
  } finally {
    await app.close();
    removeTestFolder(userData);
  }
});

test("a Ripasso whose finished answers cannot be read says so and retries, and never lists only this visit's answers", async () => {
  test.setTimeout(120_000);
  const userData = mkdtempSync(join(tmpdir(), "pyxis-review-lost-"));
  // The first read of the finished review is lost; the next one, from Riprova, comes back.
  const lose = join(tmpdir(), `pyxis-review-lose-${process.pid}-${Date.now()}`);
  const { app, page } = await reviewOfThreeCards(userData, { PYXIS_E2E_READ_FAIL: `study.reviewSession?finished=${lose}` });
  try {
    const front = page.locator("article.px-card .px-card-front");
    const rate = async (key: string) => {
      await page.keyboard.press("Space");
      await expect(page.locator("article.px-card")).toHaveAttribute("data-face", "back");
      await page.keyboard.press(key);
    };
    await expect(front).toHaveText("Prima carta?");
    await rate("1");
    await expect(front).toHaveText("Seconda carta?");
    await rate("4");
    await expect(front).toHaveText("Terza carta?");
    // The page is mounted again with two answers stored: only the last one is this visit's.
    await page.reload();
    await expect(front).toHaveText("Terza carta?");
    writeFileSync(lose, "");
    await rate("3");
    // The page says it could not read the answers, with a way to try again, and lists none of them: one answer is not
    // the review's summary, and the empty page is not its end.
    await expect(page.getByText("Non è stato possibile caricare le flashcard.")).toBeVisible();
    await expect(page.locator(".px-end")).toHaveCount(0);
    await expect(page.getByText("Nessuna flashcard in scadenza.")).toHaveCount(0);
    await expectNoAxeViolations(page);
    for (const theme of ["light", "dark"] as const) {
      await page.evaluate((value) => window.pyxis.setAppearance(value), theme);
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      await saveShot(page, `review-cards-answers-lost-${theme}.png`, { animations: "disabled" });
    }
    await page.getByRole("button", { name: "Riprova" }).click();
    const end = page.locator(".px-end");
    await expect(end.locator(".px-end-text")).toHaveText("Hai dato 3 risposte. Il ripasso è finito.");
    await expect(end.getByRole("list", { name: "Le tue risposte" }).getByRole("listitem")).toHaveText([
      "Non la sapevo1",
      "Difficile0",
      "La sapevo1",
      "Facile1",
    ]);
  } finally {
    await app.close();
    removeTestFolder(userData);
  }
});

test("a Ripasso with questions after its cards, reloaded at its last card, ends with every answer and the way on", async () => {
  test.setTimeout(120_000);
  const userData = mkdtempSync(join(tmpdir(), "pyxis-review-reload-q-"));
  const app = await launchPyxis({ userData });
  try {
    const page = await app.firstWindow();
    await page.getByRole("button", { name: "Salta" }).click();
    await fromChiediToExams(page);
    const db = new DatabaseSync(join(userData, "workspace", "pyxis.db"), { timeout: 10_000 });
    seedPlan(db, { id: "p", title: "Fisica 1", language: "it", topics: [{ id: "t", title: "Dinamica" }] });
    const now = Date.now();
    ["Prima carta?", "Seconda carta?", "Terza carta?"].forEach((front, index) =>
      db.prepare("INSERT INTO cards(id,plan_id,topic_id,front,back,seed_key,created_at) VALUES(?,'p','t',?,'Retro.',?,?)").run(`c${index + 1}`, front, `c${index + 1}`, index + 1),
    );
    // Two cards answered after the review began; the third is the one left, and a question follows.
    ["c1", "c2"].forEach((id, index) =>
      db.prepare("INSERT INTO card_reviews(id,card_id,rating,state_json,reviewed_at) VALUES(?,?,?,?,?)").run(
        `r-${id}`,
        id,
        index === 0 ? "hard" : "easy",
        JSON.stringify({ intervalDays: 3, ease: 2.5, dueAt: now + 3 * 86_400_000 }),
        now + 10 + index,
      ),
    );
    db.prepare("INSERT INTO items(id,plan_id,kind,body_json,engine_provider,grounding,created_at) VALUES('review-item','p','review',?,'fixture','sources',?)").run(
      JSON.stringify({
        questions: [
          {
            id: "q1",
            topicId: "t",
            stem: "Quale formula descrive la velocità?",
            options: ["$v=s/t$", "$v=st$", "$v=s+t$", "$v=t/s$"],
            explanation: "Spazio diviso tempo.",
            answer: { kind: "mcq", correct: 0, picked: -1 },
          },
        ],
        config: { count: 5, feedback: false },
        complete: true,
      }),
      now,
    );
    db.prepare("INSERT INTO attempts(id,plan_id,item_id,started_at) VALUES('review-attempt','p','review-item',?)").run(now + 1);
    db.prepare("INSERT INTO items(id,plan_id,kind,body_json,grounding,created_at) VALUES('review-session','p','review_session',?,'sources',?)").run(
      JSON.stringify({ cardIds: ["c1", "c2", "c3"], attemptId: "review-attempt", drills: [] }),
      now,
    );
    db.close();
    await page.evaluate(() => {
      location.hash = "#/plans/p/review/cards";
    });
    await page.reload();
    const front = page.locator("article.px-card .px-card-front");
    await expect(front).toHaveText("Terza carta?");
    await page.keyboard.press("Space");
    await expect(page.locator("article.px-card")).toHaveAttribute("data-face", "back");
    await page.keyboard.press("3");
    const end = page.locator(".px-end");
    await expect(end.getByRole("heading", { level: 2, name: "Hai finito le flashcard" })).toBeVisible();
    await expect(end.locator(".px-end-text")).toHaveText("Hai dato 3 risposte. Restano le domande del ripasso.");
    await expect(end.getByRole("list", { name: "Le tue risposte" }).getByRole("listitem")).toHaveText([
      "Non la sapevo0",
      "Difficile1",
      "La sapevo1",
      "Facile1",
    ]);
    await expect(end.locator(".px-end-row")).toHaveCount(3);
    await expect(page.getByRole("button", { name: "Vai alle domande" })).toBeVisible();
  } finally {
    await app.close();
    removeTestFolder(userData);
  }
});

test("MATH-03 a tutor Python block runs in the sandbox, drops stale output and keeps output focusable", async () => {
  test.skip(
    !existsSync(".tmp/pyodide/pyodide.js"),
    "Requires the pinned Pyodide runtime fixture in .tmp/pyodide.",
  );
  test.setTimeout(240000);
  const userData = mkdtempSync(join(tmpdir(), "pyxis-python-block-"));
  const { version } = JSON.parse(readFileSync("resources/pyodide-manifest.json", "utf8"));
  const pack = join(userData, "workspace/runtimes/pyodide", version);
  mkdirSync(pack, { recursive: true });
  cpSync(".tmp/pyodide", pack, { recursive: true });
  const env = {
    PYXIS_E2E_REPLY: "Prova così:\n\n```python\nprint(6 * 7)\n```\n",
  };
  const app = await launchPyxis({ userData, env });
  try {
    const page: Page = await app.firstWindow();
    await page.getByRole("button", { name: "Salta" }).click();
    // Skipping saves the profile, then moves to Chiedi; wait so a reload or route change cannot land on setup.
    await fromChiediToExams(page);
    const { chatId } = (await page.evaluate(() =>
      window.pyxis.invoke("chats.ask", {
        text: "calcola 6 per 7",
        allowGeneral: true,
      }),
    )) as { chatId: string };
    await page.evaluate((chatId) => {
      window.location.hash = `/ask/${chatId}`;
    }, chatId);
    const code = page.getByRole("textbox", { name: "Codice Python" });
    await expect(code).toHaveValue("print(6 * 7)");
    await page.getByRole("button", { name: "Esegui" }).click();
    const output = page.getByLabel("Risultato");
    // Pyodide's first start takes over a minute on the hosted macOS x64 runner (each python.spec case there takes ~20 s).
    // A notice under the block (setup, unavailable, slow) means no output will come, so fail on it at once.
    const notice = page.locator(".px-python-block p.small");
    await expect(output.or(notice).first()).toBeVisible({ timeout: 150000 });
    if (!(await output.isVisible()))
      throw new Error(`The Python block showed a notice instead of output: ${(await notice.allInnerTexts()).join(" | ")}`);
    await expect(output).toHaveText("42\n", { timeout: 5000 });
    // The captured output scrolls by keyboard, so it must take focus.
    await output.focus();
    await expect(output).toBeFocused();
    await expectNoAxeViolations(page);
    // Output belongs to the code that produced it: editing hides it, restoring brings it back.
    await code.fill("print(1)");
    await expect(output).toHaveCount(0);
    await page.getByRole("button", { name: "Ripristina il codice" }).click();
    await expect(code).toHaveValue("print(6 * 7)");
    await expect(output).toHaveText("42\n");
  } finally {
    await app.close();
    removeTestFolder(userData);
  }
});
