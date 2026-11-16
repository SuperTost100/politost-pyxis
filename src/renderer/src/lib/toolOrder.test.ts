import { describe, expect, it } from "vitest";
import { isConnected, limitWhen, movedOrder, shownOrder, toggledUse } from "./toolOrder";

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
    const found = [tool("claude"), tool("codex"), tool("agent"), tool("antigravity")];
    expect(shownOrder(found, ["antigravity", "claude"]).map((row) => row.id)).toEqual([
      "antigravity",
      "claude",
      "codex",
      "agent",
    ]);
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

  it("refuses to turn off the only tool in use", () => {
    expect(toggledUse(["claude"], ready, "claude", false)).toBeUndefined();
    expect(toggledUse(null, ["claude"], "claude", false)).toBeUndefined();
    // A tool that is allowed but signed out does not count as one left in use.
    expect(toggledUse(["claude", "agent"], ["claude"], "claude", false)).toBeUndefined();
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
