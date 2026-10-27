import { expect, test } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parseSmartText, smartQuestions } from "../../src/shared/smart-text";
import { launchPyxis } from "./app-under-test";
import { seedPlan, seedSource, seedSubjects } from "./seed";
import { expectNoAxeViolations } from "./axe";

const mcq = (id: string, topicId: string, stem: string) => ({
  id,
  topicId,
  stem,
  options: ["La forza", "La massa", "Il tempo", "La carica"],
  explanation: "Lo dice il secondo principio [P1].",
  sourceIds: ["pass-1"],
  answer: { kind: "mcq", picked: -1, correct: 0 },
});

/**
 * Two exams. Fisica 1 has a diagnostic with two misses and one right answer, a simulation answer worth 40%, and a
 * missed quick check; Chimica generale has one missed true-or-false question. Appunti sparsi has no mistakes.
 */
function seed(db: DatabaseSync) {
  seedSubjects(db, [{ id: "s-phys", name: "Fisica" }, { id: "s-chem", name: "Chimica" }]);
  seedPlan(db, {
    id: "p-phys",
    subjectId: "s-phys",
    title: "Fisica 1",
    language: "it",
    topics: [{ id: "t-dyn", title: "Dinamica" }, { id: "t-kin", title: "Cinematica" }],
  });
  seedPlan(db, {
    id: "p-chem",
    subjectId: "s-chem",
    title: "Chimica generale",
    language: "it",
    topics: [{ id: "t-atoms", title: "Atomi" }],
  });
  seedPlan(db, { id: "p-none", title: "Appunti sparsi", language: "it", topics: [{ id: "t-misc", title: "Varie" }] });
  seedSource(db, {
    id: "src",
    kind: "file",
    title: "Mazzoldi",
    library: null,
    document: { id: "doc", tree: {} },
    passages: [
      {
        id: "pass-1",
        text: "Una forza produce un'accelerazione proporzionale.",
        section: "Secondo principio",
        locator: { page: 12 },
      },
    ],
  });
  const now = Date.now();
  const item = db.prepare(
    "INSERT INTO items(id,plan_id,topic_id,kind,body_json,engine_provider,model_id,created_at) VALUES(?,?,?,?,?,'claude','m',1)",
  );
  const attempt = db.prepare(
    "INSERT INTO attempts(id,plan_id,item_id,started_at,submitted_at) VALUES(?,?,?,?,?)",
  );
  const answers = db.prepare(
    "INSERT INTO attempt_answers(id,attempt_id,payload_json,created_at) VALUES(?,?,?,?)",
  );
  item.run(
    "diag",
    "p-phys",
    null,
    "diagnostic",
    JSON.stringify({
      questions: [
        mcq("q-cause", "t-dyn", "Che cosa causa un'accelerazione?"),
        mcq("q-unit", "t-dyn", "Che cosa misura il newton?"),
        mcq("q-right", "t-kin", "Domanda già giusta"),
      ],
    }),
  );
  attempt.run(
    "a-diag",
    "p-phys",
    "diag",
    now - 3 * 86_400_000,
    now - 3 * 86_400_000,
  );
  answers.run(
    "aa-diag",
    "a-diag",
    JSON.stringify({
      picks: { "q-cause": "1", "q-unit": "2", "q-right": "0" },
      score: 1 / 3,
      results: [
        {
          id: "q-cause",
          score: 0,
          expected: "La forza",
          explanation: "Lo dice il secondo principio [P1].",
        },
        {
          id: "q-unit",
          score: 0,
          expected: "La forza",
          explanation: "Il newton misura una forza.",
        },
        { id: "q-right", score: 1, expected: "La forza", explanation: "" },
      ],
    }),
    now - 3 * 86_400_000,
  );
  item.run(
    "sim",
    "p-phys",
    null,
    "simulation",
    JSON.stringify({
      minutes: 60,
      questions: [
        {
          id: "s-law",
          topicId: "t-kin",
          passageIds: ["pass-1"],
          stem: "Scrivi la legge oraria del moto uniforme e spiega ogni termine.",
          answer: {
            kind: "completion",
            accepted: [
              ["$x(t) = x_0 + v t$, dove $x_0$ è la posizione iniziale."],
            ],
          },
        },
      ],
    }),
  );
  attempt.run(
    "a-sim",
    "p-phys",
    "sim",
    now - 2 * 86_400_000,
    now - 2 * 86_400_000,
  );
  answers.run(
    "aa-sim",
    "a-sim",
    JSON.stringify({
      picks: { "s-law": "$x = v t$" },
      score: 0.4,
      results: [
        {
          id: "s-law",
          score: 0.4,
          expected: "$x(t) = x_0 + v t$, dove $x_0$ è la posizione iniziale.",
          explanation: "Manca la posizione iniziale.",
        },
      ],
    }),
    now - 2 * 86_400_000,
  );
  const markdown = [
    "Il moto uniforme ha velocità costante [P1].",
    "",
    "```pyxis-check",
    JSON.stringify({
      question: "Nel moto uniforme la velocità…",
      options: ["resta costante", "cresce"],
      answer: 0,
      explanation: "Uniforme vuol dire costante.",
    }),
    "```",
  ].join("\n");
  item.run(
    "lesson",
    "p-phys",
    "t-kin",
    "lesson",
    JSON.stringify({ markdown, passageIds: ["pass-1"] }),
  );
  // The quick check answered wrong, stored as the lesson page stores it: the pick as shown.
  const [blockId, check] = [...smartQuestions(parseSmartText(markdown))][0]!;
  db.prepare(
    "INSERT INTO learning_events(id,kind,plan_id,topic_id,item_id,payload_json,created_at) VALUES('ev-check','answer_given','p-phys','t-kin','lesson',?,?)",
  ).run(
    JSON.stringify({
      blockId,
      pick: check.options.indexOf("cresce"),
      shown: true,
      score: 0,
      evidenceKind: "check",
    }),
    now - 4 * 86_400_000,
  );
  item.run(
    "chem-quiz",
    "p-chem",
    "t-atoms",
    "quiz",
    JSON.stringify({
      complete: true,
      questions: [
        {
          id: "q-proton",
          stem: "Il numero atomico conta i neutroni.",
          explanation: "Conta i protoni.",
          answer: { kind: "tf", picked: false, correct: false },
        },
      ],
    }),
  );
  attempt.run(
    "a-chem",
    "p-chem",
    "chem-quiz",
    now - 86_400_000,
    now - 86_400_000,
  );
  answers.run(
    "aa-chem",
    "a-chem",
    JSON.stringify({
      picks: { "q-proton": "true" },
      score: 0,
      results: [
        {
          id: "q-proton",
          score: 0,
          expected: "false",
          explanation: "Conta i protoni.",
        },
      ],
    }),
    now - 86_400_000,
  );
}

test("the mistakes notebook collects misses by exam and topic and asks them again", async () => {
  test.setTimeout(120_000);
  const userData = mkdtempSync(join(tmpdir(), "pyxis-mistakes-"));
  const app = await launchPyxis({ userData });
  try {
    const page = await app.firstWindow();
    await page.getByRole("button", { name: "Salta" }).click();
    await expect(page).toHaveURL(/#\/exams$/);
    await page.evaluate(() => localStorage.setItem("pyxis.lang", "en"));
    const db = new DatabaseSync(join(userData, "workspace", "pyxis.db"), {
      timeout: 10_000,
    });
    seed(db);
    // A tab next to Flashcards.
    await page.reload();
    await page
      .locator(".ant-segmented-item-label", { hasText: "Mistakes notebook" })
      .click();
    await expect(page).toHaveURL(/#\/exams\/mistakes$/);
    await expect(page.getByRole("status")).toHaveText("5 questions to redo from quizzes, quick checks and simulations");
    // Exams in subject order, then topics in plan order; an exam without mistakes is not listed.
    await expect(page.getByRole("heading", { level: 2 })).toHaveText([
      "Fisica 1",
      "Chimica generale",
    ]);
    await expect(page.getByRole("heading", { level: 3 })).toHaveText([
      "Dinamica",
      "Cinematica",
      "Atomi",
    ]);
    const entry = (text: string) =>
      page.getByRole("listitem").filter({ hasText: text });
    // The answer given and the right one; a partial answer shows its score; math is rendered.
    await expect(entry("Che cosa misura il newton?")).toContainText(
      "Your answerIl tempo",
    );
    await expect(entry("Che cosa misura il newton?")).toContainText(
      "Correct answerLa forza",
    );
    await expect(entry("legge oraria")).toContainText("Your answer · 40%");
    await expect(entry("legge oraria").locator(".katex").first()).toBeVisible();
    await expect(entry("Il numero atomico")).toContainText("Your answerTrue");
    await expect(entry("Il numero atomico")).toContainText(
      "Correct answerFalse",
    );
    await expect(entry("velocità…")).toContainText("Quick check");
    await expectNoAxeViolations(page);

    // The source opens on the passage the question came from.
    await entry("Che cosa causa")
      .getByRole("button", { name: "Source" })
      .click();
    await expect(page.getByRole("dialog")).toContainText("Una forza produce");
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);

    // One exam only.
    await page.getByRole("combobox", { name: "Exam" }).click();
    await page
      .locator(
        '.ant-select-dropdown:visible .ant-select-item-option[title="Chimica generale"]',
      )
      .click();
    await expect(page.getByRole("status")).toHaveText("1 question to redo from quizzes, quick checks and simulations");

    // Redo a question from its exam's tab: answered right, it leaves; the topic's mastery moves.
    await page.evaluate(() => {
      location.hash = "#/plans/p-phys/mistakes";
    });
    await expect(
      page.locator(".px-seg .ant-segmented-item-selected"),
    ).toHaveText("Mistakes notebook");
    await expect(page.getByRole("status")).toHaveText("4 questions to redo from quizzes, quick checks and simulations");
    // The exam is the page; its topics are the next level.
    await expect(page.getByRole("heading", { level: 2 })).toHaveText([
      "Dinamica",
      "Cinematica",
    ]);
    await entry("Che cosa causa").getByRole("button", { name: "Redo" }).click();
    await expect(page).toHaveURL(
      /#\/plans\/p-phys\/redo\?attempt=.+&from=plan$/,
    );
    await expect(page.getByText("Redo mistakes")).toBeVisible();
    await page.getByRole("button", { name: /^A La forza$/ }).click();
    await page.getByRole("button", { name: "Check", exact: true }).click();
    await page
      .getByRole("button", { name: "See results", exact: true })
      .click();
    await page.getByRole("button", { name: "Back to the notebook" }).click();
    await expect(page).toHaveURL(/#\/plans\/p-phys\/mistakes$/);
    await expect(page.getByRole("status")).toHaveText("3 questions to redo from quizzes, quick checks and simulations");
    await expect(entry("Che cosa causa")).toHaveCount(0);
    const evidence = db
      .prepare(
        "SELECT json_extract(payload_json, '$.evidenceKind') AS kind FROM learning_events WHERE kind = 'answer_given' AND topic_id = 't-dyn' ORDER BY created_at DESC LIMIT 1",
      )
      .get() as { kind: string };
    expect(evidence.kind).toBe("quiz");

    // A topic's questions together.
    await page.getByRole("button", { name: "Redo 2 questions" }).click();
    await expect(page).toHaveURL(/#\/plans\/p-phys\/redo\?attempt=/);
    await expect(page.getByText("Question 1 of 2")).toBeVisible();
    await page.getByRole("button", { name: "Close" }).first().click();
    await expect(page).toHaveURL(/#\/plans\/p-phys\/mistakes$/);

    // An exam without mistakes says what will appear.
    await page.evaluate(() => {
      location.hash = "#/plans/p-none/mistakes";
    });
    await expect(
      page.getByRole("heading", { name: "No mistakes to go over" }),
    ).toBeVisible();
    db.close();
  } finally {
    await app.close();
    rmSync(userData, { recursive: true, force: true });
  }
});
