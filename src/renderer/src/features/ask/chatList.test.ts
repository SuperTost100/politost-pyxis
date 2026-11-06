import { describe, expect, it } from "vitest";
import { groupChats } from "./chatList";

// Thursday 15 October 2026, 15:00 local time. That week starts on Monday the 12th.
const now = new Date(2026, 9, 15, 15, 0).getTime();
const at = (day: number, hour = 9) => new Date(2026, 9, day, hour).getTime();
const groups = (chats: Array<{ id: string; updatedAt: number }>, when = now) =>
  groupChats(chats, when).map(({ group, chats: rows }) => [group, rows.map((row) => row.id)]);

describe("groupChats", () => {
  it("files chats under today, yesterday, the rest of this calendar week and earlier, keeping their order", () => {
    expect(
      groups([
        { id: "a", updatedAt: at(15, 14) },
        { id: "b", updatedAt: at(15, 0) },
        { id: "c", updatedAt: at(14, 23) },
        { id: "d", updatedAt: at(14, 0) },
        { id: "e", updatedAt: at(13, 23) },
        { id: "f", updatedAt: at(12, 0) },
        { id: "g", updatedAt: at(11, 23) },
        { id: "h", updatedAt: at(1) },
      ]),
    ).toEqual([
      ["today", ["a", "b"]],
      ["yesterday", ["c", "d"]],
      ["week", ["e", "f"]],
      ["older", ["g", "h"]],
    ]);
  });

  it("keeps a Monday's yesterday, the Sunday before, under Yesterday, and leaves out empty groups", () => {
    const monday = new Date(2026, 9, 12, 10).getTime();
    expect(
      groups(
        [
          { id: "a", updatedAt: at(12, 8) },
          { id: "b", updatedAt: at(11, 20) },
          { id: "c", updatedAt: at(10, 20) },
        ],
        monday,
      ),
    ).toEqual([
      ["today", ["a"]],
      ["yesterday", ["b"]],
      ["older", ["c"]],
    ]);
    expect(groupChats([], now)).toEqual([]);
  });

  it("starts a Sunday's week on the Monday before", () => {
    const sunday = new Date(2026, 9, 18, 10).getTime();
    expect(groupChats([{ id: "a", updatedAt: at(12, 1) }], sunday)[0]?.group).toBe("week");
  });
});
