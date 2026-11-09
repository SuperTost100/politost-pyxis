import { describe, expect, it } from "vitest";
import { mapPath } from "./mapPath";

describe("mapPath", () => {
  it("opens a map by its subject, and a topic of an exam without a subject at the exam's address", () => {
    expect(mapPath({ subjectId: "s", planId: "p", topicId: "t", id: "m 1" })).toBe("/maps/s/t?from=maps&map=m%201");
    expect(mapPath({ subjectId: "s", planId: null, topicId: null })).toBe("/maps/s?from=maps");
    expect(mapPath({ subjectId: null, planId: "p", topicId: "t" })).toBe("/plans/p/map/t?from=maps");
  });
});
