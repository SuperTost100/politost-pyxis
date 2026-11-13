import { describe, expect, it } from "vitest";
import { oldLessonView, type PartData } from "./partPage";

const outline = (...states: Array<"unwritten" | "writing" | "written" | "failed">): PartData["outline"] => ({
  id: "o",
  teaching: states.length,
  done: 0,
  minutesLeft: 5 * states.length,
  parts: states.map((state, index) => ({
    id: `p${index + 1}`,
    position: index + 1,
    kind: "part" as const,
    title: `Parte ${index + 1}`,
    about: "",
    minutes: 5,
    state,
    done: false,
  })),
});

const replaces = { itemId: "old" };

describe("a lesson in parts that rewrites an old one", () => {
  it("shows the rewriting state while it is planned and while its first part is written", () => {
    expect(oldLessonView({ replaces, outline: null, state: "planning" })).toBe("rewriting");
    expect(oldLessonView({ replaces, outline: outline("writing", "unwritten"), state: "writing" })).toBe("rewriting");
  });

  it("shows the old lesson as it was when the rewrite failed, stopped or found no AI tool", () => {
    expect(oldLessonView({ replaces, outline: null, state: "failed" })).toBe("fallback");
    expect(oldLessonView({ replaces, outline: null, state: "book" })).toBe("fallback");
    // The outline was saved, then part 1 failed: there is still nothing in parts to read.
    expect(oldLessonView({ replaces, outline: outline("failed", "unwritten"), state: "failed" })).toBe("fallback");
  });

  it("is an ordinary lesson in parts once a part is written, and for a topic with no old lesson", () => {
    expect(oldLessonView({ replaces, outline: outline("written", "writing"), state: "writing" })).toBeNull();
    expect(oldLessonView({ replaces, outline: outline("written", "failed"), state: "failed" })).toBeNull();
    expect(oldLessonView({ replaces, outline: outline("written"), state: "written" })).toBeNull();
    expect(oldLessonView({ replaces: null, outline: null, state: "failed" })).toBeNull();
    expect(oldLessonView({ replaces: null, outline: null, state: "planning" })).toBeNull();
  });
});
