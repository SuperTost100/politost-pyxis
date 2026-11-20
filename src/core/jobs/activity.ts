/**
 * What a job's model call is doing right now, for the page that waits on it. A call that thinks for a minute before it
 * writes a word gives a page nothing to show but a still sentence, so the engine's own events set a phase here and the
 * pages read it with the job's state. In memory only: a quit ends the call, and the job's state in the database says what
 * is left.
 */
export type JobActivity = {
  /** `starting`: the call began and the tool has said nothing yet. `thinking`: it reasons. `writing`: its text arrives. */
  phase: "starting" | "thinking" | "writing";
  /** When the call began, in ms since the epoch, so a page can show how long it has been going. */
  since: number;
};

/** The calls a job has running, by the order they began: one job can make several at once (two figure repairs of a part). */
const live = new Map<string, Map<symbol, JobActivity>>();

/** The call a job is making now, or null between calls and for a job that makes none. With several, the oldest one. */
export function activityOf(jobId: string | undefined | null): JobActivity | null {
  const calls = jobId ? live.get(jobId) : undefined;
  if (!calls) return null;
  let oldest: JobActivity | null = null;
  for (const call of calls.values()) if (!oldest || call.since < oldest.since) oldest = call;
  return oldest;
}

/**
 * Follows one model call of `jobId` from its engine events. `end` removes this call and no other, and must run however
 * the call ends. A phase never goes back: text after reasoning is `writing`, and a late reasoning event does not undo it.
 */
export function trackCall(jobId: string | undefined, now = Date.now()) {
  if (!jobId) return { event() {}, end() {} };
  const key = Symbol("call");
  const calls = live.get(jobId) ?? new Map<symbol, JobActivity>();
  live.set(jobId, calls);
  calls.set(key, { phase: "starting", since: now });
  return {
    event(type: string) {
      const phase = calls.get(key)?.phase;
      if (type === "reasoning.delta" && phase === "starting") calls.set(key, { phase: "thinking", since: now });
      else if (type === "text.delta" && phase !== "writing" && phase !== undefined) calls.set(key, { phase: "writing", since: now });
    },
    end() {
      calls.delete(key);
      if (calls.size === 0 && live.get(jobId) === calls) live.delete(jobId);
    },
  };
}

/** Tests: no call is running. */
export function forgetActivity(): void {
  live.clear();
}
