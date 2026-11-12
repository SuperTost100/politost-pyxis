/** What Crea started that takes a while: the exam page shows it working in Adesso, then opens it. */
export type MadeActivity =
  | { kind: "quiz"; planId: string; attemptId: string; topicId: string; topicTitle: string }
  | { kind: "simulation"; planId: string; jobId: string };

/** The job states after which nothing more is being written. */
export const SETTLED = ["succeeded", "failed", "cancelled", "interrupted"];

/** What was made on this exam, or null when the page now shows another exam: an activity belongs to its own. */
export function madeFor(made: MadeActivity | null, planId: string): MadeActivity | null {
  return made && made.planId === planId ? made : null;
}

/**
 * Whether the simulation build that Crea just started is over. Only the build with that job id counts. An older build of
 * the same exam can sit in the cache under the same key, so a result for another job is waited out; once a read made
 * since this page opened still finds another job, or none, this one is gone, and the simulation page says what happened.
 */
export function simulationSettled(
  jobId: string,
  build: {
    data: { jobId: string; state: string } | null | undefined;
    isError: boolean;
    isFetchedAfterMount: boolean;
  },
): boolean {
  if (build.isError) return true;
  if (build.data?.jobId === jobId) return SETTLED.includes(build.data.state);
  return build.isFetchedAfterMount;
}
