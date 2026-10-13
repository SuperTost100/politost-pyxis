/**
 * Hands `apply` the latest pushed value at most once every `ms`. A streamed reply arrives as its whole text on every
 * delta, so rendering each one would re-parse the growing Markdown and math many times a second.
 */
export function latestEvery<T>(ms: number, apply: (value: T) => void) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let last = -Infinity;
  let pending: { value: T } | null = null;
  const fire = () => {
    timer = null;
    if (!pending) return;
    const { value } = pending;
    pending = null;
    last = Date.now();
    apply(value);
  };
  return {
    push(value: T) {
      pending = { value };
      if (timer) return;
      timer = setTimeout(fire, Math.max(0, last + ms - Date.now()));
    },
    /** Drops a value not yet applied. */
    cancel() {
      if (timer) clearTimeout(timer);
      timer = null;
      pending = null;
    },
  };
}
