// Reads the SVG a map export draws, so unit and e2e tests can check the picture a student gets.

type Rect = { x: number; y: number; width: number; height: number };
type Point = { x: number; y: number };
type Graph = {
  nodes: Array<{ id: string; parent: string | null }>;
  edges: Array<{ from: string; to: string }>;
};

/**
 * What is wrong with a drawing of `map`: pairs of concept boxes that intersect, hierarchy links that pass through a box
 * other than their two ends, and how far the root's middle is from the drawing's middle, as a share of its size. The
 * drawing holds one concept box per node, in the order of the nodes, and the hierarchy's links in the first group of
 * paths, one per link in the order of the edges.
 */
export function drawingProblems(svg: string, map: Graph) {
  const rects = [...svg.matchAll(/<rect x="([\d.-]+)" y="([\d.-]+)" width="([\d.]+)" height="([\d.]+)" rx="12"/g)];
  if (rects.length !== map.nodes.length) throw new Error(`${rects.length} concept boxes for ${map.nodes.length} nodes`);
  const boxes = new Map<string, Rect>(
    map.nodes.map((node, i) => {
      const [, x, y, width, height] = rects[i]!;
      return [node.id, { x: Number(x), y: Number(y), width: Number(width), height: Number(height) }];
    }),
  );
  const parent = (id: string) => map.nodes.find((node) => node.id === id)?.parent;
  const hierarchy = map.edges.filter((edge) => parent(edge.to) === edge.from || parent(edge.from) === edge.to);
  const group = /<g fill="none" stroke="#7e8492"[^>]*>(.*?)<\/g>/.exec(svg)![1]!;
  const paths = [...group.matchAll(/<path d="([^"]+)"/g)].map((match) => match[1]!);
  if (paths.length !== hierarchy.length) throw new Error(`${paths.length} links for ${hierarchy.length} edges`);

  const overlaps: string[] = [];
  const list = [...boxes.entries()];
  for (const [i, [a, boxA]] of list.entries())
    for (const [b, boxB] of list.slice(i + 1))
      if (boxA.x < boxB.x + boxB.width && boxB.x < boxA.x + boxA.width && boxA.y < boxB.y + boxB.height && boxB.y < boxA.y + boxA.height)
        overlaps.push(`${a} and ${b}`);

  const behind: string[] = [];
  paths.forEach((d, i) => {
    // A path is M, then straight (L) or cubic (C) segments. Each is sampled at least every 4 px of its length, and the
    // check below tests the stretch between two samples, not the samples alone, so a long straight link cannot step over
    // a box.
    const samples: Point[] = [];
    for (const [, command, rest] of d.matchAll(/([MLC])([^MLC]*)/g)) {
      const n = rest!.match(/-?[\d.]+/g)!.map(Number);
      const from = samples.at(-1)!;
      if (command === "M") {
        samples.push({ x: n[0]!, y: n[1]! });
        continue;
      }
      const corners = command === "L" ? [from, { x: n[0]!, y: n[1]! }] : [from, { x: n[0]!, y: n[1]! }, { x: n[2]!, y: n[3]! }, { x: n[4]!, y: n[5]! }];
      // A curve is never longer than the polygon of its control points.
      const length = corners.slice(1).reduce((sum, point, at) => sum + Math.hypot(point.x - corners[at]!.x, point.y - corners[at]!.y), 0);
      const steps = Math.max(24, Math.ceil(length / 4));
      for (let step = 1; step <= steps; step++) {
        const t = step / steps;
        const u = 1 - t;
        const at = (a: number, b: number, c: number, e: number) => u ** 3 * a + 3 * u * u * t * b + 3 * u * t * t * c + t ** 3 * e;
        samples.push(
          command === "L"
            ? { x: from.x + (n[0]! - from.x) * t, y: from.y + (n[1]! - from.y) * t }
            : { x: at(from.x, n[0]!, n[2]!, n[4]!), y: at(from.y, n[1]!, n[3]!, n[5]!) },
        );
      }
    }
    const link = hierarchy[i]!;
    for (const [id, box] of boxes) {
      if (id === link.from || id === link.to) continue;
      const inside = { left: box.x + 1, right: box.x + box.width - 1, top: box.y + 1, bottom: box.y + box.height - 1 };
      if (samples.some((p, at) => at > 0 && crosses(samples[at - 1]!, p, inside)))
        behind.push(`${link.from} to ${link.to} passes behind ${id}`);
    }
  });

  const width = Number(/width="(\d+)"/.exec(svg)![1]);
  const height = Number(/height="(\d+)"/.exec(svg)![1]);
  const root = boxes.get(map.nodes.find((node) => node.parent === null)!.id)!;
  return {
    overlaps,
    behind,
    rootOffset: {
      x: Math.abs(root.x + root.width / 2 - width / 2) / width,
      y: Math.abs(root.y + root.height / 2 - height / 2) / height,
    },
  };
}

/** Whether the straight stretch from `a` to `b` has a point strictly inside the rectangle (Liang-Barsky clipping). */
export function crosses(a: Point, b: Point, box: { left: number; right: number; top: number; bottom: number }): boolean {
  let enter = 0;
  let leave = 1;
  const clip = (delta: number, distance: number) => {
    if (delta === 0) return distance > 0;
    const t = distance / delta;
    if (delta < 0) enter = Math.max(enter, t);
    else leave = Math.min(leave, t);
    return enter < leave;
  };
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  return clip(-dx, a.x - box.left) && clip(dx, box.right - a.x) && clip(-dy, a.y - box.top) && clip(dy, box.bottom - a.y);
}
