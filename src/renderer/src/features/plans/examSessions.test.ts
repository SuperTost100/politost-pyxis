import { describe, expect, it } from "vitest";
import {
  draftsFromSessions,
  emptyDraft,
  nextUpcomingDay,
  sameSessions,
  sessionsFromDrafts,
} from "./examSessions";

describe("exam session drafts", () => {
  it("saves noon on the day, with empty fields as null, and drops rows without a date", () => {
    const drafts = [
      emptyDraft({ date: "2026-12-15", time: "09:30", place: " Aula 5 ", label: "Written" }),
      emptyDraft({ date: "2026-12-20" }),
      emptyDraft({ place: "Aula 1" }),
    ];
    expect(sessionsFromDrafts(drafts)).toEqual([
      { date: new Date(2026, 11, 15, 12).getTime(), time: "09:30", place: "Aula 5", label: "Written" },
      { date: new Date(2026, 11, 20, 12).getTime(), time: null, place: null, label: null },
    ]);
  });

  it("round-trips saved sessions and keeps their IDs", () => {
    const saved = [
      { id: "a", date: new Date(2026, 11, 15, 12).getTime(), time: "09:30", place: "Aula 5", label: null },
    ];
    const drafts = draftsFromSessions(saved);
    expect(drafts[0]).toMatchObject({ id: "a", date: "2026-12-15", time: "09:30", place: "Aula 5", label: "" });
    expect(sessionsFromDrafts(drafts)).toEqual(saved);
  });

  it("tells an edit from the saved list, and ignores empty rows", () => {
    const saved = draftsFromSessions([
      { id: "a", date: new Date(2026, 11, 15, 12).getTime(), time: null, place: null, label: null },
    ]);
    expect(sameSessions(saved, [...saved, emptyDraft()])).toBe(true);
    expect(sameSessions(saved, [{ ...saved[0]!, time: "10:00" }])).toBe(false);
    expect(sameSessions(saved, [])).toBe(false);
  });

  it("finds the next day that is not over", () => {
    const drafts = [emptyDraft({ date: "2026-10-01" }), emptyDraft({ date: "2026-12-02" }), emptyDraft({ date: "2026-11-02" })];
    expect(nextUpcomingDay(drafts, "2026-10-17")).toBe("2026-11-02");
    expect(nextUpcomingDay(drafts, "2027-01-01")).toBeNull();
    expect(nextUpcomingDay([], "2026-10-17")).toBeNull();
  });
});
