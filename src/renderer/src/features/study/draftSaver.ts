import { useEffect, useRef, useState } from "react";

/**
 * Saves answers while the student works. `schedule` keeps the newest draft and saves it once changes pause for
 * `delay` ms; `flush` saves it at once; `cancel` drops it. Saves run one after another and a draft is never sent after
 * a newer one: when a queued save's turn comes it sends the newest draft there is, so a draft that was overtaken is
 * dropped. A failed save calls `onError` without stopping the next, and its draft waits for the next `flush` unless a
 * newer one took its place. `flush` resolves to whether the newest draft is saved, so a page can keep the student
 * there when it is not.
 *
 * `unsaved` says whether the newest answers are not saved yet: a save is on its way, or one failed and its draft still
 * waits. A draft that only waits for its pause is not counted, since leaving the page sends it. `watch` calls back when
 * that changes, so a page can hold the menu while it is true.
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
  let saving: Promise<boolean> = Promise.resolve(true);
  let inFlight = 0;
  let failed = false;
  const watchers = new Set<() => void>();
  const unsaved = () => inFlight > 0 || failed;
  /** Runs `change`, and tells the watchers if it moved `unsaved`. */
  function track(change: () => void) {
    const before = unsaved();
    change();
    if (unsaved() !== before) for (const watcher of watchers) watcher();
  }
  /** Takes the newest unsent draft, so the turn that sends it is the only one that can. */
  function take() {
    const next = pending ?? queued;
    pending = null;
    queued = null;
    return next;
  }
  /** Saves one draft; when that fails, the draft stays for the next flush unless a newer one took its place. */
  function send(next: { draft: T }): Promise<boolean> {
    track(() => (inFlight += 1));
    return save(next.draft).then(
      () => {
        track(() => {
          inFlight -= 1;
          // A newer draft that is still to be sent is not a failed one.
          failed = false;
        });
        return true;
      },
      () => {
        if (!pending && !queued) pending = next;
        track(() => {
          inFlight -= 1;
          failed = true;
        });
        onError();
        return false;
      },
    );
  }
  function flush(leaving = false): Promise<boolean> {
    clearTimeout(timer);
    if (leaving) {
      const next = take();
      if (next) {
        const sent = send(next);
        saving = Promise.all([saving, sent]).then(([, saved]) => saved);
      }
    } else if (pending) {
      queued = pending;
      pending = null;
      saving = saving.then(() => {
        const next = take();
        return next ? send(next) : true;
      });
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
      track(() => (failed = false));
    },
    flush,
    unsaved,
    watch(watcher: () => void) {
      watchers.add(watcher);
      return () => void watchers.delete(watcher);
    },
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
