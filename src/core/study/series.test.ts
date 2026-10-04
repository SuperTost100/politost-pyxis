import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  activeMinutes,
  chartPoints,
  openGaps,
  paceFacts,
  weeklyCounts,
} from "./series";

const DAY = 86_400_000;

describe("study series", () => {
  const now = Date.UTC(2026, 0, 14, 12);

  it("puts today's study on the last point of a 14-day chart", () => {
    const points = chartPoints(
      [{ topicId: "a", at: now, score: 1, kind: "quiz" }],
      now,
    );
    expect(points).toHaveLength(14);
    expect(points[13]?.count).toBe(1);
    expect(points[13]?.mastery).toBeCloseTo(0.25);
    expect(points[0]?.count).toBe(0);
    expect(points[0]?.mastery).toBe(0);
  });

  it("counts this week in the last column", () => {
    const grid = weeklyCounts(
      [{ topicId: "a", at: now, score: 1, kind: "lesson" }],
      ["a"],
      now,
    );
    expect(grid.counts.a?.[4]).toBe(1);
    expect(grid.counts.a?.slice(0, 4).every((count) => count === 0)).toBe(true);
    const facts = paceFacts(
      chartPoints([{ topicId: "a", at: now, score: 1, kind: "lesson" }], now),
      now,
    );
    expect(facts.week).toBe(1);
    expect(facts.peakCount).toBe(1);
    const quiet = activeMinutes([], now).bars;
    expect(
      paceFacts(
        chartPoints([{ topicId: "a", at: now, score: 1, kind: "lesson" }], now),
        now,
        quiet,
      ).peakCount,
    ).toBe(1);
    const minutes = activeMinutes(
      [{ topicId: "", at: now, score: 0, kind: "active", seconds: 90 }],
      now,
    );
    expect(minutes.weekSeconds).toBe(90);
    expect(minutes.bars[13]?.seconds).toBe(90);
  });

  it("keeps a Sunday study when America/Santiago skips midnight", () => {
    execFileSync(
      process.execPath,
      [
        join(import.meta.dirname, "../../../node_modules/tsx/dist/cli.mjs"),
        join(import.meta.dirname, "series.santiago.ts"),
      ],
      {
        env: {
          ...process.env,
          ELECTRON_RUN_AS_NODE: "1",
          TZ: "America/Santiago",
        },
        stdio: "pipe",
      },
    );
  });

  it("opens a gap on two misses and closes it after two clean days", () => {
    const openedAt = Date.UTC(2026, 0, 1, 12);
    const miss = {
      topicId: "a",
      at: openedAt,
      score: 0,
      scores: [0, 0],
      kind: "quiz" as const,
    };
    expect(openGaps([miss])).toEqual([{ topicId: "a", openedAt }]);
    expect(
      openGaps([
        miss,
        {
          topicId: "a",
          at: openedAt + DAY,
          score: 1,
          scores: [1],
          kind: "quiz",
        },
        {
          topicId: "a",
          at: openedAt + 2 * DAY,
          score: 1,
          scores: [1],
          kind: "quiz",
        },
      ]),
    ).toEqual([]);
    expect(
      openGaps([
        miss,
        {
          topicId: "a",
          at: openedAt + DAY,
          score: 0,
          scores: [0],
          kind: "quiz",
        },
      ]),
    ).toEqual([{ topicId: "a", openedAt }]);
    expect(
      openGaps([
        miss,
        {
          topicId: "a",
          at: openedAt + DAY,
          score: 1,
          scores: [1],
          kind: "quiz",
        },
        {
          topicId: "a",
          at: openedAt + 2 * DAY,
          score: 1,
          scores: [1],
          kind: "quiz",
        },
        {
          topicId: "a",
          at: openedAt + 3 * DAY,
          score: 0,
          scores: [0],
          kind: "quiz",
        },
      ]),
    ).toEqual([]);
  });
});

it("charts individual quiz answers and does not count reading as mastery", () => {
  const now = new Date(2026, 0, 14, 12).getTime();
  const points = chartPoints(
    [
      {
        topicId: "a",
        at: now,
        kind: "quiz",
        score: 0.5,
        scores: [1, 0],
        answerKinds: ["open", "mcq"],
      },
      { topicId: "a", at: now, kind: "lesson", score: 1 },
    ],
    now,
  );
  const decay =
    0.5 ** ((new Date(2026, 0, 15).getTime() - 1 - now) / (14 * 86400000));
  expect(points.at(-1)!.mastery).toBeCloseTo((1.5 * decay) / (3 + 2.5 * decay));
});
