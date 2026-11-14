import { describe, expect, it } from "vitest";
import {
  TRAIL_CAP,
  arrive,
  canForward,
  currentVisit,
  emptyTrail,
  forget,
  lastChat,
  named,
  origin,
  pageOf,
  parseTrail,
  sectionFor,
  sectionOf,
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
    const again = arrive(arrive(trail, pop("a", 0, "/plans/p")), push("c", 1, "/exams/mistakes"));
    expect(again.visits.find((visit) => visit.key === "a")?.opener).toBeUndefined();
  });

  it("starts a visit the trail does not know on a pop with no origin, in place of a stale one at that position", () => {
    const trail = walk(pop("a", 0, "/exams"), push("b", 1, "/plans/p"), pop("x", 1, "/maps"));
    expect(trail.visits.map((visit) => visit.key)).toEqual(["a", "x"]);
    expect(origin(trail, "x")).toBeNull();
  });

  it("starts anew a recorded entry that comes back with another page, as an address set by hand does", () => {
    let trail = walk(pop("default", 0, "/plans/p"));
    trail = named(trail, "default", { text: "Analisi Matematica 2" });
    trail = arrive(trail, pop("default", 0, "/maps"));
    expect(currentVisit(trail)).toEqual({ key: "default", idx: 0, path: "/maps", page: "/maps", section: "maps", from: null });
    expect(trail.visits).toHaveLength(1);
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
        { key: "a", idx: 2, path: "/exams", page: "/exams", section: "exams", from: null },
        { key: "b", idx: 1, path: "/plans/p", page: "/plans/p", section: "exams", from: "a" },
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

describe("sectionOf", () => {
  it("is the sidebar row a path lights by itself", () => {
    expect(sectionOf("/ask")).toBe("ask");
    expect(sectionOf("/ask/c1")).toEqual({ chat: "c1" });
    expect(sectionOf("/exams")).toBe("exams");
    expect(sectionOf("/exams/mistakes?exam=p")).toBe("exams");
    expect(sectionOf("/exams/library")).toBe("library");
    expect(sectionOf("/plans/p")).toBe("exams");
    expect(sectionOf("/plans/p/lesson/t")).toBe("exams");
    expect(sectionOf("/maps")).toBe("maps");
    expect(sectionOf("/maps/s1/t1")).toBe("maps");
    expect(sectionOf("/plans/p/map/t")).toBe("maps");
    expect(sectionOf("/flashcards/all")).toBe("flashcards");
    expect(sectionOf("/cards/due")).toBe("flashcards");
    expect(sectionOf("/settings/engines")).toBeNull();
    expect(sectionOf("/tools/whiteboard")).toBeNull();
  });
});

describe("the lit section of a visit", () => {
  const section = (trail: Trail) => currentVisit(trail)?.section;

  it("is the section of the page's own path where a trail starts", () => {
    expect(section(walk(pop("a", 0, "/plans/p/lesson/t")))).toBe("exams");
    expect(section(walk(pop("a", 0, "/ask/c1"), push("b", 1, "/maps", { via: "sidebar" })))).toBe("maps");
    expect(section(walk(pop("a", 0, "/maps/s1"), push("b", 1, "/cards/due", { via: "outside" })))).toBe("flashcards");
  });

  it("is kept from the page that opened it: a map from an exam keeps Esami, Settings over it too", () => {
    const map = walk(pop("a", 0, "/exams"), push("b", 1, "/plans/p"), push("c", 2, "/maps/s1/t1"));
    expect(section(map)).toBe("exams");
    expect(section(arrive(map, push("d", 3, "/settings/profile")))).toBe("exams");
  });

  it("is the chat's own row for a chat, and a chat's row stays lit for the exam page opened from it", () => {
    const fromExam = walk(pop("a", 0, "/plans/p"), push("b", 1, "/ask/c1"));
    expect(section(fromExam)).toEqual({ chat: "c1" });
    expect(section(arrive(fromExam, push("c", 2, "/plans/p")))).toEqual({ chat: "c1" });
    expect(section(walk(pop("a", 0, "/plans/p"), push("b", 1, "/ask")))).toBe("ask");
  });

  it("falls back to the path's own section when the page that opened it had none", () => {
    expect(section(walk(pop("a", 0, "/settings"), push("b", 1, "/plans/p")))).toBe("exams");
  });

  it("is kept by a move inside a page, a replace, and a return to the page", () => {
    const base = walk(pop("a", 0, "/exams"), push("b", 1, "/plans/p"), push("c", 2, "/maps/s1/t1"));
    expect(section(arrive(base, replace("c2", 2, "/maps/s1/t2")))).toBe("exams");
    expect(section(arrive(base, pop("b", 1, "/plans/p")))).toBe("exams");
    expect(section(arrive(base, pop("a", 0, "/exams")))).toBe("exams");
  });

  it("is the chat's own row when a new chat is replaced by the chat it became", () => {
    const trail = walk(pop("a", 0, "/exams"), push("b", 1, "/ask", { via: "sidebar" }), replace("c", 1, "/ask/c1"));
    expect(section(trail)).toEqual({ chat: "c1" });
  });

  it("starts over when a sidebar row replaces the page that shows it", () => {
    const shown = walk(pop("a", 0, "/plans/p"), push("b", 1, "/maps"));
    expect(section(shown)).toBe("exams");
    const clicked = arrive(shown, { action: "REPLACE", key: "c", idx: 1, path: "/maps", via: "sidebar" });
    expect(section(clicked)).toBe("maps");
    expect(origin(clicked, "c")).toBeNull();
  });
});

describe("sectionFor", () => {
  it("reads a page the trail knows from its record, and a page being opened as a push", () => {
    const trail = walk(pop("a", 0, "/exams"), push("b", 1, "/plans/p"));
    expect(sectionFor(trail, { key: "b", path: "/plans/p" })).toBe("exams");
    expect(sectionFor(trail, { key: "x", path: "/maps/s1/t1" })).toBe("exams");
    expect(sectionFor(trail, { key: "x", path: "/maps", via: "sidebar" })).toBe("maps");
    expect(sectionFor(emptyTrail, { key: "x", path: "/flashcards" })).toBe("flashcards");
  });
});

describe("canForward", () => {
  it("is true only after going back, and until a new push drops what was ahead", () => {
    const trail = walk(pop("a", 0, "/exams"), push("b", 1, "/plans/p"), push("c", 2, "/plans/p/lesson/t"));
    expect(canForward(trail, "c")).toBe(false);
    const back = arrive(trail, pop("b", 1, "/plans/p"));
    expect(canForward(back, "b")).toBe(true);
    expect(canForward(arrive(back, pop("a", 0, "/exams")), "a")).toBe(true);
    expect(canForward(arrive(back, push("d", 2, "/maps")), "d")).toBe(false);
    expect(canForward(back, "zz")).toBe(false);
  });

  it("is false when the page ahead was deleted", () => {
    const trail = arrive(walk(pop("a", 0, "/maps"), push("b", 1, "/maps/s1/t1")), pop("a", 0, "/maps"));
    expect(canForward(trail, "a")).toBe(true);
    expect(canForward(forget(trail, (path) => path.startsWith("/maps/s1")), "a")).toBe(false);
  });
});

describe("lastChat", () => {
  it("names the chat a page was opened from, and none for a new chat or another place", () => {
    expect(lastChat(walk(pop("a", 0, "/ask/c1"), push("b", 1, "/tools/whiteboard")))).toBe("c1");
    expect(lastChat(walk(pop("a", 0, "/ask/c1"), push("b", 1, "/ask", { via: "sidebar" }), push("c", 2, "/tools/graph")))).toBeUndefined();
    expect(lastChat(walk(pop("a", 0, "/exams"), push("b", 1, "/tools/whiteboard")))).toBeUndefined();
    expect(lastChat(emptyTrail)).toBeUndefined();
  });
});

describe("parseTrail of an older trail", () => {
  it("reads a visit that has no section from its path", () => {
    const stored = { visits: [{ key: "a", idx: 0, path: "/plans/p/map/t", page: "/plans/p/map/t", from: null }], current: "a" };
    expect(currentVisit(parseTrail(JSON.stringify(stored)))?.section).toBe("maps");
  });

  it("refuses a section it does not know", () => {
    const stored = { visits: [{ key: "a", idx: 0, path: "/", page: "/", from: null, section: "elsewhere" }], current: "a" };
    expect(parseTrail(JSON.stringify(stored))).toEqual(emptyTrail);
  });
});
