import { describe, expect, it } from "vitest";
import { refreshPlan } from "./refreshPlan";

describe("refreshPlan", () => {
  it("marks the exam list once and each named plan's path, next step, progress and dates", async () => {
    const keys: unknown[] = [];
    const client = {
      invalidateQueries: async ({ queryKey }: { queryKey?: readonly unknown[] } = {}) => {
        keys.push(queryKey);
      },
    };
    await refreshPlan(client, "p1", "p2", "p1");
    expect(keys).toEqual([
      ["plans"],
      ["plan", "p1"],
      ["recommend", "p1"],
      ["series", "p1"],
      ["schedule", "p1"],
      ["plan", "p2"],
      ["recommend", "p2"],
      ["series", "p2"],
      ["schedule", "p2"],
    ]);
  });
});
