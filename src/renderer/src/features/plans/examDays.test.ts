import { describe, expect, it } from "vitest";
import en from "../../locales/en.json";
import it_ from "../../locales/it.json";
import { examDaysLabel } from "./examDays";

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
