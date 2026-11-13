/** The room a popover keeps from its button and from the window's edges. */
export const GAP = 8;
export const EDGE = 8;
/** Under this much room on the better side, the popover stops following its button and fills the window instead. */
export const MIN_ROOM = 120;

type Rect = { top: number; bottom: number; left: number; right: number };

export type PopoverPlace = {
  left: number;
  /** One of the two is set: the panel hangs from `top` under its button, or stands on `bottom` above it. */
  top?: number;
  bottom?: number;
  maxHeight: number;
  /** `transform-origin`, on the button's edge. */
  origin: string;
};

/**
 * Where a popover goes, decided with its height: under the button when the whole panel fits there, otherwise on the
 * side with more room, shrunk to it (the panel scrolls inside). Standing on `bottom` lets a panel above its button grow
 * upward by itself when its content grows. With less than `MIN_ROOM` on either side the panel fills the window, over its
 * button, so it is never cut off. The panel is also kept inside the window sideways, lined up with the button's right
 * edge.
 */
export function placePopover(
  button: Rect,
  panel: { width: number; height: number },
  view: { width: number; height: number },
): PopoverPlace {
  const left = Math.max(EDGE, Math.min(button.right - panel.width, view.width - EDGE - panel.width));
  const x = Math.round((button.left + button.right) / 2 - left);
  const below = view.height - EDGE - (button.bottom + GAP);
  const above = button.top - GAP - EDGE;
  if (panel.height <= below || (below >= above && below >= MIN_ROOM))
    return { left, top: button.bottom + GAP, maxHeight: below, origin: `${x}px -${GAP}px` };
  if (above >= MIN_ROOM)
    return {
      left,
      bottom: view.height - (button.top - GAP),
      maxHeight: above,
      origin: `${x}px calc(100% + ${GAP}px)`,
    };
  return { left, top: EDGE, maxHeight: Math.max(0, view.height - 2 * EDGE), origin: `${x}px 50%` };
}
