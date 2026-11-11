import { blanks, pairs } from "./quizText";

/**
 * What the student has given for one question, as the Domande card and Consegna count it: an answer, an explicit
 * "Non lo so" (an empty pick), or nothing yet.
 */
export type Given = "answer" | "dontKnow" | "none";

export function given(kind: string, raw: string | undefined): Given {
  if (raw === undefined) return "none";
  if (raw === "") return "dontKnow";
  if (kind === "completion") return blanks(raw).some((value) => value.trim()) ? "answer" : "none";
  if (kind === "matching") return pairs(raw).some(([, right]) => right.trim()) ? "answer" : "none";
  return raw.trim() ? "answer" : "none";
}

/**
 * The picks after an edit to one question. An edit that leaves nothing in the fields removes the pick, so an answer
 * typed and then erased goes back to blank and never reads as "Non lo so", which only its button sets.
 */
export function editedPicks(
  picks: Record<string, string>,
  id: string,
  kind: string,
  value: string,
): Record<string, string> {
  const next = { ...picks };
  if (given(kind, value) === "answer") next[id] = value;
  else delete next[id];
  return next;
}

/** "Non lo so" sets an empty pick; pressing it again on the same question takes it back. */
export function dontKnowPicks(picks: Record<string, string>, id: string): Record<string, string> {
  const next = { ...picks };
  if (next[id] === "") delete next[id];
  else next[id] = "";
  return next;
}

/** Marks or unmarks one question "Segna per dopo", keeping the list in question order. */
export function toggleMarked(marked: string[], id: string, order: string[]): string[] {
  const set = new Set(marked);
  if (set.has(id)) set.delete(id);
  else set.add(id);
  return order.filter((item) => set.has(item));
}

type Asked = { id: string; kind: string };

/** How many questions Consegna would hand in blank, and how many are still marked for later. */
export function handInCount(
  questions: Asked[],
  picks: Record<string, string>,
  marked: string[],
): { given: number; blank: number; marked: number } {
  const ids = new Set(questions.map((question) => question.id));
  const blank = questions.filter((question) => given(question.kind, picks[question.id]) === "none").length;
  return {
    given: questions.length - blank,
    blank,
    marked: new Set(marked.filter((id) => ids.has(id))).size,
  };
}

/** The answer sheet Consegna sends: every question, a blank one as an empty pick, which core scores as "Non lo so". */
export function handInPicks(questions: Asked[], picks: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    questions.map((question) => {
      const raw = picks[question.id];
      return [question.id, given(question.kind, raw) === "answer" ? raw! : ""];
    }),
  );
}

/**
 * A draft saved before 0.5 kept skipped questions instead of marked ones. A skip meant "later", so an unanswered
 * skipped question comes back marked for later.
 */
export function restoredMarked(
  draft: { marked?: string[]; skipped?: string[]; picks?: Record<string, string> } | undefined,
  questions: Asked[],
): string[] {
  const order = questions.map((question) => question.id);
  const wanted = draft?.marked
    ? draft.marked
    : (draft?.skipped ?? []).filter((id) => {
        const kind = questions.find((question) => question.id === id)?.kind ?? "";
        return given(kind, draft?.picks?.[id]) === "none";
      });
  const set = new Set(wanted);
  return order.filter((id) => set.has(id));
}
