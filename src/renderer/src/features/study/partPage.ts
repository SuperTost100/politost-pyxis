import type { RequestOutput } from "../../../../shared/ipc";
import { errorDetails } from "../../lib/errorDetails";

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
 * The tone of the notice for a write or a rewrite that did not end in text. Core gives the job's error when the job
 * failed, and none when it was cancelled or interrupted (or never started): a failure is the danger tone, and a stop
 * with nothing failed, or one that only waits for an AI tool to be set up, is the warning tone, a step that waits for
 * the student (docs/design-system/feedback.md).
 */
export function stoppedTone(error: string | null | undefined): "danger" | "warning" {
  return error?.trim() && !error.includes("engine-missing") ? "danger" : "warning";
}

// Old lessons in parts.

/**
 * How the page shows a lesson in parts that rewrites one written before parts, while none of its parts is written:
 * `rewriting` while it is planned or written, with the way to the earlier version; `fallback` when the rewrite failed,
 * stopped or found no AI tool, so the old lesson shows as it was, under what happened and Riprova. Null otherwise.
 */
export function oldLessonView(data: Pick<PartData, "replaces" | "outline" | "state">): "rewriting" | "fallback" | null {
  if (!data.replaces || data.outline?.parts.some((part) => part.state === "written")) return null;
  if (data.state === "planning" || data.state === "writing") return "rewriting";
  if (data.state === "failed" || data.state === "book") return "fallback";
  return null;
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

/**
 * A part's read with the answer just saved, or the read untouched when it is no read of the text that was answered: the
 * cache entry of an address can hold another part's text than the one on screen when the answer was sent, and an
 * answer belongs to its own text only (an item id), so it is never written into another part's lesson.
 */
export function withAnswer(current: PartData | undefined, itemId: string, blockId: string, pick: number): PartData | undefined {
  if (!current?.lesson || current.lesson.itemId !== itemId) return current;
  return { ...current, lesson: { ...current.lesson, answers: { ...current.lesson.answers, [blockId]: pick } } };
}

/** What changed on the part page: another part opened, the part waited for arrived, a rewrite of it started or ended. */
export type PageChange = "opened" | "arrived" | "rewriteStarted" | "rewriteEnded";

/**
 * Where the part page scrolls and what takes the focus when what it shows changes, one rule for every case, so a change
 * moves the page once:
 * - another part opened (Continua, the column, a link): the top of the page at once, never smoothly, with the focus on
 *   the title, or on the working block's way back when a block is working there (the part planned or written, or a
 *   rewrite of it running). Back and Forward keep where the student was, as the browser restores it.
 * - a rewrite started on the part on screen: the page moves to the block, which takes the focus.
 * - the part waited for arrived, or a rewrite ended: the title takes the focus, and the page moves to it, only when the
 *   focus was in the block that goes, or nowhere; otherwise nothing moves.
 */
export function pageMove(
  change: PageChange,
  input: { back: boolean; working: boolean; focusInBlock: boolean },
): { scroll: "top" | "block" | "title" | null; focus: "title" | "block" | null } {
  if (change === "opened") {
    if (input.back) return { scroll: null, focus: null };
    return { scroll: "top", focus: input.working ? "block" : "title" };
  }
  if (change === "rewriteStarted") return { scroll: "block", focus: "block" };
  return input.focusInBlock ? { scroll: "title", focus: "title" } : { scroll: null, focus: null };
}

/**
 * What a section rewrite that failed tells the student: when another rewrite of the lesson or the part was saved while
 * it ran (`lesson-changed`), that the text changed meanwhile and this section did not, so they try again on the new
 * text; any other failure, that nothing changed.
 */
export function sectionFailedKey(error: unknown, noun: "lesson" | "part"): string {
  const changed = errorDetails(error) === "lesson-changed";
  if (noun === "lesson") return changed ? "lesson.rewriteSectionChanged" : "lesson.rewriteSectionFailed";
  return changed ? "lesson.rewritePartSectionChanged" : "lesson.rewritePartSectionFailed";
}
