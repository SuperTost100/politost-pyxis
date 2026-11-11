import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { refreshSubjects } from "./refreshSubjects";

describe("refreshSubjects", () => {
  it("marks every query that shows a subject's name, whatever else its key carries, and leaves the rest", async () => {
    const client = new QueryClient();
    const named = [
      ["subjects"],
      ["sources"],
      ["plans"],
      ["plans", "planner"],
      ["plan", "p1"],
      ["chats"],
      ["chat", "c1"],
      ["cards-everywhere"],
      ["subject-cards", "s1"],
      ["card-browse", "", "", "", "all", 1],
      ["card-sections"],
      ["map-scope", "subject:s1"],
    ];
    const other = [["profile"], ["jobs"], ["maps", "subject:s1"]];
    for (const key of [...named, ...other]) client.setQueryData(key, {});
    await refreshSubjects(client);
    const stale = (key: unknown[]) => client.getQueryState(key)!.isInvalidated;
    for (const key of named) expect(stale(key), JSON.stringify(key)).toBe(true);
    for (const key of other) expect(stale(key), JSON.stringify(key)).toBe(false);
  });
});
