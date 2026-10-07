import { hierarchy, tree } from "d3-hierarchy";

export const NODE_WIDTH = 240;
export const NODE_MIN_HEIGHT = 64;
// Free space between depth columns and between siblings, on top of the node boxes.
export const COLUMN_GAP = 140;
export const SIBLING_GAP = 28;
// Maps larger than this open with everything below depth 2 folded.
export const LARGE_MAP = 25;
export const OPEN_DEPTH = 2;
export const MIN_START_ZOOM = 0.6;

type Item = { id: string; parent: string | null };

function childrenOf<T extends Item>(nodes: T[]) {
  const children = new Map<string, T[]>();
  for (const node of nodes)
    if (node.parent !== null)
      children.set(node.parent, [...(children.get(node.parent) ?? []), node]);
  return children;
}

/** Ids of nodes that have at least one child. */
export function parentIds(nodes: Item[]): Set<string> {
  return new Set(childrenOf(nodes).keys());
}

/** Nodes to fold when a map opens: branches at depth 2 on large maps. */
export function initialCollapsed(nodes: Item[]): Set<string> {
  if (nodes.length <= LARGE_MAP) return new Set();
  const children = childrenOf(nodes);
  const root = nodes.find((node) => node.parent === null);
  const folded = new Set<string>();
  const walk = (id: string, depth: number) => {
    const next = children.get(id) ?? [];
    if (depth >= OPEN_DEPTH && next.length) folded.add(id);
    else for (const child of next) walk(child.id, depth + 1);
  };
  if (root) walk(root.id, 0);
  return folded;
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

/**
 * Left-to-right tidy tree. Returns the top-left corner of every node: the root sits at
 * x 0 and each depth column starts NODE_WIDTH + COLUMN_GAP further right. Siblings keep
 * at least SIBLING_GAP between their real boxes, so tall nodes never touch.
 */
export function layoutTree(
  nodes: Item[],
  heights: ReadonlyMap<string, number>,
): Map<string, { x: number; y: number }> {
  const placed = new Map<string, { x: number; y: number }>();
  const root = nodes.find((node) => node.parent === null);
  if (!root) return placed;
  const children = childrenOf(nodes);
  const height = (id: string) => heights.get(id) ?? NODE_MIN_HEIGHT;
  const layout = tree<Item>()
    .nodeSize([1, NODE_WIDTH + COLUMN_GAP])
    .separation(
      (a, b) => (height(a.data.id) + height(b.data.id)) / 2 + SIBLING_GAP,
    );
  layout(hierarchy<Item>(root, (node) => children.get(node.id) ?? [])).each(
    (point) => {
      placed.set(point.data.id, {
        x: point.y,
        y: Math.round(point.x - height(point.data.id) / 2),
      });
    },
  );
  return placed;
}

type Box = { x: number; y: number; width: number; height: number };
const VIEW_PAD = 40;
// The tool rail floats over the left edge of the canvas.
const VIEW_PAD_LEFT = 88;

/**
 * Opening view: the whole map when it fits at MIN_START_ZOOM or more (never zoomed in
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
    width: size.width - VIEW_PAD_LEFT - VIEW_PAD,
    height: size.height - 2 * VIEW_PAD,
  };
  const fit = Math.min(
    1,
    room.width / (right - left),
    room.height / (bottom - top),
  );
  if (fit >= MIN_START_ZOOM)
    return {
      zoom: fit,
      x: VIEW_PAD_LEFT + (room.width - (right - left) * fit) / 2 - left * fit,
      y: VIEW_PAD + (room.height - (bottom - top) * fit) / 2 - top * fit,
    };
  return {
    zoom: MIN_START_ZOOM,
    x: VIEW_PAD_LEFT - root.x * MIN_START_ZOOM,
    y: size.height / 2 - (root.y + root.height / 2) * MIN_START_ZOOM,
  };
}
