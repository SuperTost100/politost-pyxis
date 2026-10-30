import { describe, expect, it } from "vitest";
import { recordedPlanRun } from "./recorded-plan";
import { generateQuiz, quizConfig, type QuizSnapshot } from "../study/configuredQuiz";

const ask = (count: number, previousQuestions: string[]) => ({
  system: "Create distinct quiz questions.",
  prompt: JSON.stringify({ count, previousQuestions, passages: [] }),
  responseSchema: { name: "quiz", schema: { properties: { questions: {} } } },
});

async function stems(run: ReturnType<typeof recordedPlanRun>, count: number, previous: string[]) {
  const reply = await run(ask(count, previous) as never);
  return (reply.structured as { questions: Array<{ stem: string }> }).questions.map((question) => question.stem);
}

describe("recorded quiz replies", () => {
  it("hands each batch the recorded questions after the ones already written", async () => {
    const run = recordedPlanRun(
      JSON.stringify({ quizQuestions: { questions: "ABCDEFGHIJ".split("").map((stem) => ({ stem })) } }),
    );
    const first = await stems(run, 4, []);
    expect(first).toEqual(["A", "B", "C", "D"]);
    const second = await stems(run, 3, first);
    expect(second).toEqual(["E", "F", "G"]);
    expect(await stems(run, 3, [...first, ...second])).toEqual(["H", "I", "J"]);
  });

  it("matches stored stems the quiz trimmed against recorded stems with spaces around them", async () => {
    const run = recordedPlanRun(
      JSON.stringify({ quizQuestions: { questions: "ABCDEF".split("").map((stem) => ({ stem: ` ${stem} ` })) } }),
    );
    const first = (await stems(run, 3, [])).map((stem) => stem.trim());
    expect(first).toEqual(["A", "B", "C"]);
    expect((await stems(run, 3, first)).map((stem) => stem.trim())).toEqual(["D", "E", "F"]);
  });

  it("skips and repeats nothing when the quiz starts with a book exercise", async () => {
    const recorded = Array.from({ length: 10 }, (_, i) => ({
      kind: "tf",
      stem: `S${i}`,
      correct: true,
      passageIds: ["{{passage:0}}"],
      explanation: "Perché sì.",
    }));
    const run = recordedPlanRun(JSON.stringify({ quizQuestions: { questions: recorded } }));
    // `prepareQuiz` puts the topic's book exercise first; the model writes the other nine, four at a time.
    const snapshot = {
      config: quizConfig.parse({ count: 10, types: ["tf"] }),
      questions: [{ id: "book", stem: "Esercizio del libro", explanation: "", grade: { kind: "open", answer: "", reference: "r" } }],
      passages: [{ id: "p", text: "La velocità." }],
      language: "it",
      selection: { provider: "claude", model: "m" },
      grounding: "sources",
    } as unknown as QuizSnapshot;
    await generateQuiz(snapshot, run, undefined, undefined, 4);
    expect(snapshot.questions.map((question) => question.stem)).toEqual([
      "Esercizio del libro",
      ...recorded.slice(0, 9).map((question) => question.stem),
    ]);
  });

  it("numbers question placeholders by their place in the whole quiz", async () => {
    const run = recordedPlanRun(
      JSON.stringify({
        quizQuestions: { questions: Array.from({ length: 10 }, (_, i) => ({ stem: `Q{{question:${i}}}` })) },
      }),
    );
    expect(await stems(run, 4, [])).toEqual(["Q0", "Q1", "Q2", "Q3"]);
    expect(await stems(run, 3, ["a", "b", "c", "d"])).toEqual(["Q4", "Q5", "Q6"]);
  });
});
