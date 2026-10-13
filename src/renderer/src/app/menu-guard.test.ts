import { describe, expect, it } from "vitest";
import { goPages, pageCommands, type MenuCommand } from "../../../shared/menu";
import { menuCommandAllowed, type MenuContext } from "./menu-guard";

const free: MenuContext = {
  pathname: "/exams",
  locked: false,
  modalOpen: false,
  draftAtRisk: false,
};

const navigation: MenuCommand[] = [
  ...goPages.map((page) => page.command),
  ...(Object.keys(pageCommands) as MenuCommand[]),
  "back",
  "report-problem",
];

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
});
