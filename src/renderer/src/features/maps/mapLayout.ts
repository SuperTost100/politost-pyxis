import { childrenOf, type Item } from "../../../../shared/map-layout";

export {
  COLUMN_GAP,
  NODE_MIN_HEIGHT,
  NODE_WIDTH,
  SIBLING_GAP,
  RADIAL_SQUASH,
  layoutRadial,
  layoutTree,
  radialDirection,
  radialLink,
  radialPlan,
  smoothPath,
} from "../../../../shared/map-layout";

// A map of more than this many concepts opens with everything below its main branches folded: the root and its first
// level, with a count on each branch, so a map joined from several parts opens as a handful of readable names.
const LARGE_MAP = 25;
/**
 * The smallest zoom the view moves to on its own, when a map opens and after an unfold. A concept's label is 14 px
 * times the text size setting (0.94 at the smallest, 1.12 at the largest), so 0.85 keeps it at 11 px or more on screen
 * at every text size (11.2 px at the smallest). Below that the labels are too small to read. The student can still zoom
 * out by hand as far as the canvas's own minimum.
 */
export const MIN_READ_ZOOM = 0.85;
/** The smallest zoom the canvas allows, by the mouse wheel, the pinch or the fit button. */
export const CANVAS_MIN_ZOOM = 0.15;

/** Ids of nodes that have at least one child. */
export function parentIds(nodes: Item[]): Set<string> {
  return new Set(childrenOf(nodes).keys());
}

/**
 * Nodes to fold when a map opens: a large map opens with every concept that has children folded except the root, so the
 * main branches show and each unfold adds one level.
 */
export function initialCollapsed(nodes: Item[]): Set<string> {
  if (nodes.length <= LARGE_MAP) return new Set();
  const root = nodes.find((node) => node.parent === null);
  return new Set([...parentIds(nodes)].filter((id) => id !== root?.id));
}

/** Nodes not hidden inside a folded branch, plus how many each folded node hides. */
export function visibleNodes<T extends Item>(
  nodes: T[],
  collapsed: Set<string>,
) {
  const children = childrenOf(nodes);
  const root = nodes.find((node) => node.parent === null);
  const hidden = new Map<string, number>();
  const shown: T[] = [];
  const count = (id: string): number =>
    (children.get(id) ?? []).reduce(
      (sum, child) => sum + 1 + count(child.id),
      0,
    );
  const walk = (node: T) => {
    shown.push(node);
    if (collapsed.has(node.id)) {
      const total = count(node.id);
      if (total) hidden.set(node.id, total);
      return;
    }
    for (const child of children.get(node.id) ?? []) walk(child);
  };
  if (root) walk(root);
  return { shown, hidden };
}

type Box = { x: number; y: number; width: number; height: number };
const VIEW_PAD = 40;

/**
 * Opening view: the whole map when it fits at MIN_READ_ZOOM or more (never zoomed in
 * past 1); otherwise MIN_READ_ZOOM with the root at the left edge, vertically centred, so the root and its nearest
 * branches are readable and the student pans for the rest. A radial map (`centred`) has its branches all round the
 * root, so there the root goes in the middle of the canvas, or as near as it can while the map still fills the
 * canvas's width (a map with one branch starts at its left edge).
 */
export function startViewport(
  boxes: Box[],
  root: Box,
  size: { width: number; height: number },
  centred = false,
): { x: number; y: number; zoom: number } {
  const left = Math.min(...boxes.map((box) => box.x));
  const right = Math.max(...boxes.map((box) => box.x + box.width));
  const top = Math.min(...boxes.map((box) => box.y));
  const bottom = Math.max(...boxes.map((box) => box.y + box.height));
  const room = {
    width: size.width - 2 * VIEW_PAD,
    height: size.height - 2 * VIEW_PAD,
  };
  const fit = Math.min(
    1,
    room.width / (right - left),
    room.height / (bottom - top),
  );
  if (fit >= MIN_READ_ZOOM)
    return {
      zoom: fit,
      x: VIEW_PAD + (room.width - (right - left) * fit) / 2 - left * fit,
      y: VIEW_PAD + (room.height - (bottom - top) * fit) / 2 - top * fit,
    };
  const z = MIN_READ_ZOOM;
  if (centred) {
    // The root in the middle, unless that leaves empty canvas on a side the map does not reach; a span that fits is
    // centred.
    const along = (low: number, high: number, middle: number, length: number, pad: number) => {
      const span = (high - low) * z;
      if (span <= length - 2 * pad) return pad + (length - 2 * pad - span) / 2 - low * z;
      return Math.min(pad - low * z, Math.max(length - pad - high * z, length / 2 - middle * z));
    };
    return {
      zoom: z,
      x: along(left, right, root.x + root.width / 2, size.width, VIEW_PAD),
      y: along(top, bottom, root.y + root.height / 2, size.height, VIEW_PAD),
    };
  }
  return {
    zoom: z,
    x: VIEW_PAD - root.x * z,
    y: size.height / 2 - (root.y + root.height / 2) * z,
  };
}

/**
 * The view of the "Adatta la mappa" button: the whole map, centred, never zoomed in past 1. Unlike the opening view
 * (`startViewport`) it has no readable minimum, since the student asked to see everything and zooms in where they want
 * to read. It goes down to the canvas's own smallest zoom, and a map too big even for that is centred at that zoom, so
 * the button always changes the view while part of the map is outside it.
 */
export function fitViewport(
  boxes: Box[],
  size: { width: number; height: number },
): { x: number; y: number; zoom: number } {
  const left = Math.min(...boxes.map((box) => box.x));
  const right = Math.max(...boxes.map((box) => box.x + box.width));
  const top = Math.min(...boxes.map((box) => box.y));
  const bottom = Math.max(...boxes.map((box) => box.y + box.height));
  const room = { width: size.width - 2 * VIEW_PAD, height: size.height - 2 * VIEW_PAD };
  const zoom = Math.max(CANVAS_MIN_ZOOM, Math.min(1, room.width / (right - left), room.height / (bottom - top)));
  return {
    zoom,
    x: size.width / 2 - ((left + right) / 2) * zoom,
    y: size.height / 2 - ((top + bottom) / 2) * zoom,
  };
}

const REVEAL_MARGIN = 24;
/** A tall branch starts at its top when its node then sits at least this far above the canvas's bottom edge. */
const NODE_ROOM = 72;

/**
 * The view that shows a branch that was just unfolded: `box` holds its node and every node it now shows, and `focus` is
 * the node's own vertical centre. Returns null when the box is inside `size` already, with a margin. Otherwise it keeps
 * the zoom if the box fits, zooms out only as far as it must, never below MIN_READ_ZOOM (or the current zoom, if that
 * is smaller already), and moves the box as little as it can. A box too tall for the canvas at that zoom starts at the
 * top, so the node and its first children show, unless that would push the node itself to the bottom edge, and
 * then it is centred on `focus`. Either way the student scrolls or pans for the rest.
 */
export function revealViewport(
  box: Box,
  focus: number,
  view: { x: number; y: number; zoom: number },
  size: { width: number; height: number },
): { x: number; y: number; zoom: number } | null {
  const m = REVEAL_MARGIN;
  const left = box.x * view.zoom + view.x;
  const top = box.y * view.zoom + view.y;
  if (
    left >= m &&
    top >= m &&
    left + box.width * view.zoom <= size.width - m &&
    top + box.height * view.zoom <= size.height - m
  )
    return null;
  const fit = Math.min((size.width - 2 * m) / box.width, (size.height - 2 * m) / box.height);
  const zoom = Math.min(view.zoom, Math.max(fit, Math.min(MIN_READ_ZOOM, view.zoom)));
  // Where a span starts on screen: as close to where its centre is now as the margins allow.
  const place = (start: number, span: number, centreNow: number, room: number, centre?: number) => {
    // Half a pixel of slack: a span fitted by the zoom above can land one rounding step over the room.
    if (span > room - 2 * m + 0.5) {
      if (centre === undefined) return m;
      // shortcut: NODE_ROOM stands for a node's height with a margin, not the measured size, upgrade if nodes get taller.
      return m + (centre - start) * zoom <= room - NODE_ROOM ? m : room / 2 - (centre - start) * zoom;
    }
    return Math.min(room - m - span, Math.max(m, centreNow - span / 2));
  };
  const x = place(box.x, box.width * zoom, left + (box.width * view.zoom) / 2, size.width);
  const y = place(box.y, box.height * zoom, top + (box.height * view.zoom) / 2, size.height, focus);
  return { zoom, x: x - box.x * zoom, y: y - box.y * zoom };
}
