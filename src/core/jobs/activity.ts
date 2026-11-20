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

const live = new Map<string, JobActivity>();

/** The call a job is making now, or null between calls and for a job that makes none. */
export function activityOf(jobId: string | undefined | null): JobActivity | null {
  return (jobId && live.get(jobId)) || null;
}

/**
 * Follows one model call of `jobId` from its engine events. `end` clears it, and must run however the call ends. A phase
 * never goes back: text after reasoning is `writing`, and a late reasoning event does not undo it.
 */
export function trackCall(jobId: string | undefined, now = Date.now()) {
  if (!jobId) return { event() {}, end() {} };
  const since = now;
  live.set(jobId, { phase: "starting", since });
  return {
    event(type: string) {
      const phase = live.get(jobId)?.phase;
      if (type === "reasoning.delta" && phase === "starting") live.set(jobId, { phase: "thinking", since });
      else if (type === "text.delta" && phase !== "writing" && phase !== undefined) live.set(jobId, { phase: "writing", since });
    },
    end() {
      live.delete(jobId);
    },
  };
}

/** Tests: no call is running. */
export function forgetActivity(): void {
  live.clear();
}
