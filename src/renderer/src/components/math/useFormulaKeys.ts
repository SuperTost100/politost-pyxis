import { useCallback, useEffect, useState, type RefObject } from "react";
import type { FormulaCommand } from "./FormulaPanel";
import type { MathTextEditorHandle } from "./MathTextEditor";

/** What shuts the keyboard that is open in each group. */
const openInGroup = new Map<string, () => void>();

/**
 * The sigma button and the formula keyboard of one editor. Opening the keyboard opens a formula at
 * the caret; closing it closes the formula and puts the caret after it.
 *
 * Editors that share a `group` show one keyboard between them: opening one's shuts the other's.
 */
export function useFormulaKeys(editor: RefObject<MathTextEditorHandle | null>, group?: string) {
  const [open, setOpen] = useState(false);
  // For another editor of the group: focus is already on its way there, so this one's caret is left alone.
  const [shut] = useState(() => () => setOpen(false));
  const forget = useCallback(() => {
    if (group && openInGroup.get(group) === shut) openInGroup.delete(group);
  }, [group, shut]);
  useEffect(() => forget, [forget]);

  const close = useCallback(() => {
    forget();
    setOpen(false);
    editor.current?.leaveMath();
  }, [editor, forget]);

  const toggle = useCallback(() => {
    if (open) close();
    else {
      if (group) {
        openInGroup.get(group)?.();
        openInGroup.set(group, shut);
      }
      editor.current?.insertMath();
      setOpen(true);
    }
  }, [open, close, editor, group, shut]);

  const onKey = useCallback((latex: string) => editor.current?.insertLatex(latex), [editor]);
  const onCommand = useCallback((name: FormulaCommand) => editor.current?.command(name), [editor]);

  return { open, toggle, close, dock: { open, onKey, onCommand, onDone: close } };
}
