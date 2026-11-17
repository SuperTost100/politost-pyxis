import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isFigureFixCall, recordedPlanRun } from "./recorded-plan";
import { systemPrompt } from "./prompts";
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

describe("a call with no recorded reply", () => {
  it("fails with the name of the missing reply instead of a TypeError", async () => {
    const run = recordedPlanRun(JSON.stringify({ folders: { folders: [] } }));
    await expect(
      run({
        system: "Sort files.",
        prompt: "{}",
        responseSchema: { name: "folder-sort", schema: { properties: { files: {} } } },
      } as never),
    ).rejects.toThrow('no recorded reply for "files"');
  });
});

describe("recorded Markdown replies", () => {
  const text = (run: ReturnType<typeof recordedPlanRun>, prompt: string) =>
    run({ system: "Write.", prompt } as never).then((reply) => reply.text);

  it("answers a list in turn, fails or waits for a file where an entry says so, and logs every prompt", async () => {
    const folder = mkdtempSync(join(tmpdir(), "pyxis-recorded-"));
    try {
      const hold = join(folder, "hold");
      const log = join(folder, "prompts");
      const run = recordedPlanRun(
        JSON.stringify({
          markdown: [{ markdown: "Uno" }, { fail: "engine down" }, { markdown: "Tre", hold }],
          lessonParts: { lessonParts: [] },
        }),
        0,
        log,
      );
      expect(await text(run, "Part 1 of 3.")).toBe("Uno");
      await expect(text(run, "Part 2 of 3.")).rejects.toThrow("engine down");
      let third: string | undefined;
      const waiting = text(run, "Part 3 of 3.").then((value) => (third = value));
      await new Promise((resolve) => setTimeout(resolve, 120));
      expect(third).toBeUndefined();
      writeFileSync(hold, "");
      await waiting;
      expect(third).toBe("Tre");
      expect(await text(run, "Part 1 again")).toBe("Uno");
      await run({ system: "Split.", prompt: "{}", responseSchema: { name: "o", schema: { properties: { lessonParts: {} } } } } as never);
      expect(readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line) as string)).toEqual([
        "Part 1 of 3.",
        "Part 2 of 3.",
        "Part 3 of 3.",
        "Part 1 again",
        "{}",
      ]);
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });
});

describe("recorded figure fixes", () => {
  const fix = {
    system: `${systemPrompt("figure.fix")}\nThe code is Python.`,
    prompt: JSON.stringify({ kind: "plot", caption: "x", code: "raise ValueError()", error: "ValueError" }),
    responseSchema: { name: "response", schema: { properties: { code: {} } } },
  } as never;

  it("answers the call that corrects a figure in turn, apart from the other structured calls", async () => {
    expect(isFigureFixCall(systemPrompt("figure.fix"))).toBe(true);
    expect(isFigureFixCall("Create distinct quiz questions.")).toBe(false);
    const run = recordedPlanRun(
      JSON.stringify({
        figureFix: [{ code: "plt.plot([1])" }, { fail: "the engine is out" }, { code: "plt.plot([2])" }],
        quizQuestions: { questions: [{ stem: "A" }] },
      }),
    );
    expect((await run(fix)).structured).toEqual({ code: "plt.plot([1])" });
    // Another structured call in between does not move the list on.
    await stems(run, 1, []);
    await expect(run(fix)).rejects.toThrow("the engine is out");
    expect((await run(fix)).structured).toEqual({ code: "plt.plot([2])" });
    expect((await run(fix)).structured).toEqual({ code: "plt.plot([1])" });
  });

  it("fails by name when nothing is recorded for it, so the figure is left out", async () => {
    await expect(recordedPlanRun("{}")(fix)).rejects.toThrow('no recorded reply for "code"');
  });
});

describe("a recorded tool that is out of requests", () => {
  const selection = (provider: string) => ({ provider, model: "m" }) as never;

  it("fails every call to that tool with a usage limit and the reset time, and answers the other tools", async () => {
    const run = recordedPlanRun(
      JSON.stringify({ limited: { codex: { resetAt: "2026-12-01T00:00:00Z" } }, markdown: { markdown: "ok" } }),
    );
    await expect(run({ prompt: "{}", selection: selection("codex") })).rejects.toMatchObject({
      code: "cli-failed",
      limit: { kind: "quota", resetAt: "2026-12-01T00:00:00Z" },
    });
    await expect(run({ prompt: "{}", selection: selection("claude") })).resolves.toMatchObject({ text: "ok" });
  });

  it("can give the reset as a wait counted from the failing call, so a test sets it when it uses it", async () => {
    vi.useFakeTimers({ now: Date.parse("2026-11-17T10:00:00Z"), toFake: ["Date"] });
    try {
      const run = recordedPlanRun(JSON.stringify({ limited: { codex: { resetInMs: 25_000 } } }));
      await expect(run({ prompt: "{}", selection: selection("codex") })).rejects.toMatchObject({
        limit: { kind: "quota", resetAt: "2026-11-17T10:00:25.000Z" },
      });
      vi.setSystemTime(Date.parse("2026-11-17T10:05:00Z"));
      await expect(run({ prompt: "{}", selection: selection("codex") })).rejects.toMatchObject({
        limit: { resetAt: "2026-11-17T10:05:25.000Z" },
      });
    } finally {
      vi.useRealTimers();
    }
  });
});
