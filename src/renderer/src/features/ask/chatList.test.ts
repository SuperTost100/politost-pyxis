import { describe, expect, it } from "vitest";
import { chatSubjects, filterBySubject, groupChats } from "./chatList";

// Thursday 15 October 2026, 15:00 local time. That week starts on Monday the 12th.
const now = new Date(2026, 9, 15, 15, 0).getTime();
const at = (day: number, hour = 9) => new Date(2026, 9, day, hour).getTime();

describe("groupChats", () => {
  it("files chats under today, this calendar week and older, keeping their order", () => {
    const chats = [
      { id: "a", updatedAt: at(15, 14) },
      { id: "b", updatedAt: at(15, 0) },
      { id: "c", updatedAt: at(14, 23) },
      { id: "d", updatedAt: at(12, 0) },
      { id: "e", updatedAt: at(11, 23) },
      { id: "f", updatedAt: at(1) },
    ];
    expect(groupChats(chats, now).map(({ group, chats: rows }) => [group, rows.map((row) => row.id)])).toEqual([
      ["today", ["a", "b"]],
      ["week", ["c", "d"]],
      ["older", ["e", "f"]],
    ]);
  });

  it("leaves out empty groups, and on a Monday only today and older remain", () => {
    const monday = new Date(2026, 9, 12, 10).getTime();
    const chats = [
      { id: "a", updatedAt: at(12, 8) },
      { id: "b", updatedAt: at(11, 20) },
    ];
    expect(groupChats(chats, monday).map(({ group }) => group)).toEqual(["today", "older"]);
    expect(groupChats([], now)).toEqual([]);
  });

  it("starts a Sunday's week on the Monday before", () => {
    const sunday = new Date(2026, 9, 18, 10).getTime();
    expect(groupChats([{ id: "a", updatedAt: at(12, 1) }], sunday)[0]?.group).toBe("week");
  });
});

describe("chatSubjects", () => {
  it("lists subjects in use in the subject list's order, removed ones last", () => {
    const chats = [{ subject: "Fisica" }, { subject: null }, { subject: "Chimica" }, { subject: "Analisi" }, { subject: "Fisica" }];
    expect(chatSubjects(chats, [{ name: "Analisi" }, { name: "Storia" }, { name: "Fisica" }])).toEqual([
      "Analisi",
      "Fisica",
      "Chimica",
    ]);
  });
});

describe("filterBySubject", () => {
  const chats = [
    { id: "a", subject: "Fisica" },
    { id: "b", subject: null },
    { id: "c", subject: "Analisi" },
  ];

  it("keeps every row without a subject, and only that subject's rows with one", () => {
    const hits = [{ id: "c" }, { id: "a" }, { id: "b" }];
    expect(filterBySubject(hits, "", chats)).toEqual(hits);
    expect(filterBySubject(hits, "Fisica", chats)).toEqual([{ id: "a" }]);
    expect(filterBySubject(hits, "Storia", chats)).toEqual([]);
  });
});
