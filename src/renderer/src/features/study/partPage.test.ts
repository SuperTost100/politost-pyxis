import { describe, expect, it } from "vitest";
import { focusFollowsAnswer, partMark, partStateWord, startsOnOpen, workingCopy, type PartData } from "./partPage";

const part = (position: number, state: "unwritten" | "writing" | "written" | "failed", done = false) => ({
  position,
  state,
  done,
});

describe("the parts list", () => {
  it("marks the part being written with the working mark, even when it is the open one", () => {
    expect(partMark(part(4, "writing"), 4)).toBe("writing");
    expect(partMark(part(5, "writing"), 4)).toBe("writing");
  });

  it("marks the open part with the arrow, read or not, and the others by what they are", () => {
    expect(partMark(part(3, "written", true), 3)).toBe("current");
    expect(partMark(part(3, "unwritten"), 3)).toBe("current");
    expect(partMark(part(1, "written", true), 3)).toBe("done");
    expect(partMark(part(4, "written"), 3)).toBe("written");
    expect(partMark(part(5, "unwritten"), 3)).toBe("unwritten");
    expect(partMark(part(5, "failed"), 3)).toBe("unwritten");
  });

  it("names each part's state in its link: being written, read, or not written yet", () => {
    expect(partStateWord(part(1, "writing"))).toBe("writing");
    expect(partStateWord(part(1, "written", true))).toBe("read");
    // A part read as book text, never written, is still read.
    expect(partStateWord(part(1, "unwritten", true))).toBe("read");
    expect(partStateWord(part(1, "failed"))).toBe("unwritten");
    expect(partStateWord(part(1, "written"))).toBeNull();
  });
});

describe("the working block", () => {
  it("says the chapter is being split before the plan exists", () => {
    expect(workingCopy({ state: "planning", position: 1, kind: null, many: false })).toEqual({
      title: ["lesson.planning"],
      line: ["lesson.planningLine"],
    });
  });

  it("names the part and where it picks up, the first part and the recap their own way", () => {
    expect(workingCopy({ state: "writing", position: 4, kind: "part", many: true })).toEqual({
      title: ["lesson.writingPart", { n: 4 }],
      line: ["lesson.writingPartLine", { previous: 3 }],
    });
    expect(workingCopy({ state: "writing", position: 1, kind: "part", many: true }).line).toEqual(["lesson.writingFirstLine"]);
    expect(workingCopy({ state: "writing", position: 9, kind: "recap", many: true }).title).toEqual(["lesson.writingRecap"]);
  });

  it("speaks of the lesson, not of part 1, on a topic of one part", () => {
    expect(workingCopy({ state: "writing", position: 1, kind: "part", many: false })).toEqual({
      title: ["lesson.writing"],
      line: null,
    });
  });
});

describe("after the answer", () => {
  const option = {};
  const elsewhere = {};
  const body = {};

  it("moves the focus to Continua from where the student answered, or from the page", () => {
    expect(focusFollowsAnswer(option, option, body)).toBe(true);
    expect(focusFollowsAnswer(body, body, body)).toBe(true);
    expect(focusFollowsAnswer(option, null, body)).toBe(true);
  });

  it("leaves the focus where the student moved it meanwhile", () => {
    expect(focusFollowsAnswer(option, elsewhere, body)).toBe(false);
  });
});

describe("opening a part", () => {
  const read = (state: PartData["state"], error: string | null) =>
    ({
      mode: "parts",
      outline: null,
      position: 1,
      state,
      error,
      lesson: null,
      summary: null,
      next: null,
      replaces: null,
    }) as PartData;

  it("starts the job of a part nothing is writing, and of one stopped by a quit", () => {
    expect(startsOnOpen(read("failed", null))).toBe(true);
  });

  it("leaves a failed job for Riprova, and a part written or being written alone", () => {
    expect(startsOnOpen(read("failed", "lesson-part-invalid"))).toBe(false);
    expect(startsOnOpen(read("writing", null))).toBe(false);
    expect(startsOnOpen(read("written", null))).toBe(false);
    expect(startsOnOpen({ mode: "legacy" })).toBe(false);
  });

  it("leaves a part whose failed or cancelled job was dismissed for Riprova, as the outline marks it", () => {
    const outline = (state: "unwritten" | "failed") =>
      ({
        id: "o",
        teaching: 2,
        done: 0,
        minutesLeft: 10,
        parts: [1, 2].map((position) => ({
          id: `p${position}`,
          position,
          kind: "part",
          title: `Parte ${position}`,
          about: "",
          minutes: 5,
          state: position === 1 ? state : "unwritten",
          done: false,
        })),
      }) as NonNullable<PartData["outline"]>;
    expect(startsOnOpen({ ...read("failed", null), outline: outline("failed") })).toBe(false);
    expect(startsOnOpen({ ...read("failed", null), outline: outline("unwritten") })).toBe(true);
  });
});
