/** A rectangle: the page's, in CSS pixels, or the window's, in its own pixels (DIPs). */
export type Box = { x: number; y: number; width: number; height: number };

// Zoom factors such as 1.2 or 1.5 give products that land a hair off a whole number (200 * 1.5 = 300.00000000000006),
// which would grow the box by a pixel on every side.
const EPSILON = 1e-6;

/**
 * The part of the window that a page rectangle covers, for `webContents.capturePage`.
 *
 * `getBoundingClientRect()` is in CSS pixels. `capturePage` takes the window's own pixels, and the app's zoom (the View
 * menu, Ctrl or Cmd with plus and minus) makes one CSS pixel `zoom` of them. The screen's scale factor is not part of
 * this: the picture comes out in device pixels whatever the window is drawn on. The box grows to whole pixels so a
 * canvas on a half pixel is not cut short, and is clamped to the window's content, so a canvas partly scrolled out of
 * the window gives what is visible. Null when none of it is visible.
 */
export function captureRect(page: Box, zoom: number, content: { width: number; height: number }): Box | null {
  const left = Math.max(0, Math.floor(page.x * zoom + EPSILON));
  const top = Math.max(0, Math.floor(page.y * zoom + EPSILON));
  const right = Math.min(Math.floor(content.width), Math.ceil((page.x + page.width) * zoom - EPSILON));
  const bottom = Math.min(Math.floor(content.height), Math.ceil((page.y + page.height) * zoom - EPSILON));
  if (right <= left || bottom <= top) return null;
  return { x: left, y: top, width: right - left, height: bottom - top };
}
