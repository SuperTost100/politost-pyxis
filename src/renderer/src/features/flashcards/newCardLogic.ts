import type { RequestInput } from "../../../../shared/ipc";

/** What closing the dialog would lose: Pyxis at work, proposals not saved, or text the student typed. */
export type Loss = "working" | "review" | "typed";

/**
 * The question to ask before closing, or null when nothing would be lost. It looks at what the dialog holds, not at the
 * side on show: Pyxis keeps working, and its proposals stay, while the student looks at the other side.
 */
export function whatWouldBeLost(state: {
  step: "form" | "working" | "review";
  proposals: number;
  front: string;
  back: string;
  /** The name of the new subject being typed, which counts only while that subject is chosen. */
  newName: string;
  naming: boolean;
  focus: string;
}): Loss | null {
  if (state.step === "working") return "working";
  if (state.step === "review" && state.proposals > 0) return "review";
  const typed = [state.front, state.back, state.naming ? state.newName : "", state.focus];
  return typed.some((value) => value.trim()) ? "typed" : null;
}

/** What a request to Pyxis was for: the proposals are saved there, whatever the dialog shows when they are saved. */
export type ProposalTarget = { subjectId: string; planId?: string; topicId?: string };

/**
 * The input of `study.cardsSaveProposed` for the cards the student kept. They go where the request that wrote them was
 * aimed (its subject, or its topic), not where the subject and topic fields point by then: changing those fields later
 * must not move cards Pyxis wrote for another subject.
 */
export function saveProposedInput(
  made: { target: ProposalTarget; provider: string; model: string },
  rows: Array<{ front: string; back: string; passageId: string | null }>,
): RequestInput<"study.cardsSaveProposed"> {
  const { target } = made;
  return {
    ...(target.topicId ? { planId: target.planId, topicId: target.topicId } : { subjectId: target.subjectId }),
    cards: rows.map(({ front, back, passageId }) => ({ front, back, passageId })),
    provider: made.provider,
    model: made.model,
    prompt: "cards.subject",
  };
}
