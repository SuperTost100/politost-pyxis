/**
 * What the address asks of Ripasso mirato: `?drill=<topicId>` starts a drill once. `started` is the request already
 * acted on. It is cleared when the parameter is gone, so asking for the same topic again later starts another drill,
 * while the same request seen twice (the effect running again before the parameter is removed) starts only one.
 */
export function readDrillRequest(
  requested: string | null,
  started: string | null,
): { started: string | null; begin: string | null } {
  if (!requested) return { started: null, begin: null };
  if (started === requested) return { started, begin: null };
  return { started: requested, begin: requested };
}

/**
 * The topic whose drill stopped, if one did. A drill that could not even be started has no job to read, so its topic is
 * kept apart in `failedTopic`; Retry needs it to start the same drill again.
 */
export function stoppedTopic(
  failedTopic: string | null,
  jobStopped: boolean,
  drillTopic: string | null,
): string | null {
  return failedTopic ?? (jobStopped ? drillTopic : null);
}

/**
 * A gap's page (`/plans/:planId/gap/:gapId`) starts the drill of the gap it shows, once for each gap. `gapId` is the gap
 * once the exam's list has it, null until then; `started` is the gap already asked for. A gap that is missing from a
 * later read (it merged into another, or the read failed) keeps `started`, so its return does not ask again, and the
 * drill that is running goes on. Going to another gap in the same page asks for that one.
 */
export function readGapStart(
  gapId: string | null,
  started: string | null,
): { started: string | null; begin: boolean } {
  if (!gapId || gapId === started) return { started, begin: false };
  return { started: gapId, begin: true };
}

/** Where a drill's quiz opens: its attempt, and the gap it is for when the page that asked knows which. */
export function drillQuizPath(planId: string, topicId: string, attemptId: string, gapId?: string): string {
  return `/plans/${planId}/quiz/${topicId}?attempt=${attemptId}${gapId ? `&gap=${encodeURIComponent(gapId)}` : ""}`;
}

/**
 * What a drill read says. `read` is `study.gapDrillRead`'s answer (undefined until it came). Before the page knows the job
 * it started, the read is by gap and says nothing for a gap with no drill yet, which is a drill still to come. Once the
 * job is known the read is by job: nothing found then, or a job that finished with no attempt, means no quiz will come,
 * and the page must say that and not keep its working mark for work that is over.
 */
export function drillStatus(
  read: { state: string; attemptId: string | null } | null | undefined,
  jobKnown: boolean,
): { state: string; attemptId: string | null } {
  if (read === undefined) return { state: "queued", attemptId: null };
  if (read === null) return { state: jobKnown ? "failed" : "queued", attemptId: null };
  if (read.state === "succeeded" && !read.attemptId) return { state: "failed", attemptId: null };
  return { state: read.state, attemptId: read.attemptId };
}
