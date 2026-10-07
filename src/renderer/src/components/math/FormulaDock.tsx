import { lazy, Suspense } from "react";
import "./FormulaPanel.css";

// MathLive and its keys load the first time a student opens the keyboard.
const FormulaPanel = lazy(() => import("./FormulaPanel"));

/** The formula field and keyboard, rendered in place while `open`. */
export function FormulaDock({
  open,
  onInsert,
  onClose,
}: {
  open: boolean;
  onInsert: (latex: string) => void;
  onClose: () => void;
}) {
  if (!open) return null;
  return (
    <Suspense fallback={<div className="px-formula-loading" aria-busy="true" />}>
      <FormulaPanel onInsert={onInsert} onClose={onClose} />
    </Suspense>
  );
}
