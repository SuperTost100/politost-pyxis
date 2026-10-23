import { useEffect, useRef, useState } from "react";

/**
 * Saves answers while the student works. `schedule` keeps the newest draft and saves it once changes pause for
 * `delay` ms; `flush` saves it at once; `cancel` drops it. Saves run one after another, so an older draft never lands
 * after a newer one, and a failed save calls `onError` without stopping the next.
 */
export function draftSaver<T>(
  save: (draft: T) => Promise<unknown>,
  onError: () => void,
  delay: number,
) {
  let pending: { draft: T } | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let saving: Promise<unknown> = Promise.resolve();
  function flush(): Promise<unknown> {
    clearTimeout(timer);
    const next = pending;
    pending = null;
    if (next)
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

/** A draftSaver for a page: it calls the latest `save` and `onError`, and saves what is left when the page closes. */
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
  useEffect(() => () => void saver.flush(), [saver]);
  return saver;
}
