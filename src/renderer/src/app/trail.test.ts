import { describe, expect, it } from "vitest";
import {
  TRAIL_CAP,
  arrive,
  currentVisit,
  emptyTrail,
  forget,
  named,
  origin,
  pageOf,
  parseTrail,
  type Navigation,
  type Trail,
} from "./trail";

/** Plays navigations from an empty trail, as the router reports them. */
function walk(...steps: Navigation[]): Trail {
  return steps.reduce(arrive, emptyTrail);
}
const pop = (key: string, idx: number, path: string): Navigation => ({ action: "POP", key, idx, path });
const push = (key: string, idx: number, path: string, extra: Partial<Navigation> = {}): Navigation => ({
  action: "PUSH",
  key,
  idx,
  path,
  ...extra,
});
const replace = (key: string, idx: number, path: string): Navigation => ({ action: "REPLACE", key, idx, path });

describe("pageOf", () => {
  it("is the pathname, with the query and a trailing slash left out and Settings as one page", () => {
    expect(pageOf("/plans/p/lesson/t?part=3")).toBe("/plans/p/lesson/t");
    expect(pageOf("/plans/p/")).toBe("/plans/p");
    expect(pageOf("/exams/cards?exam=p")).toBe("/exams/cards");
    expect(pageOf("/settings")).toBe("/settings");
    expect(pageOf("/settings/engines")).toBe("/settings");
    expect(pageOf("/settingsx")).toBe("/settingsx");
    expect(pageOf("/")).toBe("/");
  });
});

describe("arrive", () => {
  it("starts the first page of a window with no origin", () => {
    const trail = walk(pop("default", 0, "/plans/p/lesson/t"));
    expect(currentVisit(trail)).toMatchObject({ key: "default", from: null });
    expect(origin(trail, "default")).toBeNull();
  });

  it("records the page a push came from", () => {
    const trail = walk(pop("a", 0, "/exams"), push("b", 1, "/plans/p"), push("c", 2, "/plans/p/map/t"));
    expect(origin(trail, "c")?.key).toBe("b");
    expect(origin(trail, "b")?.key).toBe("a");
  });

  it("gives a push from the sidebar or from outside no origin", () => {
    const trail = walk(
      pop("a", 0, "/plans/p"),
      push("b", 1, "/cards/due", { via: "outside" }),
      push("c", 2, "/maps", { via: "sidebar" }),
    );
    expect(origin(trail, "b")).toBeNull();
    expect(origin(trail, "c")).toBeNull();
  });

  it("keeps the origin of the page on a push inside the same page", () => {
    const trail = walk(
      pop("a", 0, "/plans/p"),
      push("b", 1, "/plans/p/lesson/t?part=1"),
      push("c", 2, "/plans/p/lesson/t?part=2"),
    );
    expect(origin(trail, "c")?.key).toBe("a");
  });

  it("keeps the origin and the name through a replace inside the page, as a part written into the address", () => {
    let trail = walk(pop("a", 0, "/plans/p"), push("b", 1, "/plans/p/lesson/t"));
    trail = named(trail, "b", { text: "Dinamica" });
    trail = arrive(trail, replace("c", 1, "/plans/p/lesson/t?part=2"));
    expect(trail.visits.map((visit) => visit.key)).toEqual(["a", "c"]);
    expect(currentVisit(trail)).toMatchObject({ key: "c", from: "a", name: { text: "Dinamica" } });
  });

  it("keeps the origin through a redirect to another page, and drops the replaced page's name", () => {
    let trail = walk(pop("a", 0, "/maps"), push("b", 1, "/maps/s?map=m1"));
    trail = named(trail, "b", { text: "Gradiente" });
    trail = arrive(trail, replace("c", 1, "/maps?subject=s"));
    expect(currentVisit(trail)).toMatchObject({ key: "c", from: "a" });
    expect(currentVisit(trail)?.name).toBeUndefined();
  });

  it("keeps the origin of a push that a loader redirected, which arrives as one push to the last address", () => {
    const trail = walk(pop("a", 0, "/plans/p"), push("b", 1, "/exams"));
    expect(origin(trail, "b")?.key).toBe("a");
  });

  it("returns to a recorded visit on a pop without changing it", () => {
    const trail = walk(pop("a", 0, "/exams"), push("b", 1, "/plans/p"), push("c", 2, "/plans/p/redo"), pop("b", 1, "/plans/p"));
    expect(trail.current).toBe("b");
    expect(origin(trail, "b")?.key).toBe("a");
    expect(origin(trail, "c")?.key).toBe("b");
  });

  it("drops the branch ahead on a push: A, B, back to A, then C leads back to A", () => {
    const trail = walk(pop("a", 0, "/plans/p"), push("b", 1, "/plans/p/map/t"), pop("a", 0, "/plans/p"), push("c", 1, "/exams/mistakes"));
    expect(trail.visits.map((visit) => visit.key)).toEqual(["a", "c"]);
    expect(origin(trail, "c")?.key).toBe("a");
  });

  it("records on the page being left what had the focus", () => {
    const trail = walk(pop("a", 0, "/plans/p"), push("b", 1, "/plans/p/lesson/t", { opener: "key:step-t" }));
    expect(trail.visits.find((visit) => visit.key === "a")?.opener).toBe("key:step-t");
    expect(trail.visits.find((visit) => visit.key === "b")?.opener).toBeUndefined();
  });

  it("starts a visit the trail does not know on a pop with no origin, in place of a stale one at that position", () => {
    const trail = walk(pop("a", 0, "/exams"), push("b", 1, "/plans/p"), pop("x", 1, "/maps"));
    expect(trail.visits.map((visit) => visit.key)).toEqual(["a", "x"]);
    expect(origin(trail, "x")).toBeNull();
  });

  it(`keeps the ${TRAIL_CAP} newest visits`, () => {
    let trail = walk(pop("k0", 0, "/exams"));
    for (let idx = 1; idx <= TRAIL_CAP + 20; idx++) trail = arrive(trail, push(`k${idx}`, idx, `/plans/p${idx}`));
    expect(trail.visits).toHaveLength(TRAIL_CAP);
    expect(trail.visits[0]?.key).toBe("k21");
    expect(origin(trail, `k${TRAIL_CAP + 20}`)?.key).toBe(`k${TRAIL_CAP + 19}`);
    // The oldest kept visit's origin was dropped, so it goes back to its parent.
    expect(origin(trail, "k21")).toBeNull();
  });
});

describe("origin", () => {
  it("is null for a visit whose origin was deleted", () => {
    let trail = walk(pop("a", 0, "/ask/c1"), push("b", 1, "/plans/p"));
    trail = forget(trail, (path) => path.startsWith("/ask/c1"));
    expect(origin(trail, "b")).toBeNull();
    expect(forget(trail, (path) => path.startsWith("/ask/c1"))).toBe(trail);
  });

  it("is null for an unknown visit, or an origin that is not behind it", () => {
    const trail = walk(pop("a", 0, "/exams"));
    expect(origin(trail, "zz")).toBeNull();
    const odd: Trail = {
      visits: [
        { key: "a", idx: 2, path: "/exams", page: "/exams", from: null },
        { key: "b", idx: 1, path: "/plans/p", page: "/plans/p", from: "a" },
      ],
      current: "b",
    };
    expect(origin(odd, "b")).toBeNull();
  });
});

describe("named", () => {
  it("writes a page's name on its visit, and leaves the trail as it is when nothing changes", () => {
    const trail = named(walk(pop("a", 0, "/plans/p")), "a", { text: "Analisi Matematica 2" });
    expect(currentVisit(trail)?.name).toEqual({ text: "Analisi Matematica 2" });
    expect(named(trail, "a", { text: "Analisi Matematica 2" })).toBe(trail);
    expect(named(trail, "zz", { text: "x" })).toBe(trail);
  });
});

describe("parseTrail", () => {
  it("reads back a stored trail", () => {
    const trail = named(walk(pop("a", 0, "/exams"), push("b", 1, "/plans/p", { opener: "href:#/plans/p" })), "b", {
      key: "places.exam",
      values: { n: "1" },
    });
    expect(parseTrail(JSON.stringify(trail))).toEqual(trail);
  });

  it("means no history for nothing stored, damaged JSON or another shape", () => {
    expect(parseTrail(null)).toEqual(emptyTrail);
    expect(parseTrail("{")).toEqual(emptyTrail);
    expect(parseTrail("[]")).toEqual(emptyTrail);
    expect(parseTrail(JSON.stringify({ visits: [{ key: 1 }], current: null }))).toEqual(emptyTrail);
    expect(parseTrail(JSON.stringify({ visits: [], current: 3 }))).toEqual(emptyTrail);
    expect(
      parseTrail(
        JSON.stringify({
          visits: [{ key: "a", idx: 0, path: "/", page: "/", from: null, name: { key: "x", values: { n: 1 } } }],
          current: "a",
        }),
      ),
    ).toEqual(emptyTrail);
  });
});
