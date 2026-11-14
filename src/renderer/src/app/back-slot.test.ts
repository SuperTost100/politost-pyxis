import { afterEach, describe, expect, it, vi } from "vitest";
import { backOf, registerBack, registeredBack, whenArrived, type BackTarget } from "./back-slot";

const target = (to: string): BackTarget => ({ name: to, label: to, to, go: () => undefined, busy: false, saves: false });
const cleanups: Array<() => void> = [];
const register = (key: string, back: BackTarget | null) => cleanups.push(registerBack(key, () => back));

afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
  vi.useRealTimers();
});

describe("back slot", () => {
  it("finds the way back of the page at an entry, and knows when that page has not registered yet", () => {
    register("settings", target("/plans/p"));
    expect(backOf("settings")?.to).toBe("/plans/p");
    expect(backOf("sources")).toBeUndefined();
    register("exams", null);
    expect(backOf("exams")).toBeNull();
    expect(registeredBack()?.to).toBe("/plans/p");
  });

  it("runs at once for a page that is there", () => {
    register("settings", target("/plans/p"));
    const run = vi.fn();
    whenArrived("settings", run);
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ to: "/plans/p" }));
  });

  it("waits for a page still arriving rather than running the page before it", () => {
    // The page left is still registered while the router already shows the new entry.
    register("settings", target("/plans/p"));
    const run = vi.fn();
    whenArrived("sources", run);
    expect(run).not.toHaveBeenCalled();
    register("sources", target("/plans/p/settings"));
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ to: "/plans/p/settings" }));
    // Later changes of the slot do not run it again.
    register("other", target("/x"));
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("gives up on a page that never registers", () => {
    vi.useFakeTimers();
    const run = vi.fn();
    whenArrived("section", run, 1000);
    vi.advanceTimersByTime(1000);
    register("section", target("/late"));
    expect(run).not.toHaveBeenCalled();
  });
});
