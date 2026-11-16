import { createMemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handOverWaitingPlan, offerPlanText, planTextWaiting, takePlan } from "./openedPlan";

/** What the shared-plan page does: take the text each time it is entered. */
function sharedPlanPage(router: ReturnType<typeof open>, taken: string[]) {
  return router.subscribe((state) => {
    if (state.navigation.state === "idle" && state.location.pathname === "/exams/get") {
      const text = takePlan()?.text;
      if (text !== undefined) taken.push(text);
    }
  });
}

/** `held` makes the first visit to /exams/get wait until the test releases it, as a page that is still loading does. */
function open(held?: { release: () => void }) {
  let visits = 0;
  return createMemoryRouter(
    [
      { path: "/onboarding", element: null },
      { path: "/ask", element: null },
      { path: "/exams", element: null },
      {
        path: "/exams/get",
        element: null,
        loader: async () => {
          if (held && visits++ === 0) await new Promise<void>((resolve) => (held.release = resolve));
          return null;
        },
      },
    ],
    { initialEntries: ["/onboarding"] },
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  takePlan();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("handOverWaitingPlan", () => {
  it("waits while the window may not be moved, then opens the file once", async () => {
    const router = open();
    const taken: string[] = [];
    sharedPlanPage(router, taken);
    let allowed = false;
    const stop = handOverWaitingPlan(router, () => allowed);
    offerPlanText("plan");
    await vi.advanceTimersByTimeAsync(3000);
    expect(router.state.location.pathname).toBe("/onboarding");
    allowed = true;
    await router.navigate("/ask");
    await vi.advanceTimersByTimeAsync(1000);
    expect(router.state.location.pathname).toBe("/exams/get");
    expect(taken).toEqual(["plan"]);
    // The entry's key changes with every navigation, a second PUSH included, so the same key means none was made.
    const entry = router.state.location.key;
    await vi.advanceTimersByTimeAsync(5000);
    expect(router.state.location.key).toBe(entry);
    expect(taken).toEqual(["plan"]);
    stop();
    router.dispose();
  });

  it("opens the file even when another move lands while its own is still loading", async () => {
    const held = { release: () => {} };
    const router = open(held);
    const taken: string[] = [];
    sharedPlanPage(router, taken);
    await router.navigate("/ask");
    const stop = handOverWaitingPlan(router, () => true);
    offerPlanText("plan");
    // The move to the shared-plan page is on its way (its page has not loaded) ...
    expect(router.state.navigation.state).toBe("loading");
    // ... and the student's click on Esami lands first and replaces it.
    await router.navigate("/exams");
    held.release();
    expect(router.state.location.pathname).toBe("/exams");
    expect(planTextWaiting()).toBe(true);
    await vi.advanceTimersByTimeAsync(1000);
    expect(router.state.location.pathname).toBe("/exams/get");
    expect(taken).toEqual(["plan"]);
    stop();
    router.dispose();
  });

  it("does not start a second move while the first is still loading", async () => {
    const held = { release: () => {} };
    const router = open(held);
    const taken: string[] = [];
    sharedPlanPage(router, taken);
    await router.navigate("/ask");
    const stop = handOverWaitingPlan(router, () => true);
    offerPlanText("plan");
    await vi.advanceTimersByTimeAsync(3000);
    expect(router.state.navigation.state).toBe("loading");
    held.release();
    await vi.advanceTimersByTimeAsync(0);
    expect(router.state.location.pathname).toBe("/exams/get");
    expect(taken).toEqual(["plan"]);
    stop();
    router.dispose();
  });

  it("opens the newest of two files offered before the page took the first", async () => {
    const router = open();
    const taken: string[] = [];
    sharedPlanPage(router, taken);
    await router.navigate("/ask");
    let allowed = false;
    const stop = handOverWaitingPlan(router, () => allowed);
    offerPlanText("first");
    offerPlanText("second");
    allowed = true;
    await vi.advanceTimersByTimeAsync(1000);
    expect(taken).toEqual(["second"]);
    stop();
    router.dispose();
  });

  it("opens a file offered while the page is open by entering the page again", async () => {
    const router = open();
    const taken: string[] = [];
    sharedPlanPage(router, taken);
    await router.navigate("/exams/get");
    const stop = handOverWaitingPlan(router, () => true);
    offerPlanText("again");
    await vi.advanceTimersByTimeAsync(0);
    expect(taken).toEqual(["again"]);
    stop();
    router.dispose();
  });
});
