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

/**
 * The reply being written, kept outside React state. Only the component that shows it subscribes, so each new piece
 * re-renders that one message instead of the whole conversation.
 */
export function liveValue<T>(initial: T) {
  let value = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    set(next: T) {
      if (Object.is(next, value)) return;
      value = next;
      for (const listener of listeners) listener();
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
