import type { RequestOutput } from "../../../../shared/ipc";

// The rules of the part page that do not need the page: how a part is marked in the parts list, what the working block
// says, and whether the focus may move to Continua. Kept here so a unit test checks them.

export type PartData = Extract<RequestOutput<"study.part">, { mode: "parts" }>;
type Part = NonNullable<PartData["outline"]>["parts"][number];

/** How the parts list draws a part: the working mark, the arrow on the open one, a tick, a circle, a dashed circle. */
export type PartMark = "writing" | "current" | "done" | "written" | "unwritten";

/** A part being written shows the working mark even when it is the open one; the open one shows the arrow even when read. */
export function partMark(part: Pick<Part, "position" | "state" | "done">, current: number): PartMark {
  if (part.state === "writing") return "writing";
  if (part.position === current) return "current";
  if (part.done) return "done";
  return part.state === "written" ? "written" : "unwritten";
}

/** The state a part's link adds to its name: being written, read, or not written yet; nothing for a written part. */
export function partStateWord(part: Pick<Part, "state" | "done">): "writing" | "read" | "unwritten" | null {
  if (part.state === "writing") return "writing";
  if (part.done) return "read";
  return part.state === "written" ? null : "unwritten";
}

/** What the working block says while a part is planned or written: its heading key and values, and its line. */
export function workingCopy(input: {
  state: "planning" | "writing";
  position: number;
  kind: Part["kind"] | null;
  /** The topic has more than one part. False while it is planned, and for a topic of one part. */
  many: boolean;
}): { title: [string, Record<string, unknown>?]; line: [string, Record<string, unknown>?] | null } {
  if (input.state === "planning") return { title: ["lesson.planning"], line: ["lesson.planningLine"] };
  if (input.kind === "recap") return { title: ["lesson.writingRecap"], line: ["lesson.writingRecapLine"] };
  if (!input.many) return { title: ["lesson.writing"], line: null };
  return input.position > 1
    ? {
        title: ["lesson.writingPart", { n: input.position }],
        line: ["lesson.writingPartLine", { previous: input.position - 1 }],
      }
    : { title: ["lesson.writingPart", { n: 1 }], line: ["lesson.writingFirstLine"] };
}

/**
 * Whether the focus moves to Continua once an answer is saved: only when it is still where it was when the student
 * answered (the option, or the page itself for a letter key), or it fell back to the page. A student who moved it on
 * meanwhile keeps it there.
 */
export function focusFollowsAnswer(before: unknown, now: unknown, body: unknown): boolean {
  return now === before || now === body || now === null;
}

/** The first read of a part starts its job when nothing is writing it and it has no error of its own to show. */
export function startsOnOpen(read: RequestOutput<"study.part">): boolean {
  return read.mode === "parts" && read.state === "failed" && read.error === null;
}
