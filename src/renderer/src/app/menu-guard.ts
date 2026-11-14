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
  /** The page's way back saves what it holds before it leaves (a `beforeLeave`), so going back loses nothing typed. */
  backSaves: boolean;
};

/**
 * Onboarding and open dialogs block every command. The shortcuts list changes nothing on screen behind it, so it also
 * opens during a quiz or a simulation, where its keys are worth looking up. Everything else needs no lock and no text
 * at risk. The one exception is Indietro, which runs the page's own back control: a page that saves in its
 * `beforeLeave` (a quiz, a flashcard session) keeps what is typed, so the text in a field does not stop it. Avanti
 * goes through the router at once, so it never gets that exception.
 */
export function menuCommandAllowed(
  command: MenuCommand,
  context: MenuContext,
): boolean {
  if (context.pathname.startsWith("/onboarding") || context.modalOpen)
    return false;
  if (command === "shortcuts") return true;
  if (context.locked) return false;
  return !context.draftAtRisk || (command === "back" && context.backSaves);
}
