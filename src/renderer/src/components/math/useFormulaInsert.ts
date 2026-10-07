import { useCallback, useEffect, useRef, useState } from "react";
import { insertAtCaret, wrapLatex } from "./insertAtCaret";

/**
 * Drives the formula keyboard for one text field. `insert` wraps the LaTeX as `$...$`, puts it at
 * the field's caret, closes the keyboard and returns focus to the field with the caret after it.
 */
export function useFormulaInsert({
  getField,
  value,
  onChange,
}: {
  getField: () => HTMLTextAreaElement | null;
  value: string;
  onChange: (next: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const caret = useRef<number | null>(null);
  const field = useRef(getField);
  field.current = getField;

  // The caret moves once React has written the new text into the field.
  useEffect(() => {
    if (caret.current === null) return;
    const at = caret.current;
    caret.current = null;
    const el = field.current();
    if (!el) return;
    el.focus();
    el.setSelectionRange(at, at);
  }, [value]);

  const close = useCallback(() => {
    setOpen(false);
    field.current()?.focus();
  }, []);

  const toggle = useCallback(() => {
    if (open) field.current()?.focus();
    setOpen(!open);
  }, [open]);

  const insert = useCallback(
    (latex: string) => {
      const wrapped = wrapLatex(latex);
      setOpen(false);
      if (!wrapped) {
        field.current()?.focus();
        return;
      }
      const el = field.current();
      const start = el?.selectionStart ?? value.length;
      const end = el?.selectionEnd ?? value.length;
      const next = insertAtCaret(value, start, end, wrapped);
      caret.current = next.caret;
      onChange(next.value);
    },
    [value, onChange],
  );

  return { open, toggle, close, insert };
}
