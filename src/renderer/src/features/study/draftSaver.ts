import { useEffect, useRef, useState } from "react";

/**
 * Saves answers while the student works. `schedule` keeps the newest draft and saves it once changes pause for
 * `delay` ms; `flush` saves it at once; `cancel` drops it. Saves run one after another and a draft is never sent after
 * a newer one: when a queued save's turn comes it sends the newest draft there is, so a draft that was overtaken is
 * dropped. A failed save calls `onError` without stopping the next.
 *
 * `flush(true)` is for a page that is going away: the newest draft is sent now instead of after a save still on its
 * way, which the page may not live to see come back (a reload), and before the read of the page opened next. Core
 * answers requests in the order they arrive, so it lands after the save already sent. Older drafts still queued are
 * dropped, so none can land after it.
 */
export function draftSaver<T>(
  save: (draft: T) => Promise<unknown>,
  onError: () => void,
  delay: number,
) {
  // `pending` waits for its timer; `queued` was flushed and waits for the save before it.
  let pending: { draft: T } | null = null;
  let queued: { draft: T } | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let saving: Promise<unknown> = Promise.resolve();
  /** Takes the newest unsent draft, so the turn that sends it is the only one that can. */
  function take() {
    const next = pending ?? queued;
    pending = null;
    queued = null;
    return next;
  }
  function flush(leaving = false): Promise<unknown> {
    clearTimeout(timer);
    if (leaving) {
      const next = take();
      if (next) {
        const sent = save(next.draft).catch(onError);
        saving = Promise.all([saving.catch(() => undefined), sent]);
      }
    } else if (pending) {
      queued = pending;
      pending = null;
      saving = saving
        .catch(() => undefined)
        .then(() => {
          const next = take();
          return next ? save(next.draft) : undefined;
        })
        .catch(onError);
    }
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

/** The window, as far as this file uses it: the unit tests compile this file without the DOM's types. */
const page = globalThis as unknown as {
  addEventListener(type: "pagehide", listener: () => void): void;
  removeEventListener(type: "pagehide", listener: () => void): void;
};

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
    page.addEventListener("pagehide", leave);
    return () => {
      page.removeEventListener("pagehide", leave);
      leave();
    };
  }, [saver]);
  return saver;
}
