import { describe, expect, it } from "vitest";
import {
  deleteBody,
  resumePath,
  startedWhen,
  unfinishedDetail,
  type UnfinishedEntry,
} from "./unfinishedText";

/** A stand-in for i18next that shows the key and its values. */
const t = (key: string, options?: Record<string, unknown>) =>
  options
    ? `${key}(${Object.entries(options)
        .map(([name, value]) => `${name}=${String(value)}`)
        .join(",")})`
    : key;

const entry = (over: Partial<UnfinishedEntry>): UnfinishedEntry => ({
  id: "attempt:a1",
  kind: "quiz",
  topicId: "t1",
  topicTitle: "Limiti",
  routeTopicId: "t1",
  attemptId: "a1",
  answered: 3,
  total: 8,
  state: "open",
  startedAt: new Date(2026, 10, 11, 18, 40).getTime(),
  ...over,
});
const NOW = new Date(2026, 10, 12, 10).getTime();

describe("Da finire", () => {
  it("resumes each kind on the page that already reopens it", () => {
    expect(resumePath("p", entry({}))).toBe("/plans/p/quiz/t1?attempt=a1");
    expect(resumePath("p", entry({ kind: "diagnostic", topicId: null }))).toBe(
      "/plans/p/diagnostic?attempt=a1",
    );
    expect(resumePath("p", entry({ kind: "redo" }))).toBe(
      "/plans/p/redo?attempt=a1",
    );
    expect(resumePath("p", entry({ kind: "past" }))).toBe(
      "/plans/p/past?attempt=a1",
    );
    expect(resumePath("p", entry({ kind: "review", attemptId: null }))).toBe(
      "/plans/p/review",
    );
    expect(resumePath("p", entry({ kind: "simulation" }))).toBe(
      "/plans/p/exam/a1",
    );
    expect(
      resumePath("p", entry({ kind: "simulation", attemptId: null })),
    ).toBe("/plans/p/simulation");
  });

  it("says how far it got and when it was started", () => {
    expect(unfinishedDetail(entry({}), NOW, "it", t)).toMatch(
      /^examPage\.unfinished\.progress\(answered=3,count=8\) · examPage\.unfinished\.yesterday\(time=18:40\)$/,
    );
    expect(unfinishedDetail(entry({ state: "writing" }), NOW, "it", t)).toMatch(
      /^examPage\.unfinished\.writing · /,
    );
    expect(
      startedWhen(new Date(2026, 10, 12, 9, 5).getTime(), NOW, "it", t),
    ).toBe("examPage.unfinished.today(time=9:05)");
    // A weekday within the week, then the date.
    expect(startedWhen(new Date(2026, 10, 9, 9).getTime(), NOW, "it", t)).toBe(
      "lunedì",
    );
    expect(startedWhen(new Date(2026, 9, 30, 9).getTime(), NOW, "it", t)).toBe(
      "30 ottobre",
    );
  });

  it("says in the confirmation what a delete loses and what stays", () => {
    expect(deleteBody(entry({}), t)).toBe(
      "examPage.unfinished.lostAnswers(count=3) examPage.unfinished.staysOnPath",
    );
    expect(deleteBody(entry({ state: "writing" }), t)).toBe(
      "examPage.unfinished.lostWriting",
    );
    expect(
      deleteBody(entry({ kind: "redo", answered: 0, topicId: null }), t),
    ).toBe("examPage.unfinished.lostNothing");
    expect(
      deleteBody(
        entry({ kind: "simulation", attemptId: null, state: "ready" }),
        t,
      ),
    ).toBe("examPage.unfinished.lostPrepared");
  });
});
