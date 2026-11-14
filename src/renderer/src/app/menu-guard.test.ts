import { describe, expect, it } from "vitest";
import { goPages, pageCommands, type MenuCommand } from "../../../shared/menu";
import { menuCommandAllowed, type MenuContext } from "./menu-guard";

const free: MenuContext = {
  pathname: "/exams",
  locked: false,
  modalOpen: false,
  draftAtRisk: false,
  backSaves: false,
};

const navigation: MenuCommand[] = [
  ...goPages.map((page) => page.command),
  ...(Object.keys(pageCommands) as MenuCommand[]),
  "back",
  "forward",
  "report-problem",
];

/** The two commands that step through the window's history. */
const stepping: MenuCommand[] = ["back", "forward"];

describe("menu command guard", () => {
  it("lets every command through on an ordinary page", () => {
    for (const command of [...navigation, "shortcuts" as const])
      expect(menuCommandAllowed(command, free), command).toBe(true);
  });

  it("blocks everything on the onboarding route, and under it", () => {
    for (const pathname of ["/onboarding", "/onboarding/engines"])
      for (const command of [...navigation, "shortcuts" as const])
        expect(
          menuCommandAllowed(command, { ...free, pathname }),
          command,
        ).toBe(false);
  });

  it("blocks everything while a dialog is open", () => {
    for (const command of [...navigation, "shortcuts" as const])
      expect(
        menuCommandAllowed(command, { ...free, modalOpen: true }),
        command,
      ).toBe(false);
  });

  it("blocks navigation while a quiz or simulation holds a lock, but still lists the shortcuts", () => {
    const busy = { ...free, pathname: "/plans/p-1/quiz/t-1", locked: true };
    for (const command of navigation)
      expect(menuCommandAllowed(command, busy), command).toBe(false);
    expect(menuCommandAllowed("shortcuts", busy)).toBe(true);
  });

  it("blocks navigation while text would be lost, but still lists the shortcuts", () => {
    const typing = { ...free, draftAtRisk: true };
    for (const command of navigation)
      expect(menuCommandAllowed(command, typing), command).toBe(false);
    expect(menuCommandAllowed("shortcuts", typing)).toBe(true);
  });

  it("refuses Indietro with text in a field, since the page behind it would drop what was typed", () => {
    expect(menuCommandAllowed("back", { ...free, draftAtRisk: true })).toBe(false);
  });

  it("lets Indietro through with text in a field when the page saves before it leaves, and never Avanti", () => {
    const typing = { ...free, draftAtRisk: true, backSaves: true };
    expect(menuCommandAllowed("back", typing)).toBe(true);
    // Avanti leaves through the router at once, so the page's own saving does not run.
    expect(menuCommandAllowed("forward", typing)).toBe(false);
  });

  it("still refuses Indietro and Avanti with a dialog open, during setup and under a lock, even where the page saves", () => {
    for (const command of stepping) {
      expect(menuCommandAllowed(command, { ...free, modalOpen: true, draftAtRisk: true, backSaves: true }), command).toBe(false);
      expect(menuCommandAllowed(command, { ...free, pathname: "/onboarding", draftAtRisk: true, backSaves: true }), command).toBe(false);
      expect(menuCommandAllowed(command, { ...free, locked: true, draftAtRisk: true, backSaves: true }), command).toBe(false);
    }
  });
});
