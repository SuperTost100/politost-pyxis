import type { KeyboardEvent } from "react";

/** Arrow keys, Home and End move focus between the buttons of a popup menu. */
export function menuKeys(event: KeyboardEvent<HTMLElement>): void {
  const keys = ["ArrowDown", "ArrowUp", "Home", "End"];
  if (!keys.includes(event.key)) return;
  // Home and End edit the text in a search field.
  if (
    event.target instanceof HTMLInputElement &&
    (event.key === "Home" || event.key === "End")
  )
    return;
  const items = [
    ...event.currentTarget.querySelectorAll<HTMLElement>(
      "button:not(:disabled)",
    ),
  ];
  if (items.length === 0) return;
  event.preventDefault();
  const at = items.indexOf(document.activeElement as HTMLElement);
  const next =
    event.key === "Home"
      ? 0
      : event.key === "End"
        ? items.length - 1
        : event.key === "ArrowDown"
          ? (at + 1) % items.length
          : (at - 1 + items.length) % items.length;
  items[next]?.focus();
}

/** Ref callback for a popup's content: focuses the search field, else the chosen item, else the first button, as it mounts. */
export function focusMenu(node: HTMLElement | null): void {
  node
    ?.querySelector<HTMLElement>(
      "input, button[aria-pressed='true'], button:not(:disabled)",
    )
    ?.focus({ preventScroll: true });
}
