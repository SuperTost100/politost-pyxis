import { describe, expect, it } from "vitest";
import en from "../../locales/en.json";
import it_ from "../../locales/it.json";
import dayjs from "dayjs";
import { daysToExam, examDaysLabel, examLabel } from "./examDays";

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

describe("month-only exam", () => {
  const label = (key: string, params?: Record<string, string | number>) =>
    `${key}${params ? `:${Object.values(params).join(",")}` : ""}`;
  const first = new Date(2027, 0, 1, 12).getTime();

  it("names the month until it ends, then says past exam", () => {
    expect(examLabel(label, { examAt: first, examMonth: true, days: 20 }, "it")).toBe(
      "exams.month:gennaio 2027",
    );
    expect(examLabel(label, { examAt: first, examMonth: true, days: 0 }, "en")).toBe(
      "exams.month:January 2027",
    );
    expect(examLabel(label, { examAt: first, examMonth: true, days: -40 }, "en")).toBe(
      "exams.pastExam",
    );
    expect(examLabel(label, { examAt: first, examMonth: false, days: 5 }, "en")).toBe(
      "exams.days:5",
    );
    expect(en.exams.month).toBe("Exam in {{month}}");
    expect(it_.exams.month).toBe("Esame a {{month}}");
  });

  it("counts to the 1st, then stays at 0 for the rest of the month", () => {
    expect(daysToExam(first, true, dayjs(new Date(2026, 11, 30, 18)))).toBe(2);
    expect(daysToExam(first, true, dayjs(new Date(2027, 0, 20, 9)))).toBe(0);
    expect(daysToExam(first, true, dayjs(new Date(2027, 1, 2, 9)))).toBeLessThan(0);
    expect(daysToExam(first, false, dayjs(new Date(2027, 0, 20, 9)))).toBe(-19);
  });
});
