import { lazy, Suspense } from "react";
import type { FormulaCommand } from "./FormulaPanel";
import "./FormulaPanel.css";

// The keys load the first time a student opens the keyboard.
const FormulaPanel = lazy(() => import("./FormulaPanel"));

/** The formula keyboard, rendered in place while `open`. */
export function FormulaDock({
  open,
  onKey,
  onCommand,
  onDone,
}: {
  open: boolean;
  onKey: (latex: string) => void;
  onCommand: (name: FormulaCommand) => void;
  onDone: () => void;
}) {
  if (!open) return null;
  return (
    <Suspense fallback={<div className="px-formula-loading" aria-busy="true" />}>
      <FormulaPanel onKey={onKey} onCommand={onCommand} onDone={onDone} />
    </Suspense>
  );
}
