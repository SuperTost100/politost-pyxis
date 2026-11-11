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
