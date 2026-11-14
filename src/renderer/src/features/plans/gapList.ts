import type { JobView, RequestOutput } from "../../../../shared/ipc";

type Gaps = RequestOutput<"plans.openGaps">;

/** Whether a `gap-insight` job is reading this exam's answers on the gap's topic, which is what writes its sentence. */
export function insightRunning(jobs: ReadonlyArray<JobView>, exam: string, topic: string): boolean {
  return jobs.some(
    (job) =>
      job.kind === "gap-insight" &&
      (job.state === "queued" || job.state === "running") &&
      job.exam === exam &&
      job.topic === topic,
  );
}

type State = RequestOutput<"plans.gapState">;

/**
 * What a finished drill did to its gap, from the gap's own state (`plans.gapState`), never from its absence in the
 * exam's list: a gap that merged into another leaves the list without being closed. `state.gapId` is the gap that counts
 * (the drill's, or the one it merged into). `next` is the most serious gap still open, other than that one.
 */
export function gapEnd(state: State, gaps: Gaps): { closed: false } | { closed: true; next: Gaps["gaps"][number] | null } {
  if (!state?.closed) return { closed: false };
  return { closed: true, next: gaps.gaps.find((gap) => gap.gapId !== state.gapId) ?? null };
}
