import { hierarchy, tree } from "d3-hierarchy";

// The map's tree layout, shared by the editor, which measures node heights, and the export, which estimates them.
export const NODE_WIDTH = 240;
export const NODE_MIN_HEIGHT = 64;
// Free space between depth columns and between siblings, on top of the node boxes.
export const COLUMN_GAP = 140;
export const SIBLING_GAP = 28;

type Item = { id: string; parent: string | null };

function childrenOf<T extends Item>(nodes: T[]) {
  const children = new Map<string, T[]>();
  for (const node of nodes)
    if (node.parent !== null)
      children.set(node.parent, [...(children.get(node.parent) ?? []), node]);
  return children;
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
