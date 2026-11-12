import { hierarchy, tree } from "d3-hierarchy";

// The map's tree layout, shared by the editor, which measures node heights, and the export, which estimates them.
export const NODE_WIDTH = 240;
export const NODE_MIN_HEIGHT = 64;
// Free space between depth columns and between siblings, on top of the node boxes.
export const COLUMN_GAP = 140;
export const SIBLING_GAP = 28;

export type Item = { id: string; parent: string | null };

/** Each parent's children, in the order the nodes come. */
export function childrenOf<T extends Item>(nodes: T[]): Map<string, T[]> {
  const children = new Map<string, T[]>();
  for (const node of nodes) {
    if (node.parent === null) continue;
    const siblings = children.get(node.parent);
    if (siblings) siblings.push(node);
    else children.set(node.parent, [node]);
  }
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


/**
 * The radial layout works in a plane squashed sideways by this factor, where a 240 px wide concept is about as wide as
 * it is tall. Its rings are circles there and ellipses on screen, wider than tall, as the boxes and the window are.
 */
export const RADIAL_SQUASH = 2;
// Free space, in the squashed plane, between neighbours on a ring and between one ring and the next. The ring gap holds
// the links' turns and the fold buttons, which stand out of a concept on the side its links leave from.
const RADIAL_GAP = 18;
const RING_GAP = 64;
// How far a link's turn keeps from the boxes of the rings on either side.
const BAND_MARGIN = 6;

export type Size = { width: number; height: number };
type Box = Size & { x: number; y: number };
type Point = { x: number; y: number };
/** Where a concept sits around the root: its angle and ring in the squashed plane, and the sector it owns. */
export type RadialPlace = { angle: number; radius: number; depth: number; sector: [number, number] };
export type RadialPlan = {
  /** The top-left corner of every concept, the root centred on 0,0. */
  places: Map<string, Point>;
  polar: Map<string, RadialPlace>;
  /**
   * For the links from each parent to its children: where, as a share of the way from the parent's ring to the
   * children's, the free band between the two rings starts and ends. A link turns inside that band only, where no
   * concept is.
   */
  bands: Map<string, [number, number]>;
};
// The most of the circle one main branch takes: past that, its deeper rings move outward rather than wrap round the root.
const MAX_SECTOR = Math.PI;
// How far, in radians, a box may move from its earlier angle and still fit the room measured for it.
const ANGLE_SLACK = 0.06;

/**
 * Radial layout: the root in the middle and each depth on a ring around it. Every concept owns a sector, a slice of the
 * circle sized by what it holds: the room its own box needs on its ring, or the room its children's sectors need,
 * whichever is more. Children split their parent's sector in their order, so links never cross.
 *
 * In the squashed plane each box is held in a circle of half its diagonal. A ring sits far enough from the next for
 * their circles not to meet, and a sector is wide enough for its circle to fit between the sector's edges, so boxes
 * in different sectors or on different rings never touch. The first ring is as close to the root as that allows, or
 * further out when its concepts need more than the full circle. A main branch takes at most half the circle: one that
 * needs more keeps its rings beyond the first further out, as far as its concepts then fit, so its children fan out on
 * its side of the map instead of wrapping round the root. Spare room is left as even gaps between the main branches,
 * so a branch's children stay close to it. The first branch starts at twelve o'clock and the others follow clockwise;
 * a map with one branch points it to the right, as the tree does. Sizes are the measured boxes, so a long label gets
 * its room.
 */
export function radialPlan(nodes: Item[], sizes: ReadonlyMap<string, Size>): RadialPlan {
  const root = nodes.find((node) => node.parent === null);
  if (!root) return { places: new Map(), polar: new Map(), bands: new Map() };
  const children = childrenOf(nodes);
  const size = (id: string) => sizes.get(id) ?? { width: NODE_WIDTH, height: NODE_MIN_HEIGHT };
  const reach = (id: string) => Math.hypot(size(id).width / RADIAL_SQUASH, size(id).height) / 2;
  // Half the box in the squashed plane, with half the gap to its neighbours around it.
  const half = (id: string) => ({
    x: size(id).width / RADIAL_SQUASH / 2 + RADIAL_GAP / 2,
    y: size(id).height / 2 + RADIAL_GAP / 2,
  });
  const depth = new Map([[root.id, 0]]);
  const ringReach = [reach(root.id)];
  // Each main branch with its concepts, breadth first, so every parent comes before its children.
  const branches = (children.get(root.id) ?? []).map((branch) => {
    const order = [branch];
    depth.set(branch.id, 1);
    for (let i = 0; i < order.length; i++)
      for (const child of children.get(order[i]!.id) ?? []) {
        depth.set(child.id, depth.get(order[i]!.id)! + 1);
        order.push(child);
      }
    for (const node of order) {
      const d = depth.get(node.id)!;
      ringReach[d] = Math.max(ringReach[d] ?? 0, reach(node.id));
    }
    return order;
  });
  // The ring radii with the first ring at `first` and the deeper ones `out` further.
  const rings = (first: number, out = 0) => {
    const radii = [0, first];
    for (let d = 2; d < ringReach.length; d++)
      radii[d] = radii[d - 1]! + ringReach[d - 1]! + RING_GAP + ringReach[d]! + (d === 2 ? out : 0);
    return radii;
  };
  // How far the box of `id`, with its gap, reaches each way round the root from its middle when that sits at `radius`
  // and `angle`: the angles of its corners, seen from the root, either side of `angle`.
  const sides = (id: string, radius: number, angle: number) => {
    const { x, y } = half(id);
    const [cos, sin] = [Math.cos(angle), Math.sin(angle)];
    let [before, after] = [0, 0];
    for (const [dx, dy] of [
      [x, y],
      [x, -y],
      [-x, y],
      [-x, -y],
    ] as const) {
      const [px, py] = [cos * radius + dx, sin * radius + dy];
      const turn = Math.atan2(cos * py - sin * px, cos * px + sin * py);
      before = Math.max(before, -turn);
      after = Math.max(after, turn);
    }
    return { before, after };
  };
  const full = 2 * Math.PI;
  /** The smallest value from `low` up for which `fits` holds, `fits` being false below some value and true above it. */
  const least = (low: number, fits: (value: number) => boolean) => {
    if (fits(low)) return low;
    let high = Math.max(low * 2, 64);
    while (!fits(high)) high *= 2;
    for (let step = 0; step < 40; step++) {
      const middle = (low + high) / 2;
      if (fits(middle)) high = middle;
      else low = middle;
    }
    return high;
  };

  // One pass of the layout. Without `angles`, each box counts as the circle round it, which fits whatever its angle.
  // With the angles of an earlier pass, it counts as its own rectangle at that angle, which needs less room on the
  // left and right of the map, where boxes stack. The pass is `fits` when every box lies inside its sector.
  const pass = (angles?: ReadonlyMap<string, number>, kept?: { first: number; out: number[] }) => {
    const plan: RadialPlan = { places: new Map(), polar: new Map(), bands: new Map() };
    // The angle a concept's own box needs on its ring.
    const own = (node: Item, radii: number[]) => {
      const radius = radii[depth.get(node.id)!]!;
      const angle = angles?.get(node.id);
      if (angle === undefined) return 2 * Math.asin(Math.min(1, Math.hypot(half(node.id).x, half(node.id).y) / radius));
      // Measured a little either side of the earlier angle too, since the box moves as the sectors change.
      let most = 0;
      for (const shift of [-2, -1, 0, 1, 2]) {
        const { before, after } = sides(node.id, radius, angle + shift * ANGLE_SLACK);
        most = Math.max(most, before, after);
      }
      return 2 * most;
    };
    // The angle each concept of `order` needs with the rings at `radii`, deepest first so children come before parents.
    const needs = (order: Item[], radii: number[]) => {
      const need = new Map<string, number>();
      for (let i = order.length - 1; i >= 0; i--) {
        const node = order[i]!;
        const inside = (children.get(node.id) ?? []).reduce((sum, child) => sum + need.get(child.id)!, 0);
        need.set(node.id, Math.max(own(node, radii), inside));
      }
      return need;
    };
    // What a branch asks of the circle with its rings at `radii`: its own room on the first ring at least, the room
    // its concepts need up to half the circle.
    const ask = (order: Item[], radii: number[]) =>
      Math.max(own(order[0]!, radii), Math.min(MAX_SECTOR, needs(order, radii).get(order[0]!.id)!));
    const asked = (first: number) => branches.reduce((sum, order) => sum + ask(order, rings(first)), 0);
    const first =
      kept?.first ?? (branches.length ? least(ringReach[0]! + RING_GAP + ringReach[1]!, (r) => asked(r) <= full) : 0);
    const outs: number[] = [];
    const sectors = branches.map((order) => ask(order, rings(first)));
    const gap = (full - sectors.reduce((sum, sector) => sum + sector, 0)) / Math.max(1, branches.length);
    let fits = true;
    const placeOne = (node: Item, sector: [number, number], radii: number[], need: Map<string, number>) => {
      const d = depth.get(node.id)!;
      const angle = d === 0 ? 0 : (sector[0] + sector[1]) / 2;
      const radius = radii[d]!;
      plan.polar.set(node.id, { angle, radius, depth: d, sector });
      if (d > 0) {
        const { before, after } = sides(node.id, radius, angle);
        if (angle - before < sector[0] - 1e-9 || angle + after > sector[1] + 1e-9) fits = false;
      }
      const { width, height } = size(node.id);
      plan.places.set(node.id, {
        x: Math.round(Math.cos(angle) * radius * RADIAL_SQUASH - width / 2),
        y: Math.round(Math.sin(angle) * radius - height / 2),
      });
      const list = children.get(node.id) ?? [];
      if (!list.length) return;
      const span = radii[d + 1]! - radius;
      plan.bands.set(node.id, [
        (ringReach[d]! + BAND_MARGIN) / span,
        1 - (ringReach[d + 1]! + BAND_MARGIN) / span,
      ]);
      if (d === 0) return;
      const share = (sector[1] - sector[0]) / list.reduce((sum, child) => sum + need.get(child.id)!, 0);
      let cursor = sector[0];
      for (const child of list) {
        const next = cursor + need.get(child.id)! * share;
        placeOne(child, [cursor, next], radii, need);
        cursor = next;
      }
    };
    // One branch points right; otherwise the first starts at twelve o'clock, half a gap in.
    let cursor = branches.length === 1 ? -sectors[0]! / 2 : -Math.PI / 2 + gap / 2;
    placeOne(root, [cursor, cursor + full], rings(first), new Map());
    branches.forEach((order, b) => {
      const sector: [number, number] = [cursor, cursor + sectors[b]!];
      // The branch's deeper rings move out as far as its concepts need to fit in its sector.
      const out =
        kept?.out[b] ?? least(0, (value) => needs(order, rings(first, value)).get(order[0]!.id)! <= sectors[b]! + 1e-9);
      outs.push(out);
      const radii = rings(first, out);
      placeOne(order[0]!, sector, radii, needs(order, radii));
      cursor += sectors[b]! + gap;
    });
    return { plan, fits, rings: { first, out: outs } };
  };
  // The circles' pass always fits. Further passes keep its rings and measure each box at the angle the pass before
  // gave it; the last of up to six that fits is kept.
  const circles = pass();
  let plan = circles.plan;
  let angles = plan.polar;
  for (let round = 0; round < 6; round++) {
    const next = pass(new Map([...angles].map(([id, place]) => [id, place.angle])), circles.rings);
    angles = next.plan.polar;
    if (next.fits) plan = next.plan;
  }
  return plan;
}

/** The radial layout's top-left corners, as `layoutTree` gives the tree's. */
export function layoutRadial(nodes: Item[], sizes: ReadonlyMap<string, Size>): Map<string, Point> {
  return radialPlan(nodes, sizes).places;
}

/** Where a ray from the middle of `box` in direction (dx, dy) leaves it. */
function edgeOf(box: Box, dx: number, dy: number): Point {
  const middle = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  const length = Math.hypot(dx, dy) || 1;
  const [ux, uy] = [dx / length, dy / length];
  const t = Math.min(
    ux ? box.width / 2 / Math.abs(ux) : Infinity,
    uy ? box.height / 2 / Math.abs(uy) : Infinity,
  );
  return { x: middle.x + ux * t, y: middle.y + uy * t };
}

/** The direction, on screen, of a ray from the root at `angle` in the squashed plane. */
export function radialDirection(angle: number): Point {
  const x = Math.cos(angle) * RADIAL_SQUASH;
  const y = Math.sin(angle);
  const length = Math.hypot(x, y);
  return { x: x / length, y: y / length };
}

/**
 * The points of the link from `parent` to `child` in the radial layout, from the parent's edge to the child's. It
 * leaves the parent straight out from the root, turns toward the child inside `band` (the free band between their
 * rings, see `RadialPlan`) and comes into the child's near side straight from the root, so it never runs behind
 * another concept. A link from the root goes straight to the child. Boxes are where they are drawn now, so the link
 * follows them while they move.
 */
export function radialLink(parent: Box, child: Box, centre: Point, band: [number, number]): Point[] {
  const polar = (box: Box) => {
    const x = (box.x + box.width / 2 - centre.x) / RADIAL_SQUASH;
    const y = box.y + box.height / 2 - centre.y;
    return { radius: Math.hypot(x, y), angle: Math.atan2(y, x) };
  };
  const to = polar(child);
  const from = polar(parent);
  if (from.radius < 1) from.angle = to.angle;
  const turn = Math.atan2(Math.sin(to.angle - from.angle), Math.cos(to.angle - from.angle));
  const out = radialDirection(from.angle);
  const into = radialDirection(to.angle);
  const start = edgeOf(parent, out.x, out.y);
  const end = edgeOf(child, -into.x, -into.y);
  if (Math.abs(turn) < 1e-3 || to.radius <= from.radius) return [start, end];
  const at = (radius: number, angle: number) => ({
    x: centre.x + Math.cos(angle) * radius * RADIAL_SQUASH,
    y: centre.y + Math.sin(angle) * radius,
  });
  const span = to.radius - from.radius;
  const inner = from.radius + band[0] * span;
  const outer = from.radius + band[1] * span;
  // Enough points for the turn to look smooth once drawn as a curve through them.
  const steps = Math.min(48, Math.max(6, Math.ceil((Math.abs(turn) * outer * RADIAL_SQUASH) / 24)));
  const points = [start];
  for (let i = 0; i <= steps; i++) {
    const s = i / steps;
    const ease = s * s * (3 - 2 * s);
    points.push(at(inner + (outer - inner) * s, from.angle + turn * ease));
  }
  points.push(end);
  return points;
}

/** An SVG path through `points`: a smooth curve (Catmull-Rom as cubic Béziers). */
export function smoothPath(points: Point[]): string {
  const f = (n: number) => Math.round(n * 10) / 10;
  if (points.length < 3) return points.map((p, i) => `${i ? "L" : "M"}${f(p.x)},${f(p.y)}`).join(" ");
  let path = `M${f(points[0]!.x)},${f(points[0]!.y)}`;
  for (let i = 0; i + 1 < points.length; i++) {
    const p0 = points[Math.max(0, i - 1)]!;
    const p1 = points[i]!;
    const p2 = points[i + 1]!;
    const p3 = points[Math.min(points.length - 1, i + 2)]!;
    path += ` C${f(p1.x + (p2.x - p0.x) / 6)},${f(p1.y + (p2.y - p0.y) / 6)} ${f(p2.x - (p3.x - p1.x) / 6)},${f(p2.y - (p3.y - p1.y) / 6)} ${f(p2.x)},${f(p2.y)}`;
  }
  return path;
}
