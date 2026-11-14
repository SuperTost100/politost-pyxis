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

/**
 * What a finished drill did to its gap. The core closes a gap when the exam's gaps are read, and `plans.openGaps` is
 * that read, so the gap is closed when the exam no longer lists it. A list cut at its limit cannot say that a gap beyond
 * it is gone, so it says it is not closed then. `next` is the most serious gap that remains.
 */
export function gapEnd(gaps: Gaps, gapId: string): { closed: false } | { closed: true; next: Gaps["gaps"][number] | null } {
  const listed = gaps.gaps.some((gap) => gap.gapId === gapId);
  if (listed || gaps.gaps.length < gaps.total) return { closed: false };
  return { closed: true, next: gaps.gaps[0] ?? null };
}
