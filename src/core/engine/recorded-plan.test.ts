import { describe, expect, it } from "vitest";
import { recordedPlanRun } from "./recorded-plan";

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
