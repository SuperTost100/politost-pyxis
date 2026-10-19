/**
 * A plan file that reached the window from outside the import screen: a double-click, Open With, a second launch, or a
 * file dropped on the window. Its text waits here until the shared-plan page, which owns the import review, takes it.
 */
let waiting: string | null = null;
const listeners = new Set<() => void>();

export function offerPlanText(text: string): void {
  waiting = text;
  for (const listener of listeners) listener();
}

export function planTextWaiting(): boolean {
  return waiting !== null;
}

/** The waiting text, once. */
export function takePlanText(): string | null {
  const text = waiting;
  waiting = null;
  return text;
}

export function onPlanTextOffered(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}
