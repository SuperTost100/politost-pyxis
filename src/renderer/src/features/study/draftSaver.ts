import { useEffect, useRef, useState } from "react";

/**
 * Saves answers while the student works. `schedule` keeps the newest draft and saves it once changes pause for
 * `delay` ms; `flush` saves it at once; `cancel` drops it. Saves run one after another, so an older draft never lands
 * after a newer one, and a failed save calls `onError` without stopping the next.
 *
 * `flush(true)` is for a page that is going away: the draft is sent now instead of after a save still on its way, which
 * the page may not live to see come back (a reload), and before the read of the page opened next. Core answers requests
 * in the order they arrive, so it still lands after the earlier save.
 */
export function draftSaver<T>(
  save: (draft: T) => Promise<unknown>,
  onError: () => void,
  delay: number,
) {
  let pending: { draft: T } | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let saving: Promise<unknown> = Promise.resolve();
  function flush(leaving = false): Promise<unknown> {
    clearTimeout(timer);
    const next = pending;
    pending = null;
    if (next && leaving) {
      const sent = save(next.draft).catch(onError);
      saving = Promise.all([saving.catch(() => undefined), sent]);
    } else if (next)
      saving = saving
        .catch(() => undefined)
        .then(() => save(next.draft))
        .catch(onError);
    return saving;
  }
  return {
    schedule(draft: T) {
      pending = { draft };
      clearTimeout(timer);
      timer = setTimeout(() => void flush(), delay);
    },
    cancel() {
      clearTimeout(timer);
      pending = null;
    },
    flush,
  };
}

/**
 * A draftSaver for a page: it calls the latest `save` and `onError`, and saves what is left at once when the page
 * closes, whether it is left for another page or the window reloads.
 */
export function useDraftSaver<T>(
  save: (draft: T) => Promise<unknown>,
  onError: () => void,
  delay = 500,
) {
  const latest = useRef({ save, onError });
  latest.current = { save, onError };
  const [saver] = useState(() =>
    draftSaver<T>(
      (draft) => latest.current.save(draft),
      () => latest.current.onError(),
      delay,
    ),
  );
  useEffect(() => {
    // A reload unloads the page without running its effects' cleanup.
    const leave = () => void saver.flush(true);
    window.addEventListener("pagehide", leave);
    return () => {
      window.removeEventListener("pagehide", leave);
      leave();
    };
  }, [saver]);
  return saver;
}
