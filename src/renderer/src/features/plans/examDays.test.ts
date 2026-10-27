import { describe, expect, it } from "vitest";
import en from "../../locales/en.json";
import it_ from "../../locales/it.json";
import { examDaysLabel, onTrackLabel } from "./examDays";

const t = (key: string, params?: { count?: number }) => `${key}${params ? `:${params.count}` : ""}`;

describe("exam days label", () => {
  it("says today on the exam day and past exam after it, never 0 days", () => {
    expect(examDaysLabel(t, 3)).toBe("exams.days:3");
    expect(examDaysLabel(t, 1)).toBe("exams.days:1");
    expect(examDaysLabel(t, 0)).toBe("exams.today");
    expect(examDaysLabel(t, -2)).toBe("exams.pastExam");
    expect(en.exams.today).toBe("Exam today");
    expect(it_.exams.today).toBe("Esame oggi");
  });
});

describe("on-track label", () => {
  const tt = (key: string, params?: Record<string, unknown>) => `${key}${params ? `:${JSON.stringify(params)}` : ""}`;
  it("names the saved target when it is the threshold", () => {
    expect(onTrackLabel(tt, 0, 11, 0.75)).toBe('progress.onTrack:{"ready":0,"count":11,"target":75}');
  });
  it("names the 99% threshold a 100% target counts against, and the target", () => {
    expect(onTrackLabel(tt, 2, 11, 1)).toBe(
      'progress.onTrackReachable:{"ready":2,"count":11,"threshold":99,"target":100}',
    );
    expect(it_.progress.onTrackReachable_other).toContain("{{threshold}}%");
    expect(en.progress.onTrackReachable_other).toContain("{{threshold}}%");
  });
});
