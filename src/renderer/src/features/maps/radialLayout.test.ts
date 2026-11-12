import { describe, expect, it } from "vitest";
import { RADIAL_SQUASH, radialLink, radialPlan, visibleNodes, initialCollapsed } from "./mapLayout";
import { radialFixtures, type FixtureMap } from "../../../../../tests/fixtures/maps";

type Box = { x: number; y: number; width: number; height: number };
type Point = { x: number; y: number };

/**
 * A concept's box as the page draws it: labels wrap at the 240 px box width, 14 px text with 19 px lines for a concept,
 * 17 px serif with 21 px lines for the root. A rough estimate of the measured size, which the layout takes as given.
 */
function sizeOf(label: string, root: boolean) {
  const perLine = root ? 24 : 29;
  const lines: string[] = [];
  for (const word of label.split(" ")) {
    const last = lines.at(-1);
    if (last !== undefined && (last + " " + word).length <= perLine) lines[lines.length - 1] = `${last} ${word}`;
    else lines.push(word);
  }
  const widest = Math.max(...lines.map((line) => line.length));
  return root
    ? { width: Math.min(240, Math.ceil(widest * 8.6) + 28), height: lines.length * 21 + 24 }
    : { width: Math.min(240, Math.ceil(widest * 7.4) + 24), height: lines.length * 19 + 16 };
}
const sizes = (map: FixtureMap) => new Map(map.nodes.map((node) => [node.id, sizeOf(node.label, node.parent === null)]));

function overlaps(a: Box, b: Box) {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}
/** Whether the segment from p to q passes through the inside of `box` (its edges excluded). */
function segmentHitsBox(p: Point, q: Point, box: Box) {
  const inset = 0.5;
  const [x0, x1, y0, y1] = [box.x + inset, box.x + box.width - inset, box.y + inset, box.y + box.height - inset];
  let t0 = 0;
  let t1 = 1;
  const dx = q.x - p.x;
  const dy = q.y - p.y;
  for (const [step, room] of [
    [-dx, p.x - x0],
    [dx, x1 - p.x],
    [-dy, p.y - y0],
    [dy, y1 - p.y],
  ] as const) {
    if (step === 0) {
      if (room < 0) return false;
      continue;
    }
    const t = room / step;
    if (step < 0) t0 = Math.max(t0, t);
    else t1 = Math.min(t1, t);
    if (t0 > t1) return false;
  }
  return true;
}
function segmentsCross(a: Point, b: Point, c: Point, d: Point) {
  const side = (p: Point, q: Point, r: Point) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
  const d1 = side(c, d, a);
  const d2 = side(c, d, b);
  const d3 = side(a, b, c);
  const d4 = side(a, b, d);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

/** Lays the map out with every concept shown, or with `folded` closed, and returns its boxes and drawn links. */
function draw(map: FixtureMap, folded = new Set<string>()) {
  const shown = visibleNodes(map.nodes, folded).shown;
  const measured = sizes(map);
  const plan = radialPlan(shown, measured);
  const boxes = new Map(
    shown.map((node) => [node.id, { ...plan.places.get(node.id)!, ...measured.get(node.id)! }] as const),
  );
  const root = shown.find((node) => node.parent === null)!;
  const rootBox = boxes.get(root.id)!;
  const centre = { x: rootBox.x + rootBox.width / 2, y: rootBox.y + rootBox.height / 2 };
  const links = shown
    .filter((node) => node.parent !== null)
    .map((node) => ({
      from: node.parent!,
      to: node.id,
      points: radialLink(boxes.get(node.parent!)!, boxes.get(node.id)!, centre, plan.bands.get(node.parent!)!),
    }));
  return { shown, plan, boxes, links, centre, root };
}

const cases = Object.entries(radialFixtures);

describe.each(cases)("radial layout of %s", (_, map) => {
  const { shown, plan, boxes, links, centre, root } = draw(map);

  it("keeps every two boxes apart", () => {
    const list = [...boxes.entries()];
    for (const [i, [a, boxA]] of list.entries())
      for (const [b, boxB] of list.slice(i + 1)) expect(overlaps(boxA, boxB), `${a} overlaps ${b}`).toBe(false);
  });

  it("draws no link through a box other than its two ends", () => {
    for (const link of links)
      for (const [id, box] of boxes) {
        if (id === link.from || id === link.to) continue;
        const hit = link.points.slice(1).some((point, i) => segmentHitsBox(link.points[i]!, point, box));
        expect(hit, `${link.from}→${link.to} passes behind ${id}`).toBe(false);
      }
  });

  it("crosses no two links", () => {
    for (const [i, a] of links.entries())
      for (const b of links.slice(i + 1)) {
        // Links that share a concept meet at its box; siblings leave their parent on one stem.
        if ([a.from, a.to].some((id) => id === b.from || id === b.to)) continue;
        const cross = a.points
          .slice(1)
          .some((p, s) => b.points.slice(1).some((q, t) => segmentsCross(a.points[s]!, p, b.points[t]!, q)));
        expect(cross, `${a.from}→${a.to} crosses ${b.from}→${b.to}`).toBe(false);
      }
  });

  it("puts the root at the centre, with the map around it", () => {
    // Corners are whole pixels, so an odd-sized root sits half a pixel off.
    expect(Math.abs(centre.x)).toBeLessThanOrEqual(0.5);
    expect(Math.abs(centre.y)).toBeLessThanOrEqual(0.5);
    expect(plan.polar.get(root.id)!.radius).toBe(0);
    // The deep chain grows one way only; a map with two branches or more has the root in the middle half of its box.
    if (shown.filter((node) => node.parent === root.id).length < 2) return;
    const all = [...boxes.values()];
    const left = Math.min(...all.map((box) => box.x));
    const right = Math.max(...all.map((box) => box.x + box.width));
    const top = Math.min(...all.map((box) => box.y));
    const bottom = Math.max(...all.map((box) => box.y + box.height));
    expect(centre.x).toBeGreaterThan(left + (right - left) / 4);
    expect(centre.x).toBeLessThan(right - (right - left) / 4);
    expect(centre.y).toBeGreaterThan(top + (bottom - top) / 4);
    expect(centre.y).toBeLessThan(bottom - (bottom - top) / 4);
  });

  it("gives each branch a sector of its own and keeps every box inside its parent's sector", () => {
    const turn = (angle: number, around: number) => around + Math.atan2(Math.sin(angle - around), Math.cos(angle - around));
    for (const node of shown) {
      if (node.parent === null) continue;
      const own = plan.polar.get(node.id)!;
      const parent = plan.polar.get(node.parent)!;
      const [a0, a1] = own.sector;
      expect(a0, `${node.id} starts inside ${node.parent}`).toBeGreaterThanOrEqual(parent.sector[0] - 1e-9);
      expect(a1, `${node.id} ends inside ${node.parent}`).toBeLessThanOrEqual(parent.sector[1] + 1e-9);
      expect(own.depth).toBe(parent.depth + 1);
      // Every corner of the box, seen from the root with the squash undone, lies inside the sector.
      const box = boxes.get(node.id)!;
      const middle = (a0 + a1) / 2;
      for (const [x, y] of [
        [box.x, box.y],
        [box.x + box.width, box.y],
        [box.x, box.y + box.height],
        [box.x + box.width, box.y + box.height],
      ] as const) {
        const angle = turn(Math.atan2(y - centre.y, (x - centre.x) / RADIAL_SQUASH), middle);
        expect(angle, `a corner of ${node.id} leaves its sector`).toBeGreaterThanOrEqual(a0 - 1e-9);
        expect(angle, `a corner of ${node.id} leaves its sector`).toBeLessThanOrEqual(a1 + 1e-9);
      }
    }
    // Siblings' sectors never share space.
    const groups = new Map<string, Array<[number, number]>>();
    for (const node of shown)
      if (node.parent) groups.set(node.parent, [...(groups.get(node.parent) ?? []), plan.polar.get(node.id)!.sector]);
    for (const sectors of groups.values()) {
      const sorted = [...sectors].sort((a, b) => a[0] - b[0]);
      for (let i = 1; i < sorted.length; i++) expect(sorted[i]![0]).toBeGreaterThanOrEqual(sorted[i - 1]![1] - 1e-9);
    }
  });

  it("gives the same picture every time", () => {
    expect(draw(map).plan.places).toEqual(plan.places);
  });
});

describe("radial layout with folds", () => {
  it("lays out a large map opened folded, and each branch as it unfolds, without overlaps", () => {
    const map = radialFixtures.physics;
    const folded = initialCollapsed(map.nodes);
    expect(folded.size).toBeGreaterThan(0);
    for (const open of [undefined, "t1", "t3"]) {
      if (open) folded.delete(open);
      const { boxes } = draw(map, folded);
      const list = [...boxes.entries()];
      for (const [i, [a, boxA]] of list.entries())
        for (const [b, boxB] of list.slice(i + 1)) expect(overlaps(boxA, boxB), `${a} overlaps ${b}`).toBe(false);
    }
  });

  it("points a single branch to the right of the root, like the tree", () => {
    const { boxes, centre } = draw(radialFixtures.deepChain);
    const first = boxes.get("c1")!;
    expect(first.x).toBeGreaterThan(centre.x);
    expect(Math.abs(first.y + first.height / 2 - centre.y)).toBeLessThan(1);
  });
});
