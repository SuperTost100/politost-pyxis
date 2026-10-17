import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../db/connection";
import { createPlan, readPlan } from "../plans/create";
import { planMastery, planSeries } from "../plans/progress";
import { importSmartbook } from "../sources/smartbook";
import { parseSmartText, smartQuestions, finalRecap } from "../../shared/smart-text";
import { MASTERY_WEIGHTS, masteryFor } from "./mastery";
import { rewriteLessonSection, writeLesson } from "./openLesson";
import { cacheKey, saveLesson } from "./lesson";
import { answerSmartCheck, smartAnswers, smartSources } from "./smartText";
import { studyHandlers } from "./handlers";
import { planHandlers } from "../plans/handlers";
import { exportMarkdown } from "../share/markdown";
import { appendEvent } from "../events";
import { saveProfile } from "../profile/profile";
import { exportPlan, importPlan } from "../plans/file";
import { planFileSchema } from "../../shared/plan-file";

const check = (question: string, answer = 0) =>
  [
    "```pyxis-check",
    JSON.stringify({
      question,
      options: ["Giusta", "Sbagliata", "Altra"],
      answer,
      explanation: "Perché sì.",
    }),
    "```",
  ].join("\n");
const recap = [
  "```pyxis-recap",
  JSON.stringify({
    questions: [
      { question: "Ripasso 1", options: ["a", "b"], answer: 0 },
      { question: "Ripasso 2", options: ["a", "b"], answer: 1 },
    ],
  }),
  "```",
].join("\n");
const smartLesson = [
  "## Velocità",
  "",
  "La velocità è lo spostamento diviso il tempo.",
  "",
  check("Che cos'è la velocità?"),
  "",
  "## Accelerazione",
  "",
  "L'accelerazione cambia la velocità.",
  "",
  check("Che cosa cambia l'accelerazione?"),
  "",
  recap,
].join("\n");

function setup() {
  const db = openDatabase(":memory:");
  const imported = importSmartbook(
    db,
    zipSync({
      "smartbook.json": strToU8(
        JSON.stringify({
          id: "demo",
          title: "Fisica",
          access: "public",
          chapters: [{ id: "c1", number: 1, title: "Moti", file: "01.md" }],
        }),
      ),
      "chapters/01.md": strToU8(
        "## p1 | Velocità\nLa velocità descrive il moto.\n\n## p2 | Accelerazione\nL'accelerazione cambia la velocità.\n",
      ),
    }),
  );
  db.prepare(
    "INSERT INTO feature_engines (feature, selection_json, updated_at) VALUES ('default', ?, 1)",
  ).run(JSON.stringify({ provider: "claude", model: "m" }));
  const { planId } = createPlan(db, {
    title: "Fisica 1",
    sourceIds: [imported.sourceId],
  });
  // The introduction and the diagnostic stay undone: nothing is locked, so a lesson finishes on any topic.
  const topicId = readPlan(db, planId)!.topics[0]!.id;
  const learn = () =>
    readPlan(db, planId)!.steps.some((step) => step.activity === "lesson" && step.topicId === topicId);
  let text = smartLesson;
  const run: Parameters<typeof writeLesson>[3] = async () => ({
    text,
    provider: "claude",
    model: "m",
    inputTokens: 1,
  });
  return {
    db,
    planId,
    topicId,
    learn,
    run,
    reply: (next: string) => {
      text = next;
    },
  };
}

const completed = (db: ReturnType<typeof openDatabase>) =>
  (
    db
      .prepare("SELECT COUNT(*) AS n FROM learning_events WHERE kind = 'lesson_completed'")
      .get() as { n: number }
  ).n;

describe("smart lessons", () => {
  it("never completes a lesson on open; the closing recap does, and answers stay", async () => {
    const { db, planId, topicId, learn, run } = setup();
    const before = completed(db);
    const lesson = await studyHandlers(db, undefined, run).lesson({ planId, topicId });
    await studyHandlers(db, undefined, run).lesson({ planId, topicId });
    expect(completed(db)).toBe(before);
    expect(learn()).toBe(false);
    expect(lesson.answers).toEqual({});
    expect(lesson.sources).toEqual([
      expect.objectContaining({ title: "Fisica", places: [expect.objectContaining({ chapter: 1 })] }),
    ]);

    const segments = parseSmartText(lesson.markdown);
    const shown = smartQuestions(segments);
    const [first] = [...shown.keys()];
    const ids = finalRecap(segments)!.questions.map((q) => q.id);
    // Options are shown in a seeded order, so right and wrong are read from the question as shown.
    const right = (id: string) => shown.get(id)!.answer;
    const wrong = (id: string) => (right(id) + 1) % shown.get(id)!.options.length;
    const answer = (blockId: string, pick: number) =>
      answerSmartCheck(db, { planId, itemId: lesson.itemId!, blockId, pick });

    expect(answer(first!, wrong(first!))).toEqual({ correct: false, pick: wrong(first!), finished: false });
    // The first answer stays: a second try returns the saved result and writes nothing.
    expect(answer(first!, right(first!))).toEqual({ correct: false, pick: wrong(first!), finished: false });
    expect(answer(ids[0]!, right(ids[0]!))).toMatchObject({ correct: true, finished: false });
    expect(learn()).toBe(false);
    expect(answer(ids[1]!, wrong(ids[1]!))).toMatchObject({ correct: false, finished: true });
    expect(learn()).toBe(true);
    expect(completed(db)).toBe(before + 1);
    expect(smartAnswers(db, lesson.itemId!)).toEqual({
      [first!]: wrong(first!),
      [ids[0]!]: right(ids[0]!),
      [ids[1]!]: wrong(ids[1]!),
    });
    const reopened = await studyHandlers(db, undefined, run).lesson({ planId, topicId });
    expect(reopened.answers).toEqual(smartAnswers(db, lesson.itemId!));
    expect(() => answer("check-unknown", 0)).toThrow("question-missing");
    expect(() => answer(first!, 5)).toThrow("question-missing");
    db.close();
  });

  it("counts quick checks as light mastery evidence that opens no gap", async () => {
    const { db, planId, topicId, run } = setup();
    const lesson = await writeLesson(db, planId, topicId, run);
    const questions = [...smartQuestions(parseSmartText(lesson.markdown)).values()];
    for (const question of questions)
      answerSmartCheck(db, {
        planId,
        itemId: lesson.itemId!,
        blockId: question.id,
        pick: (question.answer + 1) % question.options.length,
      });
    // All wrong: no mastery, and still no gap, which quizzes alone open.
    expect(planMastery(db, planId).find((t) => t.id === topicId)?.mastery).toBe(0);
    const series = planSeries(db, planId);
    expect(series.gaps).toEqual([]);
    expect(series.topics.find((t) => t.id === topicId)?.exercisesSolved).toBe(0);
    const now = Date.now();
    const check = masteryFor([{ topicId, kind: "check", score: 1, at: now }], now)[topicId]!;
    const quiz = masteryFor([{ topicId, kind: "quiz", score: 1, at: now }], now)[topicId]!;
    expect(MASTERY_WEIGHTS.check).toBeLessThan(MASTERY_WEIGHTS.quiz);
    expect(check).toBeGreaterThan(0);
    expect(check).toBeLessThan(quiz);
    db.close();
  });

  it("counts each quick check of a topic's lesson once, however often it is rewritten", async () => {
    const { db, planId, topicId, run, reply } = setup();
    const mastery = () => planMastery(db, planId).find((t) => t.id === topicId)!.mastery;
    const answerAll = (itemId: string, markdown: string, from = 0, to = Infinity, right = true) => {
      for (const question of [...smartQuestions(parseSmartText(markdown)).values()].slice(from, to))
        answerSmartCheck(db, {
          planId,
          itemId,
          blockId: question.id,
          pick: right ? question.answer : (question.answer + 1) % question.options.length,
        });
    };
    const lesson = await writeLesson(db, planId, topicId, run);
    answerAll(lesson.itemId!, lesson.markdown);
    // Four right answers of weight 0.5: 2 / (3 + 2).
    expect(mastery()).toBeCloseTo(0.4);

    // "Write it again" gives the same item new checks: the old answers leave with their checks, the new ones replace them.
    reply(smartLesson.replaceAll("?", " ancora?").replace("Ripasso 1", "Ripasso uno"));
    const again = await writeLesson(db, planId, topicId, run, { regenerate: true });
    expect(again.itemId).toBe(lesson.itemId);
    expect(mastery()).toBe(0);
    answerAll(again.itemId!, again.markdown);
    expect(mastery()).toBeCloseTo(0.4);

    // Another wording is another lesson on the same topic: once answered, it replaces the earlier lesson's checks whole,
    // so the two answers given so far are all that count, not two plus the older lesson's last two.
    reply(smartLesson.replaceAll("?", " in breve?").replace("Ripasso 1", "Ripasso primo"));
    const simple = await writeLesson(db, planId, topicId, run, { wording: "simple" });
    expect(simple.itemId).not.toBe(lesson.itemId);
    answerAll(simple.itemId!, simple.markdown, 0, 2, false);
    expect(mastery()).toBe(0);
    answerAll(simple.itemId!, simple.markdown, 2);
    // Two right of four: 1 / (3 + 2).
    expect(mastery()).toBeCloseTo(0.2);
    db.close();
  });

  it("grades the option the reader sees, whatever order the model wrote", async () => {
    const { db, planId, topicId, run, reply } = setup();
    // The model always puts the right option first.
    reply(Array.from({ length: 12 }, (_, n) => check(`Domanda ${n}?`, 0)).join("\n\n"));
    const lesson = await writeLesson(db, planId, topicId, run);
    const questions = [...smartQuestions(parseSmartText(lesson.markdown)).values()];
    expect(questions).toHaveLength(12);
    expect(new Set(questions.map((question) => question.answer)).size).toBeGreaterThan(1);
    for (const [index, question] of questions.entries()) {
      const pick = question.options.indexOf(index % 2 ? "Giusta" : "Sbagliata");
      expect(
        answerSmartCheck(db, { planId, itemId: lesson.itemId!, blockId: question.id, pick }),
      ).toMatchObject({ correct: index % 2 === 1, pick });
    }
    // The pick is saved as shown, and reads back as shown.
    expect(smartAnswers(db, lesson.itemId!)[questions[1]!.id]).toBe(questions[1]!.options.indexOf("Giusta"));
    db.close();
  });

  it("keeps an answer saved before options were rearranged on the option the student chose", async () => {
    const { db, planId, topicId, run, reply } = setup();
    reply(Array.from({ length: 6 }, (_, n) => check(`Domanda ${n}?`, 0)).join("\n\n"));
    const lesson = await writeLesson(db, planId, topicId, run);
    const questions = [...smartQuestions(parseSmartText(lesson.markdown)).values()];
    // An old event holds the model's own index (1 is "Sbagliata") and no `shown` marker.
    for (const question of questions)
      appendEvent(db, {
        kind: "answer_given",
        planId,
        topicId,
        itemId: lesson.itemId!,
        payload: { blockId: question.id, pick: 1, score: 0, evidenceKind: "check" },
        at: 1,
      });
    const saved = smartAnswers(db, lesson.itemId!);
    for (const question of questions) expect(question.options[saved[question.id]!]).toBe("Sbagliata");
    // Answering again returns that saved pick as wrong and writes nothing.
    expect(
      answerSmartCheck(db, {
        planId,
        itemId: lesson.itemId!,
        blockId: questions[0]!.id,
        pick: questions[0]!.answer,
      }),
    ).toEqual({ correct: false, pick: saved[questions[0]!.id], finished: false });
    expect(smartAnswers(db, lesson.itemId!)).toEqual(saved);
    db.close();
  });

  it("an introduction finishes when its quick checks are answered", () => {
    const { db, planId } = setup();
    const fresh = createPlan(db, { title: "Altro", sourceIds: [] });
    db.prepare(
      "INSERT INTO items (id, plan_id, kind, body_json, created_at) VALUES ('intro-item', ?, 'intro', ?, 1)",
    ).run(fresh.planId, JSON.stringify({ markdown: `Benvenuto.\n\n${check("Ricordi?")}`, passageIds: [] }));
    const intro = () => readPlan(db, fresh.planId)!.steps.some((step) => step.activity === "intro");
    expect(intro()).toBe(false);
    const [question] = [...smartQuestions(parseSmartText(`${check("Ricordi?")}`)).values()];
    const id = question!.id;
    expect(
      answerSmartCheck(db, {
        planId: fresh.planId,
        itemId: "intro-item",
        blockId: id,
        pick: question!.options.indexOf("Altra"),
      }),
    ).toMatchObject({ correct: false, finished: true });
    expect(intro()).toBe(true);
    // Another plan's item is not reachable through this plan.
    expect(() =>
      answerSmartCheck(db, { planId, itemId: "intro-item", blockId: id, pick: 0 }),
    ).toThrow("item-missing");
    db.close();
  });

  it("hashes an introduction's checks from the text the page shows, without passage references", async () => {
    const { db } = setup();
    const fresh = createPlan(db, { title: "Altro", sourceIds: [] });
    const body = `Benvenuto [P1].\n\n${check("Ricordi la velocità [P2] ?")}`;
    db.prepare(
      "INSERT INTO items (id, plan_id, kind, body_json, created_at) VALUES ('intro-refs', ?, 'intro', ?, 1)",
    ).run(fresh.planId, JSON.stringify({ markdown: body, passageIds: [] }));
    const shown = planHandlers(db).intro({ planId: fresh.planId })!;
    expect(shown.markdown).not.toContain("[P");
    // The ids the page computes from what it shows are the ones core accepts and reads back.
    const [question] = [...smartQuestions(parseSmartText(shown.markdown)).values()];
    expect(
      answerSmartCheck(db, { planId: fresh.planId, itemId: "intro-refs", blockId: question!.id, pick: 0 }),
    ).toMatchObject({ pick: 0, finished: true });
    expect(planHandlers(db).intro({ planId: fresh.planId })!.answers).toEqual({ [question!.id]: 0 });
    db.close();
  });

  it("reopens the lesson a step read after the profile wording changed, writing nothing", async () => {
    const { db, planId, topicId, run } = setup();
    let calls = 0;
    const counting: typeof run = async (input) => {
      calls++;
      return run!(input);
    };
    const handlers = studyHandlers(db, undefined, counting);
    const read = await handlers.lesson({ planId, topicId });
    const [first] = [...smartQuestions(parseSmartText(read.markdown)).keys()];
    answerSmartCheck(db, { planId, itemId: read.itemId!, blockId: first!, pick: 0 });
    const items = () =>
      (db.prepare("SELECT COUNT(*) AS n FROM items WHERE kind = 'lesson'").get() as { n: number }).n;
    expect([calls, items()]).toEqual([1, 1]);

    saveProfile(db, { displayName: "Ada" });
    db.prepare("UPDATE profile SET wording_level = 'technical'").run();
    const again = await handlers.lesson({ planId, topicId, itemId: read.itemId });
    // The same lesson and its saved answers, marked as not the one the settings give now; no model call, no new row.
    expect(again).toMatchObject({
      itemId: read.itemId,
      markdown: read.markdown,
      wording: "balanced",
      earlier: true,
      answers: { [first!]: 0 },
    });
    expect([calls, items()]).toEqual([1, 1]);

    // Opening the topic without the item is today's behaviour: a new lesson for the new wording.
    const current = await handlers.lesson({ planId, topicId });
    expect(current.itemId).not.toBe(read.itemId);
    expect([calls, items()]).toEqual([2, 2]);
    // The lesson the settings give is not marked.
    expect(await handlers.lesson({ planId, topicId, itemId: current.itemId })).toMatchObject({
      itemId: current.itemId,
      wording: "technical",
    });
    expect((await handlers.lesson({ planId, topicId, itemId: current.itemId })).earlier).toBeUndefined();
    // A missing item, or one of another topic, falls back to opening the topic.
    expect((await handlers.lesson({ planId, topicId, itemId: "gone" })).itemId).toBe(current.itemId);
    expect([calls, items()]).toEqual([2, 2]);
    db.close();
  });

  it("rewrites one section and keeps the others and their answers", async () => {
    const { db, planId, topicId, run, reply } = setup();
    const lesson = await writeLesson(db, planId, topicId, run);
    const [first] = [...smartQuestions(parseSmartText(lesson.markdown)).keys()];
    answerSmartCheck(db, { planId, itemId: lesson.itemId!, blockId: first!, pick: 0 });
    reply("L'accelerazione è la variazione della velocità nel tempo, $a=\\Delta v/\\Delta t$.");
    const prompts: string[] = [];
    const rewritten = await rewriteLessonSection(
      db,
      planId,
      topicId,
      async (input) => {
        prompts.push(input.prompt);
        return run!(input);
      },
      { section: 1, note: "più esempi" },
    );
    expect(rewritten.itemId).toBe(lesson.itemId);
    expect(rewritten.markdown).toContain("## Velocità\n\nLa velocità è lo spostamento");
    expect(rewritten.markdown).toContain("## Accelerazione\n\nL'accelerazione è la variazione");
    expect(rewritten.markdown).not.toContain("Che cosa cambia l'accelerazione?");
    expect(prompts[0]).toContain('Rewrite only the section "Accelerazione"');
    expect(prompts[0]).toContain('The student asked: "più esempi"');
    expect(smartAnswers(db, lesson.itemId!)).toEqual({ [first!]: 0 });
    expect((await writeLesson(db, planId, topicId, run)).markdown).toBe(rewritten.markdown);
    await expect(
      rewriteLessonSection(db, planId, topicId, run, { section: 9 }),
    ).rejects.toThrow("section-missing");
    db.close();
  });

  it("keeps showing a lesson from the earlier prompt until it is rewritten", async () => {
    const { db, planId, topicId, run } = setup();
    const passageIds = (
      db.prepare("SELECT passage_id FROM topic_passages WHERE topic_id = ?").all(topicId) as Array<{
        passage_id: string;
      }>
    ).map((row) => row.passage_id);
    const itemId = saveLesson(db, {
      planId,
      topicId,
      kind: "lesson",
      key: cacheKey({
        kind: "lesson",
        scopeId: topicId,
        passageIds,
        promptVersion: "model-3|complete-2|balanced|university|||Italian",
      }),
      markdown: "La velocità [P1].",
      passageIds,
      engine: { provider: "claude", model: "old" },
      prompt: { template: "lesson.write", version: "model-3" },
    });
    let calls = 0;
    const counting: typeof run = async (input) => {
      calls++;
      return run!(input);
    };
    const shown = await writeLesson(db, planId, topicId, counting);
    expect(shown).toMatchObject({ itemId, markdown: "La velocità [P1].", earlier: true });
    expect(calls).toBe(0);
    // Another level is another variant: it is written fresh.
    await writeLesson(db, planId, topicId, counting, { wording: "simple" });
    expect(calls).toBe(1);
    const rewritten = await writeLesson(db, planId, topicId, counting, { regenerate: true });
    expect(calls).toBe(2);
    expect(rewritten.earlier).toBeUndefined();
    expect(rewritten.itemId).not.toBe(itemId);
    expect((await writeLesson(db, planId, topicId, counting)).markdown).toBe(smartLesson);
    db.close();
  });

  it("exports blocks as readable Markdown and lists the given sources", async () => {
    const { db, planId, topicId, run } = setup();
    db.prepare("UPDATE plans SET content_language = 'it' WHERE id = ?").run(planId);
    const lesson = await writeLesson(db, planId, topicId, run);
    const exported = exportMarkdown(db, { planId, topicId, kind: "lesson" }).markdown;
    expect(exported).toContain("**Verifica rapida.** Che cos'è la velocità?");
    expect(exported).toContain("### Ripasso finale");
    expect(exported).not.toContain("pyxis-");
    expect(smartSources(db, lesson.passageIds)[0]?.places).toHaveLength(1);
    db.close();
  });
  it("keeps quick checks answered through an export and import, and accepts a file without the item", async () => {
    const { db, planId, topicId, run } = setup();
    const lesson = await writeLesson(db, planId, topicId, run);
    const shown = smartQuestions(parseSmartText(lesson.markdown));
    const [first, second] = [...shown.keys()];
    answerSmartCheck(db, { planId, itemId: lesson.itemId!, blockId: first!, pick: 1 });
    answerSmartCheck(db, { planId, itemId: lesson.itemId!, blockId: second!, pick: 0 });
    const file = planFileSchema.parse(JSON.parse(JSON.stringify(exportPlan(db, planId, { progress: true }))));
    const lessonIndex = file.items!.findIndex((item) => item.kind === "lesson");
    const checks = file.progress!.filter((event) => event.kind === "answer_given");
    expect(checks.map((event) => event.item)).toEqual([lessonIndex, lessonIndex]);

    const fresh = openDatabase(":memory:");
    const copy = importPlan(fresh, file, Date.now() + 5000);
    const copied = fresh.prepare("SELECT id FROM items WHERE plan_id = ? AND kind = 'lesson'").get(copy) as { id: string };
    expect(copied.id).not.toBe(lesson.itemId);
    expect(smartAnswers(fresh, copied.id)).toEqual(smartAnswers(db, lesson.itemId!));
    // Answering again returns the saved pick and writes no second event, so mastery counts it once.
    expect(answerSmartCheck(fresh, { planId: copy, itemId: copied.id, blockId: first!, pick: shown.get(first!)!.answer }))
      .toMatchObject({ pick: smartAnswers(db, lesson.itemId!)[first!] });
    const events = () =>
      (fresh.prepare("SELECT COUNT(*) AS n FROM learning_events WHERE plan_id = ? AND kind = 'answer_given'").get(copy) as { n: number }).n;
    expect(events()).toBe(2);

    // A file written before events named their item imports as before, with its checks unanswered.
    const older = JSON.parse(JSON.stringify(file)) as typeof file;
    for (const event of older.progress!) delete event.item;
    const secondCopy = importPlan(fresh, planFileSchema.parse(older), Date.now() + 6000);
    const bare = fresh.prepare("SELECT id FROM items WHERE plan_id = ? AND kind = 'lesson'").get(secondCopy) as { id: string };
    expect(smartAnswers(fresh, bare.id)).toEqual({});

    // An event may only point at a lesson or introduction of the file.
    const dangling = JSON.parse(JSON.stringify(file)) as typeof file;
    dangling.progress!.find((event) => event.kind === "answer_given")!.item = 999;
    expect(() => importPlan(fresh, dangling, Date.now() + 7000)).toThrow("plan-file");
    db.close();
    fresh.close();
  });
});
