/**
 * A plan file that reached the window from outside the import screen: a double-click, Open With, a second launch, or a
 * file dropped on the window. Its text waits here until the shared-plan page, which owns the import review, takes it.
 */
/** Where a file came from, when it is a file: its name without the folder, and its size in bytes. */
export type PlanOrigin = { name: string; bytes: number };
let waiting: { text: string; origin?: PlanOrigin } | null = null;
const listeners = new Set<() => void>();

export function offerPlanText(text: string, origin?: PlanOrigin): void {
  waiting = { text, ...(origin ? { origin } : {}) };
  for (const listener of listeners) listener();
}

export function planTextWaiting(): boolean {
  return waiting !== null;
}

/** The waiting file, once. */
export function takePlan(): { text: string; origin?: PlanOrigin } | null {
  const plan = waiting;
  waiting = null;
  return plan;
}

export function onPlanTextOffered(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/** The part of the router that hands a waiting file over. */
type PlanRouter = {
  state: { location: { pathname: string }; navigation: { state: string } };
  navigate(to: string, options: { replace: boolean; state: { via: "outside" } }): Promise<void>;
};

/**
 * Brings the waiting text to the shared-plan page, which takes it when it is entered, and keeps trying until it has:
 * a move of the student's or of a reminder's that lands while this one is on its way replaces it, and nothing else
 * would offer the file again. `allowed` says whether the window may be moved from `pathname` now (not in onboarding,
 * not with a lock, a dialog or a draft). Returns the stop function.
 */
export function handOverWaitingPlan(
  router: PlanRouter,
  allowed: (pathname: string) => boolean,
  retryAfter = 1000,
): () => void {
  let retry: ReturnType<typeof setTimeout> | undefined;
  const show = () => {
    clearTimeout(retry);
    if (!planTextWaiting()) return;
    const pathname = router.state.location.pathname;
    // One move at a time: a second one to the same page would cancel the first while it loads.
    if (router.state.navigation.state === "idle" && allowed(pathname)) {
      // On the page already, entering it again gives it a new location key, which is when it takes the text.
      // A file comes from outside the app: the page starts a trail of its own (history.ts).
      void router.navigate("/exams/get", { replace: pathname === "/exams/get", state: { via: "outside" } });
    }
    retry = setTimeout(show, retryAfter);
  };
  show();
  const off = onPlanTextOffered(show);
  return () => {
    clearTimeout(retry);
    off();
  };
}
