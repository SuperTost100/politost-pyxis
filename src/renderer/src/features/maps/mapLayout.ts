import { childrenOf, type Item } from "../../../../shared/map-layout";

export {
  COLUMN_GAP,
  NODE_MIN_HEIGHT,
  NODE_WIDTH,
  SIBLING_GAP,
  layoutTree,
} from "../../../../shared/map-layout";

// Maps larger than this open with everything below depth 2 folded, or below depth 1 when that still shows more
// concepts than this: a wide map, such as one joined from several parts, would open as a column too tall to read.
const LARGE_MAP = 25;
const OPEN_DEPTH = 2;
const MIN_START_ZOOM = 0.6;
/** The smallest zoom a map is fitted to on its own: a 14 px concept still reads at about 6 px. */
export const MIN_READ_ZOOM = 0.45;

/** Ids of nodes that have at least one child. */
export function parentIds(nodes: Item[]): Set<string> {
  return new Set(childrenOf(nodes).keys());
}

/** Nodes to fold so that the branches at `depth` show without their children. */
function foldedAt(nodes: Item[], depth: number): Set<string> {
  const children = childrenOf(nodes);
  const root = nodes.find((node) => node.parent === null);
  const folded = new Set<string>();
  const walk = (id: string, at: number) => {
    const next = children.get(id) ?? [];
    if (at >= depth && next.length) folded.add(id);
    else for (const child of next) walk(child.id, at + 1);
  };
  if (root) walk(root.id, 0);
  return folded;
}

/** Nodes to fold when a map opens: large maps open at depth 2, or depth 1 if depth 2 is still too many to read. */
export function initialCollapsed(nodes: Item[]): Set<string> {
  if (nodes.length <= LARGE_MAP) return new Set();
  const second = foldedAt(nodes, OPEN_DEPTH);
  if (visibleNodes(nodes, second).shown.length <= LARGE_MAP) return second;
  return foldedAt(nodes, 1);
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
 * past 1); otherwise MIN_START_ZOOM with the root at the left edge, vertically centred.
 */
export function startViewport(
  boxes: Box[],
  root: Box,
  size: { width: number; height: number },
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
  return {
    zoom: MIN_START_ZOOM,
    x: VIEW_PAD - root.x * MIN_START_ZOOM,
    y: size.height / 2 - (root.y + root.height / 2) * MIN_START_ZOOM,
  };
}

const REVEAL_MARGIN = 24;

/**
 * The view that shows a branch that was just unfolded: `box` holds its node and every node it now shows, and `focus` is
 * the node's own vertical centre. Returns null when the box is inside `size` already, with a margin. Otherwise it keeps
 * the zoom if the box fits, zooms out only as far as it must, never below MIN_READ_ZOOM (or the current zoom, if that
 * is smaller already), and moves the box as little as it can. A box too tall for the canvas at that zoom is centred on
 * `focus`, so the node that was clicked stays on screen with its nearest children.
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
    if (span > room - 2 * m) return centre === undefined ? m : room / 2 - (centre - start) * zoom;
    return Math.min(room - m - span, Math.max(m, centreNow - span / 2));
  };
  const x = place(box.x, box.width * zoom, left + (box.width * view.zoom) / 2, size.width);
  const y = place(box.y, box.height * zoom, top + (box.height * view.zoom) / 2, size.height, focus);
  return { zoom, x: x - box.x * zoom, y: y - box.y * zoom };
}
