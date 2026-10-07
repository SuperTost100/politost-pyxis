import { describe, expect, it } from "vitest";
import { addIds, applySubject, scopeItems } from "./scope";

describe("chat scope", () => {
  it("swaps the previous subject's sources for the new one and keeps hand-picked ones", () => {
    expect(applySubject(["analisi-1", "mine"], ["analisi-1"], ["fisica-1", "fisica-2"])).toEqual([
      "mine",
      "fisica-1",
      "fisica-2",
    ]);
    expect(applySubject(["analisi-1"], ["analisi-1"], [])).toEqual([]);
    expect(applySubject(["a"], [], ["a", "b"])).toEqual(["a", "b"]);
  });

  it("adds ids once", () => {
    expect(addIds(["a"], ["a", "b", "b"])).toEqual(["a", "b"]);
  });

  it("lists the plan first, then sources by title, and locks attached documents", () => {
    expect(
      scopeItems({
        planId: "p",
        planTitle: "Analisi 2",
        picked: ["s2", "s1", "doc", "gone"],
        library: [
          { id: "s1", title: "Dispense" },
          { id: "s2", title: "Appunti" },
        ],
        held: [{ id: "doc", title: "foto.png" }],
      }),
    ).toEqual([
      { kind: "plan", id: "p", title: "Analisi 2" },
      { kind: "source", id: "s2", title: "Appunti" },
      { kind: "source", id: "s1", title: "Dispense" },
      { kind: "source", id: "doc", title: "foto.png", locked: true },
    ]);
  });
});
