import type { MathfieldElement } from "mathlive";

/** Keys that only move the caret or end the formula: a brace opened before one is no longer the caret's group. */
const LEAVES = new Set(["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "Tab", "Escape", "Enter"]);
const MODIFIERS = new Set(["Shift", "Control", "Alt", "AltGraph", "Meta", "CapsLock"]);

/**
 * MathLive writes a typed `{` or `}` as a literal brace, so `t^{3}` would store `t^{\lbrace3\rbrace}`. A
 * student who knows LaTeX types braces to group, and `\{` for a brace that shows. This reads the two keys the
 * way LaTeX does, while the field is in math mode (in LaTeX mode, after a `\`, they stay text):
 *
 * - `{` right after `^` or `_` opens nothing, since the exponent or index is already a group. Anywhere else it
 *   opens a group, written `\mathord{…}` in the field and `{…}` in the stored text (`cleanLatex`).
 * - `}` closes the innermost group the student opened, moving the caret out of it. With none open it does nothing.
 *
 * shortcut: the open groups are counted from the keys typed, so deleting or moving the caret by mouse can leave
 * the count wrong, and a `}` then steps out of a group early; upgrade by asking MathLive for the caret's depth.
 */
export class TypedBraces {
  private open = 0;
  private last = "";

  /** Reads one key typed into `field`. True when the key was a brace this class dealt with. */
  key(field: MathfieldElement, key: string): boolean {
    if (MODIFIERS.has(key)) return false;
    const before = this.last;
    this.last = key;
    if (LEAVES.has(key)) {
      this.open = 0;
      field.smartSuperscript = true;
      return false;
    }
    if (field.mode !== "math") return false;
    if (key === "{") {
      if (before !== "^" && before !== "_") {
        field.executeCommand(["insert", "\\mathord{#?}", { format: "latex", focus: true, feedback: false }]);
      }
      this.open += 1;
      // A digit after `^` normally ends the exponent; inside braces it stays until the closing one.
      field.smartSuperscript = false;
      return true;
    }
    if (key === "}") {
      if (this.open === 0) return true;
      this.open -= 1;
      field.executeCommand("moveToGroupEnd");
      field.executeCommand("moveToNextChar");
      if (this.open === 0) field.smartSuperscript = true;
      return true;
    }
    return false;
  }
}
