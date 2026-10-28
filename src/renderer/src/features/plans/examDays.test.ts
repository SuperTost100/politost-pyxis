import { describe, expect, it } from "vitest";
import en from "../../locales/en.json";
import it_ from "../../locales/it.json";
import { formatGrade } from "../../lib/grade";
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
  const on30 = (fraction: number) => formatGrade(fraction, 30, "it");
  const on100 = (fraction: number) => formatGrade(fraction, 100, "it");
  it("names the saved target, on the profile's scale, when it is the threshold", () => {
    expect(onTrackLabel(tt, 0, 11, 0.75, on100)).toBe('progress.onTrack:{"ready":0,"count":11,"target":"75/100"}');
    expect(onTrackLabel(tt, 0, 11, 0.75, on30)).toBe('progress.onTrack:{"ready":0,"count":11,"target":"22,5/30"}');
  });
  it("names the threshold a full-mark target counts against, and the target", () => {
    expect(onTrackLabel(tt, 2, 11, 1, on100)).toBe(
      'progress.onTrackReachable:{"ready":2,"count":11,"threshold":"99/100","target":"100/100"}',
    );
    expect(onTrackLabel(tt, 2, 11, 1, on30)).toBe(
      'progress.onTrackReachable:{"ready":2,"count":11,"threshold":"29,7/30","target":"30/30"}',
    );
    // The values come formatted with their scale, so the copy adds no percent sign.
    expect(it_.progress.onTrackReachable_other).not.toContain("%");
    expect(en.progress.onTrackReachable_other).not.toContain("%");
  });
});
