import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { menuTakesEscape } from "./ItemMenu";
import { placePopover, type PopoverPlace } from "./popoverPlace";
import "./Popover.css";

/**
 * What a popover leaves alone when it is clicked or takes the focus: a menu or a dialog that something inside the
 * popover opened, which the page draws in the document's body.
 */
const OPENED_FROM_INSIDE = ".px-item-menu, .ant-dropdown, .px-dialog";
/**
 * Where an Escape belongs to something opened from inside rather than to the popover: that menu or dialog, or a button
 * whose menu is open. The menu closes on any Escape while it is open, and on a slow computer the key can come before the
 * menu has taken the focus from its button.
 */
const ESCAPE_NOT_MINE = `${OPENED_FROM_INSIDE}, [aria-haspopup][aria-expanded="true"]`;

/**
 * A panel that belongs to the button that opened it (`anchor`): 8px under it, lined up with its right edge and kept inside
 * the window, growing out of it. With too little room under the button it opens above it when there is more room there
 * (`placePopover`), and it scrolls inside itself when neither side fits it, so the window never scrolls for it.
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
  const [place, setPlace] = useState<PopoverPlace | null>(null);
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
      // `scrollHeight` is the whole content's height, also while a smaller `maxHeight` makes the panel scroll.
      setPlace(
        placePopover(
          button,
          { width: box.offsetWidth, height: box.scrollHeight },
          { width: innerWidth, height: innerHeight },
        ),
      );
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
          ? {
              top: place.top,
              bottom: place.bottom,
              left: place.left,
              maxHeight: place.maxHeight,
              transformOrigin: place.origin,
            }
          : { visibility: "hidden" }
      }
      onKeyDown={(event) => {
        // A menu opened from a row inside closes on its own Escape first; this one is for the popover.
        if (
          event.key !== "Escape" ||
          menuTakesEscape(event.nativeEvent) ||
          (event.target instanceof Element && event.target.closest(ESCAPE_NOT_MINE))
        )
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
