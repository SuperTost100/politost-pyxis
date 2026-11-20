import { afterEach, describe, expect, it, vi } from "vitest";
import type { RequestOutput } from "../../../shared/ipc";
import { callAfter, isConnected, limitWhen, limitsOf, movedOrder, nextTool, shownOrder, toggledUse } from "./toolOrder";

const tool = (id: string) => ({ id });

describe("the list of connected tools", () => {
  it("counts a signed-in CLI and nothing else", () => {
    const row = { id: "claude", kind: "cli" as const, installed: true, loggedIn: true, disabled: false };
    expect(isConnected(row)).toBe(true);
    expect(isConnected({ ...row, loggedIn: false })).toBe(false);
    expect(isConnected({ ...row, installed: false })).toBe(false);
    expect(isConnected({ ...row, disabled: true })).toBe(false);
    // A key is in Advanced, not in the list.
    expect(isConnected({ ...row, id: "openai-api", kind: "api" })).toBe(false);
  });

  it("shows the tools as Pyxis found them until the student saves an order", () => {
    const found = [tool("claude"), tool("codex"), tool("antigravity")];
    expect(shownOrder(found, null).map((row) => row.id)).toEqual(["claude", "codex", "antigravity"]);
  });

  it("follows the saved order and puts a tool connected since at the end", () => {
    const found = [tool("claude"), tool("codex"), tool("antigravity")];
    expect(shownOrder(found, ["antigravity"]).map((row) => row.id)).toEqual(["antigravity", "claude", "codex"]);
  });

  it("leaves out of the list a saved tool that is no longer connected", () => {
    expect(shownOrder([tool("codex")], ["claude", "codex"]).map((row) => row.id)).toEqual(["codex"]);
  });
});

describe("moving a tool", () => {
  it("saves the whole shown list in its new order, up or down", () => {
    expect(movedOrder(["claude", "codex", "antigravity"], 2, 0, null)).toEqual(["antigravity", "claude", "codex"]);
    expect(movedOrder(["claude", "codex", "antigravity"], 0, 1, null)).toEqual(["codex", "claude", "antigravity"]);
  });

  it("keeps a tool that is signed out now after the connected ones", () => {
    expect(movedOrder(["codex", "antigravity"], 1, 0, ["claude", "codex", "antigravity"])).toEqual([
      "antigravity",
      "codex",
      "claude",
    ]);
  });

  it("changes nothing for a place that does not exist", () => {
    expect(movedOrder(["claude", "codex"], 5, 0, null)).toEqual(["claude", "codex"]);
  });
});

describe("turning a tool off and on", () => {
  const ready = ["claude", "codex", "antigravity"];

  it("starts from the tools that work now and leaves the one turned off out", () => {
    expect(toggledUse(null, ["claude", "codex"], "codex", false)).toEqual(["claude"]);
  });

  it("returns to every tool, also one connected later, when the last one that was off is turned on again", () => {
    expect(toggledUse(["claude", "antigravity"], ready, "codex", true)).toBeNull();
    expect(toggledUse(["claude"], ready, "codex", true)).toEqual(["claude", "codex"]);
    // A tool that is not connected now does not keep the choice from going back to every tool.
    expect(toggledUse(["claude"], ["claude", "codex"], "codex", true)).toBeNull();
  });

  it("lets a tool be turned on before it works, as when it is connected while the only tool in use is signed out", () => {
    // Claude, the only allowed tool, is signed out, so nothing works yet. Connecting ChatGPT, which was off, must keep it on.
    expect(toggledUse(["claude"], [], "codex", true)).toBeNull();
    expect(toggledUse(["claude"], ["antigravity"], "codex", true)).toEqual(["claude", "codex"]);
  });

  it("refuses to turn off the only tool in use", () => {
    expect(toggledUse(["claude"], ready, "claude", false)).toBeUndefined();
    expect(toggledUse(null, ["claude"], "claude", false)).toBeUndefined();
    // A tool that is allowed but signed out does not count as one left in use.
    expect(toggledUse(["claude", "antigravity"], ["claude"], "claude", false)).toBeUndefined();
  });
});

describe("when a tool has requests again", () => {
  const now = new Date(2026, 10, 16, 22, 30).getTime();

  it("tells apart later today, tomorrow and another day by the calendar, not by the hours", () => {
    expect(limitWhen(new Date(2026, 10, 16, 23, 0).getTime(), now)).toBe("today");
    // Two hours away, but on the next calendar day.
    expect(limitWhen(new Date(2026, 10, 17, 0, 30).getTime(), now)).toBe("tomorrow");
    expect(limitWhen(new Date(2026, 10, 20, 9, 0).getTime(), now)).toBe("later");
  });
});

type Row = RequestOutput<"engines.overview">[number];
const NOW = 1_000;

const row = (id: string, over: Partial<Row> = {}): Row => ({
  id,
  name: id,
  kind: "cli",
  installed: true,
  loggedIn: true,
  refused: false,
  disabled: false,
  version: "1",
  path: "",
  withinTestedRange: true,
  acknowledged: true,
  allowed: true,
  refusedModels: [],
  limitedUntil: null,
  capabilities: { effort: false, fast: false, signOut: true },
  ...over,
});

describe("which tools are out of requests", () => {
  it("lists the tools whose requests are not back yet, with the time", () => {
    const rows = [row("claude"), row("codex", { limitedUntil: 5_000 }), row("antigravity", { limitedUntil: 500 })];
    expect([...limitsOf(rows, NOW)]).toEqual([["codex", 5_000]]);
  });
});

describe("the tool a stopped job goes on with", () => {
  const rows = [row("claude"), row("codex"), row("antigravity")];

  it("is the first tool of the student's order, other than the one that ran out", () => {
    expect(nextTool(rows, ["antigravity", "codex", "claude"], "antigravity", NOW)?.id).toBe("codex");
    expect(nextTool(rows, ["antigravity", "codex", "claude"], "codex", NOW)?.id).toBe("antigravity");
  });

  it("follows the order the tools were found in when the student never set one", () => {
    expect(nextTool(rows, null, "claude", NOW)?.id).toBe("codex");
  });

  it("skips a tool that is out of requests too, turned off, signed out or not installed", () => {
    const some = [
      row("claude"),
      row("codex", { limitedUntil: 9_000 }),
      row("antigravity", { allowed: false }),
    ];
    expect(nextTool(some, null, "claude", NOW)).toBeUndefined();
    expect(nextTool([row("claude"), row("antigravity", { loggedIn: false })], null, "claude", NOW)).toBeUndefined();
    expect(nextTool([...some, row("openai-api", { kind: "api" })], null, "claude", NOW)).toBeUndefined();
  });

  it("takes a tool whose limit has passed", () => {
    expect(nextTool([row("claude"), row("codex", { limitedUntil: 500 })], null, "claude", NOW)?.id).toBe("codex");
  });
});

describe("callAfter", () => {
  afterEach(() => vi.useRealTimers());
  const day = 24 * 3_600_000;

  it("calls a second after the time, and not before", () => {
    vi.useFakeTimers({ now: 0 });
    const fire = vi.fn();
    callAfter(2 * day, fire);
    vi.advanceTimersByTime(2 * day);
    expect(fire).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1000);
    expect(fire).toHaveBeenCalledTimes(1);
  });

  it("waits out a time further away than a timer holds, in stretches, and calls once at the end", () => {
    vi.useFakeTimers({ now: 0 });
    const fire = vi.fn();
    callAfter(30 * day, fire);
    // The first stretch ends at about 24.8 days, and nothing is called: the reset is still ahead.
    vi.advanceTimersByTime(26 * day);
    expect(fire).not.toHaveBeenCalled();
    vi.advanceTimersByTime(4 * day);
    expect(fire).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1000);
    expect(fire).toHaveBeenCalledTimes(1);
  });

  it("stops when asked, between stretches too", () => {
    vi.useFakeTimers({ now: 0 });
    const fire = vi.fn();
    const stop = callAfter(30 * day, fire);
    vi.advanceTimersByTime(26 * day);
    stop();
    vi.advanceTimersByTime(10 * day);
    expect(fire).not.toHaveBeenCalled();
  });
});
