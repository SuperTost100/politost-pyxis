import { describe, expect, it } from "vitest";
import { byShelfOrder, coverColour, mixedReasons, needsStudent, nextPickerRow, placeWhenReady, unsortedReasons } from "./shelf";

describe("the Library's shelf", () => {
  it("gives a subject the same cover colour every time, from its id alone", () => {
    const id = "0193f1c2-7a4e-7cc1-9a1b-2f3d4e5f6a7b";
    expect(coverColour(id)).toBe(coverColour(id));
    const colours = new Set(Array.from({ length: 60 }, (_, n) => coverColour(`subject-${n}`)));
    expect([...colours].every((colour) => colour >= 1 && colour <= 6)).toBe(true);
    expect(colours.size).toBe(6);
  });

  it("moves focus after a sort to a row that has a picker, never to one Pyxis is still choosing for", () => {
    const rows = [
      { id: "a", sort: null },
      { id: "b", sort: "working" as const },
      { id: "c", sort: "working" as const },
      { id: "d", sort: "unsure" as const },
    ];
    // The next rows are being sorted and have no picker: the previous row has one.
    expect(nextPickerRow(rows, "a")).toBe("d");
    expect(nextPickerRow(rows, "d")).toBe("a");
    // Only rows with no picker left: the caller falls back to the moved cover.
    expect(nextPickerRow([{ id: "a", sort: null }, { id: "b", sort: "working" as const }], "a")).toBeNull();
    expect(nextPickerRow([{ id: "a", sort: null }], "a")).toBeNull();
    // The nearest row below comes first, then the nearest above.
    expect(nextPickerRow([{ id: "a", sort: null }, { id: "b", sort: null }, { id: "c", sort: null }], "b")).toBe("c");
    expect(nextPickerRow([{ id: "a", sort: null }, { id: "b", sort: null }, { id: "c", sort: null }], "c")).toBe("b");
  });

  it("explains a waiting file only by what really happened to it", () => {
    // A file the Library never asked about is not one Pyxis could not place.
    expect([...unsortedReasons([{ sort: null }])]).toEqual(["none"]);
    expect([...unsortedReasons([{ sort: "unsure" }])]).toEqual(["unsure"]);
    expect(unsortedReasons([{ sort: null }, { sort: "unsure" }, { sort: "working" }, { sort: "no-ai" }, { sort: "stopped" }])).toEqual(
      new Set(["none", "unsure", "working", "no-ai", "stopped"]),
    );
  });

  it("calls the reasons mixed whenever a group has two, a file still being sorted included", () => {
    expect(mixedReasons(unsortedReasons([{ sort: "unsure" }, { sort: "unsure" }]))).toBe(false);
    expect(mixedReasons(unsortedReasons([{ sort: "working" }]))).toBe(false);
    // One file Pyxis is still choosing for and one it could not place: "some files", not "these files".
    expect(mixedReasons(unsortedReasons([{ sort: "working" }, { sort: "unsure" }]))).toBe(true);
    expect(mixedReasons(unsortedReasons([{ sort: "unsure" }, { sort: null }]))).toBe(true);
  });

  it("puts the files that need the student first: failed, missing, locked, then being read, then the rest by title", () => {
    const file = (title: string, more: Record<string, unknown> = {}) => ({ title, status: "ready", ...more });
    const files = [
      file("Appunti"),
      file("Lezione 10"),
      file("Lezione 2"),
      file("Slide in lettura", { status: "reading" }),
      file("Zeta illeggibile", { status: "failed" }),
      file("Bloccato", { status: "failed", error: "pdf-password-required", errorJobId: "job-1" }),
      file("Sparito", { linked: { missing: true } }),
      file("Scansione", { status: "needs-ocr" }),
    ];
    expect([...files].sort(byShelfOrder).map((source) => source.title)).toEqual([
      "Scansione",
      "Zeta illeggibile",
      "Sparito",
      "Bloccato",
      "Slide in lettura",
      "Appunti",
      "Lezione 2",
      "Lezione 10",
    ]);
    expect(files.filter(needsStudent).map((source) => source.title)).toEqual([
      "Slide in lettura",
      "Zeta illeggibile",
      "Bloccato",
      "Sparito",
      "Scansione",
    ]);
  });

  it("places a file where it will sit once read, whatever its state now", () => {
    const shelf = Array.from({ length: 14 }, (_, n) => ({
      id: `a${n}`,
      title: `Appunti ${String(n + 1).padStart(2, "0")}`,
      status: "ready",
    }));
    const zeta = { id: "zeta", title: "Zeta", status: "reading" };
    // Being read, it would sort first; ready, it sorts after the fourteen by title.
    expect([...shelf, zeta].sort(byShelfOrder).indexOf(zeta)).toBe(0);
    expect(placeWhenReady(shelf, zeta)).toBe(14);
    // A failed file on the shelf goes first and moves it one place on.
    expect(placeWhenReady([...shelf, { id: "bad", title: "Zulu", status: "failed" }], zeta)).toBe(15);
    // Its own old copy on the shelf is not counted twice, and a title that sorts early stays in view.
    expect(placeWhenReady([...shelf, zeta], zeta)).toBe(14);
    expect(placeWhenReady(shelf, { id: "b", title: "Algebra", status: "failed" })).toBe(0);
  });
});
