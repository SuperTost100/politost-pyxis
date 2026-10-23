import { useEffect, useState } from "react";

/** A longer setTimeout delay overflows and fires at once. */
const MAX_DELAY_MS = 2 ** 31 - 1;

/** How long to wait before looking at `deadline` again, or null once it has passed. */
export function deadlineCheckDelay(deadline: number, now: number): number | null {
  const left = deadline - now;
  return left > 0 ? Math.min(left, MAX_DELAY_MS) : null;
}

/**
 * Whether `deadline` has passed. While `watch` holds, it re-renders the page once, when the deadline passes, so a
 * page can lock on time-up without ticking; the clock the student sees ticks in its own small component.
 */
export function useDeadlinePassed(deadline: number | undefined, watch: boolean): boolean {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (deadline == null || !watch) return;
    const delay = deadlineCheckDelay(deadline, Date.now());
    if (delay === null) {
      if (now < deadline) setNow(Date.now());
      return;
    }
    // A timer that fires early, or a delay cut to the maximum, changes `now` and looks again.
    const timer = setTimeout(() => setNow(Date.now()), delay);
    return () => clearTimeout(timer);
  }, [deadline, watch, now]);
  return deadline != null && now >= deadline;
}

/** The current time, refreshed every `intervalMs` while `active`, and left where it was otherwise. */
export function useNow(intervalMs: number, active = true): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs, active]);
  return now;
}
