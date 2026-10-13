import { useEffect } from "react";
import type { MenuContext } from "./menu-guard";

/**
 * A page that holds work the router cannot give back (a quiz being answered, a timed simulation, a half-filled plan)
 * holds a lock with `useMenuLock`. Open dialogs and unsaved text in a field block menu commands too.
 */
const locks = new Set<symbol>();

export function useMenuLock(active: boolean): void {
  useEffect(() => {
    if (!active) return;
    const lock = Symbol("menu-lock");
    locks.add(lock);
    return () => {
      locks.delete(lock);
    };
  }, [active]);
}

const TEXT_INPUTS = new Set([
  "text",
  "search",
  "email",
  "url",
  "tel",
  "password",
  "number",
]);

/**
 * Text in the focused field that would be lost by leaving the page. The Ask composer keeps its draft per chat and says
 * so with `data-keeps-draft`, so Ctrl+N from a half-written message is fine.
 */
export function draftAtRisk(active: Element | null): boolean {
  if (!(active instanceof HTMLElement)) return false;
  const field = active.closest(
    "input, textarea, [contenteditable]:not([contenteditable=false]), [role=textbox]",
  );
  if (!(field instanceof HTMLElement) || field.closest("[data-keeps-draft]"))
    return false;
  if (field instanceof HTMLInputElement) {
    return TEXT_INPUTS.has(field.type) && field.value.trim() !== "";
  }
  if (field instanceof HTMLTextAreaElement) return field.value.trim() !== "";
  return (field.textContent ?? "").trim() !== "";
}

function modalOpen(): boolean {
  for (const dialog of document.querySelectorAll(
    "[role=dialog], [role=alertdialog]",
  ))
    if (dialog instanceof HTMLElement && dialog.checkVisibility()) return true;
  return false;
}

export function readMenuContext(pathname: string): MenuContext {
  return {
    pathname,
    locked: locks.size > 0,
    modalOpen: modalOpen(),
    draftAtRisk: draftAtRisk(document.activeElement),
  };
}
