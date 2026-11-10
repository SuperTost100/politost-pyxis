import { describe, expect, it } from "vitest";
import {
  COLUMN_GAP,
  NODE_WIDTH,
  SIBLING_GAP,
  initialCollapsed,
  MIN_READ_ZOOM,
  revealViewport,
  startViewport,
  layoutTree,
  visibleNodes,
} from "./mapLayout";
import { childrenOf } from "../../../../shared/map-layout";

const wide = (count: number) => [
  { id: "r", parent: null },
  ...Array.from({ length: count }, (_, i) => ({ id: `a${i}`, parent: "r" })),
  ...Array.from({ length: count }, (_, i) => ({
    id: `b${i}`,
    parent: `a${i}`,
  })),
  ...Array.from({ length: count }, (_, i) => ({
    id: `c${i}`,
    parent: `b${i}`,
  })),
];

describe("layoutTree", () => {
  it("puts depth columns left to right with a real gap", () => {
    const placed = layoutTree(wide(3), new Map());
    expect(placed.get("r")!.x).toBe(0);
    expect(placed.get("a0")!.x - placed.get("r")!.x).toBeGreaterThanOrEqual(
      NODE_WIDTH + COLUMN_GAP,
    );
    expect(placed.get("c1")!.x).toBe(3 * (NODE_WIDTH + COLUMN_GAP));
  });

  it("keeps siblings of different heights apart", () => {
    const heights = new Map([
      ["a0", 200],
      ["a1", 64],
      ["a2", 120],
    ]);
    const placed = layoutTree(wide(3), heights);
    const boxes = ["a0", "a1", "a2"]
      .map((id) => ({ top: placed.get(id)!.y, height: heights.get(id)! }))
      .sort((a, b) => a.top - b.top);
    for (let i = 1; i < boxes.length; i++)
      expect(
        boxes[i]!.top - (boxes[i - 1]!.top + boxes[i - 1]!.height),
      ).toBeGreaterThanOrEqual(SIBLING_GAP);
  });

  it("centres a parent on its children", () => {
    const placed = layoutTree(
      [
        { id: "r", parent: null },
        { id: "a", parent: "r" },
        { id: "b", parent: "r" },
      ],
      new Map(),
    );
    expect(placed.get("r")!.y).toBe(
      (placed.get("a")!.y + placed.get("b")!.y) / 2,
    );
  });
});

describe("collapsing", () => {
  it("leaves small maps open", () => {
    expect(initialCollapsed(wide(8)).size).toBe(0);
  });

  it("folds below depth 2 on large maps", () => {
    const nodes = wide(10);
    const folded = initialCollapsed(nodes);
    expect([...folded].sort()).toEqual(
      Array.from({ length: 10 }, (_, i) => `b${i}`).sort(),
    );
    const { shown, hidden } = visibleNodes(nodes, folded);
    expect(shown).toHaveLength(21);
    expect(hidden.get("b0")).toBe(1);
  });

  it("folds below the first level when depth 2 would still show too many concepts", () => {
    // Three parts of thirteen concepts each, joined under one root: 43 nodes, all within two levels of it.
    const joined = [
      { id: "r", parent: null },
      ...[1, 2, 3].flatMap((part) => [
        { id: `p${part}`, parent: "r" },
        ...Array.from({ length: 13 }, (_, i) => ({ id: `p${part}c${i}`, parent: `p${part}` })),
      ]),
    ];
    const folded = initialCollapsed(joined);
    expect([...folded].sort()).toEqual(["p1", "p2", "p3"]);
    const { shown, hidden } = visibleNodes(joined, folded);
    expect(shown.map((node) => node.id)).toEqual(["r", "p1", "p2", "p3"]);
    expect(hidden.get("p2")).toBe(13);
  });

  it("hides whole branches and counts them", () => {
    const { shown, hidden } = visibleNodes(wide(2), new Set(["a0"]));
    expect(shown.map((node) => node.id)).toEqual(["r", "a0", "a1", "b1", "c1"]);
    expect(hidden.get("a0")).toBe(2);
  });
});

describe("startViewport", () => {
  const box = (x: number, y: number) => ({ x, y, width: 240, height: 64 });
  const size = { width: 1000, height: 600 };

  it("fits a small map without zooming in past 1", () => {
    const view = startViewport([box(0, 0), box(380, 100)], box(0, 0), size);
    expect(view.zoom).toBe(1);
  });

  it("fits a medium map between 0.6 and 1", () => {
    const view = startViewport([box(0, 0), box(900, 300)], box(0, 0), size);
    expect(view.zoom).toBeGreaterThan(0.6);
    expect(view.zoom).toBeLessThan(1);
  });

  it("shows a tall first level whole when it still reads, down to MIN_READ_ZOOM", () => {
    // Eighteen concepts in a column, 35 px tall with the gap between them, are 1.1 times a 600 px canvas at zoom 1.
    const column = Array.from({ length: 18 }, (_, i) => ({ x: 380, y: i * 63, width: 240, height: 35 }));
    const view = startViewport([box(0, 500), ...column], box(0, 500), size);
    expect(view.zoom).toBeLessThan(0.6);
    expect(view.zoom).toBeGreaterThanOrEqual(MIN_READ_ZOOM);
    for (const { y, height } of column) {
      expect(y * view.zoom + view.y).toBeGreaterThanOrEqual(0);
      expect((y + height) * view.zoom + view.y).toBeLessThanOrEqual(size.height);
    }
  });

  it("starts at 0.6 on the root when the map is too big", () => {
    const view = startViewport(
      [box(0, 0), box(2660, 2000), box(0, -2000)],
      box(0, 0),
      size,
    );
    expect(view.zoom).toBe(0.6);
    expect(view.x).toBeGreaterThan(0);
    expect(view.x).toBeLessThan(200);
    expect(view.y + 32 * 0.6).toBeCloseTo(300);
  });
});

describe("childrenOf", () => {
  it("lists each parent's children in the order the nodes come", () => {
    const children = childrenOf([
      { id: "r", parent: null },
      { id: "a", parent: "r" },
      { id: "a1", parent: "a" },
      { id: "b", parent: "r" },
      { id: "a2", parent: "a" },
    ]);
    expect([...children.keys()]).toEqual(["r", "a"]);
    expect(children.get("r")?.map((node) => node.id)).toEqual(["a", "b"]);
    expect(children.get("a")?.map((node) => node.id)).toEqual(["a1", "a2"]);
  });
});

describe("revealViewport", () => {
  const size = { width: 1000, height: 600 };
  const at = { x: 0, y: 0, zoom: 1 };
  // The unfolded node and its children: 13 children of 64 px with 28 px between them, a column to the right.
  const branch = (top: number) => ({ x: 0, y: top, width: 620, height: 13 * 92 - 28 });

  it("leaves the view alone when the branch is inside it", () => {
    expect(revealViewport({ x: 100, y: 100, width: 300, height: 200 }, 200, at, size)).toBeNull();
  });

  it("moves without zooming when the branch fits but runs off an edge", () => {
    const view = revealViewport({ x: 100, y: 450, width: 300, height: 200 }, 550, at, size)!;
    expect(view.zoom).toBe(1);
    expect(view.y + 450).toBeGreaterThanOrEqual(24);
    expect(view.y + 450 + 200).toBeLessThanOrEqual(600 - 24);
  });

  it("zooms out only as far as the branch needs, and puts all of it on screen", () => {
    const box = branch(-300);
    const view = revealViewport(box, 300, at, size)!;
    expect(view.zoom).toBeLessThan(1);
    expect(view.zoom).toBeGreaterThanOrEqual(MIN_READ_ZOOM);
    expect(box.y * view.zoom + view.y).toBeGreaterThanOrEqual(24 - 1e-6);
    expect((box.y + box.height) * view.zoom + view.y).toBeLessThanOrEqual(600 - 24 + 1e-6);
    // The fit is tight: no more zoom-out than the 552 px of room asks for.
    expect(view.zoom).toBeCloseTo(552 / box.height, 5);
  });

  it("never zooms below a readable size and keeps the parent on screen", () => {
    const box = { x: 0, y: -2000, width: 620, height: 4000 };
    const view = revealViewport(box, 0, at, size)!;
    expect(view.zoom).toBe(MIN_READ_ZOOM);
    expect(0 * view.zoom + view.y).toBeCloseTo(300);
  });

  it("does not zoom in when the view is zoomed out past the readable size already", () => {
    const view = revealViewport({ x: 0, y: -2000, width: 620, height: 4000 }, 0, { x: 0, y: 0, zoom: 0.3 }, size)!;
    expect(view.zoom).toBe(0.3);
  });
});
