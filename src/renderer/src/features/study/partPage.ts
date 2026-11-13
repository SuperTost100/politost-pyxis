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

/**
 * The first read of a part starts its job when nothing is writing it and it has nothing of its own to show. A part whose
 * write failed or was cancelled stays failed after its job is dismissed: core then gives no error, but the outline marks
 * the part failed, and it waits for Riprova as a failed job does.
 */
export function startsOnOpen(read: RequestOutput<"study.part">): boolean {
  if (read.mode !== "parts" || read.state !== "failed" || read.error !== null) return false;
  return read.outline?.parts.find((part) => part.position === read.position)?.state !== "failed";
}

/**
 * Whether a read of the lesson's address can decide for it: one this visit to the address made (`updatedAt` at or after
 * `since`, when the page came to the address), finished (no read of it running), and not a placeholder carried over
 * from the address before. Data cached from an earlier visit, or shown while the next read runs, is neither: after a
 * part is finished it still names that part, and after a stopped rewrite it names the part from before.
 */
export function freshRead(read: { fetching: boolean; placeholder: boolean; updatedAt: number }, since: number): boolean {
  return !read.fetching && !read.placeholder && read.updatedAt >= since;
}

/**
 * The part a lesson opened without one writes into its address, so finishing that part does not move the page on to
 * the next one when the part is read again: the part core chose in a fresh read (`freshRead`) of this address. Null
 * for an address that names a part or a saved item, for a lesson in the reader that came before parts, and until such
 * a read arrives.
 */
export function addressPart(
  read: RequestOutput<"study.part"> | undefined,
  address: { position?: number; itemId?: string },
  fresh: boolean,
): number | null {
  if (address.position || address.itemId || !fresh || read?.mode !== "parts") return null;
  return read.position;
}
