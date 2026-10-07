import { useCallback, useState, type RefObject } from "react";
import type { FormulaCommand } from "./FormulaPanel";
import type { MathTextEditorHandle } from "./MathTextEditor";

/**
 * The sigma button and the formula keyboard of one editor. Opening the keyboard opens a formula at
 * the caret; closing it closes the formula and puts the caret after it.
 */
export function useFormulaKeys(editor: RefObject<MathTextEditorHandle | null>) {
  const [open, setOpen] = useState(false);

  const close = useCallback(() => {
    setOpen(false);
    editor.current?.leaveMath();
  }, [editor]);

  const toggle = useCallback(() => {
    if (open) close();
    else {
      editor.current?.insertMath();
      setOpen(true);
    }
  }, [open, close, editor]);

  const onKey = useCallback((latex: string) => editor.current?.insertLatex(latex), [editor]);
  const onCommand = useCallback((name: FormulaCommand) => editor.current?.command(name), [editor]);

  return { open, toggle, close, dock: { open, onKey, onCommand, onDone: close } };
}
