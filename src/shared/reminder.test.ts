import { describe, expect, it } from "vitest";
import {
  isOpenablePath,
  isReminderTime,
  reminderText,
  type ReminderSummary,
} from "./reminder";

const summary = (over: Partial<ReminderSummary> = {}): ReminderSummary => ({
  dueCards: 12,
  planId: "p1",
  planTitle: "Analisi",
  daysToExam: 3,
  ...over,
});

describe("reminderText", () => {
  it("says the cards and the exam in Italian", () => {
    expect(reminderText("it", summary()).body).toBe(
      "12 flashcard da ripassare, esame di Analisi tra 3 giorni",
    );
    expect(reminderText("it", summary({ daysToExam: 1 })).body).toBe(
      "12 flashcard da ripassare, esame di Analisi domani",
    );
    expect(reminderText("it", summary({ daysToExam: 0 })).body).toBe(
      "12 flashcard da ripassare, esame di Analisi oggi",
    );
  });

  it("says the cards and the exam in English, with the singular", () => {
    expect(reminderText("en", summary()).body).toBe(
      "12 flashcards to review, Analisi exam in 3 days",
    );
    expect(
      reminderText("en", summary({ dueCards: 1, daysToExam: 1 })).body,
    ).toBe("1 flashcard to review, Analisi exam tomorrow");
  });

  it("leaves the exam out when it is far off, past or undated", () => {
    for (const daysToExam of [null, 31, -2])
      expect(reminderText("it", summary({ daysToExam })).body).toBe(
        "12 flashcard da ripassare",
      );
    expect(reminderText("en", summary({ daysToExam: 30 })).body).toContain(
      "in 30 days",
    );
  });

  it("shortens a long plan title", () => {
    const body = reminderText(
      "en",
      summary({ planTitle: "A".repeat(200) }),
    ).body;
    expect(body.length).toBeLessThan(120);
    expect(body).toContain("…");
  });
});

describe("isReminderTime", () => {
  it("accepts 24-hour HH:MM only", () => {
    for (const ok of ["00:00", "09:05", "18:00", "23:59"])
      expect(isReminderTime(ok)).toBe(true);
    for (const bad of ["24:00", "9:05", "18:60", "18:00:00", "", null, 1800])
      expect(isReminderTime(bad)).toBe(false);
  });
});

describe("isOpenablePath", () => {
  it("lets main open a plan page or the Flashcards page and nothing else", () => {
    expect(isOpenablePath("/plans/0198-ab_C")).toBe(true);
    expect(isOpenablePath("/exams/cards")).toBe(true);
    for (const bad of [
      "/plans/",
      "/plans/a/b",
      "/plans/../settings",
      "/settings/data",
      "https://example.com",
      "//evil",
      42,
    ])
      expect(isOpenablePath(bad)).toBe(false);
  });
});
