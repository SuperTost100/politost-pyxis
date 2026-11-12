import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import "./Popover.css";

/** The room a popover keeps from its button and from the window's edges. */
const GAP = 8;
const EDGE = 8;

/**
 * What a popover leaves alone when it is clicked or takes the focus: a menu or a dialog that something inside the
 * popover opened, which the page draws in the document's body.
 */
const OPENED_FROM_INSIDE = ".px-item-menu, .ant-modal-root, .ant-dropdown";

/**
 * A panel that belongs to the button that opened it (`anchor`): 8px under it, lined up with its right edge and kept inside
 * the window, growing out of it. It scrolls inside itself when the window is short, so the window never scrolls for it.
 * It takes the focus as it opens. Escape closes it and gives the focus back to the button; a click outside closes it
 * and leaves the focus where the click put it. A menu or a dialog opened from inside it counts as inside, and Escape
 * closes that first. It is a dialog that does not block the page, named by `label`. Under reduced motion it fades.
 */
export function Popover({
  open,
  anchor,
  onClose,
  label,
  id,
  className,
  children,
}: {
  open: boolean;
  anchor: RefObject<HTMLElement | null>;
  /** `byKey`: Escape closed it, and the popover gives the focus back to the button. */
  onClose: (byKey: boolean) => void;
  label: string;
  id?: string;
  className?: string;
  children: ReactNode;
}) {
  const panel = useRef<HTMLDivElement>(null);
  // Kept on the page while it fades out, so closing is not a hard cut.
  const [shown, setShown] = useState(open);
  const [place, setPlace] = useState<{ top: number; left: number; maxHeight: number; origin: string } | null>(null);
  // Set a frame after it is placed, so it grows from its button rather than appearing there.
  const [entered, setEntered] = useState(false);
  const latest = useRef(onClose);
  latest.current = onClose;

  useEffect(() => {
    if (open) setShown(true);
  }, [open]);

  useLayoutEffect(() => {
    if (!shown) return;
    const measure = () => {
      const button = anchor.current?.getBoundingClientRect();
      const box = panel.current;
      if (!button || !box) return;
      const width = box.offsetWidth;
      const left = Math.max(EDGE, Math.min(button.right - width, innerWidth - EDGE - width));
      const top = button.bottom + GAP;
      setPlace({
        top,
        left,
        maxHeight: Math.max(120, innerHeight - top - EDGE),
        origin: `${Math.round(button.left + button.width / 2 - left)}px -${GAP}px`,
      });
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [shown, anchor]);

  const placed = place !== null;
  useLayoutEffect(() => {
    if (!open || !placed) return;
    // Only when it opens: a move after a resize leaves the focus where it is.
    panel.current?.focus({ preventScroll: true });
    const frame = requestAnimationFrame(() => setEntered(true));
    return () => cancelAnimationFrame(frame);
  }, [open, placed]);

  // Closing fades it out (the transition's end unmounts it); this ends it when no transition runs, as in a hidden window.
  useEffect(() => {
    if (open || !shown) return;
    const timer = setTimeout(() => finish(), 300);
    return () => clearTimeout(timer);
  }, [open, shown]);
  const finish = () => {
    setShown(false);
    setPlace(null);
    setEntered(false);
  };

  useEffect(() => {
    if (!open) return;
    const inside = (target: EventTarget | null) =>
      target instanceof Node &&
      (panel.current?.contains(target) ||
        anchor.current?.contains(target) ||
        (target instanceof Element && target.closest(OPENED_FROM_INSIDE)));
    const onPointer = (event: PointerEvent) => {
      if (!inside(event.target)) latest.current(false);
    };
    document.addEventListener("pointerdown", onPointer, true);
    return () => document.removeEventListener("pointerdown", onPointer, true);
  }, [open, anchor]);

  if (!shown) return null;
  return createPortal(
    <div
      ref={panel}
      id={id}
      role="dialog"
      aria-label={label}
      tabIndex={-1}
      className={["px-popover", open ? (entered ? "is-in" : "") : "is-closing", className].filter(Boolean).join(" ")}
      style={
        place
          ? { top: place.top, left: place.left, maxHeight: place.maxHeight, transformOrigin: place.origin }
          : { visibility: "hidden" }
      }
      onKeyDown={(event) => {
        // A menu opened from a row inside closes on its own Escape first; this one is for the popover.
        if (event.key !== "Escape" || (event.target instanceof Element && event.target.closest(OPENED_FROM_INSIDE)))
          return;
        event.stopPropagation();
        latest.current(true);
        const button = anchor.current;
        (button?.matches("button") ? button : button?.querySelector<HTMLElement>("button"))?.focus({ preventScroll: true });
      }}
      onTransitionEnd={(event) => {
        if (event.target === panel.current && event.propertyName === "opacity" && !open) finish();
      }}
    >
      {children}
    </div>,
    document.body,
  );
}
