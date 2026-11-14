import type { MenuCommand } from "../../../shared/menu";

/**
 * The application menu runs even while a student is in the middle of something, so the renderer decides when a command
 * may go through. The state it decides on is read in `menu-state.ts`.
 */
export type MenuContext = {
  pathname: string;
  /** A page holds a lock. */
  locked: boolean;
  /** A dialog or drawer is open. */
  modalOpen: boolean;
  /** Focus is in a text field with text that the app does not keep by itself. */
  draftAtRisk: boolean;
  /**
   * How the page keeps what is typed when it is left: `back` when its way back saves it first (a `beforeLeave`, as the
   * quiz and a flashcard session do), `asks` when its leave guard asks before any move to another page drops it
   * (`useLeaveGuard`), null when it does neither.
   */
  keepsTyped: "back" | "asks" | null;
};

/**
 * Onboarding and open dialogs block every command. The shortcuts list changes nothing on screen behind it, so it also
 * opens during a quiz or a simulation, where its keys are worth looking up. Everything else needs no lock and no text
 * at risk, unless the page keeps that text itself. A page that saves in its `beforeLeave` (a quiz, a flashcard
 * session) keeps it on Indietro only, which runs the page's own back control; Avanti goes through the router at once,
 * past that saving. A page with a leave guard asks before any move through the router, so every command that moves
 * goes on and the guard asks; reporting a problem opens the browser, which the guard cannot hold, so it stays refused.
 */
export function menuCommandAllowed(
  command: MenuCommand,
  context: MenuContext,
): boolean {
  if (context.pathname.startsWith("/onboarding") || context.modalOpen)
    return false;
  if (command === "shortcuts") return true;
  if (context.locked) return false;
  if (!context.draftAtRisk) return true;
  if (context.keepsTyped === "asks") return command !== "report-problem";
  return command === "back" && context.keepsTyped === "back";
}
