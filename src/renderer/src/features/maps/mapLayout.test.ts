import { describe, expect, it } from "vitest";
import {
  COLUMN_GAP,
  NODE_WIDTH,
  SIBLING_GAP,
  initialCollapsed,
  startViewport,
  layoutTree,
  visibleNodes,
} from "./mapLayout";

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
