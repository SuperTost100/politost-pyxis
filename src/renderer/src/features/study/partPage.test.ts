import { describe, expect, it } from "vitest";
import {
  addressPart,
  focusFollowsAnswer,
  freshRead,
  lessonLine,
  pageMove,
  sectionFailedKey,
  partMark,
  partStateWord,
  startsOnOpen,
  stoppedTone,
  withAnswer,
  workingCopy,
  type PartData,
} from "./partPage";

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

describe("the part an address without one names", () => {
  const read = (position: number) =>
    ({
      mode: "parts",
      outline: null,
      position,
      state: "written",
      error: null,
      lesson: null,
      summary: null,
      next: null,
      replaces: null,
    }) as PartData;
  const since = 1_000;

  it("takes only a read this visit made and finished, never a cached or placeholder one", () => {
    expect(freshRead({ fetching: false, placeholder: false, updatedAt: 1_200 }, since)).toBe(true);
    // Cached from the visit before, when part 1 was still the first part not read.
    expect(freshRead({ fetching: false, placeholder: false, updatedAt: 900 }, since)).toBe(false);
    // The cached read while the new one runs.
    expect(freshRead({ fetching: true, placeholder: false, updatedAt: 900 }, since)).toBe(false);
    // The part the page came from, shown while this address is read.
    expect(freshRead({ fetching: false, placeholder: true, updatedAt: 1_200 }, since)).toBe(false);
  });

  it("names the part core chose, only for an address without a part or an item", () => {
    expect(addressPart(read(2), {}, true)).toBe(2);
    expect(addressPart(read(2), {}, false)).toBeNull();
    expect(addressPart(read(2), { position: 1 }, true)).toBeNull();
    expect(addressPart(read(2), { itemId: "i" }, true)).toBeNull();
    expect(addressPart({ mode: "legacy" } as never, {}, true)).toBeNull();
    expect(addressPart(undefined, {}, true)).toBeNull();
  });
});

describe("where the page moves", () => {
  const at = (back = false, working = false, focusInBlock = false) => ({ back, working, focusInBlock });

  it("opens another part at the top, with the focus on its title or on the block working there", () => {
    expect(pageMove("opened", at())).toEqual({ scroll: "top", focus: "title" });
    expect(pageMove("opened", at(false, true))).toEqual({ scroll: "top", focus: "block" });
    // Back and Forward leave the page where the browser puts it.
    expect(pageMove("opened", at(true))).toEqual({ scroll: null, focus: null });
  });

  it("moves to the block when a rewrite starts, and back to the title when the block goes with the focus in it", () => {
    expect(pageMove("rewriteStarted", at())).toEqual({ scroll: "block", focus: "block" });
    for (const change of ["arrived", "rewriteEnded"] as const) {
      expect(pageMove(change, at(false, false, true))).toEqual({ scroll: "title", focus: "title" });
      // The student moved on meanwhile: nothing moves under them.
      expect(pageMove(change, at())).toEqual({ scroll: null, focus: null });
    }
  });
});

describe("a section rewrite that failed", () => {
  it("says the text changed meanwhile when another rewrite was saved first, and that nothing changed otherwise", () => {
    const changed = { code: "internal", messageKey: "errors.internal", params: {}, detail: "lesson-changed" };
    const other = { code: "internal", messageKey: "errors.internal", params: {}, detail: "lesson-invalid" };
    expect(sectionFailedKey(changed, "lesson")).toBe("lesson.rewriteSectionChanged");
    expect(sectionFailedKey(changed, "part")).toBe("lesson.rewritePartSectionChanged");
    expect(sectionFailedKey(other, "lesson")).toBe("lesson.rewriteSectionFailed");
    expect(sectionFailedKey(other, "part")).toBe("lesson.rewritePartSectionFailed");
  });
});

describe("the tone of a write that did not end in text", () => {
  it("is danger when the job failed and warning when nothing failed or a tool is missing", () => {
    expect(stoppedTone("lesson-part-invalid")).toBe("danger");
    expect(stoppedTone("engines.errors.timeout")).toBe("danger");
    expect(stoppedTone(null)).toBe("warning");
    expect(stoppedTone("")).toBe("warning");
    expect(stoppedTone("engines.errors.engine-missing")).toBe("warning");
  });
});

describe("an answer saved into a part's read", () => {
  const withLesson = (itemId: string, answers: Record<string, number>) =>
    ({ mode: "parts", position: 1, lesson: { itemId, answers } }) as unknown as PartData;

  it("is added to the read of the text that was answered", () => {
    const next = withAnswer(withLesson("i1", { a: 0 }), "i1", "b", 2);
    expect(next?.lesson?.answers).toEqual({ a: 0, b: 2 });
  });

  it("is never written into another part's text, even when both ask the same question", () => {
    const other = withLesson("i2", {});
    expect(withAnswer(other, "i1", "b", 2)).toBe(other);
  });

  it("leaves a read with no lesson yet, and no read, as they are", () => {
    const planning = { mode: "parts", position: 2, lesson: null } as unknown as PartData;
    expect(withAnswer(planning, "i1", "b", 2)).toBe(planning);
    expect(withAnswer(undefined, "i1", "b", 2)).toBeUndefined();
  });
});

// A translation that shows the key and its values, so a test reads what the line is made of.
const key = (name: string, values?: Record<string, unknown>) => (values ? `${name}${JSON.stringify(values)}` : name);

describe("the bar's line on a lesson", () => {
  it("names the part, the parts there are and the minutes of a lesson in parts", () => {
    expect(lessonLine(key, { many: true, recap: false, position: 3, parts: 5, minutes: 6 })).toBe(
      'lesson.title \u00b7 lesson.partOf{"n":3,"count":5} \u00b7 lesson.barMinutes{"count":6}',
    );
  });

  it("names the recap instead of a part number", () => {
    expect(lessonLine(key, { many: true, recap: true, position: 6, parts: 5, minutes: 4 })).toBe(
      'lesson.title \u00b7 lesson.recapTitle \u00b7 lesson.barMinutes{"count":4}',
    );
  });

  it("has no part for a lesson of one part, and no length while the part is written", () => {
    expect(lessonLine(key, { many: false, recap: false, position: 1, parts: 1, minutes: 8 })).toBe(
      'lesson.title \u00b7 lesson.barMinutes{"count":8}',
    );
    expect(lessonLine(key, { many: true, recap: false, position: 2, parts: 4, minutes: null })).toBe(
      'lesson.title \u00b7 lesson.partOf{"n":2,"count":4}',
    );
    expect(lessonLine(key, { many: false, recap: false, position: 1, parts: 1, minutes: 0 })).toBe("lesson.title");
  });
});
